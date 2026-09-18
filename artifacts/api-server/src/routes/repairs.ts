import { Router } from "express";
import { db } from "@workspace/db";
import { repairJobsTable, karigarsTable, repairPaymentTransactionsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { postJournalEntry, getOrCreateDefaultAccounts, resolveMoneyAccountId, isValidBankAccount, safeFloat } from "./accounting-helpers";

const router = Router();

function mapTransaction(t: typeof repairPaymentTransactionsTable.$inferSelect) {
  return {
    id: t.id,
    repairJobId: t.repairJobId,
    customerId: t.customerId,
    customerName: t.customerName,
    amount: safeFloat(t.amount),
    paymentMode: t.paymentMode,
    bankAccountId: t.bankAccountId,
    paidAt: t.paidAt.toISOString(),
    notes: t.notes,
  };
}

// A repair only counts against a karigar's pending workload while it's assigned
// to them and not yet handed back (received/in_progress) — mirrors custom_orders'
// karigar_assigned/in_progress window.
function isActiveWithKarigar(karigarId: number | null, status: string): boolean {
  return !!karigarId && (status === "received" || status === "in_progress");
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function adjustPendingOrders(tx: Tx, userId: number, karigarId: number, delta: number) {
  await tx.execute(sql`UPDATE karigars SET pending_orders = GREATEST(0, pending_orders + ${delta}) WHERE id = ${karigarId} AND user_id = ${userId}`);
}

function mapRepair(r: typeof repairJobsTable.$inferSelect) {
  return {
    id: r.id,
    customerId: r.customerId,
    customerName: r.customerName,
    customerMobile: r.customerMobile,
    itemDescription: r.itemDescription,
    issue: r.issue,
    grossWeight: r.grossWeight ? parseFloat(r.grossWeight) : null,
    netWeight: r.netWeight ? parseFloat(r.netWeight) : null,
    estimatedCost: parseFloat(r.estimatedCost),
    actualCost: r.actualCost ? parseFloat(r.actualCost) : null,
    status: r.status,
    receivedDate: r.receivedDate.toISOString(),
    promisedDate: r.promisedDate.toISOString(),
    deliveredDate: r.deliveredDate ? r.deliveredDate.toISOString() : null,
    notes: r.notes,
    karigarId: r.karigarId,
    karigarName: r.karigarName,
    createdAt: r.createdAt.toISOString(),
  };
}

router.get("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { status } = req.query as Record<string, string>;
    const where = status
      ? and(eq(repairJobsTable.userId, userId), eq(repairJobsTable.status, status))
      : eq(repairJobsTable.userId, userId);
    const repairs = await db.select().from(repairJobsTable).where(where).orderBy(desc(repairJobsTable.promisedDate));
    res.json(repairs.map(mapRepair));
  } catch (err) {
    req.log.error({ err }, "Failed to list repairs");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const data = req.body;
    if (!data.customerName?.trim()) return res.status(400).json({ error: "Customer name is required" });
    if (!data.customerMobile?.trim()) return res.status(400).json({ error: "Customer mobile is required" });
    if (!data.itemDescription?.trim()) return res.status(400).json({ error: "Item description is required" });
    if (!data.issue?.trim()) return res.status(400).json({ error: "Issue description is required" });
    const estimatedCost = parseFloat(String(data.estimatedCost));
    if (!isFinite(estimatedCost) || estimatedCost < 0) return res.status(400).json({ error: "Valid estimated cost is required" });
    const promisedDate = new Date(data.promisedDate);
    if (isNaN(promisedDate.getTime())) return res.status(400).json({ error: "Valid promised date is required" });
    // Optional — defaults to now (item logged as received today) if not given, same as
    // before this was settable; lets a shop backdate a job entered a day or two late.
    let receivedDate: Date | undefined;
    if (data.receivedDate !== undefined && data.receivedDate !== null && data.receivedDate !== "") {
      receivedDate = new Date(data.receivedDate);
      if (isNaN(receivedDate.getTime())) return res.status(400).json({ error: "Invalid received date" });
    }

    let karigarId: number | null = null;
    let karigarName: string | null = null;
    if (data.karigarId != null) {
      const kid = parseInt(data.karigarId);
      const [karigar] = await db.select({ id: karigarsTable.id, name: karigarsTable.name })
        .from(karigarsTable).where(and(eq(karigarsTable.id, kid), eq(karigarsTable.userId, userId)));
      if (!karigar) return res.status(404).json({ error: "Karigar not found" });
      karigarId = kid;
      karigarName = karigar.name;
    }

    const repair = await db.transaction(async (tx) => {
      const [r] = await tx.insert(repairJobsTable).values({
        userId,
        customerId: data.customerId ?? null,
        customerName: data.customerName.trim(),
        customerMobile: data.customerMobile.trim(),
        itemDescription: data.itemDescription.trim(),
        issue: data.issue.trim(),
        grossWeight: data.grossWeight ? safeFloat(data.grossWeight).toString() : null,
        netWeight: data.netWeight ? safeFloat(data.netWeight).toString() : null,
        estimatedCost: estimatedCost.toString(),
        promisedDate,
        ...(receivedDate ? { receivedDate } : {}),
        notes: data.notes ? String(data.notes).slice(0, 500) || null : null,
        karigarId,
        karigarName,
      }).returning();

      if (isActiveWithKarigar(r.karigarId, r.status)) {
        await adjustPendingOrders(tx, userId, r.karigarId!, 1);
      }
      return r;
    });

    res.status(201).json(mapRepair(repair));
  } catch (err) {
    req.log.error({ err }, "Failed to create repair");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const [repair] = await db.select().from(repairJobsTable).where(and(eq(repairJobsTable.id, parseInt(req.params.id)), eq(repairJobsTable.userId, userId)));
    if (!repair) return res.status(404).json({ error: "Not found" });
    res.json(mapRepair(repair));
  } catch (err) {
    req.log.error({ err }, "Failed to get repair");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    const data = req.body;
    const VALID_STATUSES = ["received", "in_progress", "ready", "delivered"];

    const updateData: Record<string, unknown> = {};
    if (data.status !== undefined) {
      if (!VALID_STATUSES.includes(data.status)) return res.status(400).json({ error: "Invalid status value" });
      updateData.status = data.status;
    }
    if (data.actualCost !== undefined) updateData.actualCost = data.actualCost?.toString() ?? null;
    if (data.deliveredDate !== undefined) updateData.deliveredDate = data.deliveredDate ? new Date(data.deliveredDate) : null;
    if (data.notes !== undefined) updateData.notes = data.notes ? String(data.notes).slice(0, 500) : null;
    if (data.customerName !== undefined) updateData.customerName = String(data.customerName).trim();
    if (data.customerMobile !== undefined) updateData.customerMobile = String(data.customerMobile).trim();
    if (data.itemDescription !== undefined) updateData.itemDescription = String(data.itemDescription).trim();
    if (data.issue !== undefined) updateData.issue = String(data.issue).trim();
    if (data.grossWeight !== undefined) updateData.grossWeight = data.grossWeight ? safeFloat(data.grossWeight).toString() : null;
    if (data.netWeight !== undefined) updateData.netWeight = data.netWeight ? safeFloat(data.netWeight).toString() : null;
    if (data.estimatedCost !== undefined) updateData.estimatedCost = parseFloat(String(data.estimatedCost)).toString();
    if (data.promisedDate !== undefined) updateData.promisedDate = new Date(data.promisedDate);
    if (data.receivedDate !== undefined) updateData.receivedDate = new Date(data.receivedDate);

    if (data.karigarId !== undefined) {
      if (data.karigarId === null) {
        updateData.karigarId = null;
        updateData.karigarName = null;
      } else {
        const kid = parseInt(data.karigarId);
        const [karigar] = await db.select({ id: karigarsTable.id, name: karigarsTable.name })
          .from(karigarsTable).where(and(eq(karigarsTable.id, kid), eq(karigarsTable.userId, userId)));
        if (!karigar) return res.status(404).json({ error: "Karigar not found" });
        updateData.karigarId = kid;
        updateData.karigarName = karigar.name;
      }
    }

    const repair = await db.transaction(async (tx) => {
      // Locks the row for the duration of this transaction so two concurrent PATCHes to the
      // same repair can't both read the same pre-update status/karigar and double- or
      // under-count the karigar's pending-order balance.
      const [existing] = await tx.select().from(repairJobsTable)
        .where(and(eq(repairJobsTable.id, id), eq(repairJobsTable.userId, userId)))
        .for("update");
      if (!existing) return null;

      const newKarigarId = (data.karigarId !== undefined ? updateData.karigarId : existing.karigarId) as number | null;
      const newStatus = (updateData.status as string | undefined) ?? existing.status;
      const wasActive = isActiveWithKarigar(existing.karigarId, existing.status);
      const isActive = isActiveWithKarigar(newKarigarId, newStatus);

      const [r] = await tx.update(repairJobsTable).set(updateData).where(and(eq(repairJobsTable.id, id), eq(repairJobsTable.userId, userId))).returning();

      // Keep each karigar's pending-order count in sync with reassignment/status changes
      if (existing.karigarId === newKarigarId) {
        if (wasActive && !isActive) await adjustPendingOrders(tx, userId, existing.karigarId!, -1);
        else if (!wasActive && isActive) await adjustPendingOrders(tx, userId, newKarigarId!, 1);
      } else {
        if (wasActive) await adjustPendingOrders(tx, userId, existing.karigarId!, -1);
        if (isActive) await adjustPendingOrders(tx, userId, newKarigarId!, 1);
      }

      return r;
    });
    if (!repair) return res.status(404).json({ error: "Not found" });

    res.json(mapRepair(repair));
  } catch (err) {
    req.log.error({ err }, "Failed to update repair");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id/payments — payment history for a repair job
router.get("/:id/payments", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const txns = await db.select().from(repairPaymentTransactionsTable)
      .where(and(eq(repairPaymentTransactionsTable.repairJobId, id), eq(repairPaymentTransactionsTable.userId, userId)))
      .orderBy(desc(repairPaymentTransactionsTable.paidAt));
    res.json(txns.map(mapTransaction));
  } catch (err) {
    req.log.error({ err }, "Failed to get repair payment history");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/payments — collect a payment against a repair job (advance at drop-off, final at delivery)
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

    const repair = await db.transaction(async (tx) => {
      const [job] = await tx.select().from(repairJobsTable)
        .where(and(eq(repairJobsTable.id, id), eq(repairJobsTable.userId, userId)));
      if (!job) throw Object.assign(new Error("Repair job not found"), { statusCode: 404 });

      await tx.insert(repairPaymentTransactionsTable).values({
        userId,
        repairJobId: id,
        customerId: job.customerId,
        customerName: job.customerName,
        amount: amount.toString(),
        paymentMode,
        bankAccountId,
        notes,
      });

      await postJournalEntry(tx, {
        userId,
        voucherType: "receipt",
        narration: `Payment received for repair #${id} (${job.itemDescription})`,
        sourceModule: "repairs",
        sourceId: id,
        lines: [
          { accountId: await resolveMoneyAccountId(userId, paymentMode, bankAccountId, accts, tx), debit: amount, particulars: "Payment received" },
          { accountId: accts.REPAIR_INCOME, credit: amount, particulars: "Repair income" },
        ],
      });

      return job;
    });

    res.status(201).json(mapRepair(repair));
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 404) return res.status(404).json({ error: e.message });
    req.log.error({ err }, "Failed to record repair payment");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const deleted = await db.transaction(async (tx) => {
      const [d] = await tx.delete(repairJobsTable)
        .where(and(eq(repairJobsTable.id, parseInt(req.params.id)), eq(repairJobsTable.userId, userId)))
        .returning();
      if (d && isActiveWithKarigar(d.karigarId, d.status)) {
        await adjustPendingOrders(tx, userId, d.karigarId!, -1);
      }
      return d;
    });
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete repair");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
