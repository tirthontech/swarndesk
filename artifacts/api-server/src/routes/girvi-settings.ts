import { Router } from "express";
import { db } from "@workspace/db";
import { girviSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrCreateGirviSettings, invalidateGirviSettings, safeFloat, VALID_PERIODS } from "./girvi-helpers";

const router = Router();

function mapSettings(s: typeof girviSettingsTable.$inferSelect) {
  return {
    shopName: s.shopName,
    ownerName: s.ownerName,
    licenseNumber: s.licenseNumber,
    gstin: s.gstin,
    pan: s.pan,
    address: s.address,
    mobile: s.mobile,
    email: s.email,
    termsAndConditions: s.termsAndConditions,
    financialYearStartMonth: s.financialYearStartMonth,
    defaultInterestRate: safeFloat(s.defaultInterestRate),
    defaultInterestPeriod: s.defaultInterestPeriod,
    defaultPenaltyRate: safeFloat(s.defaultPenaltyRate),
    defaultLoanDurationDays: s.defaultLoanDurationDays,
    cashTransactionLimit: safeFloat(s.cashTransactionLimit),
    overdueGraceDays: s.overdueGraceDays,
    forfeitureNoticeDays: s.forfeitureNoticeDays,
    receiptPrefix: s.receiptPrefix,
    returnPrefix: s.returnPrefix,
    transferPrefix: s.transferPrefix,
    partialReleasePrefix: s.partialReleasePrefix,
    noticePrefix: s.noticePrefix,
    updatedAt: s.updatedAt.toISOString(),
  };
}

router.get("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const settings = await getOrCreateGirviSettings(userId);
    res.json(mapSettings(settings));
  } catch (err) {
    req.log.error({ err }, "Failed to get girvi settings");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    await getOrCreateGirviSettings(userId); // ensure a row exists
    const data = req.body;
    const updates: Partial<typeof girviSettingsTable.$inferInsert> = { updatedAt: new Date() };

    if (data.shopName !== undefined) updates.shopName = String(data.shopName).trim() || "SwarnDesk Jewellers";
    if (data.ownerName !== undefined) updates.ownerName = String(data.ownerName).trim() || null;
    if (data.licenseNumber !== undefined) updates.licenseNumber = String(data.licenseNumber).trim() || null;
    if (data.gstin !== undefined) updates.gstin = String(data.gstin).trim() || null;
    if (data.pan !== undefined) updates.pan = String(data.pan).trim().toUpperCase() || null;
    if (data.address !== undefined) updates.address = String(data.address).trim() || null;
    if (data.mobile !== undefined) updates.mobile = String(data.mobile).trim() || null;
    if (data.email !== undefined) updates.email = String(data.email).trim() || null;
    if (data.termsAndConditions !== undefined) updates.termsAndConditions = String(data.termsAndConditions).trim() || null;
    if (data.financialYearStartMonth !== undefined) {
      const m = parseInt(data.financialYearStartMonth);
      if (isNaN(m) || m < 1 || m > 12) return res.status(400).json({ error: "financialYearStartMonth must be 1–12" });
      updates.financialYearStartMonth = m;
    }
    // Bounds matching what a per-loan creation is held to (girvi.ts POST /) —
    // these values pre-fill every subsequent New Loan form, so an unbounded
    // typo here (e.g. "250" instead of "2.5") would silently become the
    // default rate offered on every loan going forward.
    if (data.defaultInterestRate !== undefined) {
      const r = safeFloat(data.defaultInterestRate, 2);
      if (r < 0 || r > 100) return res.status(400).json({ error: "Default interest rate must be 0–100" });
      updates.defaultInterestRate = r.toString();
    }
    if (data.defaultInterestPeriod !== undefined) {
      if (!VALID_PERIODS.has(data.defaultInterestPeriod)) return res.status(400).json({ error: "Invalid interest period" });
      updates.defaultInterestPeriod = data.defaultInterestPeriod;
    }
    if (data.defaultPenaltyRate !== undefined) {
      const pr = safeFloat(data.defaultPenaltyRate, 1);
      if (pr < 0 || pr > 100) return res.status(400).json({ error: "Default penalty rate must be 0–100" });
      updates.defaultPenaltyRate = pr.toString();
    }
    if (data.defaultLoanDurationDays !== undefined) {
      const d = parseInt(data.defaultLoanDurationDays);
      if (isNaN(d) || d <= 0) return res.status(400).json({ error: "defaultLoanDurationDays must be positive" });
      updates.defaultLoanDurationDays = d;
    }
    if (data.cashTransactionLimit !== undefined) {
      const cl = safeFloat(data.cashTransactionLimit, 200000);
      if (cl <= 0) return res.status(400).json({ error: "Cash transaction limit must be positive" });
      updates.cashTransactionLimit = cl.toString();
    }
    if (data.overdueGraceDays !== undefined) {
      const g = parseInt(data.overdueGraceDays);
      if (isNaN(g) || g < 0) return res.status(400).json({ error: "overdueGraceDays must be 0 or more" });
      updates.overdueGraceDays = g;
    }
    if (data.forfeitureNoticeDays !== undefined) {
      const n = parseInt(data.forfeitureNoticeDays);
      if (isNaN(n) || n < 0) return res.status(400).json({ error: "forfeitureNoticeDays must be 0 or more" });
      updates.forfeitureNoticeDays = n;
    }
    if (data.receiptPrefix !== undefined) updates.receiptPrefix = String(data.receiptPrefix).trim().toUpperCase() || "GRV";
    if (data.returnPrefix !== undefined) updates.returnPrefix = String(data.returnPrefix).trim().toUpperCase() || "RTN";
    if (data.transferPrefix !== undefined) updates.transferPrefix = String(data.transferPrefix).trim().toUpperCase() || "TRF";
    if (data.partialReleasePrefix !== undefined) updates.partialReleasePrefix = String(data.partialReleasePrefix).trim().toUpperCase() || "PRL";
    if (data.noticePrefix !== undefined) updates.noticePrefix = String(data.noticePrefix).trim().toUpperCase() || "NTC";

    invalidateGirviSettings(userId);
    const [updated] = await db.update(girviSettingsTable).set(updates)
      .where(eq(girviSettingsTable.userId, userId))
      .returning();
    res.json(mapSettings(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update girvi settings");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
