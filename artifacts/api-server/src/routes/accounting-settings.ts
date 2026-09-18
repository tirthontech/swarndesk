import { Router } from "express";
import { db } from "@workspace/db";
import { accountingSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrCreateAccountingSettings, invalidateAccountingSettings } from "./accounting-helpers";

const router = Router();

function mapSettings(s: typeof accountingSettingsTable.$inferSelect) {
  return {
    financialYearStartMonth: s.financialYearStartMonth,
    journalPrefix: s.journalPrefix,
    receiptPrefix: s.receiptPrefix,
    paymentPrefix: s.paymentPrefix,
    booksLockedBefore: s.booksLockedBefore?.toISOString() ?? null,
    updatedAt: s.updatedAt.toISOString(),
  };
}

router.get("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const settings = await getOrCreateAccountingSettings(userId);
    res.json(mapSettings(settings));
  } catch (err) {
    req.log.error({ err }, "Failed to get accounting settings");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    await getOrCreateAccountingSettings(userId); // ensure a row exists
    const data = req.body;
    const updates: Partial<typeof accountingSettingsTable.$inferInsert> = { updatedAt: new Date() };

    if (data.financialYearStartMonth !== undefined) {
      const m = parseInt(data.financialYearStartMonth);
      if (isNaN(m) || m < 1 || m > 12) return res.status(400).json({ error: "financialYearStartMonth must be 1–12" });
      updates.financialYearStartMonth = m;
    }
    if (data.journalPrefix !== undefined) updates.journalPrefix = String(data.journalPrefix).trim().toUpperCase().slice(0, 10) || "JV";
    if (data.receiptPrefix !== undefined) updates.receiptPrefix = String(data.receiptPrefix).trim().toUpperCase().slice(0, 10) || "RCP";
    if (data.paymentPrefix !== undefined) updates.paymentPrefix = String(data.paymentPrefix).trim().toUpperCase().slice(0, 10) || "PMT";
    if (data.booksLockedBefore !== undefined) {
      if (!data.booksLockedBefore) {
        updates.booksLockedBefore = null;
      } else {
        const d = new Date(data.booksLockedBefore);
        if (isNaN(d.getTime())) return res.status(400).json({ error: "Invalid booksLockedBefore date" });
        updates.booksLockedBefore = d;
      }
    }

    invalidateAccountingSettings(userId);
    const [updated] = await db.update(accountingSettingsTable).set(updates)
      .where(eq(accountingSettingsTable.userId, userId))
      .returning();
    res.json(mapSettings(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update accounting settings");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
