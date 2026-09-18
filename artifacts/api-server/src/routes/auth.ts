import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable, paymentRequestsTable, staffTable, partnersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { signToken, verifyToken, authMiddleware } from "../middleware/auth.js";
import { PLANS, isValidPlanId } from "../lib/plans.js";
import { normalizeReferralCode } from "../lib/referral-code.js";

// Best-effort referral lookup shared by /register and /payment-request — an invalid,
// unknown, or not-yet-approved code must never fail the surrounding action. Only an
// ACTIVE partner's code attributes; pending/inactive partner codes are silently
// ignored (no error surfaced to the referred signer-upper).
async function lookupActivePartnerId(rawCode: unknown): Promise<number | null> {
  if (!rawCode || !String(rawCode).trim()) return null;
  try {
    const code = normalizeReferralCode(String(rawCode));
    const [partner] = await db.select({ id: partnersTable.id, status: partnersTable.status })
      .from(partnersTable).where(eq(partnersTable.referralCode, code)).limit(1);
    return partner && partner.status === "active" ? partner.id : null;
  } catch {
    return null;
  }
}

const router = Router();

router.post("/register", async (req, res) => {
  try {
    const { password, name, shopName, mobile, referralCode } = req.body;
    // Coerced the same way staff.ts does, so a non-string email can't blow up on
    // .toLowerCase() and surface as a 500 instead of a plain validation error.
    const email = String(req.body.email ?? "").trim().toLowerCase();
    if (!email || !password || !name || !shopName) {
      return res.status(400).json({ error: "email, password, name, shopName are required" });
    }
    // Same minimum the rest of the app enforces (staff creation, staff edit, and
    // /change-password below) — without it the shop OWNER, the most privileged account
    // in the shop, was the one account that could be created with a one-character password.
    if (String(password).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    const existing = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (existing.length > 0) {
      return res.status(409).json({ error: "Email already registered" });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const partnerId = await lookupActivePartnerId(referralCode);
    const [user] = await db.insert(usersTable).values({
      email,
      passwordHash,
      name,
      shopName,
      mobile: mobile || null,
      role: "user",
      plan: "trial",
      trialEndsAt,
      partnerId,
    }).returning();
    const token = signToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      plan: user.plan,
      trialEndsAt: user.trialEndsAt.toISOString(),
      subscriptionEndsAt: null,
      shopName: user.shopName,
      staffId: null,
      staffRole: null,
      partnerId: user.partnerId,
    });
    res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name, shopName: user.shopName, role: user.role, plan: user.plan, trialEndsAt: user.trialEndsAt, subscriptionEndsAt: null, staffId: null, staffRole: null, partnerId: user.partnerId } });
  } catch (err) {
    req.log.error({ err }, "Register failed");
    res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase())).limit(1);
    if (!user) return loginAsStaff(req, res, email, password);
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password" });
    // Refresh plan status on login
    let plan = user.plan;
    const now = new Date();
    if (plan === "trial" && new Date(user.trialEndsAt) < now) {
      plan = "expired";
      await db.update(usersTable).set({ plan: "expired" }).where(eq(usersTable.id, user.id));
    } else if (plan === "active" && user.subscriptionEndsAt && new Date(user.subscriptionEndsAt) < now) {
      plan = "expired";
      await db.update(usersTable).set({ plan: "expired" }).where(eq(usersTable.id, user.id));
    }
    const token = signToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      plan,
      trialEndsAt: user.trialEndsAt.toISOString(),
      subscriptionEndsAt: user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt).toISOString() : null,
      shopName: user.shopName,
      staffId: null,
      staffRole: null,
      partnerId: user.partnerId,
    });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, shopName: user.shopName, role: user.role, plan, trialEndsAt: user.trialEndsAt, subscriptionEndsAt: user.subscriptionEndsAt ?? null, staffId: null, staffRole: null, partnerId: user.partnerId } });
  } catch (err) {
    req.log.error({ err }, "Login failed");
    res.status(500).json({ error: "Login failed" });
  }
});

// Falls back here when the email doesn't match a shop-owner account — checks staff logins
// instead. The resulting token/user carries the OWNER's userId (so every other route's
// data scoping keeps working unchanged) plus staffId/staffRole for permission checks.
async function loginAsStaff(req: import("express").Request, res: import("express").Response, email: string, password: string) {
  const [staff] = await db.select().from(staffTable).where(eq(staffTable.email, email.toLowerCase())).limit(1);
  if (!staff || !staff.isActive) return res.status(401).json({ error: "Invalid email or password" });
  const valid = await bcrypt.compare(password, staff.passwordHash);
  if (!valid) return res.status(401).json({ error: "Invalid email or password" });
  const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, staff.ownerUserId)).limit(1);
  if (!owner) return res.status(401).json({ error: "Invalid email or password" });
  const token = signToken({
    userId: owner.id,
    email: staff.email,
    role: owner.role,
    plan: owner.plan,
    trialEndsAt: owner.trialEndsAt.toISOString(),
    subscriptionEndsAt: owner.subscriptionEndsAt ? new Date(owner.subscriptionEndsAt).toISOString() : null,
    shopName: owner.shopName,
    staffId: staff.id,
    staffRole: staff.role,
    partnerId: owner.partnerId,
  });
  res.json({
    token,
    user: {
      id: owner.id, email: staff.email, name: staff.name, shopName: owner.shopName,
      role: owner.role, plan: owner.plan, trialEndsAt: owner.trialEndsAt, subscriptionEndsAt: owner.subscriptionEndsAt ?? null,
      staffId: staff.id, staffRole: staff.role, partnerId: owner.partnerId,
    },
  });
}

// One-time admin setup — protected by ADMIN_SETUP_SECRET
router.post("/setup-admin", async (req, res) => {
  try {
    const secret = process.env.ADMIN_SETUP_SECRET;
    if (!secret || req.body.secret !== secret) {
      return res.status(403).json({ error: "Invalid setup secret" });
    }
    const existing = await db.select().from(usersTable).where(eq(usersTable.role, "admin")).limit(1);
    if (existing.length > 0) return res.status(409).json({ error: "Admin already exists" });
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: "email, password, name required" });
    const passwordHash = await bcrypt.hash(password, 12);
    const trialEndsAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000 * 100); // 100 years
    const [admin] = await db.insert(usersTable).values({
      email: email.toLowerCase(),
      passwordHash,
      name,
      shopName: "SwarnDesk Admin",
      role: "admin",
      plan: "active",
      trialEndsAt,
    }).returning();
    res.status(201).json({ message: "Admin created", email: admin.email });
  } catch (err) {
    req.log.error({ err }, "Admin setup failed");
    res.status(500).json({ error: "Setup failed" });
  }
});

// Change own password — requires the current password, works for any logged-in role
// (used by the admin panel's "Change Password" action, and available for regular users too).
router.post("/change-password", authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "currentPassword and newPassword required" });
    if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });
    if (req.user!.staffId !== null) {
      const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, req.user!.staffId)).limit(1);
      if (!staff) return res.status(404).json({ error: "Account not found" });
      const validStaff = await bcrypt.compare(currentPassword, staff.passwordHash);
      if (!validStaff) return res.status(401).json({ error: "Current password is incorrect" });
      const staffPasswordHash = await bcrypt.hash(newPassword, 10);
      await db.update(staffTable).set({ passwordHash: staffPasswordHash }).where(eq(staffTable.id, staff.id));
      return res.json({ success: true });
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.userId)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Current password is incorrect" });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, user.id));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Change password failed");
    res.status(500).json({ error: "Failed to change password" });
  }
});

// GET /auth/me — returns fresh user data from DB (used to refresh stale JWT/localStorage)
router.get("/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
    const token = authHeader.slice(7);
    let payload: { userId: number; staffId: number | null };
    try {
      payload = verifyToken(token) as typeof payload;
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, payload.userId)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Re-verify staff status/role every refresh — if they were deactivated or had their
    // role changed since they last logged in, that must take effect immediately, not just
    // on their next login.
    let staffId: number | null = null;
    let staffRole: string | null = null;
    let name = user.name;
    let email = user.email;
    if (payload.staffId !== null && payload.staffId !== undefined) {
      const [staff] = await db.select().from(staffTable).where(eq(staffTable.id, payload.staffId)).limit(1);
      if (!staff || !staff.isActive || staff.ownerUserId !== user.id) return res.status(401).json({ error: "Your access has been revoked" });
      staffId = staff.id;
      staffRole = staff.role;
      name = staff.name;
      email = staff.email;
    }

    // Refresh expired plan
    let plan = user.plan;
    const now = new Date();
    if (plan === "trial" && new Date(user.trialEndsAt) < now) {
      plan = "expired";
      await db.update(usersTable).set({ plan: "expired" }).where(eq(usersTable.id, user.id));
    } else if (plan === "active" && user.subscriptionEndsAt && new Date(user.subscriptionEndsAt) < now) {
      plan = "expired";
      await db.update(usersTable).set({ plan: "expired" }).where(eq(usersTable.id, user.id));
    }
    const newToken = signToken({
      userId: user.id,
      email,
      role: user.role,
      plan,
      trialEndsAt: user.trialEndsAt.toISOString(),
      subscriptionEndsAt: user.subscriptionEndsAt ? new Date(user.subscriptionEndsAt).toISOString() : null,
      shopName: user.shopName,
      staffId,
      staffRole,
      partnerId: user.partnerId,
    });
    res.json({
      token: newToken,
      user: { id: user.id, email, name, shopName: user.shopName, role: user.role, plan, trialEndsAt: user.trialEndsAt, subscriptionEndsAt: user.subscriptionEndsAt ?? null, staffId, staffRole, partnerId: user.partnerId },
    });
  } catch (err) {
    req.log.error({ err }, "/me failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Submit payment request — requires auth (but not subscriptionCheck, since an expired/trial-
// expired user must still be able to submit one). userId is taken from the verified token,
// never trusted from the request body — otherwise any logged-in user could submit fake
// payment requests against another user's account.
router.post("/payment-request", authMiddleware, async (req, res) => {
  try {
    const { utrNumber, planId, referralCode } = req.body;
    if (!utrNumber || !String(utrNumber).trim()) return res.status(400).json({ error: "utrNumber required" });
    // planId picks which row of PLANS to charge — amount/duration are always
    // resolved from that table server-side, never taken from the client, so a
    // tampered request body can't claim a cheaper plan than what was selected.
    if (!isValidPlanId(planId)) return res.status(400).json({ error: "A valid plan must be selected" });
    const plan = PLANS[planId];
    const userId = req.user!.userId;
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Fallback attribution — lets someone who signed up organically still credit a
    // partner at checkout. Best-effort and one-shot: only applies if no partner is
    // already attributed, and first attribution wins permanently — never overwritten.
    if (user.partnerId === null) {
      const partnerId = await lookupActivePartnerId(referralCode);
      if (partnerId !== null) {
        await db.update(usersTable).set({ partnerId }).where(eq(usersTable.id, userId));
      }
    }

    const [pr] = await db.insert(paymentRequestsTable).values({
      userId,
      userNameSnapshot: user.name,
      userEmailSnapshot: user.email,
      shopNameSnapshot: user.shopName,
      utrNumber: String(utrNumber).trim(),
      amount: plan.amount,
      planId: plan.id,
      durationDays: plan.durationDays,
      status: "pending",
    }).returning();
    res.status(201).json(pr);
  } catch (err) {
    req.log.error({ err }, "Payment request failed");
    res.status(500).json({ error: "Failed to submit payment request" });
  }
});

// Current user's own payment request history — lets the billing page show whether the
// latest submission is pending, was approved, or was rejected (and why).
router.get("/payment-requests/mine", authMiddleware, async (req, res) => {
  try {
    const rows = await db.select({
      id: paymentRequestsTable.id,
      amount: paymentRequestsTable.amount,
      planId: paymentRequestsTable.planId,
      utrNumber: paymentRequestsTable.utrNumber,
      status: paymentRequestsTable.status,
      notes: paymentRequestsTable.notes,
      createdAt: paymentRequestsTable.createdAt,
      processedAt: paymentRequestsTable.processedAt,
    }).from(paymentRequestsTable)
      .where(eq(paymentRequestsTable.userId, req.user!.userId))
      .orderBy(desc(paymentRequestsTable.createdAt));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list own payment requests");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
