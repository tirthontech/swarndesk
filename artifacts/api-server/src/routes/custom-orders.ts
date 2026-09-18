import { Router } from "express";
import { db } from "@workspace/db";
import { customOrdersTable, customOrderPaymentTransactionsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { postJournalEntry, getOrCreateDefaultAccounts, resolveMoneyAccountId, isValidBankAccount, safeFloat, nextVoucherNumber, type DefaultAccountKey } from "./accounting-helpers";

const router = Router();

function mapTransaction(t: typeof customOrderPaymentTransactionsTable.$inferSelect) {
  return {
    id: t.id,
    customOrderId: t.customOrderId,
    customerId: t.customerId,
    customerName: t.customerName,
    amount: safeFloat(t.amount),
    paymentMode: t.paymentMode,
    bankAccountId: t.bankAccountId,
    paidAt: t.paidAt.toISOString(),
    notes: t.notes,
  };
}

// Records a payment transaction row and posts the matching journal entry — the single path
// every money-collecting flow below goes through (initial advance at booking, a top-up via
// general edit, and the extra collected at delivery), so none of them can silently skip the
// books the way a bare `advancePaid` field update used to.
async function postCustomOrderPayment(
  tx: Tx, userId: number, order: { id: number; orderNumber: string; customerId: number | null; customerName: string },
  amount: number, paymentMode: string, bankAccountId: number | null, notes: string | null,
  accts: Record<DefaultAccountKey, number>,
) {
  await tx.insert(customOrderPaymentTransactionsTable).values({
    userId,
    customOrderId: order.id,
    customerId: order.customerId,
    customerName: order.customerName,
    amount: amount.toString(),
    paymentMode,
    bankAccountId,
    notes,
  });
  await postJournalEntry(tx, {
    userId,
    voucherType: "receipt",
    narration: `Payment received for custom order ${order.orderNumber}`,
    sourceModule: "custom_orders",
    sourceId: order.id,
    lines: [
      { accountId: await resolveMoneyAccountId(userId, paymentMode, bankAccountId, accts, tx), debit: amount, particulars: "Payment received" },
      { accountId: accts.CUSTOM_ORDER_INCOME, credit: amount, particulars: "Custom order income" },
    ],
  });
}

const VALID_STATUSES = ["pending", "karigar_assigned", "in_progress", "karigar_returned", "ready", "delivered", "cancelled"];

// An order only counts against a karigar's pending workload while it's assigned to
// them and still in their hands (not yet returned/ready/delivered/cancelled).
function isActiveWithKarigar(karigarId: number | null, status: string): boolean {
  return !!karigarId && (status === "karigar_assigned" || status === "in_progress");
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function adjustPendingOrders(tx: Tx, userId: number, karigarId: number, delta: number) {
  await tx.execute(sql`UPDATE karigars SET pending_orders = GREATEST(0, pending_orders + ${delta}) WHERE id = ${karigarId} AND user_id = ${userId}`);
}

function mapOrder(r: typeof customOrdersTable.$inferSelect) {
  return {
    id: r.id,
    orderNumber: r.orderNumber,
    customerId: r.customerId,
    customerName: r.customerName,
    customerMobile: r.customerMobile,
    itemType: r.itemType,
    description: r.description,
    metalType: r.metalType,
    purity: r.purity,
    targetWeight: r.targetWeight ? parseFloat(r.targetWeight) : null,
    estimatedPrice: r.estimatedPrice ? parseFloat(r.estimatedPrice) : null,
    agreedPrice: r.agreedPrice ? parseFloat(r.agreedPrice) : null,
    bookingMetalRate: r.bookingMetalRate ? parseFloat(r.bookingMetalRate) : null,
    advancePaid: parseFloat(r.advancePaid ?? "0"),
    status: r.status,
    karigarId: r.karigarId,
    karigarName: r.karigarName,
    metalIssuedWeight: r.metalIssuedWeight ? parseFloat(r.metalIssuedWeight) : null,
    metalIssuedDate: r.metalIssuedDate ? r.metalIssuedDate.toISOString() : null,
    finishedWeight: r.finishedWeight ? parseFloat(r.finishedWeight) : null,
    wastageWeight: r.wastageWeight ? parseFloat(r.wastageWeight) : null,
    karigarReturnDate: r.karigarReturnDate ? r.karigarReturnDate.toISOString() : null,
    karigarWages: r.karigarWages ? parseFloat(r.karigarWages) : null,
    karigarNotes: r.karigarNotes,
    orderDate: r.orderDate.toISOString(),
    dueDate: r.dueDate.toISOString(),
    deliveryDate: r.deliveryDate ? r.deliveryDate.toISOString() : null,
    finalPrice: r.finalPrice ? parseFloat(r.finalPrice) : null,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
  };
}

// GET / — list all custom orders (optional ?status=)
router.get("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { status } = req.query as Record<string, string>;
    const where = status && VALID_STATUSES.includes(status)
      ? and(eq(customOrdersTable.userId, userId), eq(customOrdersTable.status, status))
      : eq(customOrdersTable.userId, userId);
    const orders = await db.select().from(customOrdersTable).where(where).orderBy(desc(customOrdersTable.createdAt));
    res.json(orders.map(mapOrder));
  } catch (err) {
    req.log.error({ err }, "Failed to list custom orders");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST / — create custom order
router.post("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const d = req.body;
    if (!d.customerName?.trim()) return res.status(400).json({ error: "Customer name required" });
    if (!d.customerMobile?.trim()) return res.status(400).json({ error: "Mobile required" });
    if (!d.itemType?.trim()) return res.status(400).json({ error: "Item type required" });
    if (!d.metalType?.trim()) return res.status(400).json({ error: "Metal type required" });
    if (!d.purity?.trim()) return res.status(400).json({ error: "Purity required" });
    if (!d.dueDate) return res.status(400).json({ error: "Due date required" });
    const dueDate = new Date(d.dueDate);
    if (isNaN(dueDate.getTime())) return res.status(400).json({ error: "Invalid due date" });

    // Optional — defaults to now (order logged as booked today) if not given, same as
    // before this was settable; lets a shop backdate an order entered a day or two late.
    let orderDate: Date | undefined;
    if (d.orderDate !== undefined && d.orderDate !== null && d.orderDate !== "") {
      orderDate = new Date(d.orderDate);
      if (isNaN(orderDate.getTime())) return res.status(400).json({ error: "Invalid order date" });
    }

    let advancePaid = 0;
    if (d.advancePaid != null) {
      advancePaid = safeFloat(d.advancePaid);
      if (!isFinite(advancePaid) || advancePaid < 0) return res.status(400).json({ error: "Advance paid cannot be negative" });
      const priceCap = d.agreedPrice != null ? safeFloat(d.agreedPrice) : d.estimatedPrice != null ? safeFloat(d.estimatedPrice) : null;
      if (priceCap != null && advancePaid > priceCap) return res.status(400).json({ error: "Advance paid cannot exceed the agreed/estimated price" });
    }
    const allowedModes = ["cash", "upi", "card", "bank"];
    const paymentMode = allowedModes.includes(d.paymentMode) ? d.paymentMode : "cash";
    const bankAccountId = d.bankAccountId ? parseInt(d.bankAccountId) : null;
    if (advancePaid > 0 && bankAccountId && !(await isValidBankAccount(userId, bankAccountId))) {
      return res.status(400).json({ error: "Invalid bank account" });
    }

    const orderNumber = await nextVoucherNumber(userId, "custom_order", "CO");
    const order = await db.transaction(async (tx) => {
      const [newOrder] = await tx.insert(customOrdersTable).values({
        userId,
        orderNumber,
        customerId: d.customerId ?? null,
        customerName: d.customerName.trim(),
        customerMobile: d.customerMobile.trim(),
        itemType: d.itemType.trim(),
        description: d.description?.trim() || null,
        metalType: d.metalType,
        purity: d.purity,
        targetWeight: d.targetWeight != null ? String(d.targetWeight) : null,
        estimatedPrice: d.estimatedPrice != null ? String(d.estimatedPrice) : null,
        agreedPrice: d.agreedPrice != null ? String(d.agreedPrice) : null,
        bookingMetalRate: d.bookingMetalRate != null ? String(d.bookingMetalRate) : null,
        advancePaid: advancePaid.toString(),
        ...(orderDate ? { orderDate } : {}),
        dueDate,
        notes: d.notes?.trim() || null,
      }).returning();

      // The advance collected at booking is real money in the till — it must hit the books
      // the same way a top-up or delivery-time collection does, not just sit in this row.
      if (advancePaid > 0) {
        const accts = await getOrCreateDefaultAccounts(userId, tx);
        await postCustomOrderPayment(tx, userId, newOrder, advancePaid, paymentMode, bankAccountId, "Advance collected at booking", accts);
      }

      return newOrder;
    });
    res.status(201).json(mapOrder(order));
  } catch (err) {
    req.log.error({ err }, "Failed to create custom order");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id — get single order
router.get("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const [order] = await db.select().from(customOrdersTable)
      .where(and(eq(customOrdersTable.id, parseInt(req.params.id)), eq(customOrdersTable.userId, userId)));
    if (!order) return res.status(404).json({ error: "Not found" });
    res.json(mapOrder(order));
  } catch (err) {
    req.log.error({ err }, "Failed to get custom order");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:id — general update (edit fields + status transitions)
router.patch("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const d = req.body;
    const update: Record<string, unknown> = {};

    // Basic fields
    if (d.customerName !== undefined) update.customerName = String(d.customerName).trim();
    if (d.customerMobile !== undefined) update.customerMobile = String(d.customerMobile).trim();
    if (d.itemType !== undefined) update.itemType = String(d.itemType).trim();
    if (d.description !== undefined) update.description = d.description?.trim() || null;
    if (d.metalType !== undefined) update.metalType = d.metalType;
    if (d.purity !== undefined) update.purity = d.purity;
    if (d.targetWeight !== undefined) update.targetWeight = d.targetWeight != null ? String(d.targetWeight) : null;
    if (d.estimatedPrice !== undefined) update.estimatedPrice = d.estimatedPrice != null ? String(d.estimatedPrice) : null;
    if (d.agreedPrice !== undefined) update.agreedPrice = d.agreedPrice != null ? String(d.agreedPrice) : null;
    if (d.bookingMetalRate !== undefined) update.bookingMetalRate = d.bookingMetalRate != null ? String(d.bookingMetalRate) : null;
    if (d.orderDate !== undefined) update.orderDate = new Date(d.orderDate);
    if (d.dueDate !== undefined) update.dueDate = new Date(d.dueDate);
    if (d.notes !== undefined) update.notes = d.notes?.trim() || null;

    // Status
    if (d.status !== undefined) {
      if (!VALID_STATUSES.includes(d.status)) return res.status(400).json({ error: "Invalid status" });
      update.status = d.status;
    }

    // Karigar assignment
    if (d.karigarId !== undefined) update.karigarId = d.karigarId;
    if (d.karigarName !== undefined) update.karigarName = d.karigarName;

    // Metal issued
    if (d.metalIssuedWeight !== undefined) update.metalIssuedWeight = d.metalIssuedWeight != null ? String(d.metalIssuedWeight) : null;
    if (d.metalIssuedDate !== undefined) update.metalIssuedDate = d.metalIssuedDate ? new Date(d.metalIssuedDate) : null;

    // Karigar return
    if (d.finishedWeight !== undefined) update.finishedWeight = d.finishedWeight != null ? String(d.finishedWeight) : null;
    if (d.wastageWeight !== undefined) update.wastageWeight = d.wastageWeight != null ? String(d.wastageWeight) : null;
    if (d.karigarReturnDate !== undefined) update.karigarReturnDate = d.karigarReturnDate ? new Date(d.karigarReturnDate) : null;
    if (d.karigarWages !== undefined) update.karigarWages = d.karigarWages != null ? String(d.karigarWages) : null;
    if (d.karigarNotes !== undefined) update.karigarNotes = d.karigarNotes?.trim() || null;

    // Delivery
    if (d.deliveryDate !== undefined) update.deliveryDate = d.deliveryDate ? new Date(d.deliveryDate) : null;
    if (d.finalPrice !== undefined) update.finalPrice = d.finalPrice != null ? String(d.finalPrice) : null;

    // Only relevant when advancePaid is being raised (see below) — a fresh payment mode/bank
    // account for whatever new money this edit represents.
    const allowedModes = ["cash", "upi", "card", "bank"];
    const paymentMode = allowedModes.includes(d.paymentMode) ? d.paymentMode : "cash";
    const bankAccountId = d.bankAccountId ? parseInt(d.bankAccountId) : null;
    if (bankAccountId && !(await isValidBankAccount(userId, bankAccountId))) {
      return res.status(400).json({ error: "Invalid bank account" });
    }

    const orderId = parseInt(req.params.id);
    const updated = await db.transaction(async (tx) => {
      // Locks the row for the duration of this transaction so two concurrent PATCHes to the
      // same order can't both read the same pre-update status/karigar and double- or
      // under-count the karigar's pending-order balance.
      const [existing] = await tx.select().from(customOrdersTable)
        .where(and(eq(customOrdersTable.id, orderId), eq(customOrdersTable.userId, userId)))
        .for("update");
      if (!existing) return null;

      // A higher advancePaid than before means real new money came in and must hit the
      // books, exactly like the booking-time advance and the dedicated /payments endpoint —
      // this is what used to let money collected through this edit form vanish silently.
      // A lower or unchanged value is treated as a correction (e.g. a typo), not a refund,
      // and posts nothing — there's no reliable way to tell those two apart from this field alone.
      let advanceDelta = 0;
      if (d.advancePaid !== undefined) {
        const advancePaid = safeFloat(d.advancePaid, 0);
        if (!isFinite(advancePaid) || advancePaid < 0) throw Object.assign(new Error("Advance paid cannot be negative"), { statusCode: 400 });
        const agreedPrice = d.agreedPrice !== undefined ? d.agreedPrice : existing.agreedPrice;
        const estimatedPrice = d.estimatedPrice !== undefined ? d.estimatedPrice : existing.estimatedPrice;
        const priceCap = agreedPrice != null ? safeFloat(agreedPrice) : estimatedPrice != null ? safeFloat(estimatedPrice) : null;
        if (priceCap != null && advancePaid > priceCap) throw Object.assign(new Error("Advance paid cannot exceed the agreed/estimated price"), { statusCode: 400 });
        update.advancePaid = advancePaid.toString();
        advanceDelta = Math.round((advancePaid - safeFloat(existing.advancePaid)) * 100) / 100;
      }

      const newKarigarId = (update.karigarId !== undefined ? update.karigarId : existing.karigarId) as number | null;
      const newStatus = (update.status as string | undefined) ?? existing.status;
      const wasActive = isActiveWithKarigar(existing.karigarId, existing.status);
      const isActive = isActiveWithKarigar(newKarigarId, newStatus);

      const [u] = await tx.update(customOrdersTable).set(update)
        .where(and(eq(customOrdersTable.id, orderId), eq(customOrdersTable.userId, userId)))
        .returning();

      if (advanceDelta > 0) {
        const accts = await getOrCreateDefaultAccounts(userId, tx);
        await postCustomOrderPayment(tx, userId, u, advanceDelta, paymentMode, bankAccountId, "Advance collected", accts);
      }

      // Keep each karigar's pending-order count in sync with reassignment/status changes
      if (existing.karigarId === newKarigarId) {
        if (wasActive && !isActive) await adjustPendingOrders(tx, userId, existing.karigarId!, -1);
        else if (!wasActive && isActive) await adjustPendingOrders(tx, userId, newKarigarId!, 1);
      } else {
        if (wasActive) await adjustPendingOrders(tx, userId, existing.karigarId!, -1);
        if (isActive) await adjustPendingOrders(tx, userId, newKarigarId!, 1);
      }

      return u;
    });
    if (!updated) return res.status(404).json({ error: "Not found" });

    res.json(mapOrder(updated));
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 400) return res.status(400).json({ error: e.message });
    req.log.error({ err }, "Failed to update custom order");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id/payments — payment history for a custom order
router.get("/:id/payments", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const txns = await db.select().from(customOrderPaymentTransactionsTable)
      .where(and(eq(customOrderPaymentTransactionsTable.customOrderId, id), eq(customOrderPaymentTransactionsTable.userId, userId)))
      .orderBy(desc(customOrderPaymentTransactionsTable.paidAt));
    res.json(txns.map(mapTransaction));
  } catch (err) {
    req.log.error({ err }, "Failed to get custom order payment history");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/payments — collect a payment against a custom order (advance at booking, top-ups, final on delivery)
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

    const updated = await db.transaction(async (tx) => {
      const [order] = await tx.select().from(customOrdersTable)
        .where(and(eq(customOrdersTable.id, id), eq(customOrdersTable.userId, userId)));
      if (!order) throw Object.assign(new Error("Custom order not found"), { statusCode: 404 });

      const newAdvancePaid = safeFloat(order.advancePaid) + amount;
      const [u] = await tx.update(customOrdersTable)
        .set({ advancePaid: newAdvancePaid.toString() })
        .where(and(eq(customOrdersTable.id, id), eq(customOrdersTable.userId, userId)))
        .returning();

      await postCustomOrderPayment(tx, userId, order, amount, paymentMode, bankAccountId, notes, accts);

      return u;
    });

    res.status(201).json(mapOrder(updated));
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 404) return res.status(404).json({ error: e.message });
    req.log.error({ err }, "Failed to record custom order payment");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:id
router.delete("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const deleted = await db.transaction(async (tx) => {
      const [d] = await tx.delete(customOrdersTable)
        .where(and(eq(customOrdersTable.id, parseInt(req.params.id)), eq(customOrdersTable.userId, userId)))
        .returning();
      if (d && isActiveWithKarigar(d.karigarId, d.status)) {
        await adjustPendingOrders(tx, userId, d.karigarId!, -1);
      }
      return d;
    });
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete custom order");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
