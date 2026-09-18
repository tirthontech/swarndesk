import { Router } from "express";
import { db } from "@workspace/db";
import { karigarsTable, metalIssuesTable, metalReturnsTable, karigarPaymentTransactionsTable } from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";
import { postJournalEntry, getOrCreateDefaultAccounts, resolveMoneyAccountId, isValidBankAccount, safeFloat } from "./accounting-helpers";

const router = Router();

function mapTransaction(t: typeof karigarPaymentTransactionsTable.$inferSelect) {
  return {
    id: t.id,
    karigarId: t.karigarId,
    karigarName: t.karigarName,
    amount: safeFloat(t.amount),
    paymentMode: t.paymentMode,
    bankAccountId: t.bankAccountId,
    paidAt: t.paidAt.toISOString(),
    notes: t.notes,
  };
}

function mapKarigar(k: typeof karigarsTable.$inferSelect) {
  return {
    id: k.id,
    name: k.name,
    mobile: k.mobile,
    specialization: k.specialization,
    address: k.address,
    pendingGoldWeight: parseFloat(k.pendingGoldWeight),
    pendingSilverWeight: parseFloat(k.pendingSilverWeight),
    pendingOrders: k.pendingOrders,
    totalWagesPaid: parseFloat(k.totalWagesPaid),
    openingBalance: safeFloat(k.openingBalance),
    openingBalanceType: k.openingBalanceType,
    createdAt: k.createdAt.toISOString(),
  };
}

function mapIssue(i: typeof metalIssuesTable.$inferSelect) {
  return {
    id: i.id,
    karigarId: i.karigarId,
    metalType: i.metalType,
    weight: parseFloat(i.weight),
    purity: i.purity,
    issueDate: i.issueDate.toISOString(),
    notes: i.notes,
    voidedAt: i.voidedAt ? i.voidedAt.toISOString() : null,
  };
}

function mapReturn(r: typeof metalReturnsTable.$inferSelect) {
  return {
    id: r.id,
    karigarId: r.karigarId,
    metalType: r.metalType,
    issuedWeight: parseFloat(r.issuedWeight),
    returnedWeight: parseFloat(r.returnedWeight),
    wastagePercent: parseFloat(r.wastagePercent),
    returnDate: r.returnDate.toISOString(),
    notes: r.notes,
    voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
  };
}

router.get("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const karigars = await db.select().from(karigarsTable).where(eq(karigarsTable.userId, userId));
    res.json(karigars.map(mapKarigar));
  } catch (err) {
    req.log.error({ err }, "Failed to list karigars");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const data = req.body;
    if (!data.name?.trim()) return res.status(400).json({ error: "Name is required" });
    if (!data.mobile?.trim()) return res.status(400).json({ error: "Mobile is required" });
    if (!data.specialization?.trim()) return res.status(400).json({ error: "Specialization is required" });
    const [karigar] = await db.insert(karigarsTable).values({
      userId,
      name: String(data.name).trim(),
      mobile: String(data.mobile).trim(),
      specialization: String(data.specialization).trim(),
      address: data.address ? String(data.address).trim() || null : null,
      openingBalance: safeFloat(data.openingBalance, 0).toString(),
      openingBalanceType: data.openingBalanceType === "debit" ? "debit" : "credit",
    }).returning();
    res.status(201).json(mapKarigar(karigar));
  } catch (err) {
    req.log.error({ err }, "Failed to create karigar");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    const [karigar] = await db.select().from(karigarsTable).where(and(eq(karigarsTable.id, id), eq(karigarsTable.userId, userId)));
    if (!karigar) return res.status(404).json({ error: "Not found" });
    const issues = await db.select().from(metalIssuesTable).where(and(eq(metalIssuesTable.karigarId, id), eq(metalIssuesTable.userId, userId)));
    const returns = await db.select().from(metalReturnsTable).where(and(eq(metalReturnsTable.karigarId, id), eq(metalReturnsTable.userId, userId)));
    res.json({
      karigar: mapKarigar(karigar),
      metalIssues: issues.map(mapIssue),
      metalReturns: returns.map(mapReturn),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get karigar");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const data = req.body;
    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.mobile !== undefined) updateData.mobile = data.mobile;
    if (data.specialization !== undefined) updateData.specialization = data.specialization;
    if (data.address !== undefined) updateData.address = data.address;
    if (data.openingBalance !== undefined) updateData.openingBalance = safeFloat(data.openingBalance, 0).toString();
    if (data.openingBalanceType !== undefined) updateData.openingBalanceType = data.openingBalanceType === "debit" ? "debit" : "credit";
    const [karigar] = await db.update(karigarsTable).set(updateData).where(and(eq(karigarsTable.id, parseInt(req.params.id)), eq(karigarsTable.userId, userId))).returning();
    if (!karigar) return res.status(404).json({ error: "Not found" });
    res.json(mapKarigar(karigar));
  } catch (err) {
    req.log.error({ err }, "Failed to update karigar");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:id/issue-metal", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const karigarId = parseInt(req.params.id);
    if (isNaN(karigarId)) return res.status(400).json({ error: "Invalid id" });
    const data = req.body;

    const weight = parseFloat(String(data.weight));
    if (!isFinite(weight) || weight <= 0) return res.status(400).json({ error: "Weight must be a positive number" });
    if (!["gold", "silver"].includes(data.metalType)) return res.status(400).json({ error: "Invalid metal type" });

    // Verify karigar belongs to this user before writing any records
    const [karigar] = await db.select({ id: karigarsTable.id })
      .from(karigarsTable)
      .where(and(eq(karigarsTable.id, karigarId), eq(karigarsTable.userId, userId)));
    if (!karigar) return res.status(404).json({ error: "Karigar not found" });

    const issue = await db.transaction(async (tx) => {
      const [newIssue] = await tx.insert(metalIssuesTable).values({
        userId,
        karigarId,
        metalType: data.metalType,
        weight: weight.toString(),
        purity: data.purity ? String(data.purity).trim() || "22K" : "22K",
        notes: data.notes ? String(data.notes).trim() || null : null,
      }).returning();

      // Atomically increment pending weight — avoids read-modify-write race under concurrent
      // requests; wrapped with the insert above so a crash can't leave the ledger row and the
      // running balance out of sync with each other.
      if (data.metalType === "gold") {
        await tx.execute(sql`UPDATE karigars SET pending_gold_weight = pending_gold_weight + ${weight}::numeric WHERE id = ${karigarId} AND user_id = ${userId}`);
      } else {
        await tx.execute(sql`UPDATE karigars SET pending_silver_weight = pending_silver_weight + ${weight}::numeric WHERE id = ${karigarId} AND user_id = ${userId}`);
      }

      return newIssue;
    });

    res.status(201).json(mapIssue(issue));
  } catch (err) {
    req.log.error({ err }, "Failed to issue metal");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:id/return-metal", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const karigarId = parseInt(req.params.id);
    if (isNaN(karigarId)) return res.status(400).json({ error: "Invalid id" });
    const data = req.body;

    const issuedWeight = parseFloat(String(data.issuedWeight));
    const returnedWeight = parseFloat(String(data.returnedWeight));
    const wastagePercent = parseFloat(String(data.wastagePercent ?? 0));
    if (!isFinite(issuedWeight) || issuedWeight <= 0) return res.status(400).json({ error: "Issued weight must be a positive number" });
    if (!isFinite(returnedWeight) || returnedWeight < 0) return res.status(400).json({ error: "Returned weight cannot be negative" });
    if (returnedWeight > issuedWeight) return res.status(400).json({ error: "Returned weight cannot exceed issued weight" });
    if (!["gold", "silver"].includes(data.metalType)) return res.status(400).json({ error: "Invalid metal type" });

    // Verify karigar belongs to this user before writing any records
    const [karigar] = await db.select({ id: karigarsTable.id })
      .from(karigarsTable)
      .where(and(eq(karigarsTable.id, karigarId), eq(karigarsTable.userId, userId)));
    if (!karigar) return res.status(404).json({ error: "Karigar not found" });

    const ret = await db.transaction(async (tx) => {
      const [newReturn] = await tx.insert(metalReturnsTable).values({
        userId,
        karigarId,
        metalType: data.metalType,
        issuedWeight: issuedWeight.toString(),
        returnedWeight: returnedWeight.toString(),
        wastagePercent: (isFinite(wastagePercent) ? wastagePercent : 0).toString(),
        notes: data.notes ? String(data.notes).trim() || null : null,
      }).returning();

      // Atomically decrement pending weight by the full issued amount (job fully settled:
      // returned + wastage) — wrapped with the insert so a crash can't desync the ledger.
      if (data.metalType === "gold") {
        await tx.execute(sql`UPDATE karigars SET pending_gold_weight = GREATEST(0, pending_gold_weight - ${issuedWeight}::numeric) WHERE id = ${karigarId} AND user_id = ${userId}`);
      } else {
        await tx.execute(sql`UPDATE karigars SET pending_silver_weight = GREATEST(0, pending_silver_weight - ${issuedWeight}::numeric) WHERE id = ${karigarId} AND user_id = ${userId}`);
      }

      return newReturn;
    });

    res.status(201).json(mapReturn(ret));
  } catch (err) {
    req.log.error({ err }, "Failed to return metal");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/issues/:issueId/void — reverse a mistaken metal-issue entry (weight adjustment
// only; the log row is kept and flagged, not deleted, for an auditable correction trail).
router.post("/:id/issues/:issueId/void", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const karigarId = parseInt(req.params.id);
    const issueId = parseInt(req.params.issueId);
    if (isNaN(karigarId) || isNaN(issueId)) return res.status(400).json({ error: "Invalid id" });

    const [issue] = await db.select().from(metalIssuesTable)
      .where(and(eq(metalIssuesTable.id, issueId), eq(metalIssuesTable.karigarId, karigarId), eq(metalIssuesTable.userId, userId)));
    if (!issue) return res.status(404).json({ error: "Not found" });
    if (issue.voidedAt) return res.status(400).json({ error: "Already voided" });

    const weight = safeFloat(issue.weight);
    await db.transaction(async (tx) => {
      await tx.update(metalIssuesTable).set({ voidedAt: new Date() })
        .where(and(eq(metalIssuesTable.id, issueId), eq(metalIssuesTable.userId, userId)));
      const column = issue.metalType === "gold" ? "pending_gold_weight" : "pending_silver_weight";
      await tx.execute(sql`UPDATE karigars SET ${sql.raw(column)} = GREATEST(0, ${sql.raw(column)} - ${weight}::numeric) WHERE id = ${karigarId} AND user_id = ${userId}`);
    });

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to void metal issue");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/returns/:returnId/void — reverse a mistaken metal-return entry.
router.post("/:id/returns/:returnId/void", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const karigarId = parseInt(req.params.id);
    const returnId = parseInt(req.params.returnId);
    if (isNaN(karigarId) || isNaN(returnId)) return res.status(400).json({ error: "Invalid id" });

    const [ret] = await db.select().from(metalReturnsTable)
      .where(and(eq(metalReturnsTable.id, returnId), eq(metalReturnsTable.karigarId, karigarId), eq(metalReturnsTable.userId, userId)));
    if (!ret) return res.status(404).json({ error: "Not found" });
    if (ret.voidedAt) return res.status(400).json({ error: "Already voided" });

    const issuedWeight = safeFloat(ret.issuedWeight);
    await db.transaction(async (tx) => {
      await tx.update(metalReturnsTable).set({ voidedAt: new Date() })
        .where(and(eq(metalReturnsTable.id, returnId), eq(metalReturnsTable.userId, userId)));
      // The return had decremented pending weight by the full issued amount — voiding it
      // puts that weight back into the karigar's pending balance.
      const column = ret.metalType === "gold" ? "pending_gold_weight" : "pending_silver_weight";
      await tx.execute(sql`UPDATE karigars SET ${sql.raw(column)} = ${sql.raw(column)} + ${issuedWeight}::numeric WHERE id = ${karigarId} AND user_id = ${userId}`);
    });

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to void metal return");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id/payments — wage payment history for a karigar
router.get("/:id/payments", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const txns = await db.select().from(karigarPaymentTransactionsTable)
      .where(and(eq(karigarPaymentTransactionsTable.karigarId, id), eq(karigarPaymentTransactionsTable.userId, userId)))
      .orderBy(desc(karigarPaymentTransactionsTable.paidAt));
    res.json(txns.map(mapTransaction));
  } catch (err) {
    req.log.error({ err }, "Failed to get karigar payment history");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/payments — pay a karigar's wages
router.post("/:id/payments", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const amount = safeFloat(req.body.amount);
    if (!isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Invalid payment amount" });
    const allowedModes = ["cash", "upi", "card", "bank"];
    const paymentMode = allowedModes.includes(req.body.paymentMode) ? req.body.paymentMode : "cash";
    const notes = req.body.notes ? String(req.body.notes).slice(0, 500) : null;
    const bankAccountId = req.body.bankAccountId ? parseInt(req.body.bankAccountId) : null;
    if (bankAccountId && !(await isValidBankAccount(userId, bankAccountId))) {
      return res.status(400).json({ error: "Invalid bank account" });
    }

    const accts = await getOrCreateDefaultAccounts(userId);

    const karigar = await db.transaction(async (tx) => {
      const [k] = await tx.select().from(karigarsTable)
        .where(and(eq(karigarsTable.id, id), eq(karigarsTable.userId, userId)));
      if (!k) throw Object.assign(new Error("Karigar not found"), { statusCode: 404 });

      await tx.insert(karigarPaymentTransactionsTable).values({
        userId,
        karigarId: id,
        karigarName: k.name,
        amount: amount.toString(),
        paymentMode,
        bankAccountId,
        notes,
      });

      const [updated] = await tx.update(karigarsTable)
        .set({ totalWagesPaid: sql`${karigarsTable.totalWagesPaid} + ${amount.toFixed(2)}::numeric` })
        .where(and(eq(karigarsTable.id, id), eq(karigarsTable.userId, userId)))
        .returning();

      await postJournalEntry(tx, {
        userId,
        voucherType: "payment",
        narration: `Wage payment to ${k.name}`,
        sourceModule: "karigars",
        sourceId: id,
        lines: [
          { accountId: accts.KARIGAR_WAGES_EXPENSE, debit: amount, partyType: "karigar", partyId: id, particulars: "Wages paid" },
          { accountId: await resolveMoneyAccountId(userId, paymentMode, bankAccountId, accts, tx), credit: amount, particulars: "Payment made" },
        ],
      });

      return updated;
    });

    res.status(201).json(mapKarigar(karigar));
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 404) return res.status(404).json({ error: e.message });
    req.log.error({ err }, "Failed to record karigar payment");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:id/payments/:paymentId — correct notes on a logged wage payment.
// Neither the amount nor the payment mode/bank account is editable here — they're already
// posted to the books (amount is reflected in totalWagesPaid, mode/bank decided which
// account the credit landed in). Changing either after the fact without reversing and
// reposting the journal entry would leave the payment list disagreeing with the books.
// Void and re-log the payment instead if it was recorded wrong.
router.patch("/:id/payments/:paymentId", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const karigarId = parseInt(req.params.id);
    const paymentId = parseInt(req.params.paymentId);
    if (isNaN(karigarId) || isNaN(paymentId)) return res.status(400).json({ error: "Invalid id" });

    const updateData: Record<string, unknown> = {};
    if (req.body.notes !== undefined) updateData.notes = req.body.notes ? String(req.body.notes).slice(0, 500) : null;

    const [updated] = await db.update(karigarPaymentTransactionsTable).set(updateData)
      .where(and(eq(karigarPaymentTransactionsTable.id, paymentId), eq(karigarPaymentTransactionsTable.karigarId, karigarId), eq(karigarPaymentTransactionsTable.userId, userId)))
      .returning();
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(mapTransaction(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update karigar payment");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const result = await db.delete(karigarsTable).where(and(eq(karigarsTable.id, id), eq(karigarsTable.userId, userId))).returning({ id: karigarsTable.id });
    if (result.length === 0) return res.status(404).json({ error: "Not found" });
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Failed to delete karigar");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
