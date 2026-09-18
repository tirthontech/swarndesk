import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, paymentRequestsTable, adminActivityLogTable, userNotesTable, partnersTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { authMiddleware, adminOnly } from "../middleware/auth.js";

const router = Router();
router.use(authMiddleware, adminOnly);

/** Generates a random, human-typeable temporary password (unambiguous charset — no 0/O/1/l/I). */
function generateTempPassword(length = 10): string {
  const charset = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  return Array.from(crypto.randomBytes(length))
    .map(b => charset[b % charset.length])
    .join("");
}

/** Parses a days value, rejecting anything that isn't a positive integer (blocks 0/negative/NaN silently corrupting subscription dates). */
function parsePositiveInt(value: unknown, max = 3650): number | null {
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > max) return null;
  return n;
}

/** Records an admin action for the activity log. Never throws — logging failures shouldn't block the underlying action. */
async function logAdminAction(
  req: { user?: { userId: number; email: string } },
  action: string,
  targetUserId: number | null,
  targetLabel: string | null,
  details: string,
) {
  try {
    await db.insert(adminActivityLogTable).values({
      adminId: req.user?.userId ?? null,
      adminEmailSnapshot: req.user?.email ?? "unknown",
      action,
      targetUserId,
      targetLabelSnapshot: targetLabel,
      details,
    });
  } catch {
    // best-effort — do not fail the request over a logging error
  }
}

router.get("/users", async (req, res) => {
  try {
    const users = await db.select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      shopName: usersTable.shopName,
      mobile: usersTable.mobile,
      role: usersTable.role,
      plan: usersTable.plan,
      trialEndsAt: usersTable.trialEndsAt,
      subscriptionEndsAt: usersTable.subscriptionEndsAt,
      createdAt: usersTable.createdAt,
      partnerName: partnersTable.name,
    }).from(usersTable)
      .leftJoin(partnersTable, eq(usersTable.partnerId, partnersTable.id))
      .where(eq(usersTable.role, "user")).orderBy(desc(usersTable.createdAt));
    res.json(users);
  } catch (err) {
    req.log.error({ err }, "Failed to list users");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/payment-requests", async (req, res) => {
  try {
    // Single LEFT JOIN instead of one user lookup per payment request (was N+1 queries).
    // LEFT JOIN also means requests from a since-deleted user still come back — their
    // identity falls back to the snapshot columns captured at request-creation time.
    const rows = await db.select({
      id: paymentRequestsTable.id,
      userId: paymentRequestsTable.userId,
      amount: paymentRequestsTable.amount,
      planId: paymentRequestsTable.planId,
      durationDays: paymentRequestsTable.durationDays,
      utrNumber: paymentRequestsTable.utrNumber,
      status: paymentRequestsTable.status,
      notes: paymentRequestsTable.notes,
      createdAt: paymentRequestsTable.createdAt,
      processedAt: paymentRequestsTable.processedAt,
      userNameSnapshot: paymentRequestsTable.userNameSnapshot,
      userEmailSnapshot: paymentRequestsTable.userEmailSnapshot,
      shopNameSnapshot: paymentRequestsTable.shopNameSnapshot,
      liveName: usersTable.name,
      liveEmail: usersTable.email,
      liveShopName: usersTable.shopName,
    }).from(paymentRequestsTable)
      .leftJoin(usersTable, eq(paymentRequestsTable.userId, usersTable.id))
      .orderBy(desc(paymentRequestsTable.createdAt));

    const withUsers = rows.map(r => ({
      id: r.id,
      userId: r.userId,
      amount: r.amount,
      planId: r.planId,
      durationDays: r.durationDays,
      utrNumber: r.utrNumber,
      status: r.status,
      notes: r.notes,
      createdAt: r.createdAt,
      processedAt: r.processedAt,
      userName: r.liveName ?? r.userNameSnapshot ?? "Deleted user",
      userEmail: r.liveEmail ?? r.userEmailSnapshot ?? "—",
      shopName: r.liveShopName ?? r.shopNameSnapshot ?? "—",
    }));
    res.json(withUsers);
  } catch (err) {
    req.log.error({ err }, "Failed to list payment requests");
    res.status(500).json({ error: "Internal server error" });
  }
});

/** Atomically flips a payment request from "pending" to a new status. A plain
 * select-then-check-then-update has a TOCTOU race: two concurrent approve requests can
 * both read status="pending" before either writes, both extend the subscription and
 * both log an admin action — and since partner commission is computed live off this
 * status field, that race would double-count commission too. The WHERE clause makes
 * Postgres the sole arbiter: only the request that actually flips a still-pending row
 * gets a row back; the loser gets null and must not apply any of its side effects. */
async function claimPendingPaymentRequest(id: number, set: Record<string, unknown>) {
  const [claimed] = await db.update(paymentRequestsTable)
    .set(set)
    .where(and(eq(paymentRequestsTable.id, id), eq(paymentRequestsTable.status, "pending")))
    .returning();
  return claimed ?? null;
}

/** Builds the 409/404 response when claimPendingPaymentRequest returns null. */
async function paymentRequestConflictResponse(res: import("express").Response, id: number) {
  const [existing] = await db.select({ status: paymentRequestsTable.status }).from(paymentRequestsTable).where(eq(paymentRequestsTable.id, id)).limit(1);
  if (!existing) return res.status(404).json({ error: "Not found" });
  return res.status(409).json({ error: `Payment request already ${existing.status}` });
}

router.patch("/payment-requests/:id/approve", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const pr = await claimPendingPaymentRequest(id, { status: "approved", processedAt: new Date() });
    if (!pr) return await paymentRequestConflictResponse(res, id);
    // Duration comes from the plan the user actually selected at submission
    // time; requests from before planId/durationDays existed fall back to 30.
    const days = pr.durationDays ?? 30;
    if (pr.userId) {
      // Stack onto whatever subscription time is still unused, exactly as
      // /approve-custom and /users/:id/extend do. Dating the new period from "now"
      // instead would silently burn the remaining days of anyone who renews early.
      const [user] = await db.select().from(usersTable).where(eq(usersTable.id, pr.userId)).limit(1);
      const base = user?.subscriptionEndsAt && new Date(user.subscriptionEndsAt) > new Date()
        ? new Date(user.subscriptionEndsAt) : new Date();
      const subscriptionEndsAt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
      await db.update(usersTable).set({ plan: "active", subscriptionEndsAt }).where(eq(usersTable.id, pr.userId));
    }
    await logAdminAction(req, "approve_payment", pr.userId, pr.userNameSnapshot ?? pr.userEmailSnapshot, `Quick-approved ₹${pr.amount}${pr.planId ? ` (${pr.planId})` : ""} for ${days} days (UTR ${pr.utrNumber ?? "—"})`);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to approve payment");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/payment-requests/:id/reject", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const notes = typeof req.body.notes === "string" ? req.body.notes.trim() : "";
    if (!notes) return res.status(400).json({ error: "A rejection reason is required — it is shown to the user." });
    const pr = await claimPendingPaymentRequest(id, { status: "rejected", processedAt: new Date(), notes });
    if (!pr) return await paymentRequestConflictResponse(res, id);
    await logAdminAction(req, "reject_payment", pr.userId, pr.userNameSnapshot ?? pr.userEmailSnapshot, `Rejected ₹${pr.amount} (UTR ${pr.utrNumber ?? "—"}): ${notes}`);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to reject payment");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/payment-requests/:id/approve-custom", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [existing] = await db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.id, id)).limit(1);
    if (!existing) return res.status(404).json({ error: "Not found" });
    // Only used to pick a sensible default for `days` below — the actual pending→approved
    // transition is still an atomic compare-and-swap a few lines down, so a race here
    // can't cause a double-approval, only (at worst) a slightly stale default.
    const days = parsePositiveInt(req.body.days ?? existing.durationDays ?? 31);
    if (days === null) return res.status(400).json({ error: "days must be a positive whole number" });
    const notes = req.body.notes ?? null;
    const pr = await claimPendingPaymentRequest(id, { status: "approved", processedAt: new Date(), notes });
    if (!pr) return await paymentRequestConflictResponse(res, id);
    if (pr.userId) {
      const [user] = await db.select().from(usersTable).where(eq(usersTable.id, pr.userId)).limit(1);
      const base = user?.subscriptionEndsAt && new Date(user.subscriptionEndsAt) > new Date()
        ? new Date(user.subscriptionEndsAt) : new Date();
      const subscriptionEndsAt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
      await db.update(usersTable).set({ plan: "active", subscriptionEndsAt }).where(eq(usersTable.id, pr.userId));
    }
    await logAdminAction(req, "approve_payment", pr.userId, pr.userNameSnapshot ?? pr.userEmailSnapshot, `Approved ₹${pr.amount}${pr.planId ? ` (${pr.planId})` : ""} for ${days} days (UTR ${pr.utrNumber ?? "—"})${notes ? ` — ${notes}` : ""}`);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to approve payment");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/users/:id/plan", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { action, days } = req.body as { action: string; days?: number };
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!user || user.role === "admin") return res.status(404).json({ error: "User not found" });
    const updateData: Record<string, unknown> = {};
    let detail: string;
    if (action === "activate") {
      const n = parsePositiveInt(days ?? 30);
      if (n === null) return res.status(400).json({ error: "days must be a positive whole number" });
      const base = user.subscriptionEndsAt && new Date(user.subscriptionEndsAt) > new Date()
        ? new Date(user.subscriptionEndsAt) : new Date();
      updateData.plan = "active";
      updateData.subscriptionEndsAt = new Date(base.getTime() + n * 24 * 60 * 60 * 1000);
      detail = `Activated / extended subscription by ${n} days`;
    } else if (action === "extend_trial") {
      const n = parsePositiveInt(days ?? 7);
      if (n === null) return res.status(400).json({ error: "days must be a positive whole number" });
      updateData.plan = "trial";
      updateData.trialEndsAt = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
      detail = `Extended trial by ${n} days`;
    } else if (action === "expire") {
      updateData.plan = "expired";
      updateData.subscriptionEndsAt = new Date();
      detail = "Expired account";
    } else {
      return res.status(400).json({ error: "Invalid action. Use: activate, extend_trial, expire" });
    }
    await db.update(usersTable).set(updateData).where(eq(usersTable.id, id));
    await logAdminAction(req, "plan_change", id, `${user.name} (${user.email})`, detail);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to update user plan");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Edits a tenant's basic account details. Email is the login credential, so changes here
// are logged with the old value in the activity log for accountability, and it's checked
// for both valid format and uniqueness before being written.
router.patch("/users/:id/details", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!user || user.role === "admin") return res.status(404).json({ error: "User not found" });

    const updateData: Record<string, unknown> = {};
    const changes: string[] = [];

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: "Name cannot be empty" });
      if (name !== user.name) { updateData.name = name; changes.push(`name: "${user.name}" → "${name}"`); }
    }
    if (req.body.shopName !== undefined) {
      const shopName = String(req.body.shopName).trim();
      if (!shopName) return res.status(400).json({ error: "Shop name cannot be empty" });
      if (shopName !== user.shopName) { updateData.shopName = shopName; changes.push(`shop: "${user.shopName}" → "${shopName}"`); }
    }
    if (req.body.mobile !== undefined) {
      const mobile = req.body.mobile ? String(req.body.mobile).trim() : null;
      if (mobile !== user.mobile) { updateData.mobile = mobile; changes.push(`mobile: "${user.mobile ?? "—"}" → "${mobile ?? "—"}"`); }
    }
    if (req.body.email !== undefined) {
      const email = String(req.body.email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Invalid email address" });
      if (email !== user.email) {
        const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
        if (existing) return res.status(409).json({ error: "Another account already uses this email" });
        updateData.email = email;
        changes.push(`email: "${user.email}" → "${email}"`);
      }
    }

    if (Object.keys(updateData).length === 0) return res.json({ success: true });

    await db.update(usersTable).set(updateData).where(eq(usersTable.id, id));
    await logAdminAction(req, "edit_details", id, `${user.name} (${user.email})`, changes.join("; "));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to update user details");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Resets a user's password. Passwords are one-way bcrypt hashes — there is no way to
// "view" an existing one, so this either accepts an admin-chosen password or generates a
// random temporary one, and returns it exactly once so the admin can relay it to the user.
// It is never persisted or logged in plaintext.
router.patch("/users/:id/reset-password", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });
    const custom = typeof req.body?.newPassword === "string" ? req.body.newPassword.trim() : "";
    if (custom && custom.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
    const newPassword = custom || generateTempPassword();
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, id));
    await logAdminAction(req, "reset_password", id, `${user.name} (${user.email})`, custom ? "Set a new password" : "Generated a temporary password");
    res.json({ success: true, newPassword });
  } catch (err) {
    req.log.error({ err }, "Failed to reset password");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/users/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (!user || user.role === "admin") return res.status(404).json({ error: "User not found" });
    // Payment history is intentionally left alone — the FK is ON DELETE SET NULL and each
    // row already carries a snapshot of the user's identity, so revenue/MRR figures stay
    // accurate after the account is gone. Only the user record itself is removed.
    await db.delete(usersTable).where(eq(usersTable.id, id));
    await logAdminAction(req, "delete_user", null, `${user.name} (${user.email})`, `Deleted user account (${user.shopName})`);
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Failed to delete user");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/revenue", async (req, res) => {
  try {
    const approved = await db.select().from(paymentRequestsTable)
      .where(eq(paymentRequestsTable.status, "approved"))
      .orderBy(desc(paymentRequestsTable.processedAt));
    const totalRevenue = approved.reduce((a, p) => a + p.amount, 0);
    const byMonth: Record<string, number> = {};
    approved.forEach(p => {
      if (!p.processedAt) return;
      const key = new Date(p.processedAt).toISOString().slice(0, 7);
      byMonth[key] = (byMonth[key] ?? 0) + p.amount;
    });
    const monthly = Object.entries(byMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)
      .map(([month, revenue]) => ({ month, revenue }));
    const thisMonth = new Date().toISOString().slice(0, 7);
    const mrr = byMonth[thisMonth] ?? 0;
    res.json({ totalRevenue, approvedCount: approved.length, mrr, monthly });
  } catch (err) {
    req.log.error({ err }, "Failed to get revenue");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/stats", async (req, res) => {
  try {
    const users = await db.select().from(usersTable).where(eq(usersTable.role, "user"));
    const pendingPayments = await db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.status, "pending"));
    const now = new Date();
    const trialUsers = users.filter(u => u.plan === "trial" && new Date(u.trialEndsAt) > now);
    const activeUsers = users.filter(u => u.plan === "active" && (!u.subscriptionEndsAt || new Date(u.subscriptionEndsAt) > now));
    const expiredUsers = users.filter(u =>
      u.plan === "expired" ||
      (u.plan === "trial" && new Date(u.trialEndsAt) <= now) ||
      (u.plan === "active" && !!u.subscriptionEndsAt && new Date(u.subscriptionEndsAt) <= now)
    );
    res.json({
      totalUsers: users.length,
      trialUsers: trialUsers.length,
      activeUsers: activeUsers.length,
      expiredUsers: expiredUsers.length,
      pendingPayments: pendingPayments.length,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get admin stats");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/expiring-soon", async (req, res) => {
  try {
    const now = new Date();
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const users = await db.select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      shopName: usersTable.shopName,
      mobile: usersTable.mobile,
      plan: usersTable.plan,
      trialEndsAt: usersTable.trialEndsAt,
      subscriptionEndsAt: usersTable.subscriptionEndsAt,
    }).from(usersTable).where(eq(usersTable.role, "user"));

    const expiring = users.filter(u => {
      if (u.plan === "trial") {
        const d = new Date(u.trialEndsAt);
        return d > now && d <= in7Days;
      }
      if (u.plan === "active" && u.subscriptionEndsAt) {
        const d = new Date(u.subscriptionEndsAt);
        return d > now && d <= in7Days;
      }
      return false;
    });
    res.json(expiring);
  } catch (err) {
    req.log.error({ err }, "Failed to get expiring users");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Admin activity log ──────────────────────────────────────────────────────

router.get("/activity-log", async (req, res) => {
  try {
    const requested = parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 500) : 100;
    const rows = await db.select().from(adminActivityLogTable).orderBy(desc(adminActivityLogTable.createdAt)).limit(limit);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to get activity log");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Per-user admin notes (CRM-lite: renewal follow-ups, support context) ────

router.get("/users/:id/notes", async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const notes = await db.select().from(userNotesTable).where(eq(userNotesTable.userId, userId)).orderBy(desc(userNotesTable.createdAt));
    res.json(notes);
  } catch (err) {
    req.log.error({ err }, "Failed to get user notes");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/users/:id/notes", async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const note = typeof req.body.note === "string" ? req.body.note.trim() : "";
    if (!note) return res.status(400).json({ error: "note is required" });
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });
    const [created] = await db.insert(userNotesTable).values({
      userId,
      adminId: req.user!.userId,
      adminEmailSnapshot: req.user!.email,
      note,
    }).returning();
    res.status(201).json(created);
  } catch (err) {
    req.log.error({ err }, "Failed to add user note");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
