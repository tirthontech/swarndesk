import { Router } from "express";
import { db } from "@workspace/db";
import { girviLoansTable, girviPaymentsTable, girviLoanItemsTable, girviCustomersTable, girviPartialReleasesTable, girviPartialReleaseItemsTable, girviTransfersTable } from "@workspace/db";
import { eq, and, ne, desc, asc, lt, lte, gte, sql, inArray, isNull } from "drizzle-orm";
import {
  safeFloat, mapLoan, mapPayment, calcAccruedInterest, preserveOutstandingBaseline,
  ensureDefaultBranch, getOrCreateGirviSettings, nextGirviNumber, computeLoanAggregatesFromItems,
  isLoanEditable,
  VALID_METAL_TYPES, VALID_STATUSES, VALID_PERIODS, VALID_PAYMENT_MODES, VALID_COLLECT_PAYMENT_TYPES,
  MAX_NOTES_LEN, MAX_ADDRESS_LEN,
} from "./girvi-helpers";
import { postJournalEntry, getOrCreateDefaultAccounts, resolveMoneyAccountId, isValidBankAccount, reverseVoucherTx } from "./accounting-helpers";

const router = Router();

router.get("/stats/summary", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const settings = await getOrCreateGirviSettings(userId);
    const graceDays = settings.overdueGraceDays;
    // Voided loans never really happened (see isLoanEditable/DELETE /:id) — exclude
    // them from every stat here, same as if they'd never been entered at all.
    //
    // Split deliberately into two queries. The book-wide totals (collected, processing
    // fees, forfeiture loss, loan count) are plain sums that Postgres returns as a single
    // row, so they no longer require shipping every loan the shop has ever written to
    // Node. Only the ACTIVE loans still come back as rows, because accrued interest is
    // day-count maths that has to run per loan — and active loans are a small, roughly
    // constant slice of a book that otherwise grows forever.
    const now = new Date();
    const [bookTotals, active] = await Promise.all([
      db.select({
        totalLoans: sql<string>`count(*)`,
        totalCollected: sql<string>`coalesce(sum(${girviLoansTable.totalInterestCollected}), 0)`,
        totalProcessingFees: sql<string>`coalesce(sum(${girviLoansTable.processingFee}), 0)`,
        totalLoss: sql<string>`coalesce(sum(${girviLoansTable.lossAmount}) filter (where ${girviLoansTable.status} = 'forfeited'), 0)`,
      }).from(girviLoansTable)
        .where(and(eq(girviLoansTable.userId, userId), ne(girviLoansTable.status, "voided"))),
      // Only the columns calcAccruedInterest and the weight/date tallies below actually read.
      db.select({
        id: girviLoansTable.id,
        status: girviLoansTable.status,
        loanAmount: girviLoansTable.loanAmount,
        principalPaid: girviLoansTable.principalPaid,
        interestRate: girviLoansTable.interestRate,
        penaltyRate: girviLoansTable.penaltyRate,
        interestPeriod: girviLoansTable.interestPeriod,
        startDate: girviLoansTable.startDate,
        dueDate: girviLoansTable.dueDate,
        metalType: girviLoansTable.metalType,
        grossWeight: girviLoansTable.grossWeight,
      }).from(girviLoansTable)
        .where(and(eq(girviLoansTable.userId, userId), inArray(girviLoansTable.status, ["active", "extended"]))),
    ]);

    const totals = bookTotals[0];
    const overdue = active.filter(l => new Date(l.dueDate) < now);
    const totalLent = active.reduce((s, l) => {
      const principalPaid = safeFloat(l.principalPaid ?? "0");
      return s + Math.max(0, safeFloat(l.loanAmount) - principalPaid);
    }, 0);
    const totalInterest = active.reduce(
      (s, l) => s + calcAccruedInterest(l as unknown as typeof girviLoansTable.$inferSelect, now, graceDays).total, 0);
    const totalLoss = safeFloat(totals?.totalLoss);
    const totalCollected = safeFloat(totals?.totalCollected);
    const totalProcessingFees = safeFloat(totals?.totalProcessingFees);
    const totalLoans = Number(totals?.totalLoans ?? 0);
    const totalGoldWeight = active.filter(l => l.metalType === "gold").reduce((s, l) => s + safeFloat(l.grossWeight), 0);
    const totalSilverWeight = active.filter(l => l.metalType === "silver").reduce((s, l) => s + safeFloat(l.grossWeight), 0);
    const dueSoon = active.filter(l => {
      const d = new Date(l.dueDate);
      return d >= now && d <= new Date(now.getTime() + 7 * 86400000);
    });

    res.json({
      totalActive: active.length,
      totalLent: Math.round(totalLent),
      totalInterestAccrued: Math.round(totalInterest),
      totalInterestCollected: Math.round(totalCollected),
      totalProcessingFees: Math.round(totalProcessingFees),
      overdueCount: overdue.length,
      dueSoonCount: dueSoon.length,
      totalLoss: Math.round(totalLoss),
      totalLoans,
      totalGoldWeight: Math.round(totalGoldWeight * 1000) / 1000,
      totalSilverWeight: Math.round(totalSilverWeight * 1000) / 1000,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get girvi summary");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const settings = await getOrCreateGirviSettings(userId);
    const { status, due, mobile, customerId, branchId } = req.query as Record<string, string>;

    if (status && status !== "all" && !VALID_STATUSES.has(status)) {
      return res.json([]);
    }

    // Exact-match filters go straight into the WHERE clause so they use the
    // existing (userId, status) / customerId / branchId indexes instead of
    // downloading this shop's entire loan history on every list/refresh.
    const conditions = [eq(girviLoansTable.userId, userId)];
    if (status && status !== "all") conditions.push(eq(girviLoansTable.status, status));
    if (customerId) {
      const cid = parseInt(customerId);
      if (!isNaN(cid)) conditions.push(eq(girviLoansTable.customerId, cid));
    }
    if (branchId) {
      const bid = parseInt(branchId);
      if (!isNaN(bid)) conditions.push(eq(girviLoansTable.branchId, bid));
    }

    const now = new Date();

    // The due/mobile filters used to run in JS over the full result set, which meant the
    // database still read and shipped every loan the shop had ever made even when the
    // user was asking for the handful due today. Expressed here they become part of the
    // WHERE clause, so the "overdue"/"today"/"week" tabs read only the rows they show —
    // and the (userId, dueDate) index can serve the range.
    if (due === "overdue" || due === "today" || due === "week") {
      conditions.push(inArray(girviLoansTable.status, ["active", "extended"]));
      if (due === "overdue") {
        conditions.push(lt(girviLoansTable.dueDate, now));
      } else {
        const until = due === "today"
          ? (() => { const d = new Date(now); d.setHours(23, 59, 59, 999); return d; })()
          : new Date(now.getTime() + 7 * 86400000);
        conditions.push(gte(girviLoansTable.dueDate, now));
        conditions.push(lte(girviLoansTable.dueDate, until));
      }
    }

    // Digit-only substring match, mirroring what the JS filter did character for character
    // (stored numbers may carry spaces, +91 or dashes). It can't use an index, but doing
    // it in the database returns just the matches instead of the whole book for Node to
    // sift — and it keeps the cap below from hiding results the search should have found.
    if (mobile) {
      const digits = mobile.replace(/\D/g, "");
      if (digits) {
        // [^0-9] rather than \D: inside a JS template literal the backslash is eaten
        // before the SQL ever sees it, which silently turns the pattern into a literal "D".
        conditions.push(sql`regexp_replace(${girviLoansTable.customerMobile}, '[^0-9]', '', 'g') LIKE ${"%" + digits + "%"}`);
      }
    }

    // A safety ceiling, not pagination: no realistic shop has 5000 loans matching one
    // filter, but without any cap a single request can pin the whole table in memory.
    // `?limit=` can ask for less; the UI does not paginate, so the default stays high
    // enough that nothing a shop would actually look at gets truncated.
    const limitNum = Math.min(5000, Math.max(1, parseInt(String(req.query.limit ?? "")) || 5000));

    const loans = await db.select().from(girviLoansTable)
      .where(and(...conditions))
      .orderBy(desc(girviLoansTable.createdAt))
      .limit(limitNum);
    res.json(loans.map(l => mapLoan(l, now, settings.overdueGraceDays)));
  } catch (err) {
    req.log.error({ err }, "Failed to list girvi loans");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const data = req.body;

    // Resolve the customer: either an existing girvi_customers row, or create
    // one inline as part of this transaction.
    let customer: typeof girviCustomersTable.$inferSelect | null = null;
    if (data.customerId) {
      const cid = parseInt(data.customerId);
      if (isNaN(cid)) return res.status(400).json({ error: "Invalid customerId" });
      const [found] = await db.select().from(girviCustomersTable)
        .where(and(eq(girviCustomersTable.id, cid), eq(girviCustomersTable.userId, userId)));
      if (!found) return res.status(404).json({ error: "Customer not found" });
      customer = found;
    } else if (data.newCustomer) {
      const nc = data.newCustomer;
      const name = String(nc.name ?? "").trim();
      const mobile = String(nc.mobile ?? "").trim();
      if (!name) return res.status(400).json({ error: "Customer name is required" });
      if (!mobile) return res.status(400).json({ error: "Customer mobile is required" });

      // Same dedup check as POST /girvi/customers — inline "Create New Customer"
      // inside the New Loan dialog is the other place this mistake happens.
      const mobileDigits = mobile.replace(/\D/g, "");
      if (mobileDigits) {
        const existingCustomers = await db.select().from(girviCustomersTable).where(eq(girviCustomersTable.userId, userId));
        const dupe = existingCustomers.find(c => c.mobile.replace(/\D/g, "") === mobileDigits);
        if (dupe) {
          return res.status(409).json({
            error: `A customer with this mobile number already exists: ${dupe.name} (${dupe.mobile}). Search for them instead of creating a new record.`,
            existingCustomerId: dupe.id,
          });
        }
      }

      const [created] = await db.insert(girviCustomersTable).values({
        userId,
        name,
        mobile,
        fatherName: nc.fatherName ? String(nc.fatherName).trim() || null : null,
        address: nc.address ? String(nc.address).slice(0, MAX_ADDRESS_LEN) || null : null,
        altMobile: nc.altMobile ? String(nc.altMobile).trim() || null : null,
        email: nc.email ? String(nc.email).trim() || null : null,
        idProofType: nc.idProofType ? String(nc.idProofType).trim() || null : null,
        idProofNumber: nc.idProofNumber ? String(nc.idProofNumber).trim() || null : null,
        pan: nc.pan ? String(nc.pan).trim().toUpperCase() || null : null,
        notes: nc.notes ? String(nc.notes).slice(0, MAX_NOTES_LEN) || null : null,
      }).returning();
      customer = created;
    } else {
      return res.status(400).json({ error: "Either customerId or newCustomer is required" });
    }

    const loanAmount = safeFloat(data.loanAmount);
    const interestRate = safeFloat(data.interestRate, 2);
    const penaltyRate = safeFloat(data.penaltyRate, 0);
    const processingFee = safeFloat(data.processingFee, 0);
    if (loanAmount <= 0) return res.status(400).json({ error: "Loan amount must be positive" });
    if (interestRate < 0 || interestRate > 100) return res.status(400).json({ error: "Interest rate must be 0–100" });
    if (penaltyRate < 0 || penaltyRate > 100) return res.status(400).json({ error: "Penalty rate must be 0–100" });
    if (processingFee < 0) return res.status(400).json({ error: "Processing fee cannot be negative" });

    const interestPeriod = VALID_PERIODS.has(data.interestPeriod) ? data.interestPeriod : "monthly";
    const startDate = data.startDate ? new Date(data.startDate) : new Date();
    const dueDate = data.dueDate ? new Date(data.dueDate) : new Date(Date.now() + 90 * 86400000);
    if (isNaN(startDate.getTime())) return res.status(400).json({ error: "Invalid start date" });
    if (isNaN(dueDate.getTime())) return res.status(400).json({ error: "Invalid due date" });
    if (dueDate <= startDate) return res.status(400).json({ error: "Due date must be after start date" });

    const notes = data.notes ? String(data.notes).slice(0, MAX_NOTES_LEN) : null;

    let branchId = data.branchId ? parseInt(data.branchId) : NaN;
    if (isNaN(branchId)) branchId = await ensureDefaultBranch(userId);

    // Parse items array
    type ItemInput = { itemType: string; quantity: number; metalType: string; purity: string; grossWeight: number; netWeight: number; estimatedValue: number; notes?: string; itemCode?: string };
    const rawItems: ItemInput[] = Array.isArray(data.items) ? data.items : [];
    if (rawItems.length === 0) return res.status(400).json({ error: "At least one item is required" });

    const items = rawItems.map(it => ({
      itemType: String(it.itemType ?? "Item").trim() || "Item",
      quantity: Math.max(1, parseInt(String(it.quantity)) || 1),
      metalType: VALID_METAL_TYPES.has(it.metalType) ? it.metalType : "gold",
      purity: String(it.purity ?? "22K").trim() || "22K",
      grossWeight: safeFloat(it.grossWeight),
      netWeight: safeFloat(it.netWeight ?? it.grossWeight, safeFloat(it.grossWeight)),
      estimatedValue: safeFloat(it.estimatedValue),
      notes: it.notes ? String(it.notes).slice(0, MAX_NOTES_LEN) : null,
      itemCode: it.itemCode ? String(it.itemCode).trim().slice(0, 100) || null : null,
    }));

    const invalidItem = items.find(it => it.grossWeight <= 0);
    if (invalidItem) return res.status(400).json({ error: `Item "${invalidItem.itemType}" must have a positive gross weight` });

    // Aggregate totals across all items (helper expects line totals, not per-unit)
    const lineTotals = items.map(it => ({ ...it, grossWeight: it.grossWeight * it.quantity, netWeight: it.netWeight * it.quantity, estimatedValue: it.estimatedValue * it.quantity }));
    const { grossWeight: totalGrossWeight, netWeight: totalNetWeight, estimatedValue: totalEstimatedValue, metalType: primaryMetal, purity: primaryPurity, itemDescription: autoDesc } = computeLoanAggregatesFromItems(lineTotals);

    const settings = await getOrCreateGirviSettings(userId);
    const loanNumber = await nextGirviNumber(userId, "loan", settings.receiptPrefix, startDate, settings.financialYearStartMonth);
    const accts = await getOrCreateDefaultAccounts(userId);

    const disbursementMode = VALID_PAYMENT_MODES.has(data.disbursementMode) ? data.disbursementMode : "cash";
    const disbursementBankAccountId = data.disbursementBankAccountId ? parseInt(data.disbursementBankAccountId) : null;
    if (disbursementBankAccountId && !(await isValidBankAccount(userId, disbursementBankAccountId))) {
      return res.status(400).json({ error: "Invalid bank account" });
    }

    const loan = await db.transaction(async tx => {
      const [newLoan] = await tx.insert(girviLoansTable).values({
        userId,
        loanNumber,
        branchId,
        customerId: customer!.id,
        customerName: customer!.name,
        customerMobile: customer!.mobile,
        fatherName: customer!.fatherName,
        address: customer!.address,
        kycDocType: customer!.idProofType,
        kycDocNumber: customer!.idProofNumber,
        pan: customer!.pan,
        itemDescription: autoDesc,
        metalType: primaryMetal,
        purity: primaryPurity,
        grossWeight: totalGrossWeight.toFixed(3),
        netWeight: totalNetWeight.toFixed(3),
        estimatedValue: totalEstimatedValue.toFixed(2),
        loanAmount: loanAmount.toString(),
        processingFee: processingFee.toString(),
        interestRate: interestRate.toString(),
        penaltyRate: penaltyRate.toString(),
        interestPeriod,
        startDate,
        dueDate,
        status: "active",
        totalInterestCollected: "0",
        disbursementMode,
        disbursementBankAccountId,
        notes,
      }).returning();

      await tx.insert(girviLoanItemsTable).values(items.map(it => ({
        userId,
        loanId: newLoan.id,
        itemType: it.itemType,
        quantity: it.quantity,
        metalType: it.metalType,
        purity: it.purity,
        grossWeight: (it.grossWeight * it.quantity).toFixed(3),
        netWeight: (it.netWeight * it.quantity).toFixed(3),
        estimatedValue: (it.estimatedValue * it.quantity).toFixed(2),
        notes: it.notes,
        itemCode: it.itemCode,
        status: "pledged",
        currentBranchId: branchId,
      })));

      // Dr Girvi Loans Receivable (loanAmount) / Cr Cash-or-Bank (loanAmount - processingFee) +
      // Cr Processing Fee Income (processingFee) — money disbursed net of the upfront fee.
      const disbursed = loanAmount - processingFee;
      const disbursementAccountId = await resolveMoneyAccountId(userId, disbursementMode, disbursementBankAccountId, accts, tx);
      const voucher = await postJournalEntry(tx, {
        userId,
        voucherDate: startDate,
        voucherType: "payment",
        narration: `Girvi loan ${loanNumber} disbursed to ${customer!.name}`,
        sourceModule: "girvi",
        sourceId: newLoan.id,
        lines: [
          { accountId: accts.GIRVI_LOANS_RECEIVABLE, debit: loanAmount, partyType: "girvi_customer", partyId: customer!.id, particulars: "Loan disbursed" },
          { accountId: disbursementAccountId, credit: disbursed, particulars: "Disbursed to customer" },
          { accountId: accts.PROCESSING_FEE_INCOME, credit: processingFee, particulars: "Processing fee" },
        ],
      });

      const [withVoucher] = await tx.update(girviLoansTable)
        .set({ disbursementVoucherId: voucher.id })
        .where(eq(girviLoansTable.id, newLoan.id))
        .returning();

      return withVoucher;
    });

    res.status(201).json(mapLoan(loan, new Date(), settings.overdueGraceDays));
  } catch (err) {
    req.log.error({ err }, "Failed to create girvi loan");
    res.status(500).json({ error: "Internal server error" });
  }
});

// "Today's Follow-Ups" — active loans overdue or due within `days` (default 3),
// most urgent first. Deliberately independent of whatever status/due filter the
// Loans tab currently has selected, so this always reflects the full book.
//
// Registered BEFORE "/:id" — Express matches in registration order, and
// "follow-ups" would otherwise be captured as an :id and rejected as NaN.
router.get("/follow-ups", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const settings = await getOrCreateGirviSettings(userId);
    const days = Math.max(0, parseInt(String(req.query.days ?? "3")) || 3);
    const now = new Date();
    // Both filters belong in SQL: this used to read every loan the shop had ever made and
    // throw away all but the handful due in the next few days. Status narrows to the live
    // book, and the due-date cutoff narrows again to what this panel can actually show —
    // overdue (dueDate < now) or due within `days` — which the girvi_user_due_idx serves.
    const cutoff = new Date(now.getTime() + days * 86400000);
    const loans = await db.select().from(girviLoansTable)
      .where(and(
        eq(girviLoansTable.userId, userId),
        inArray(girviLoansTable.status, ["active", "extended"]),
        lte(girviLoansTable.dueDate, cutoff),
      ))
      .orderBy(asc(girviLoansTable.dueDate));
    const dueSoon = loans.map(l => mapLoan(l, now, settings.overdueGraceDays))
      .filter(l => l.isOverdue || l.daysRemaining <= days)
      .sort((a, b) => a.daysRemaining - b.daysRemaining);
    res.json(dueSoon);
  } catch (err) {
    req.log.error({ err }, "Failed to build follow-ups list");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const [loan] = await db.select().from(girviLoansTable).where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)));
    if (!loan) return res.status(404).json({ error: "Not found" });
    const settings = await getOrCreateGirviSettings(userId);
    const payments = await db.select().from(girviPaymentsTable)
      .where(and(eq(girviPaymentsTable.loanId, id), eq(girviPaymentsTable.userId, userId)))
      .orderBy(desc(girviPaymentsTable.paymentDate));
    res.json({ loan: mapLoan(loan, new Date(), settings.overdueGraceDays), payments: payments.map(mapPayment) });
  } catch (err) {
    req.log.error({ err }, "Failed to get girvi loan");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id/items", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const [loan] = await db.select({ id: girviLoansTable.id }).from(girviLoansTable)
      .where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)));
    if (!loan) return res.status(404).json({ error: "Not found" });
    const items = await db.select().from(girviLoanItemsTable)
      .where(and(eq(girviLoanItemsTable.loanId, id), eq(girviLoanItemsTable.userId, userId)));
    res.json(items.map(it => ({
      id: it.id,
      itemType: it.itemType,
      quantity: it.quantity,
      metalType: it.metalType,
      purity: it.purity,
      grossWeight: safeFloat(it.grossWeight),
      netWeight: safeFloat(it.netWeight),
      estimatedValue: safeFloat(it.estimatedValue),
      notes: it.notes,
      itemCode: it.itemCode,
      status: it.status,
      currentBranchId: it.currentBranchId,
      returnedAt: it.returnedAt?.toISOString() ?? null,
    })));
  } catch (err) {
    req.log.error({ err }, "Failed to get girvi items");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Search pledged items across all loans by the shop's own physical tag/serial
// number (written on the item at pledge time — see girvi_loan_items.itemCode).
// Lets the front desk type the number off a tag and jump straight to the loan
// it belongs to, instead of hunting through the loan list.
router.get("/items/search", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const code = String(req.query.code ?? "").trim();
    if (code.length < 2) return res.json([]);
    const settings = await getOrCreateGirviSettings(userId);
    const rows = await db.select({ item: girviLoanItemsTable, loan: girviLoansTable })
      .from(girviLoanItemsTable)
      .innerJoin(girviLoansTable, eq(girviLoanItemsTable.loanId, girviLoansTable.id))
      .where(and(
        eq(girviLoanItemsTable.userId, userId),
        sql`${girviLoanItemsTable.itemCode} ILIKE ${"%" + code + "%"}`,
      ))
      .orderBy(desc(girviLoansTable.createdAt))
      .limit(25);
    res.json(rows.map(({ item, loan }) => ({
      item: {
        id: item.id, itemType: item.itemType, quantity: item.quantity, metalType: item.metalType,
        purity: item.purity, grossWeight: safeFloat(item.grossWeight), netWeight: safeFloat(item.netWeight),
        estimatedValue: safeFloat(item.estimatedValue), notes: item.notes, itemCode: item.itemCode,
        status: item.status,
      },
      loan: mapLoan(loan, new Date(), settings.overdueGraceDays),
    })));
  } catch (err) {
    req.log.error({ err }, "Failed to search girvi items by code");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Recompute and persist a loan's aggregate collateral fields (grossWeight/
// netWeight/estimatedValue/metalType/purity/itemDescription) from whatever is
// currently pledged — same rollup partial-release already does, shared here
// for the item add/edit/delete endpoints below.
async function refreshLoanAggregates(tx: any, userId: number, loanId: number) {
  const allItems = await tx.select().from(girviLoanItemsTable)
    .where(and(eq(girviLoanItemsTable.loanId, loanId), eq(girviLoanItemsTable.userId, userId)));
  const pledged = allItems.filter((it: any) => it.status === "pledged");
  const aggregates = computeLoanAggregatesFromItems(pledged.map((it: any) => ({
    itemType: it.itemType, quantity: it.quantity, metalType: it.metalType, purity: it.purity,
    grossWeight: safeFloat(it.grossWeight), netWeight: safeFloat(it.netWeight), estimatedValue: safeFloat(it.estimatedValue),
  })));
  const [updated] = await tx.update(girviLoansTable)
    .set({
      grossWeight: aggregates.grossWeight.toFixed(3),
      netWeight: aggregates.netWeight.toFixed(3),
      estimatedValue: aggregates.estimatedValue.toFixed(2),
      metalType: aggregates.metalType || "gold",
      purity: aggregates.purity || "22K",
      itemDescription: aggregates.itemDescription,
      updatedAt: new Date(),
    })
    .where(and(eq(girviLoansTable.id, loanId), eq(girviLoansTable.userId, userId)))
    .returning();
  return updated;
}

// Closes out every item still with the shop — "pledged" AND "transferred" —
// when a loan reaches a terminal state (redeemed/forfeited/voided). Earlier
// versions of these three endpoints only matched status="pledged", which
// silently stranded any item mid-transfer at status="transferred" forever
// (its transfer stayed "active" in the Transfers tab for a loan that no
// longer existed). Also auto-closes any transfer still open for this loan —
// the loan is done, so leaving it "active" would dangle in the Transfers
// register with nothing left to resolve it. POST /transfers/:id/return is
// still safe to call after this: it only reverts items still literally
// status="transferred", so it just no-ops if beaten to it here.
async function closeOutLoanItems(tx: any, userId: number, loanId: number, terminalStatus: "returned" | "forfeited" | "voided", now: Date) {
  await tx.update(girviLoanItemsTable)
    .set({ status: terminalStatus, returnedAt: now })
    .where(and(eq(girviLoanItemsTable.loanId, loanId), eq(girviLoanItemsTable.userId, userId), inArray(girviLoanItemsTable.status, ["pledged", "transferred"])));
  await tx.update(girviTransfersTable)
    .set({ returnedAt: now, returnNotes: `Auto-closed: loan ${terminalStatus}` })
    .where(and(eq(girviTransfersTable.loanId, loanId), eq(girviTransfersTable.userId, userId), isNull(girviTransfersTable.returnedAt)));
}

// A loan qualifies for direct term-editing / voiding (see isLoanEditable) only
// until its first real business event — that's payments, but a $0 partial
// release (items handed back with nothing collected, which the partial-release
// endpoint explicitly allows) is a real event too and isn't reflected in
// totalInterestCollected/principalPaid. Voiding after that would reverse the
// original disbursement while some collateral is already, unrecoverably, back
// with the customer — so check for ANY partial-release history too.
async function loanHasPartialReleaseHistory(userId: number, loanId: number): Promise<boolean> {
  const [row] = await db.select({ id: girviPartialReleasesTable.id }).from(girviPartialReleasesTable)
    .where(and(eq(girviPartialReleasesTable.loanId, loanId), eq(girviPartialReleasesTable.userId, userId)))
    .limit(1);
  return !!row;
}

// Add a pledged item to an existing loan — e.g. the customer brought one more
// piece, or the original entry missed an item. Does not touch loanAmount or
// the accounting ledger: collateral value itself is never booked, only the
// cash loanAmount is (see POST / above), so adding collateral is purely a
// data/valuation change.
router.post("/:id/items", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const [loan] = await db.select().from(girviLoansTable).where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)));
    if (!loan) return res.status(404).json({ error: "Not found" });
    if (loan.status !== "active" && loan.status !== "extended") {
      return res.status(400).json({ error: "Can only add items to active or extended loans" });
    }

    const it = req.body ?? {};
    const grossWeight = safeFloat(it.grossWeight);
    if (grossWeight <= 0) return res.status(400).json({ error: "Item must have a positive gross weight" });
    const quantity = Math.max(1, parseInt(String(it.quantity)) || 1);
    const netWeight = safeFloat(it.netWeight ?? it.grossWeight, grossWeight);
    const values = {
      userId,
      loanId: id,
      itemType: String(it.itemType ?? "Item").trim() || "Item",
      quantity,
      metalType: VALID_METAL_TYPES.has(it.metalType) ? it.metalType : "gold",
      purity: String(it.purity ?? "22K").trim() || "22K",
      grossWeight: (grossWeight * quantity).toFixed(3),
      netWeight: (netWeight * quantity).toFixed(3),
      estimatedValue: (safeFloat(it.estimatedValue) * quantity).toFixed(2),
      notes: it.notes ? String(it.notes).slice(0, MAX_NOTES_LEN) : null,
      itemCode: it.itemCode ? String(it.itemCode).trim().slice(0, 100) || null : null,
      status: "pledged" as const,
      currentBranchId: loan.branchId,
    };

    const { created, updatedLoan } = await db.transaction(async tx => {
      const [created] = await tx.insert(girviLoanItemsTable).values(values).returning();
      const updatedLoan = await refreshLoanAggregates(tx, userId, id);
      return { created, updatedLoan };
    });

    const settings = await getOrCreateGirviSettings(userId);
    res.status(201).json({
      item: { ...created, grossWeight: safeFloat(created.grossWeight), netWeight: safeFloat(created.netWeight), estimatedValue: safeFloat(created.estimatedValue) },
      loan: mapLoan(updatedLoan, new Date(), settings.overdueGraceDays),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to add girvi loan item");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Edit a pledged item's own details (weight/purity/type/notes/tag number) —
// for correcting a data-entry mistake, not for recording a real-world event
// (use partial-release/transfer/redeem/forfeit for those). Only the item
// itself changes; loanAmount/interest terms are untouched.
router.patch("/:id/items/:itemId", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    const itemId = parseInt(req.params.itemId);
    if (isNaN(id) || isNaN(itemId)) return res.status(400).json({ error: "Invalid id" });
    const [loan] = await db.select().from(girviLoansTable).where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)));
    if (!loan) return res.status(404).json({ error: "Loan not found" });
    const [item] = await db.select().from(girviLoanItemsTable).where(and(eq(girviLoanItemsTable.id, itemId), eq(girviLoanItemsTable.loanId, id), eq(girviLoanItemsTable.userId, userId)));
    if (!item) return res.status(404).json({ error: "Item not found" });
    if (item.status !== "pledged") return res.status(400).json({ error: "Only currently-pledged items can be edited" });

    const data = req.body ?? {};
    const quantity = data.quantity !== undefined ? Math.max(1, parseInt(String(data.quantity)) || 1) : item.quantity;
    const grossPerUnit = data.grossWeight !== undefined ? safeFloat(data.grossWeight) : safeFloat(item.grossWeight) / item.quantity;
    if (grossPerUnit <= 0) return res.status(400).json({ error: "Gross weight must be positive" });
    const netPerUnit = data.netWeight !== undefined ? safeFloat(data.netWeight) : safeFloat(item.netWeight) / item.quantity;
    const estPerUnit = data.estimatedValue !== undefined ? safeFloat(data.estimatedValue) : safeFloat(item.estimatedValue) / item.quantity;

    const updates: Partial<typeof girviLoanItemsTable.$inferInsert> = {
      itemType: data.itemType !== undefined ? (String(data.itemType).trim() || item.itemType) : undefined,
      quantity,
      metalType: data.metalType !== undefined ? (VALID_METAL_TYPES.has(data.metalType) ? data.metalType : item.metalType) : undefined,
      purity: data.purity !== undefined ? (String(data.purity).trim() || item.purity) : undefined,
      grossWeight: (grossPerUnit * quantity).toFixed(3),
      netWeight: (netPerUnit * quantity).toFixed(3),
      estimatedValue: (estPerUnit * quantity).toFixed(2),
      notes: data.notes !== undefined ? (String(data.notes).slice(0, MAX_NOTES_LEN) || null) : undefined,
      itemCode: data.itemCode !== undefined ? (String(data.itemCode).trim().slice(0, 100) || null) : undefined,
    };
    Object.keys(updates).forEach(k => (updates as any)[k] === undefined && delete (updates as any)[k]);

    const { updatedItem, updatedLoan } = await db.transaction(async tx => {
      const [updatedItem] = await tx.update(girviLoanItemsTable).set(updates)
        .where(and(eq(girviLoanItemsTable.id, itemId), eq(girviLoanItemsTable.userId, userId)))
        .returning();
      const updatedLoan = await refreshLoanAggregates(tx, userId, id);
      return { updatedItem, updatedLoan };
    });

    const settings = await getOrCreateGirviSettings(userId);
    res.json({
      item: { ...updatedItem, grossWeight: safeFloat(updatedItem.grossWeight), netWeight: safeFloat(updatedItem.netWeight), estimatedValue: safeFloat(updatedItem.estimatedValue) },
      loan: mapLoan(updatedLoan, new Date(), settings.overdueGraceDays),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to update girvi loan item");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Remove an item that was pledged by mistake (wrong loan, duplicate row, etc).
// This is a correction, not a release — the collateral was never really taken
// in, so it deliberately does NOT go through partial-release's payment/voucher
// flow. Restricted to loans with zero payment history (see isLoanEditable) so
// it can never be used to quietly erase collateral backing money already
// collected; once a payment exists, use Partial Release instead.
router.delete("/:id/items/:itemId", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    const itemId = parseInt(req.params.itemId);
    if (isNaN(id) || isNaN(itemId)) return res.status(400).json({ error: "Invalid id" });
    const [loan] = await db.select().from(girviLoansTable).where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)));
    if (!loan) return res.status(404).json({ error: "Loan not found" });
    if (!isLoanEditable(loan)) {
      return res.status(400).json({ error: "This loan already has payment history — use Partial Release to return an item instead of deleting it" });
    }
    const [item] = await db.select().from(girviLoanItemsTable).where(and(eq(girviLoanItemsTable.id, itemId), eq(girviLoanItemsTable.loanId, id), eq(girviLoanItemsTable.userId, userId)));
    if (!item) return res.status(404).json({ error: "Item not found" });
    if (item.status !== "pledged") return res.status(400).json({ error: "Item is not currently pledged" });

    const pledgedCount = await db.select({ id: girviLoanItemsTable.id }).from(girviLoanItemsTable)
      .where(and(eq(girviLoanItemsTable.loanId, id), eq(girviLoanItemsTable.userId, userId), eq(girviLoanItemsTable.status, "pledged")));
    if (pledgedCount.length <= 1) {
      return res.status(400).json({ error: "Cannot delete the loan's last item — delete the whole loan instead" });
    }

    const updatedLoan = await db.transaction(async tx => {
      await tx.delete(girviLoanItemsTable).where(and(eq(girviLoanItemsTable.id, itemId), eq(girviLoanItemsTable.userId, userId)));
      return refreshLoanAggregates(tx, userId, id);
    });

    const settings = await getOrCreateGirviSettings(userId);
    res.json({ loan: mapLoan(updatedLoan, new Date(), settings.overdueGraceDays) });
  } catch (err) {
    req.log.error({ err }, "Failed to delete girvi loan item");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Return a subset of a loan's pledged items while the loan stays active for
// the rest, against an optional (lender-decided) paydown. See VALID_PAYMENT_TYPES
// note on collect-interest for why the interest/principal split logic is
// duplicated in spirit here — this reuses the exact same allocation rule.
router.post("/:id/partial-release", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const [loan] = await db.select().from(girviLoansTable).where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)));
    if (!loan) return res.status(404).json({ error: "Not found" });
    if (loan.status !== "active" && loan.status !== "extended") {
      return res.status(400).json({ error: "Can only release items from active or extended loans" });
    }

    const { itemIds, amount, paymentMode, notes, bankAccountId: rawBankAccountId } = req.body;
    const requestedIds: number[] = Array.isArray(itemIds) ? itemIds.map((n: unknown) => parseInt(String(n))).filter((n: number) => !isNaN(n)) : [];
    if (requestedIds.length === 0) return res.status(400).json({ error: "Select at least one item to release" });
    const bankAccountId = rawBankAccountId ? parseInt(rawBankAccountId) : null;
    if (bankAccountId && !(await isValidBankAccount(userId, bankAccountId))) {
      return res.status(400).json({ error: "Invalid bank account" });
    }

    const allItems = await db.select().from(girviLoanItemsTable).where(and(eq(girviLoanItemsTable.loanId, id), eq(girviLoanItemsTable.userId, userId)));
    const pledgedItems = allItems.filter(it => it.status === "pledged");
    const releaseItems = pledgedItems.filter(it => requestedIds.includes(it.id));
    if (releaseItems.length !== requestedIds.length) {
      return res.status(400).json({ error: "One or more selected items are not currently pledged on this loan" });
    }
    const remainingItems = pledgedItems.filter(it => !requestedIds.includes(it.id));
    if (remainingItems.length === 0) {
      return res.status(400).json({ error: "This would release every pledged item — use Redeem to close out the loan instead" });
    }

    const amt = safeFloat(amount, 0);
    if (amt < 0) return res.status(400).json({ error: "Amount cannot be negative" });
    const resolvedNotes = notes ? String(notes).slice(0, MAX_NOTES_LEN) : null;
    const resolvedMode = VALID_PAYMENT_MODES.has(paymentMode) ? paymentMode : "cash";
    const now = new Date();

    const settings = await getOrCreateGirviSettings(userId);
    const mappedLoan = mapLoan(loan, now, settings.overdueGraceDays);
    const outstandingInterest = mappedLoan.outstandingInterest;
    const currentPrincipal = mappedLoan.currentPrincipal;
    if (amt > mappedLoan.totalDue + 0.01) {
      return res.status(400).json({ error: `Amount exceeds total amount due (₹${mappedLoan.totalDue.toFixed(2)})` });
    }

    // Same interest-then-principal split as collect-interest's "auto" mode.
    const interestPortion = Math.min(amt, outstandingInterest);
    const principalPortion = Math.min(Math.max(0, amt - interestPortion), currentPrincipal);
    const newPrincipalPaid = safeFloat((loan as any).principalPaid ?? "0") + principalPortion;
    const newTotalInterestCollected = safeFloat(loan.totalInterestCollected) + interestPortion;

    const remainingAggregates = computeLoanAggregatesFromItems(remainingItems.map(it => ({
      itemType: it.itemType, quantity: it.quantity, metalType: it.metalType, purity: it.purity,
      grossWeight: safeFloat(it.grossWeight), netWeight: safeFloat(it.netWeight), estimatedValue: safeFloat(it.estimatedValue),
    })));
    const releasedDescription = releaseItems.map(it => `${it.quantity} ${it.itemType}${it.quantity > 1 ? "s" : ""}`).join(", ");

    const releaseNumber = await nextGirviNumber(userId, "partial_release", settings.partialReleasePrefix, now, settings.financialYearStartMonth);
    const accts = await getOrCreateDefaultAccounts(userId);

    const loanUpdates: Record<string, unknown> = {
      grossWeight: remainingAggregates.grossWeight.toFixed(3),
      netWeight: remainingAggregates.netWeight.toFixed(3),
      estimatedValue: remainingAggregates.estimatedValue.toFixed(2),
      metalType: remainingAggregates.metalType,
      purity: remainingAggregates.purity,
      itemDescription: remainingAggregates.itemDescription,
      updatedAt: now,
    };
    if (amt > 0) {
      loanUpdates.principalPaid = newPrincipalPaid.toFixed(2);
      loanUpdates.totalInterestCollected = newTotalInterestCollected.toFixed(2);
      // Reset the interest clock on the reduced principal, same as a normal paydown.
      loanUpdates.startDate = now;
      loanUpdates.interestBaseline = newTotalInterestCollected.toFixed(2);
    }

    const { updatedLoan, release } = await db.transaction(async tx => {
      const [createdRelease] = await tx.insert(girviPartialReleasesTable).values({
        userId, loanId: id, releaseNumber, releaseDate: now,
        itemsDescription: releasedDescription,
        principalSettled: principalPortion.toFixed(2),
        interestSettled: interestPortion.toFixed(2),
        notes: resolvedNotes,
      }).returning();

      await tx.insert(girviPartialReleaseItemsTable).values(
        releaseItems.map(it => ({ userId, releaseId: createdRelease.id, loanItemId: it.id }))
      );

      await tx.update(girviLoanItemsTable)
        .set({ status: "returned", returnedAt: now })
        .where(and(eq(girviLoanItemsTable.userId, userId), inArray(girviLoanItemsTable.id, requestedIds)));

      if (amt > 0) {
        if (interestPortion > 0) {
          await tx.insert(girviPaymentsTable).values({
            userId, loanId: id, loanNumber: loan.loanNumber, customerName: loan.customerName,
            amount: interestPortion.toFixed(2), paymentType: "interest", paymentMode: resolvedMode, bankAccountId, paymentDate: now,
            notes: resolvedNotes ? `${resolvedNotes} [partial release ${releaseNumber}]` : `Partial release ${releaseNumber}: interest portion`,
          });
        }
        if (principalPortion > 0) {
          await tx.insert(girviPaymentsTable).values({
            userId, loanId: id, loanNumber: loan.loanNumber, customerName: loan.customerName,
            amount: principalPortion.toFixed(2), paymentType: "principal", paymentMode: resolvedMode, bankAccountId, paymentDate: now,
            notes: resolvedNotes ? `${resolvedNotes} [partial release ${releaseNumber}]` : `Partial release ${releaseNumber}: principal portion`,
          });
        }
      }

      const [u] = await tx.update(girviLoansTable)
        .set(loanUpdates as Partial<typeof girviLoansTable.$inferInsert>)
        .where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)))
        .returning();

      if (amt > 0) {
        await postJournalEntry(tx, {
          userId,
          voucherDate: now,
          voucherType: "receipt",
          narration: `Partial release ${releaseNumber} on girvi loan ${loan.loanNumber}`,
          sourceModule: "girvi",
          sourceId: id,
          lines: [
            { accountId: await resolveMoneyAccountId(userId, resolvedMode, bankAccountId, accts, tx), debit: amt, particulars: "Payment received" },
            ...(interestPortion > 0 ? [{ accountId: accts.INTEREST_INCOME, credit: interestPortion, particulars: "Interest portion" }] : []),
            ...(principalPortion > 0 ? [{ accountId: accts.GIRVI_LOANS_RECEIVABLE, credit: principalPortion, partyType: "girvi_customer" as const, partyId: loan.customerId ?? undefined, particulars: "Principal portion" }] : []),
          ],
        });
      }

      return { updatedLoan: u, release: createdRelease };
    });

    res.status(201).json({
      loan: mapLoan(updatedLoan, now, settings.overdueGraceDays),
      release: {
        id: release.id,
        releaseNumber: release.releaseNumber,
        releaseDate: release.releaseDate.toISOString(),
        itemsDescription: release.itemsDescription,
        principalSettled: safeFloat(release.principalSettled),
        interestSettled: safeFloat(release.interestSettled),
        notes: release.notes,
      },
      releasedItems: releaseItems.map(it => ({
        id: it.id, itemType: it.itemType, quantity: it.quantity, metalType: it.metalType, purity: it.purity,
        grossWeight: safeFloat(it.grossWeight), netWeight: safeFloat(it.netWeight), estimatedValue: safeFloat(it.estimatedValue),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to process partial release");
    res.status(500).json({ error: "Internal server error" });
  }
});

// History of partial releases for a loan (expanded detail view + voucher reprint)
router.get("/:id/partial-releases", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const releases = await db.select().from(girviPartialReleasesTable)
      .where(and(eq(girviPartialReleasesTable.loanId, id), eq(girviPartialReleasesTable.userId, userId)))
      .orderBy(desc(girviPartialReleasesTable.releaseDate));
    res.json(releases.map(r => ({
      id: r.id,
      releaseNumber: r.releaseNumber,
      releaseDate: r.releaseDate.toISOString(),
      itemsDescription: r.itemsDescription,
      principalSettled: safeFloat(r.principalSettled),
      interestSettled: safeFloat(r.interestSettled),
      notes: r.notes,
    })));
  } catch (err) {
    req.log.error({ err }, "Failed to get partial release history");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Issue (or reissue) a forfeiture notice to the customer on an overdue loan.
// Forfeiture (PATCH /:id with status:"forfeited") is blocked until
// settings.forfeitureNoticeDays have elapsed since the LATEST notice — resending
// simply restarts that clock, e.g. if the shop wants to give a fresh warning.
router.post("/:id/send-notice", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const [loan] = await db.select().from(girviLoansTable).where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)));
    if (!loan) return res.status(404).json({ error: "Not found" });
    if (loan.status !== "active" && loan.status !== "extended") {
      return res.status(400).json({ error: "Can only send a forfeiture notice on an active or extended loan" });
    }
    const settings = await getOrCreateGirviSettings(userId);
    const now = new Date();
    const mappedLoan = mapLoan(loan, now, settings.overdueGraceDays);
    if (!mappedLoan.isOverdue) {
      return res.status(400).json({ error: "This loan is not overdue yet — a forfeiture notice can only be sent once the due date has passed" });
    }
    const noticeNumber = await nextGirviNumber(userId, "notice", settings.noticePrefix, now, settings.financialYearStartMonth);
    const [updated] = await db.update(girviLoansTable)
      .set({ noticeSentAt: now, noticeNumber, updatedAt: now })
      .where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)))
      .returning();
    res.json(mapLoan(updated, now, settings.overdueGraceDays));
  } catch (err) {
    req.log.error({ err }, "Failed to send forfeiture notice");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Top-up: increase the disbursed principal on an active loan, optionally against
// newly added collateral and/or an interest payment collected at the same time.
// Resets the interest clock (same as renew) so the added principal doesn't
// appear to have been accruing interest since the ORIGINAL start date — any
// interest already owed as of now is preserved via interestBaseline exactly
// like renew does, it just isn't erased by the reset.
router.post("/:id/topup", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const [loan] = await db.select().from(girviLoansTable).where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)));
    if (!loan) return res.status(404).json({ error: "Not found" });
    if (loan.status !== "active" && loan.status !== "extended") {
      return res.status(400).json({ error: "Can only top up active or extended loans" });
    }

    const { additionalAmount, interestPaid, newDueDate, notes, paymentMode, referenceNumber, items, bankAccountId: rawBankAccountId } = req.body;
    const addAmt = safeFloat(additionalAmount);
    if (addAmt <= 0 || !isFinite(addAmt)) return res.status(400).json({ error: "Top-up amount must be a positive number" });
    const paid = safeFloat(interestPaid, 0);
    if (paid < 0 || !isFinite(paid)) return res.status(400).json({ error: "Interest amount must be zero or positive" });
    const bankAccountId = rawBankAccountId ? parseInt(rawBankAccountId) : null;
    if (bankAccountId && !(await isValidBankAccount(userId, bankAccountId))) {
      return res.status(400).json({ error: "Invalid bank account" });
    }

    const now = new Date();
    const topupDueDate = newDueDate ? new Date(newDueDate) : new Date(loan.dueDate);
    if (isNaN(topupDueDate.getTime())) return res.status(400).json({ error: "Invalid due date" });
    if (topupDueDate <= now) return res.status(400).json({ error: "Due date must be in the future" });

    // Optional additional collateral pledged alongside the top-up — same shape/
    // validation as POST / and POST /:id/items.
    type ItemInput = { itemType: string; quantity: number; metalType: string; purity: string; grossWeight: number; netWeight: number; estimatedValue: number; notes?: string; itemCode?: string };
    const rawItems: ItemInput[] = Array.isArray(items) ? items : [];
    const newItems = rawItems.map(it => ({
      itemType: String(it.itemType ?? "Item").trim() || "Item",
      quantity: Math.max(1, parseInt(String(it.quantity)) || 1),
      metalType: VALID_METAL_TYPES.has(it.metalType) ? it.metalType : "gold",
      purity: String(it.purity ?? "22K").trim() || "22K",
      grossWeight: safeFloat(it.grossWeight),
      netWeight: safeFloat(it.netWeight ?? it.grossWeight, safeFloat(it.grossWeight)),
      estimatedValue: safeFloat(it.estimatedValue),
      notes: it.notes ? String(it.notes).slice(0, MAX_NOTES_LEN) : null,
      itemCode: it.itemCode ? String(it.itemCode).trim().slice(0, 100) || null : null,
    }));
    const invalidItem = newItems.find(it => it.grossWeight <= 0);
    if (invalidItem) return res.status(400).json({ error: `Item "${invalidItem.itemType}" must have a positive gross weight` });

    const resolvedNotes = notes ? String(notes).slice(0, MAX_NOTES_LEN) : null;
    const resolvedMode = VALID_PAYMENT_MODES.has(paymentMode) ? paymentMode : "cash";
    const resolvedRef = referenceNumber ? String(referenceNumber).trim().slice(0, 100) || null : null;
    const mergedNotes = resolvedNotes
      ? (loan.notes ? `${loan.notes}\n${resolvedNotes}`.slice(0, MAX_NOTES_LEN) : resolvedNotes)
      : loan.notes;

    const settings = await getOrCreateGirviSettings(userId);
    const graceDays = settings.overdueGraceDays;
    const { total: accruedBeforeTopup } = calcAccruedInterest(loan, now, graceDays);
    const interestBaselineBefore = safeFloat((loan as any).interestBaseline ?? "0");
    // Unfloored on purpose — a baseline above what's been collected is carried-forward
    // unpaid interest, and flooring it here would forgive it. See mapLoan.
    const creditSinceReset = safeFloat(loan.totalInterestCollected) - interestBaselineBefore;
    const outstandingBeforeTopup = Math.max(0, accruedBeforeTopup - creditSinceReset);

    const accts = await getOrCreateDefaultAccounts(userId);
    const newTotalCollected = safeFloat(loan.totalInterestCollected) + paid;
    const newInterestBaseline = newTotalCollected + Math.max(0, outstandingBeforeTopup - paid);
    const newLoanAmount = safeFloat(loan.loanAmount) + addAmt;

    const updated = await db.transaction(async tx => {
      if (newItems.length > 0) {
        await tx.insert(girviLoanItemsTable).values(newItems.map(it => ({
          userId, loanId: id, itemType: it.itemType, quantity: it.quantity, metalType: it.metalType, purity: it.purity,
          grossWeight: (it.grossWeight * it.quantity).toFixed(3), netWeight: (it.netWeight * it.quantity).toFixed(3),
          estimatedValue: (it.estimatedValue * it.quantity).toFixed(2), notes: it.notes, itemCode: it.itemCode,
          status: "pledged" as const, currentBranchId: loan.branchId,
        })));
      }
      if (paid > 0) {
        await tx.insert(girviPaymentsTable).values({
          userId, loanId: id, loanNumber: loan.loanNumber, customerName: loan.customerName,
          amount: paid.toFixed(2), paymentType: "interest", paymentMode: resolvedMode, bankAccountId, referenceNumber: resolvedRef,
          paymentDate: now, notes: resolvedNotes ? `${resolvedNotes} [top-up]` : "Interest collected at top-up",
        });
      }

      const loanUpdates: Record<string, unknown> = {
        loanAmount: newLoanAmount.toFixed(2),
        startDate: now,
        dueDate: topupDueDate,
        status: "active",
        totalInterestCollected: newTotalCollected.toFixed(2),
        interestBaseline: newInterestBaseline.toFixed(2),
        notes: mergedNotes ?? null,
        updatedAt: now,
      };
      if (newItems.length > 0) {
        const allPledged = await tx.select().from(girviLoanItemsTable)
          .where(and(eq(girviLoanItemsTable.loanId, id), eq(girviLoanItemsTable.userId, userId), eq(girviLoanItemsTable.status, "pledged")));
        const aggregates = computeLoanAggregatesFromItems(allPledged.map(it => ({
          itemType: it.itemType, quantity: it.quantity, metalType: it.metalType, purity: it.purity,
          grossWeight: safeFloat(it.grossWeight), netWeight: safeFloat(it.netWeight), estimatedValue: safeFloat(it.estimatedValue),
        })));
        loanUpdates.grossWeight = aggregates.grossWeight.toFixed(3);
        loanUpdates.netWeight = aggregates.netWeight.toFixed(3);
        loanUpdates.estimatedValue = aggregates.estimatedValue.toFixed(2);
        loanUpdates.metalType = aggregates.metalType;
        loanUpdates.purity = aggregates.purity;
        loanUpdates.itemDescription = aggregates.itemDescription;
      }

      const [u] = await tx.update(girviLoansTable).set(loanUpdates as Partial<typeof girviLoansTable.$inferInsert>)
        .where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)))
        .returning();

      // Dr Girvi Loans Receivable (addAmt) / Cr Cash-or-Bank (addAmt) — additional principal disbursed.
      await postJournalEntry(tx, {
        userId, voucherDate: now, voucherType: "payment",
        narration: `Girvi loan ${loan.loanNumber} top-up disbursed`,
        sourceModule: "girvi", sourceId: id,
        lines: [
          { accountId: accts.GIRVI_LOANS_RECEIVABLE, debit: addAmt, partyType: "girvi_customer", partyId: loan.customerId ?? undefined, particulars: "Top-up principal disbursed" },
          { accountId: await resolveMoneyAccountId(userId, resolvedMode, bankAccountId, accts, tx), credit: addAmt, particulars: "Disbursed to customer (top-up)" },
        ],
      });

      if (paid > 0) {
        await postJournalEntry(tx, {
          userId, voucherDate: now, voucherType: "receipt",
          narration: `Interest collected at top-up on girvi loan ${loan.loanNumber}`,
          sourceModule: "girvi", sourceId: id,
          lines: [
            { accountId: await resolveMoneyAccountId(userId, resolvedMode, bankAccountId, accts, tx), debit: paid, particulars: "Interest received" },
            { accountId: accts.INTEREST_INCOME, credit: paid, particulars: "Interest" },
          ],
        });
      }

      return u;
    });

    res.json(mapLoan(updated, new Date(), graceDays));
  } catch (err) {
    req.log.error({ err }, "Failed to top up loan");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Record a payment — supports interest, penalty, and smart auto-allocation.
// paymentType: "auto" (default) | "interest" | "penalty"
//
// "auto" logic:
//   - If amount ≤ outstanding interest → pure interest payment, clock unchanged
//   - If amount > outstanding interest:
//       interest portion = outstanding interest
//       principal portion = amount - outstandingInterest
//       → totalInterestCollected += interestPortion
//       → principalPaid += principalPortion
//       → startDate reset to now (interest restarts on reduced principal)
//       → interestBaseline set to new totalInterestCollected (fixes post-reset calc)
//       → if currentPrincipal - principalPortion ≤ 0: auto-redeem
//
// "interest" / "penalty" → simple accumulation, no principal change.
// "waiver" → the lender forgives some/all of the outstanding interest (e.g. a
// customer ran well past the grace period but the lender chooses not to
// charge for it). No cash changes hands — recorded as its own payment type so
// reports don't count it as real interest income, but it still clears the
// loan's outstanding-interest ledger the same way a real payment would.
router.post("/:id/collect-interest", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const [loan] = await db.select().from(girviLoansTable)
      .where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)));
    if (!loan) return res.status(404).json({ error: "Not found" });
    if (loan.status !== "active" && loan.status !== "extended") {
      return res.status(400).json({ error: "Can only collect payments on active or extended loans" });
    }

    const { amount, paymentType = "auto", notes, paymentMode, referenceNumber, bankAccountId: rawBankAccountId } = req.body;
    if (!VALID_COLLECT_PAYMENT_TYPES.has(paymentType)) return res.status(400).json({ error: "Invalid payment type" });
    const amt = safeFloat(amount);
    if (amt <= 0 || !isFinite(amt)) return res.status(400).json({ error: "Amount must be a positive number" });
    const resolvedNotes = notes ? String(notes).slice(0, MAX_NOTES_LEN) : null;
    const resolvedMode = VALID_PAYMENT_MODES.has(paymentMode) ? paymentMode : "cash";
    const resolvedRef = referenceNumber ? String(referenceNumber).trim().slice(0, 100) || null : null;
    const bankAccountId = rawBankAccountId ? parseInt(rawBankAccountId) : null;
    if (bankAccountId && !(await isValidBankAccount(userId, bankAccountId))) {
      return res.status(400).json({ error: "Invalid bank account" });
    }
    const now = new Date();
    // When the cash was actually collected — defaults to now, but settable so a payment
    // received a day or two ago (and only now being entered into the system) is recorded
    // and posted on the right date instead of today's. Outstanding-interest validation
    // above still uses the real "now", since that's genuinely what's owed as of this moment.
    const paymentDate = req.body.paymentDate ? new Date(req.body.paymentDate) : now;
    if (isNaN(paymentDate.getTime())) return res.status(400).json({ error: "Invalid payment date" });
    if (paymentDate.getTime() > now.getTime() + 86400000) return res.status(400).json({ error: "Payment date cannot be in the future" });

    const settings = await getOrCreateGirviSettings(userId);
    const mappedLoan = mapLoan(loan, now, settings.overdueGraceDays);
    const outstandingInterest = mappedLoan.outstandingInterest;
    const currentPrincipal = mappedLoan.currentPrincipal;

    if (paymentType === "auto" && amt > mappedLoan.totalDue + 0.01) {
      return res.status(400).json({ error: `Amount exceeds total amount due (₹${mappedLoan.totalDue.toFixed(2)})` });
    }
    if (paymentType === "waiver" && amt > outstandingInterest + 0.01) {
      return res.status(400).json({ error: `Cannot waive more than the outstanding interest (₹${outstandingInterest.toFixed(2)})` });
    }

    let updated: typeof girviLoansTable.$inferSelect;
    const accts = await getOrCreateDefaultAccounts(userId);

    if (paymentType === "auto" && amt > outstandingInterest) {
      // The validation above allows amt up to totalDue + 0.01 so a client echoing back a
      // rounded totalDue isn't rejected over a stray paisa. Settle that slack here rather
      // than carrying it into the postings: anything above totalDue can be allocated to
      // neither interest nor principal, so it would land in the journal as a debit with no
      // matching credit — under postJournalEntry's own 0.01 tolerance, hence silently
      // written rather than rejected, leaving the trial balance a paisa out.
      const allocatable = Math.min(amt, mappedLoan.totalDue);
      // Smart allocation: settle interest first, remainder reduces principal
      const interestPortion = Math.min(allocatable, outstandingInterest);
      // Cap principal portion at current principal to prevent overpayment
      const principalPortion = Math.min(allocatable - interestPortion, currentPrincipal);
      const newPrincipalPaid = safeFloat((loan as any).principalPaid ?? "0") + principalPortion;
      const remainingPrincipal = Math.max(0, safeFloat(loan.loanAmount) - newPrincipalPaid);
      const newTotalInterestCollected = safeFloat(loan.totalInterestCollected) + interestPortion;

      const loanUpdates: Record<string, unknown> = {
        totalInterestCollected: newTotalInterestCollected.toFixed(2),
        principalPaid: newPrincipalPaid.toFixed(2),
        // Reset interest clock so future interest accrues on reduced principal, from
        // whenever the money actually changed hands rather than today's data-entry time.
        startDate: paymentDate,
        // Baseline = new totalInterestCollected so outstanding correctly starts at 0 post-reset
        interestBaseline: newTotalInterestCollected.toFixed(2),
      };

      let returnVoucherNumber: string | null = null;
      if (remainingPrincipal <= 0) {
        // Loan fully repaid
        returnVoucherNumber = await nextGirviNumber(userId, "return", settings.returnPrefix, paymentDate, settings.financialYearStartMonth);
        loanUpdates.status = "redeemed";
        loanUpdates.redeemedDate = paymentDate;
        loanUpdates.redeemedAmount = allocatable.toFixed(2);
        loanUpdates.returnVoucherNumber = returnVoucherNumber;
      }

      // Single atomic transaction: payments + loan update together
      updated = await db.transaction(async tx => {
        if (interestPortion > 0) {
          await tx.insert(girviPaymentsTable).values({
            userId, loanId: id, loanNumber: loan.loanNumber,
            customerName: loan.customerName,
            amount: interestPortion.toFixed(2),
            paymentType: "interest",
            paymentMode: resolvedMode,
            bankAccountId,
            referenceNumber: resolvedRef,
            paymentDate,
            notes: resolvedNotes ? `${resolvedNotes} [auto: interest portion]` : "Auto: interest portion",
          });
        }
        await tx.insert(girviPaymentsTable).values({
          userId, loanId: id, loanNumber: loan.loanNumber,
          customerName: loan.customerName,
          amount: principalPortion.toFixed(2),
          paymentType: "principal",
          paymentMode: resolvedMode,
          bankAccountId,
          referenceNumber: resolvedRef,
          paymentDate,
          notes: resolvedNotes ? `${resolvedNotes} [auto: principal portion]` : "Auto: principal portion",
        });
        if (remainingPrincipal <= 0) {
          await closeOutLoanItems(tx, userId, id, "returned", paymentDate);
        }
        const [u] = await tx.update(girviLoansTable)
          .set(loanUpdates as Partial<typeof girviLoansTable.$inferInsert>)
          .where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)))
          .returning();

        await postJournalEntry(tx, {
          userId,
          voucherDate: paymentDate,
          voucherType: "receipt",
          narration: `Payment collected on girvi loan ${loan.loanNumber}`,
          sourceModule: "girvi",
          sourceId: id,
          lines: [
            { accountId: await resolveMoneyAccountId(userId, resolvedMode, bankAccountId, accts, tx), debit: allocatable, particulars: "Payment received" },
            { accountId: accts.INTEREST_INCOME, credit: interestPortion, particulars: "Interest portion" },
            { accountId: accts.GIRVI_LOANS_RECEIVABLE, credit: principalPortion, partyType: "girvi_customer", partyId: loan.customerId ?? undefined, particulars: "Principal portion" },
          ],
        });

        return u;
      });

    } else {
      // Interest-only, penalty, or waiver — simple accumulation, no principal/clock change.
      // A waiver still clears the outstanding-interest ledger (totalInterestCollected) exactly
      // like a real payment would, but is also tracked separately in interestWaived (informational
      // only) so the loan/reports can distinguish cash actually received from interest forgiven.
      const resolvedType = paymentType === "penalty" ? "penalty" : paymentType === "waiver" ? "waiver" : "interest";
      updated = await db.transaction(async tx => {
        await tx.insert(girviPaymentsTable).values({
          userId, loanId: id, loanNumber: loan.loanNumber,
          customerName: loan.customerName,
          amount: amt.toFixed(2),
          paymentType: resolvedType,
          paymentMode: resolvedMode,
          bankAccountId,
          referenceNumber: resolvedRef,
          paymentDate,
          notes: resolvedNotes,
        });
        const [u] = await tx.update(girviLoansTable)
          .set({
            totalInterestCollected: sql`COALESCE(${girviLoansTable.totalInterestCollected}, 0) + ${amt.toFixed(2)}::numeric`,
            ...(resolvedType === "waiver" ? { interestWaived: sql`COALESCE(${girviLoansTable.interestWaived}, 0) + ${amt.toFixed(2)}::numeric` } : {}),
          })
          .where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)))
          .returning();

        // A waiver moves no cash and was never booked as a receivable in this cash-basis
        // model, so there's nothing to post — see VALID_PAYMENT_TYPES comment.
        if (resolvedType !== "waiver") {
          await postJournalEntry(tx, {
            userId,
            voucherDate: paymentDate,
            voucherType: "receipt",
            narration: `${resolvedType === "penalty" ? "Penalty" : "Interest"} collected on girvi loan ${loan.loanNumber}`,
            sourceModule: "girvi",
            sourceId: id,
            lines: [
              { accountId: await resolveMoneyAccountId(userId, resolvedMode, bankAccountId, accts, tx), debit: amt, particulars: "Payment received" },
              { accountId: accts.INTEREST_INCOME, credit: amt, particulars: resolvedType === "penalty" ? "Penalty interest" : "Interest" },
            ],
          });
        }

        return u;
      });
    }

    res.json(mapLoan(updated, new Date(), settings.overdueGraceDays));
  } catch (err) {
    req.log.error({ err }, "Failed to collect payment");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Renew loan — collect interest + reset start date so interest clock restarts from today
router.post("/:id/renew", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const [loan] = await db.select().from(girviLoansTable).where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)));
    if (!loan) return res.status(404).json({ error: "Not found" });
    if (loan.status !== "active" && loan.status !== "extended") {
      return res.status(400).json({ error: "Can only renew active or extended loans" });
    }

    const { interestPaid, newDueDate, notes, paymentMode, referenceNumber, bankAccountId: rawBankAccountId } = req.body;
    const paid = safeFloat(interestPaid, 0);
    if (paid < 0 || !isFinite(paid)) return res.status(400).json({ error: "Interest amount must be zero or positive" });
    const bankAccountId = rawBankAccountId ? parseInt(rawBankAccountId) : null;
    if (bankAccountId && !(await isValidBankAccount(userId, bankAccountId))) {
      return res.status(400).json({ error: "Invalid bank account" });
    }

    const renewedDueDate = newDueDate ? new Date(newDueDate) : new Date(Date.now() + 90 * 86400000);
    if (isNaN(renewedDueDate.getTime())) return res.status(400).json({ error: "Invalid new due date" });

    const resolvedNotes = notes ? String(notes).slice(0, MAX_NOTES_LEN) : null;
    const resolvedMode = VALID_PAYMENT_MODES.has(paymentMode) ? paymentMode : "cash";
    const resolvedRef = referenceNumber ? String(referenceNumber).trim().slice(0, 100) || null : null;
    const mergedNotes = resolvedNotes
      ? (loan.notes ? `${loan.notes}\n${resolvedNotes}`.slice(0, MAX_NOTES_LEN) : resolvedNotes)
      : loan.notes;

    const now = new Date();
    const settings = await getOrCreateGirviSettings(userId);
    const { total: accruedBeforeRenewal } = calcAccruedInterest(loan, now, settings.overdueGraceDays);
    const interestBaselineBefore = safeFloat((loan as any).interestBaseline ?? "0");
    // Unfloored on purpose — a baseline above what's been collected is carried-forward
    // unpaid interest, and flooring it here would forgive it. See mapLoan.
    const creditSinceReset = safeFloat(loan.totalInterestCollected) - interestBaselineBefore;
    const outstandingBeforeRenewal = Math.max(0, accruedBeforeRenewal - creditSinceReset);

    const accts = await getOrCreateDefaultAccounts(userId);

    // Reset the clock, but if the interest paid doesn't cover what was already accrued,
    // carry the shortfall forward as already-outstanding on the fresh cycle instead of
    // writing it off — otherwise unpaid interest simply vanishes on renewal.
    const newTotalCollected = safeFloat(loan.totalInterestCollected) + paid;
    const newInterestBaseline = newTotalCollected + Math.max(0, outstandingBeforeRenewal - paid);

    const updated = await db.transaction(async (tx) => {
      if (paid > 0) {
        await tx.insert(girviPaymentsTable).values({
          userId,
          loanId: id,
          loanNumber: loan.loanNumber,
          customerName: loan.customerName,
          amount: paid.toString(),
          paymentType: "renewal",
          paymentMode: resolvedMode,
          bankAccountId,
          referenceNumber: resolvedRef,
          paymentDate: now,
          notes: resolvedNotes,
        });
      }

      const [u] = await tx.update(girviLoansTable)
        .set({
          startDate: now,
          dueDate: renewedDueDate,
          status: "active",
          totalInterestCollected: newTotalCollected.toFixed(2),
          interestBaseline: newInterestBaseline.toFixed(2),
          notes: mergedNotes ?? null,
        })
        .where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)))
        .returning();

      if (paid > 0) {
        await postJournalEntry(tx, {
          userId,
          voucherDate: now,
          voucherType: "receipt",
          narration: `Renewal interest collected on girvi loan ${loan.loanNumber}`,
          sourceModule: "girvi",
          sourceId: id,
          lines: [
            { accountId: await resolveMoneyAccountId(userId, resolvedMode, bankAccountId, accts, tx), debit: paid, particulars: "Renewal interest received" },
            { accountId: accts.INTEREST_INCOME, credit: paid, particulars: "Interest" },
          ],
        });
      }

      return u;
    });

    res.json(mapLoan(updated, new Date(), settings.overdueGraceDays));
  } catch (err) {
    req.log.error({ err }, "Failed to renew loan");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get payment history for a loan
router.get("/:id/payments", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const payments = await db.select().from(girviPaymentsTable)
      .where(and(eq(girviPaymentsTable.loanId, id), eq(girviPaymentsTable.userId, userId)))
      .orderBy(desc(girviPaymentsTable.paymentDate));
    res.json(payments.map(mapPayment));
  } catch (err) {
    req.log.error({ err }, "Failed to get payment history");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const [loan] = await db.select().from(girviLoansTable).where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)));
    if (!loan) return res.status(404).json({ error: "Not found" });

    const data = req.body;
    const now = new Date();
    const settings = await getOrCreateGirviSettings(userId);
    const graceDays = settings.overdueGraceDays;
    const updates: Partial<typeof girviLoansTable.$inferInsert> = {};

    if (data.status === "redeemed") {
      if (loan.status !== "active" && loan.status !== "extended") {
        return res.status(400).json({ error: "Only active/extended loans can be redeemed" });
      }
      const { total: accruedInterest } = calcAccruedInterest(loan, now, graceDays);
      const interestBaseline = safeFloat((loan as any).interestBaseline ?? "0");
      // Unfloored on purpose — a baseline above what's been collected is carried-forward
      // unpaid interest, and flooring it here would forgive it. See mapLoan.
      const creditSinceReset = safeFloat(loan.totalInterestCollected) - interestBaseline;
      const outstanding = Math.max(0, accruedInterest - creditSinceReset);
      const principalPaid = safeFloat((loan as any).principalPaid ?? "0");
      const currentPrincipal = Math.max(0, safeFloat(loan.loanAmount) - principalPaid);
      const resolvedMode = VALID_PAYMENT_MODES.has(data.paymentMode) ? data.paymentMode : "cash";
      const redeemBankAccountId = data.bankAccountId ? parseInt(data.bankAccountId) : null;
      if (redeemBankAccountId && !(await isValidBankAccount(userId, redeemBankAccountId))) {
        return res.status(400).json({ error: "Invalid bank account" });
      }

      // Optional lender discretion: forgive some/all of the outstanding interest
      // instead of collecting it (e.g. the customer is well past the grace
      // period, but the lender chooses not to charge for it this time).
      const waiveInterest = safeFloat(data.waiveInterest, 0);
      if (waiveInterest < 0 || waiveInterest > outstanding + 0.01) {
        return res.status(400).json({ error: `Waived interest must be between 0 and the outstanding interest (₹${outstanding.toFixed(2)})` });
      }
      const interestToCollect = Math.max(0, outstanding - waiveInterest);
      const cashCollected = currentPrincipal + interestToCollect; // actual cash received — excludes any waived interest

      const returnVoucherNumber = await nextGirviNumber(userId, "return", settings.returnPrefix, now, settings.financialYearStartMonth);
      const accts = await getOrCreateDefaultAccounts(userId);

      // Record the final interest + principal settlement as payments (mirrors the
      // auto-redeem path in collect-interest) so payment history and the
      // totalInterestCollected dashboard stat aren't left understated.
      const updated = await db.transaction(async tx => {
        if (interestToCollect > 0) {
          await tx.insert(girviPaymentsTable).values({
            userId, loanId: id, loanNumber: loan.loanNumber, customerName: loan.customerName,
            amount: interestToCollect.toFixed(2), paymentType: "interest", paymentMode: resolvedMode, bankAccountId: redeemBankAccountId, paymentDate: now,
            notes: "Redemption: final interest settlement",
          });
        }
        if (waiveInterest > 0) {
          await tx.insert(girviPaymentsTable).values({
            userId, loanId: id, loanNumber: loan.loanNumber, customerName: loan.customerName,
            amount: waiveInterest.toFixed(2), paymentType: "waiver", paymentMode: resolvedMode, bankAccountId: redeemBankAccountId, paymentDate: now,
            notes: "Redemption: interest waived by lender",
          });
        }
        if (currentPrincipal > 0) {
          await tx.insert(girviPaymentsTable).values({
            userId, loanId: id, loanNumber: loan.loanNumber, customerName: loan.customerName,
            amount: currentPrincipal.toFixed(2), paymentType: "principal", paymentMode: resolvedMode, bankAccountId: redeemBankAccountId, paymentDate: now,
            notes: "Redemption: final principal settlement",
          });
        }
        // Anything already released via a prior partial release keeps its own
        // returnedAt from that transaction — closeOutLoanItems only touches
        // items still pledged/transferred.
        await closeOutLoanItems(tx, userId, id, "returned", now);
        const [u] = await tx.update(girviLoansTable)
          .set({
            status: "redeemed",
            redeemedDate: now,
            redeemedAmount: cashCollected.toFixed(2),
            returnVoucherNumber,
            // Both the collected and waived portions clear the outstanding-interest ledger.
            totalInterestCollected: (safeFloat(loan.totalInterestCollected) + outstanding).toFixed(2),
            interestWaived: (safeFloat((loan as any).interestWaived ?? "0") + waiveInterest).toFixed(2),
            principalPaid: loan.loanAmount,
          })
          .where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)))
          .returning();

        // Dr Cash/Bank (cashCollected) / Cr Girvi Loans Receivable (principal) +
        // Cr Interest Income (interest actually collected — waived interest never
        // touches the ledger since it was never booked as a receivable).
        await postJournalEntry(tx, {
          userId,
          voucherDate: now,
          voucherType: "receipt",
          narration: `Redemption of girvi loan ${loan.loanNumber}`,
          sourceModule: "girvi",
          sourceId: id,
          lines: [
            { accountId: await resolveMoneyAccountId(userId, resolvedMode, redeemBankAccountId, accts, tx), debit: cashCollected, particulars: "Redemption payment received" },
            { accountId: accts.GIRVI_LOANS_RECEIVABLE, credit: currentPrincipal, partyType: "girvi_customer", partyId: loan.customerId ?? undefined, particulars: "Principal settled" },
            { accountId: accts.INTEREST_INCOME, credit: interestToCollect, particulars: "Interest settled" },
          ],
        });

        return u;
      });

      return res.json(mapLoan(updated, now, graceDays));
    } else if (data.status === "forfeited") {
      if (loan.status !== "active" && loan.status !== "extended") {
        return res.status(400).json({ error: "Only active/extended loans can be forfeited" });
      }
      // A forfeiture notice must have been sent, and the configured notice
      // period must have fully elapsed since it — see POST /:id/send-notice.
      if (!loan.noticeSentAt) {
        return res.status(400).json({ error: "Send a forfeiture notice to the customer first — required before this loan can be forfeited" });
      }
      const eligibleFrom = new Date(loan.noticeSentAt.getTime() + settings.forfeitureNoticeDays * 86400000);
      if (now < eligibleFrom) {
        return res.status(400).json({ error: `Notice period not yet complete — this loan can be forfeited on or after ${eligibleFrom.toISOString().slice(0, 10)} (${settings.forfeitureNoticeDays} days from the notice)` });
      }
      const { total: accruedInterest } = calcAccruedInterest(loan, now, graceDays);
      const interestBaseline = safeFloat((loan as any).interestBaseline ?? "0");
      // Unfloored on purpose — a baseline above what's been collected is carried-forward
      // unpaid interest, and flooring it here would forgive it. See mapLoan.
      const creditSinceReset = safeFloat(loan.totalInterestCollected) - interestBaseline;
      const outstanding = Math.max(0, accruedInterest - creditSinceReset);
      const principalPaid = safeFloat((loan as any).principalPaid ?? "0");
      const currentPrincipal = Math.max(0, safeFloat(loan.loanAmount) - principalPaid);
      const totalDue = currentPrincipal + outstanding;
      const goldSaleValue = safeFloat(data.goldSaleValue, safeFloat(loan.estimatedValue));
      if (goldSaleValue < 0) return res.status(400).json({ error: "Gold sale value cannot be negative" });
      const lossAmount = Math.max(0, totalDue - goldSaleValue);

      const returnVoucherNumber = await nextGirviNumber(userId, "return", settings.returnPrefix, now, settings.financialYearStartMonth);
      const accts = await getOrCreateDefaultAccounts(userId);
      const forfeitUpdates: Partial<typeof girviLoansTable.$inferInsert> = {
        returnVoucherNumber,
        status: "forfeited",
        redeemedDate: now,
        goldSaleValue: goldSaleValue.toString(),
        lossAmount: lossAmount.toString(),
        // Loan is closed out (via gold sale) — clear the remaining principal so
        // currentPrincipal doesn't keep showing a stale nonzero balance afterwards.
        principalPaid: loan.loanAmount,
        updatedAt: now,
      };

      const updated = await db.transaction(async (tx) => {
        // Anything already released via a prior partial release keeps its own
        // returnedAt from that transaction — closeOutLoanItems only touches
        // items still pledged/transferred.
        await closeOutLoanItems(tx, userId, id, "forfeited", now);
        const [u] = await tx.update(girviLoansTable).set(forfeitUpdates)
          .where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)))
          .returning();

        // Dr Forfeited Gold Stock (goldSaleValue) + Dr Forfeiture Loss (lossAmount) /
        // Cr Girvi Loans Receivable (totalDue) — the shop keeps/sells the collateral
        // instead of the customer repaying; any shortfall is booked as a loss.
        await postJournalEntry(tx, {
          userId,
          voucherDate: now,
          voucherType: "journal",
          narration: `Forfeiture of girvi loan ${loan.loanNumber}`,
          sourceModule: "girvi",
          sourceId: id,
          lines: [
            { accountId: accts.FORFEITED_GOLD_STOCK, debit: goldSaleValue, particulars: "Forfeited collateral retained" },
            { accountId: accts.FORFEITURE_LOSS, debit: lossAmount, particulars: "Shortfall on forfeiture" },
            { accountId: accts.GIRVI_LOANS_RECEIVABLE, credit: totalDue, partyType: "girvi_customer", partyId: loan.customerId ?? undefined, particulars: "Loan closed out" },
          ],
        });

        return u;
      });

      return res.json(mapLoan(updated, now, graceDays));
    } else if (data.status === "extended") {
      if (loan.status !== "active" && loan.status !== "extended") {
        return res.status(400).json({ error: "Only active/extended loans can be extended" });
      }
      updates.status = "extended";
      if (data.newDueDate) {
        const nd = new Date(data.newDueDate);
        if (isNaN(nd.getTime())) return res.status(400).json({ error: "Invalid new due date" });
        // Pushing the due date out changes how much of the accrued interest counts as
        // "normal" vs "penalty" under the recalculation — preserve what's owed right now.
        updates.interestBaseline = preserveOutstandingBaseline(loan, { dueDate: nd }, now, graceDays);
        updates.dueDate = nd;
      }
    } else {
      // General field updates — always safe, no accounting/interest impact.
      if (data.notes !== undefined) updates.notes = String(data.notes).slice(0, MAX_NOTES_LEN) || null;
      if (data.itemDescription !== undefined) updates.itemDescription = String(data.itemDescription).slice(0, 500) || null;
      if (data.customerName !== undefined) {
        const cn = String(data.customerName).trim();
        if (!cn) return res.status(400).json({ error: "Customer name cannot be blank" });
        updates.customerName = cn;
      }
      if (data.customerMobile !== undefined) {
        const cm = String(data.customerMobile).trim();
        if (!cm) return res.status(400).json({ error: "Customer mobile cannot be blank" });
        updates.customerMobile = cm;
      }
      if (data.kycDocType !== undefined) updates.kycDocType = String(data.kycDocType).trim() || null;
      if (data.kycDocNumber !== undefined) updates.kycDocNumber = String(data.kycDocNumber).trim() || null;
      if (data.fatherName !== undefined) updates.fatherName = String(data.fatherName).trim() || null;
      if (data.address !== undefined) updates.address = String(data.address).slice(0, MAX_ADDRESS_LEN) || null;
      if (data.pan !== undefined) updates.pan = String(data.pan).trim().toUpperCase() || null;
      if (data.penaltyRate !== undefined) {
        const pr = safeFloat(data.penaltyRate);
        if (pr < 0 || pr > 100) return res.status(400).json({ error: "Penalty rate must be 0–100" });
        updates.interestBaseline = preserveOutstandingBaseline(loan, { penaltyRate: pr.toString() }, now, graceDays);
        updates.penaltyRate = pr.toString();
      }

      // Correctable-only-before-first-payment terms: loan amount, processing
      // fee, interest rate/period, start date, due date. Once any payment has
      // actually been collected these can no longer move without corrupting
      // interest already accrued/booked against a specific timeline — use the
      // normal business actions (collect/renew/redeem/forfeit/extend) instead.
      const TERM_FIELDS = ["loanAmount", "processingFee", "interestRate", "interestPeriod", "startDate", "dueDate"] as const;
      const wantsTermChange = TERM_FIELDS.some(k => data[k] !== undefined);
      if (wantsTermChange) {
        if (!isLoanEditable(loan)) {
          return res.status(400).json({ error: "This loan already has payment history — loan amount, rate, and dates can no longer be edited directly. Use Renew/Extend/Redeem instead." });
        }
        if (await loanHasPartialReleaseHistory(userId, id)) {
          return res.status(400).json({ error: "Some items on this loan have already been released to the customer — loan amount, rate, and dates can no longer be edited directly." });
        }

        let newLoanAmount = safeFloat(loan.loanAmount);
        let newProcessingFee = safeFloat(loan.processingFee);
        let newInterestRate = safeFloat(loan.interestRate);
        let newInterestPeriod = loan.interestPeriod;
        let newStartDate = new Date(loan.startDate);
        let newDueDateVal = new Date(loan.dueDate);

        if (data.loanAmount !== undefined) {
          newLoanAmount = safeFloat(data.loanAmount);
          if (newLoanAmount <= 0) return res.status(400).json({ error: "Loan amount must be positive" });
        }
        if (data.processingFee !== undefined) {
          newProcessingFee = safeFloat(data.processingFee);
          if (newProcessingFee < 0) return res.status(400).json({ error: "Processing fee cannot be negative" });
        }
        if (data.interestRate !== undefined) {
          newInterestRate = safeFloat(data.interestRate);
          if (newInterestRate < 0 || newInterestRate > 100) return res.status(400).json({ error: "Interest rate must be 0–100" });
        }
        if (data.interestPeriod !== undefined && VALID_PERIODS.has(data.interestPeriod)) {
          newInterestPeriod = data.interestPeriod;
        }
        if (data.startDate !== undefined) {
          newStartDate = new Date(data.startDate);
          if (isNaN(newStartDate.getTime())) return res.status(400).json({ error: "Invalid start date" });
        }
        if (data.dueDate !== undefined) {
          newDueDateVal = new Date(data.dueDate);
          if (isNaN(newDueDateVal.getTime())) return res.status(400).json({ error: "Invalid due date" });
        }
        if (newDueDateVal <= newStartDate) return res.status(400).json({ error: "Due date must be after start date" });
        if (newProcessingFee > newLoanAmount) return res.status(400).json({ error: "Processing fee cannot exceed loan amount" });

        const amountChanged = newLoanAmount !== safeFloat(loan.loanAmount) || newProcessingFee !== safeFloat(loan.processingFee);
        const accts = await getOrCreateDefaultAccounts(userId);

        // No separate audit-log table for these corrections — instead, record a
        // system line directly in the loan's own notes so "what did this loan
        // originally say before it was corrected" stays answerable from the
        // loan record itself. Only lists fields that actually changed.
        const diffParts: string[] = [];
        if (newLoanAmount !== safeFloat(loan.loanAmount)) diffParts.push(`amount ₹${safeFloat(loan.loanAmount)}→₹${newLoanAmount}`);
        if (newProcessingFee !== safeFloat(loan.processingFee)) diffParts.push(`processing fee ₹${safeFloat(loan.processingFee)}→₹${newProcessingFee}`);
        if (newInterestRate !== safeFloat(loan.interestRate)) diffParts.push(`rate ${safeFloat(loan.interestRate)}%→${newInterestRate}%`);
        if (newInterestPeriod !== loan.interestPeriod) diffParts.push(`period ${loan.interestPeriod}→${newInterestPeriod}`);
        if (newStartDate.getTime() !== new Date(loan.startDate).getTime()) diffParts.push(`loan date ${new Date(loan.startDate).toISOString().slice(0, 10)}→${newStartDate.toISOString().slice(0, 10)}`);
        if (newDueDateVal.getTime() !== new Date(loan.dueDate).getTime()) diffParts.push(`due date ${new Date(loan.dueDate).toISOString().slice(0, 10)}→${newDueDateVal.toISOString().slice(0, 10)}`);
        if (diffParts.length > 0) {
          const auditLine = `[Corrected ${now.toISOString().slice(0, 10)}] ${diffParts.join(", ")}`;
          // Base off `updates.notes` if the same request also set notes directly
          // (the general-field-updates branch above runs first), so we don't
          // clobber a notes edit made in the same PATCH call.
          const baseNotes = updates.notes ?? loan.notes;
          updates.notes = (baseNotes ? `${baseNotes}\n${auditLine}` : auditLine).slice(0, MAX_NOTES_LEN);
        }

        const updated = await db.transaction(async tx => {
          if (amountChanged) {
            if (loan.disbursementVoucherId) {
              await reverseVoucherTx(tx, userId, loan.disbursementVoucherId, `Correction of girvi loan ${loan.loanNumber} disbursement`);
            }
            const disbursed = newLoanAmount - newProcessingFee;
            const voucher = await postJournalEntry(tx, {
              userId,
              voucherDate: newStartDate,
              voucherType: "payment",
              narration: `Girvi loan ${loan.loanNumber} disbursement corrected`,
              sourceModule: "girvi",
              sourceId: loan.id,
              lines: [
                { accountId: accts.GIRVI_LOANS_RECEIVABLE, debit: newLoanAmount, partyType: "girvi_customer", partyId: loan.customerId ?? undefined, particulars: "Loan disbursed (corrected)" },
                // Re-post against whichever account the loan was originally disbursed from —
                // this correction only fixes amount/rate/dates, not how the money moved.
                { accountId: await resolveMoneyAccountId(userId, loan.disbursementMode, loan.disbursementBankAccountId, accts, tx), credit: disbursed, particulars: "Disbursed to customer (corrected)" },
                { accountId: accts.PROCESSING_FEE_INCOME, credit: newProcessingFee, particulars: "Processing fee" },
              ],
            });
            updates.disbursementVoucherId = voucher.id;
          }
          updates.loanAmount = newLoanAmount.toString();
          updates.processingFee = newProcessingFee.toString();
          updates.interestRate = newInterestRate.toString();
          updates.interestPeriod = newInterestPeriod;
          updates.startDate = newStartDate;
          updates.dueDate = newDueDateVal;
          updates.updatedAt = now;
          const [u] = await tx.update(girviLoansTable).set(updates)
            .where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)))
            .returning();
          return u;
        });

        return res.json(mapLoan(updated, now, graceDays));
      }
    }

    updates.updatedAt = now;
    const [updated] = await db.update(girviLoansTable).set(updates)
      .where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)))
      .returning();
    res.json(mapLoan(updated, now, graceDays));
  } catch (err) {
    req.log.error({ err }, "Failed to update girvi loan");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Void a loan entered by mistake — e.g. wrong customer selected, duplicate
// entry, or a test entry. Never hard-deletes: the row and its items are kept
// (status flips to "voided") and the original disbursement journal entry is
// reversed via a mirror voucher, exactly like reverseVoucher does for any
// other correction — so the books and the audit trail both stay intact.
// Restricted to loans with zero payment history (see isLoanEditable); once
// real money has moved, redeem/forfeit is the correct way to close it out.
router.delete("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const [loan] = await db.select().from(girviLoansTable).where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)));
    if (!loan) return res.status(404).json({ error: "Not found" });
    if (!isLoanEditable(loan)) {
      return res.status(400).json({ error: "This loan already has payment history and cannot be voided — redeem or forfeit it to close it out instead" });
    }
    if (await loanHasPartialReleaseHistory(userId, id)) {
      return res.status(400).json({ error: "Some items on this loan have already been released to the customer and cannot be un-done — this loan cannot be voided" });
    }

    const now = new Date();
    const updated = await db.transaction(async tx => {
      if (loan.disbursementVoucherId) {
        await reverseVoucherTx(tx, userId, loan.disbursementVoucherId, `Void of girvi loan ${loan.loanNumber}`);
      }
      await closeOutLoanItems(tx, userId, id, "voided", now);
      const [u] = await tx.update(girviLoansTable)
        .set({ status: "voided", updatedAt: now })
        .where(and(eq(girviLoansTable.id, id), eq(girviLoansTable.userId, userId)))
        .returning();
      return u;
    });

    const settings = await getOrCreateGirviSettings(userId);
    res.json(mapLoan(updated, now, settings.overdueGraceDays));
  } catch (err) {
    req.log.error({ err }, "Failed to void girvi loan");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
