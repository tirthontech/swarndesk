import { Router } from "express";
import { db } from "@workspace/db";
import { purchasesTable, purchasePaymentTransactionsTable, journalVouchersTable } from "@workspace/db";
import { eq, and, desc, isNull } from "drizzle-orm";
import { postJournalEntry, getOrCreateDefaultAccounts, resolveMoneyAccountId, isValidBankAccount, safeFloat, reverseVoucherTx, type DefaultAccountKey, type DbExecutor } from "./accounting-helpers";

const router = Router();

function inventoryAccountKey(metalType: string): DefaultAccountKey {
  return metalType === "gold" ? "INVENTORY_GOLD" : metalType === "silver" ? "INVENTORY_SILVER" : "INVENTORY_OTHER";
}

// "Fine" = the supplier was settled by handing over gold/silver out of the shop's own stock
// instead of cash/bank — books against the metal's inventory account, not a cash/bank account.
async function paymentAccountId(
  userId: number, paymentMode: string, metalType: string, bankAccountId: number | null,
  accts: Record<DefaultAccountKey, number>, exec: DbExecutor = db,
): Promise<number> {
  if (paymentMode === "fine") return accts[inventoryAccountKey(metalType)];
  return resolveMoneyAccountId(userId, paymentMode, bankAccountId, accts, exec);
}

// Raw bullion HSN codes — distinct from 7113 (finished jewellery, used on the sales side).
function bullionHsn(metalType: string): string {
  return metalType === "silver" ? "7106" : "7108";
}

function mapPurchase(p: typeof purchasesTable.$inferSelect) {
  const total = parseFloat(p.totalAmount) || 0;
  // Legacy rows (pre payment-tracking) have paidAmount = null — treat as fully paid in cash,
  // which was the only behavior possible before this column existed.
  const paid = p.paidAmount === null ? total : parseFloat(p.paidAmount) || 0;
  return {
    id: p.id,
    supplierId: p.supplierId,
    supplierName: p.supplierName,
    metalType: p.metalType,
    purity: p.purity,
    grossWeight: parseFloat(p.grossWeight),
    netWeight: parseFloat(p.netWeight),
    fineWeight: parseFloat(p.fineWeight),
    ratePerGram: parseFloat(p.ratePerGram),
    makingCharges: p.makingCharges !== null ? parseFloat(p.makingCharges) || 0 : 0,
    totalAmount: total,
    paidAmount: paid,
    balanceAmount: Math.max(0, total - paid),
    paymentMode: p.paymentMode,
    bankAccountId: p.bankAccountId,
    metalPaidWeight: p.metalPaidWeight !== null ? parseFloat(p.metalPaidWeight) : null,
    metalPaidPurity: p.metalPaidPurity,
    taxableValue: p.taxableValue !== null ? parseFloat(p.taxableValue) : null,
    gstRate: p.gstRate !== null ? parseFloat(p.gstRate) : null,
    gstAmount: p.gstAmount !== null ? parseFloat(p.gstAmount) : null,
    hsnCode: p.hsnCode,
    invoiceNumber: p.invoiceNumber,
    purchaseDate: p.purchaseDate.toISOString(),
    notes: p.notes,
    cancelledAt: p.cancelledAt ? p.cancelledAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
  };
}

function mapTransaction(t: typeof purchasePaymentTransactionsTable.$inferSelect) {
  return {
    id: t.id,
    purchaseId: t.purchaseId,
    supplierId: t.supplierId,
    supplierName: t.supplierName,
    amount: safeFloat(t.amount),
    paymentMode: t.paymentMode,
    bankAccountId: t.bankAccountId,
    paidAt: t.paidAt.toISOString(),
    notes: t.notes,
  };
}

function generateInvoice() {
  return `PO${Date.now().toString().slice(-8)}`;
}

router.get("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.userId, userId));
    res.json(purchases.map(mapPurchase));
  } catch (err) {
    req.log.error({ err }, "Failed to list purchases");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const data = req.body;
    const totalAmount = safeFloat(data.totalAmount, 0);
    const allowedModes = ["cash", "bank", "upi", "fine", "credit", "partial"];
    const paymentMode = allowedModes.includes(data.paymentMode) ? data.paymentMode : "cash";
    const rawPaid = data.paidAmount;
    const paidAmount = rawPaid !== undefined && rawPaid !== null && rawPaid !== ""
      ? Math.max(0, Math.min(totalAmount, safeFloat(rawPaid, totalAmount)))
      : totalAmount; // default: fully paid, matching pre-existing behavior
    const invoiceNumber = data.invoiceNumber ?? generateInvoice();
    const supplierName = data.supplierName;
    const supplierId = data.supplierId ?? null;
    const metalType = data.metalType;
    const purchaseDate = data.purchaseDate ? new Date(data.purchaseDate) : new Date();

    // GST is optional per purchase — a shop buying from an unregistered supplier, or one
    // that hasn't opted into purchase-side GST, sends no gstRate and the whole amount is
    // treated as taxable-value-only (no ITC claimed).
    const hasGst = data.gstRate !== undefined && data.gstRate !== null && data.gstRate !== "";
    const gstRate = hasGst ? safeFloat(data.gstRate, 0) : null;
    const gstAmount = hasGst ? Math.max(0, totalAmount - totalAmount / (1 + gstRate! / 100)) : null;
    const taxableValue = hasGst ? totalAmount - (gstAmount ?? 0) : null;
    const hsnCode = hasGst ? (data.hsnCode ? String(data.hsnCode).trim() : bullionHsn(metalType)) : null;
    const bankAccountId = data.bankAccountId ? parseInt(data.bankAccountId) : null;
    if (bankAccountId && !(await isValidBankAccount(userId, bankAccountId))) {
      return res.status(400).json({ error: "Invalid bank account" });
    }

    const accts = await getOrCreateDefaultAccounts(userId);

    const purchase = await db.transaction(async (tx) => {
      const [newPurchase] = await tx.insert(purchasesTable).values({
        userId,
        supplierId,
        supplierName,
        metalType,
        purity: data.purity,
        grossWeight: (data.grossWeight ?? 0).toString(),
        netWeight: (data.netWeight ?? data.fineWeight ?? 0).toString(),
        fineWeight: (data.fineWeight ?? data.netWeight ?? 0).toString(),
        ratePerGram: (data.ratePerGram ?? 0).toString(),
        makingCharges: safeFloat(data.makingCharges, 0).toString(),
        totalAmount: totalAmount.toString(),
        paidAmount: paidAmount.toString(),
        paymentMode,
        bankAccountId,
        taxableValue: taxableValue !== null ? taxableValue.toFixed(2) : null,
        gstRate: gstRate !== null ? gstRate.toFixed(2) : null,
        gstAmount: gstAmount !== null ? gstAmount.toFixed(2) : null,
        hsnCode,
        invoiceNumber,
        purchaseDate,
        notes: data.notes ?? null,
        metalPaidWeight: paymentMode === "fine" && data.metalPaidWeight ? safeFloat(data.metalPaidWeight).toString() : null,
        metalPaidPurity: paymentMode === "fine" && data.metalPaidPurity ? String(data.metalPaidPurity) : null,
      }).returning();

      const balance = Math.max(0, totalAmount - paidAmount);
      // Without GST: Dr Inventory (full amount). With GST: split into Dr Inventory
      // (taxable value) + Dr Input GST Credit (ITC, claimable against output GST payable).
      const inventoryDebit = hasGst ? taxableValue! : totalAmount;
      await postJournalEntry(tx, {
        userId,
        voucherDate: purchaseDate,
        voucherType: "purchase",
        narration: `Purchase ${invoiceNumber} from ${supplierName}`,
        sourceModule: "purchases",
        sourceId: newPurchase.id,
        lines: [
          { accountId: accts[inventoryAccountKey(metalType)], debit: inventoryDebit, particulars: "Metal purchased" },
          { accountId: accts.INPUT_GST_CREDIT, debit: gstAmount ?? 0, particulars: "GST paid (ITC)" },
          { accountId: await paymentAccountId(userId, paymentMode, metalType, bankAccountId, accts, tx), credit: paidAmount, particulars: paymentMode === "fine" ? "Settled in fine metal" : "Paid to supplier" },
          { accountId: accts.ACCOUNTS_PAYABLE, credit: balance, partyType: "supplier", partyId: supplierId, particulars: "Balance owed to supplier" },
        ],
      });

      return newPurchase;
    });

    res.status(201).json(mapPurchase(purchase));
  } catch (err) {
    req.log.error({ err }, "Failed to create purchase");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const [purchase] = await db.select().from(purchasesTable).where(and(eq(purchasesTable.id, parseInt(req.params.id)), eq(purchasesTable.userId, userId)));
    if (!purchase) return res.status(404).json({ error: "Not found" });
    res.json(mapPurchase(purchase));
  } catch (err) {
    req.log.error({ err }, "Failed to get purchase");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:id — edit a purchase. Fields that don't affect the books (supplier, purity,
// notes, date) can always be edited. Fields that do (weights/rate/total/GST/paidAmount/
// paymentMode) can only be edited while the purchase is still exactly as first recorded —
// i.e. no follow-up payments have been collected yet — since editing those after the fact
// would desync the already-posted journal entry from reality. Financial edits reverse the
// original voucher and post a fresh one for the corrected totals.
router.patch("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const data = req.body;

    const [purchase] = await db.select().from(purchasesTable).where(and(eq(purchasesTable.id, id), eq(purchasesTable.userId, userId)));
    if (!purchase) return res.status(404).json({ error: "Not found" });
    if (purchase.cancelledAt) return res.status(400).json({ error: "Cannot edit a cancelled purchase" });

    const nonFinancialUpdate: Record<string, unknown> = {};
    if (data.supplierName !== undefined) nonFinancialUpdate.supplierName = String(data.supplierName).trim();
    if (data.supplierId !== undefined) nonFinancialUpdate.supplierId = data.supplierId;
    if (data.purity !== undefined) nonFinancialUpdate.purity = data.purity;
    if (data.notes !== undefined) nonFinancialUpdate.notes = data.notes ?? null;
    if (data.purchaseDate !== undefined) nonFinancialUpdate.purchaseDate = new Date(data.purchaseDate);

    const financialFields = ["grossWeight", "netWeight", "fineWeight", "ratePerGram", "makingCharges", "totalAmount", "metalType", "gstRate", "hsnCode", "paidAmount", "paymentMode", "bankAccountId", "metalPaidWeight", "metalPaidPurity"];
    const wantsFinancialChange = financialFields.some(f => data[f] !== undefined);

    if (!wantsFinancialChange) {
      const [updated] = await db.update(purchasesTable).set(nonFinancialUpdate)
        .where(and(eq(purchasesTable.id, id), eq(purchasesTable.userId, userId)))
        .returning();
      return res.json(mapPurchase(updated));
    }

    const payments = await db.select().from(purchasePaymentTransactionsTable).where(and(eq(purchasePaymentTransactionsTable.purchaseId, id), eq(purchasePaymentTransactionsTable.userId, userId)));
    if (payments.length > 0) {
      return res.status(400).json({ error: "Cannot edit amounts/weights after payments have been collected against this purchase — record a correction journal voucher instead" });
    }

    // The currently-live voucher for this purchase — a purchase edited more than once has
    // several voucherType="purchase" rows (one per edit), all but the latest already
    // reversed, so this must find the one still active rather than an arbitrary row.
    const [currentVoucher] = await db.select().from(journalVouchersTable)
      .where(and(eq(journalVouchersTable.userId, userId), eq(journalVouchersTable.sourceModule, "purchases"), eq(journalVouchersTable.sourceId, id), eq(journalVouchersTable.voucherType, "purchase"), isNull(journalVouchersTable.reversedByVoucherId)))
      .orderBy(desc(journalVouchersTable.id)).limit(1);

    const totalAmount = data.totalAmount !== undefined ? safeFloat(data.totalAmount, safeFloat(purchase.totalAmount)) : safeFloat(purchase.totalAmount);
    const allowedModes = ["cash", "bank", "upi", "fine", "credit", "partial"];
    const paymentMode = data.paymentMode !== undefined && allowedModes.includes(data.paymentMode) ? data.paymentMode : purchase.paymentMode;
    const paidAmount = data.paidAmount !== undefined ? Math.max(0, Math.min(totalAmount, safeFloat(data.paidAmount, totalAmount))) : Math.min(totalAmount, purchase.paidAmount === null ? totalAmount : safeFloat(purchase.paidAmount));
    const metalType = data.metalType !== undefined ? data.metalType : purchase.metalType;
    const hasGst = data.gstRate !== undefined ? (data.gstRate !== null && data.gstRate !== "") : purchase.gstRate !== null;
    const gstRate = hasGst ? safeFloat(data.gstRate !== undefined ? data.gstRate : purchase.gstRate, 0) : null;
    const gstAmount = hasGst ? Math.max(0, totalAmount - totalAmount / (1 + gstRate! / 100)) : null;
    const taxableValue = hasGst ? totalAmount - (gstAmount ?? 0) : null;
    const hsnCode = hasGst ? (data.hsnCode ?? purchase.hsnCode ?? bullionHsn(metalType)) : null;
    const supplierId = nonFinancialUpdate.supplierId !== undefined ? nonFinancialUpdate.supplierId as number | null : purchase.supplierId;
    const supplierName = (nonFinancialUpdate.supplierName as string | undefined) ?? purchase.supplierName;
    const purchaseDate = (nonFinancialUpdate.purchaseDate as Date | undefined) ?? purchase.purchaseDate;
    const bankAccountId = data.bankAccountId !== undefined ? (data.bankAccountId ? parseInt(data.bankAccountId) : null) : purchase.bankAccountId;
    if (bankAccountId && !(await isValidBankAccount(userId, bankAccountId))) {
      return res.status(400).json({ error: "Invalid bank account" });
    }

    const accts = await getOrCreateDefaultAccounts(userId);
    const updated = await db.transaction(async (tx) => {
      // Reversal of the old voucher and posting of the corrected one now happen in the same
      // transaction as the row update — a crash partway through can no longer leave the old
      // voucher reversed with no replacement, or the purchase row updated with a stale voucher.
      if (currentVoucher) {
        await reverseVoucherTx(tx, userId, currentVoucher.id, `Superseded by edit to purchase ${purchase.invoiceNumber}`);
      }

      const [u] = await tx.update(purchasesTable).set({
        ...nonFinancialUpdate,
        grossWeight: (data.grossWeight ?? purchase.grossWeight).toString(),
        netWeight: (data.netWeight ?? purchase.netWeight).toString(),
        fineWeight: (data.fineWeight ?? purchase.fineWeight).toString(),
        ratePerGram: (data.ratePerGram ?? purchase.ratePerGram).toString(),
        makingCharges: (data.makingCharges !== undefined ? safeFloat(data.makingCharges, 0) : safeFloat(purchase.makingCharges, 0)).toString(),
        metalType,
        totalAmount: totalAmount.toString(),
        paidAmount: paidAmount.toString(),
        paymentMode,
        bankAccountId,
        taxableValue: taxableValue !== null ? taxableValue.toFixed(2) : null,
        gstRate: gstRate !== null ? gstRate.toFixed(2) : null,
        gstAmount: gstAmount !== null ? gstAmount.toFixed(2) : null,
        hsnCode,
        metalPaidWeight: paymentMode === "fine" && (data.metalPaidWeight ?? purchase.metalPaidWeight)
          ? safeFloat(data.metalPaidWeight ?? purchase.metalPaidWeight).toString() : null,
        metalPaidPurity: paymentMode === "fine" ? String(data.metalPaidPurity ?? purchase.metalPaidPurity ?? "") || null : null,
      }).where(and(eq(purchasesTable.id, id), eq(purchasesTable.userId, userId))).returning();

      const balance = Math.max(0, totalAmount - paidAmount);
      const inventoryDebit = hasGst ? taxableValue! : totalAmount;
      await postJournalEntry(tx, {
        userId,
        voucherDate: purchaseDate,
        voucherType: "purchase",
        narration: `Purchase ${purchase.invoiceNumber} from ${supplierName} (edited)`,
        sourceModule: "purchases",
        sourceId: id,
        lines: [
          { accountId: accts[inventoryAccountKey(metalType)], debit: inventoryDebit, particulars: "Metal purchased" },
          { accountId: accts.INPUT_GST_CREDIT, debit: gstAmount ?? 0, particulars: "GST paid (ITC)" },
          { accountId: await paymentAccountId(userId, paymentMode, metalType, bankAccountId, accts, tx), credit: paidAmount, particulars: paymentMode === "fine" ? "Settled in fine metal" : "Paid to supplier" },
          { accountId: accts.ACCOUNTS_PAYABLE, credit: balance, partyType: "supplier", partyId: supplierId, particulars: "Balance owed to supplier" },
        ],
      });

      return u;
    });

    res.json(mapPurchase(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update purchase");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/cancel — cancel a purchase, reversing its journal entry. Only allowed before
// any follow-up payment has been collected (otherwise the accounts-payable balance being
// reversed wouldn't match what's actually been paid/owed). The row is kept (not deleted)
// with cancelledAt set, preserving the audit trail — mirrors journal-voucher voiding.
router.post("/:id/cancel", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const [purchase] = await db.select().from(purchasesTable).where(and(eq(purchasesTable.id, id), eq(purchasesTable.userId, userId)));
    if (!purchase) return res.status(404).json({ error: "Not found" });
    if (purchase.cancelledAt) return res.status(400).json({ error: "Already cancelled" });

    const payments = await db.select().from(purchasePaymentTransactionsTable).where(and(eq(purchasePaymentTransactionsTable.purchaseId, id), eq(purchasePaymentTransactionsTable.userId, userId)));
    if (payments.length > 0) {
      return res.status(400).json({ error: "Cannot cancel a purchase that already has payments collected against it" });
    }

    const [currentVoucher] = await db.select().from(journalVouchersTable)
      .where(and(eq(journalVouchersTable.userId, userId), eq(journalVouchersTable.sourceModule, "purchases"), eq(journalVouchersTable.sourceId, id), eq(journalVouchersTable.voucherType, "purchase"), isNull(journalVouchersTable.reversedByVoucherId)))
      .orderBy(desc(journalVouchersTable.id)).limit(1);

    const updated = await db.transaction(async (tx) => {
      // Reversal and the cancelledAt flag are set together — a crash between them used to be
      // able to leave the voucher reversed while the purchase still looked active/uncancelled.
      if (currentVoucher) {
        await reverseVoucherTx(tx, userId, currentVoucher.id, `Purchase ${purchase.invoiceNumber} cancelled`);
      }
      const [u] = await tx.update(purchasesTable).set({ cancelledAt: new Date() })
        .where(and(eq(purchasesTable.id, id), eq(purchasesTable.userId, userId)))
        .returning();
      return u;
    });

    res.json(mapPurchase(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to cancel purchase");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id/payments — payment history against a purchase's outstanding balance
router.get("/:id/payments", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const txns = await db.select().from(purchasePaymentTransactionsTable)
      .where(and(eq(purchasePaymentTransactionsTable.purchaseId, id), eq(purchasePaymentTransactionsTable.userId, userId)))
      .orderBy(desc(purchasePaymentTransactionsTable.paidAt));
    res.json(txns.map(mapTransaction));
  } catch (err) {
    req.log.error({ err }, "Failed to get purchase payment history");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/payments — record a payment against a purchase's accounts-payable balance
router.post("/:id/payments", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const amount = safeFloat(req.body.amount);
    if (!isFinite(amount) || amount <= 0) return res.status(400).json({ error: "Invalid payment amount" });
    const allowedModes = ["cash", "bank", "upi", "fine", "credit", "partial"];
    const paymentMode = allowedModes.includes(req.body.paymentMode) ? req.body.paymentMode : "cash";
    const notes = req.body.notes ? String(req.body.notes).slice(0, 500) : null;
    const bankAccountId = req.body.bankAccountId ? parseInt(req.body.bankAccountId) : null;
    if (bankAccountId && !(await isValidBankAccount(userId, bankAccountId))) {
      return res.status(400).json({ error: "Invalid bank account" });
    }

    const accts = await getOrCreateDefaultAccounts(userId);

    const updated = await db.transaction(async (tx) => {
      const [purchase] = await tx.select().from(purchasesTable)
        .where(and(eq(purchasesTable.id, id), eq(purchasesTable.userId, userId)));
      if (!purchase) throw Object.assign(new Error("Purchase not found"), { statusCode: 404 });

      const total = safeFloat(purchase.totalAmount);
      const alreadyPaid = purchase.paidAmount === null ? total : safeFloat(purchase.paidAmount);
      const newPaid = Math.min(total, alreadyPaid + amount);

      await tx.insert(purchasePaymentTransactionsTable).values({
        userId,
        purchaseId: id,
        supplierId: purchase.supplierId,
        supplierName: purchase.supplierName,
        amount: amount.toString(),
        paymentMode,
        bankAccountId,
        notes,
      });

      const [u] = await tx.update(purchasesTable)
        .set({ paidAmount: newPaid.toString() })
        .where(and(eq(purchasesTable.id, id), eq(purchasesTable.userId, userId)))
        .returning();

      await postJournalEntry(tx, {
        userId,
        voucherType: "payment",
        narration: `Payment made against purchase ${purchase.invoiceNumber}`,
        sourceModule: "purchases",
        sourceId: id,
        lines: [
          { accountId: accts.ACCOUNTS_PAYABLE, debit: amount, partyType: "supplier", partyId: purchase.supplierId, particulars: "Balance settled" },
          { accountId: await paymentAccountId(userId, paymentMode, purchase.metalType, bankAccountId, accts, tx), credit: amount, particulars: paymentMode === "fine" ? "Settled in fine metal" : "Payment made" },
        ],
      });

      return u;
    });

    res.json(mapPurchase(updated));
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 404) return res.status(404).json({ error: e.message });
    req.log.error({ err }, "Failed to record purchase payment");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
