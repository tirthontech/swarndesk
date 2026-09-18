import { Router } from "express";
import { db } from "@workspace/db";
import {
  chartOfAccountsTable, journalVouchersTable, journalLinesTable,
  salesTable, girviLoansTable, customOrdersTable, purchasesTable, repairJobsTable,
  repairPaymentTransactionsTable, customersTable, businessSettingsTable, paymentTransactionsTable,
  suppliersTable, karigarsTable,
} from "@workspace/db";
import { eq, and, gte, lte, lt, asc, sql, inArray, isNotNull } from "drizzle-orm";
import { safeFloat, getOrCreateDefaultAccounts } from "./accounting-helpers";
import { mapLoan, getOrCreateGirviSettings } from "./girvi-helpers";

const router = Router();

type Side = "debit" | "credit";

function normalSideForAccountType(accountType: string): Side {
  return accountType === "liability" || accountType === "equity" || accountType === "income" ? "credit" : "debit";
}
function normalSideForParty(partyType: string): Side {
  return partyType === "supplier" || partyType === "karigar" ? "credit" : "debit";
}
function lineDelta(debit: number, credit: number, side: Side): number {
  return side === "debit" ? debit - credit : credit - debit;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function parseAsOf(raw: string | undefined): Date {
  const d = raw ? new Date(raw) : new Date();
  const valid = isNaN(d.getTime()) ? new Date() : d;
  valid.setHours(23, 59, 59, 999);
  return valid;
}
function parseDateRange(req: { query: Record<string, unknown> }) {
  const { from, to } = req.query as Record<string, string>;
  const fromDate = from ? new Date(from) : new Date(0);
  const toDate = to ? new Date(to) : new Date();
  if (isNaN(fromDate.getTime())) fromDate.setTime(0);
  if (isNaN(toDate.getTime())) toDate.setTime(Date.now());
  toDate.setHours(23, 59, 59, 999);
  return { fromDate, toDate };
}

// Same state (or either side's state code unknown) -> CGST+SGST 50/50. Different state -> IGST.
function splitGst(gstAmount: number, shopStateCode: string | null | undefined, customerStateCode: string | null | undefined) {
  const interState = !!shopStateCode && !!customerStateCode && shopStateCode !== customerStateCode;
  if (interState) return { cgst: 0, sgst: 0, igst: gstAmount };
  return { cgst: round2(gstAmount / 2), sgst: round2(gstAmount / 2), igst: 0 };
}

const SALES_HSN_CODE = "7113"; // finished jewellery — every sale line item today is a finished piece
function purchaseHsn(metalType: string): string {
  return metalType === "silver" ? "7106" : "7108";
}

// Shared by /ledger, /cash-book, /bank-book — builds a running-balance ledger for one account.
async function buildAccountLedger(userId: number, account: typeof chartOfAccountsTable.$inferSelect, fromDate: Date | null, toDate: Date | null) {
  const side = normalSideForAccountType(account.accountType);
  const openingRaw = safeFloat(account.openingBalance);
  let opening = account.openingBalanceType === side ? openingRaw : -openingRaw;

  if (fromDate) {
    const [before] = await db.select({
      debit: sql<string>`coalesce(sum(${journalLinesTable.debit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLinesTable.credit}), 0)`,
    }).from(journalLinesTable)
      .innerJoin(journalVouchersTable, eq(journalLinesTable.voucherId, journalVouchersTable.id))
      .where(and(
        eq(journalLinesTable.userId, userId),
        eq(journalLinesTable.accountId, account.id),
        lt(journalVouchersTable.voucherDate, fromDate),
      ));
    opening += lineDelta(safeFloat(before?.debit), safeFloat(before?.credit), side);
  }

  const conditions = [eq(journalLinesTable.userId, userId), eq(journalLinesTable.accountId, account.id)];
  if (fromDate) conditions.push(gte(journalVouchersTable.voucherDate, fromDate));
  if (toDate) conditions.push(lte(journalVouchersTable.voucherDate, toDate));

  const rows = await db.select({
    voucherId: journalVouchersTable.id,
    voucherNumber: journalVouchersTable.voucherNumber,
    voucherDate: journalVouchersTable.voucherDate,
    voucherType: journalVouchersTable.voucherType,
    narration: journalVouchersTable.narration,
    debit: journalLinesTable.debit,
    credit: journalLinesTable.credit,
    particulars: journalLinesTable.particulars,
  }).from(journalLinesTable)
    .innerJoin(journalVouchersTable, eq(journalLinesTable.voucherId, journalVouchersTable.id))
    .where(and(...conditions))
    .orderBy(asc(journalVouchersTable.voucherDate), asc(journalVouchersTable.id));

  let running = opening;
  const entries = rows.map(r => {
    const debit = safeFloat(r.debit);
    const credit = safeFloat(r.credit);
    running += lineDelta(debit, credit, side);
    return {
      voucherId: r.voucherId,
      voucherNumber: r.voucherNumber,
      voucherDate: r.voucherDate.toISOString(),
      voucherType: r.voucherType,
      narration: r.narration,
      particulars: r.particulars,
      debit, credit,
      balance: round2(running),
    };
  });

  return {
    account: { id: account.id, code: account.code, name: account.name, accountType: account.accountType },
    openingBalance: round2(opening),
    entries,
    closingBalance: round2(running),
  };
}

// GET /ledger?accountId=&from=&to=
router.get("/ledger", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const accountId = parseInt(String(req.query.accountId));
    if (isNaN(accountId)) return res.status(400).json({ error: "accountId is required" });
    const [account] = await db.select().from(chartOfAccountsTable)
      .where(and(eq(chartOfAccountsTable.id, accountId), eq(chartOfAccountsTable.userId, userId)));
    if (!account) return res.status(404).json({ error: "Account not found" });
    const { from, to } = req.query as Record<string, string>;
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? (() => { const d = new Date(to); d.setHours(23, 59, 59, 999); return d; })() : null;
    res.json(await buildAccountLedger(userId, account, fromDate, toDate));
  } catch (err) {
    req.log.error({ err }, "Failed to build ledger");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /cash-book?from=&to=  |  GET /bank-book?from=&to=
async function bookHandler(req: any, res: any, key: "CASH" | "BANK") {
  try {
    const userId = req.user!.userId;
    const accounts = await getOrCreateDefaultAccounts(userId);
    const [account] = await db.select().from(chartOfAccountsTable)
      .where(and(eq(chartOfAccountsTable.id, accounts[key]), eq(chartOfAccountsTable.userId, userId)));
    if (!account) return res.status(404).json({ error: "Account not found" });
    const { from, to } = req.query as Record<string, string>;
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? (() => { const d = new Date(to); d.setHours(23, 59, 59, 999); return d; })() : null;
    res.json(await buildAccountLedger(userId, account, fromDate, toDate));
  } catch (err) {
    req.log.error({ err }, `Failed to build ${key.toLowerCase()} book`);
    res.status(500).json({ error: "Internal server error" });
  }
}
router.get("/cash-book", (req, res) => bookHandler(req, res, "CASH"));
router.get("/bank-book", (req, res) => bookHandler(req, res, "BANK"));

// GET /party-ledger?partyType=&partyId=&from=&to=
router.get("/party-ledger", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { partyType, from, to } = req.query as Record<string, string>;
    const partyId = parseInt(String(req.query.partyId));
    if (!["customer", "supplier", "karigar", "girvi_customer"].includes(partyType)) {
      return res.status(400).json({ error: "Invalid partyType" });
    }
    if (isNaN(partyId)) return res.status(400).json({ error: "partyId is required" });
    const side = normalSideForParty(partyType);
    const fromDate = from ? new Date(from) : null;
    const toDate = to ? (() => { const d = new Date(to); d.setHours(23, 59, 59, 999); return d; })() : null;

    // What this party already owed (or was owed) before the shop started using the app —
    // set once on the customer/supplier/karigar record, never touched by any transaction.
    let opening = 0;
    if (partyType === "customer") {
      const [c] = await db.select({ balance: customersTable.balance }).from(customersTable)
        .where(and(eq(customersTable.id, partyId), eq(customersTable.userId, userId)));
      // customersTable.balance sign convention: positive = advance (shop owes customer, a
      // credit), negative = due (customer owes shop, a debit) — opposite of this debit-normal ledger.
      if (c) opening += -safeFloat(c.balance);
    } else if (partyType === "supplier") {
      const [s] = await db.select({ openingBalance: suppliersTable.openingBalance, openingBalanceType: suppliersTable.openingBalanceType })
        .from(suppliersTable).where(and(eq(suppliersTable.id, partyId), eq(suppliersTable.userId, userId)));
      if (s) { const mag = safeFloat(s.openingBalance); opening += s.openingBalanceType === side ? mag : -mag; }
    } else if (partyType === "karigar") {
      const [k] = await db.select({ openingBalance: karigarsTable.openingBalance, openingBalanceType: karigarsTable.openingBalanceType })
        .from(karigarsTable).where(and(eq(karigarsTable.id, partyId), eq(karigarsTable.userId, userId)));
      if (k) { const mag = safeFloat(k.openingBalance); opening += k.openingBalanceType === side ? mag : -mag; }
    }

    if (fromDate) {
      const [before] = await db.select({
        debit: sql<string>`coalesce(sum(${journalLinesTable.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${journalLinesTable.credit}), 0)`,
      }).from(journalLinesTable)
        .innerJoin(journalVouchersTable, eq(journalLinesTable.voucherId, journalVouchersTable.id))
        .where(and(
          eq(journalLinesTable.userId, userId), eq(journalLinesTable.partyType, partyType), eq(journalLinesTable.partyId, partyId),
          lt(journalVouchersTable.voucherDate, fromDate),
        ));
      opening += lineDelta(safeFloat(before?.debit), safeFloat(before?.credit), side);
    }

    const conditions = [eq(journalLinesTable.userId, userId), eq(journalLinesTable.partyType, partyType), eq(journalLinesTable.partyId, partyId)];
    if (fromDate) conditions.push(gte(journalVouchersTable.voucherDate, fromDate));
    if (toDate) conditions.push(lte(journalVouchersTable.voucherDate, toDate));
    const rows = await db.select({
      voucherId: journalVouchersTable.id,
      voucherNumber: journalVouchersTable.voucherNumber,
      voucherDate: journalVouchersTable.voucherDate,
      voucherType: journalVouchersTable.voucherType,
      narration: journalVouchersTable.narration,
      debit: journalLinesTable.debit,
      credit: journalLinesTable.credit,
      particulars: journalLinesTable.particulars,
    }).from(journalLinesTable)
      .innerJoin(journalVouchersTable, eq(journalLinesTable.voucherId, journalVouchersTable.id))
      .where(and(...conditions))
      .orderBy(asc(journalVouchersTable.voucherDate), asc(journalVouchersTable.id));

    let running = opening;
    const entries = rows.map(r => {
      const debit = safeFloat(r.debit);
      const credit = safeFloat(r.credit);
      running += lineDelta(debit, credit, side);
      return {
        voucherId: r.voucherId, voucherNumber: r.voucherNumber, voucherDate: r.voucherDate.toISOString(),
        voucherType: r.voucherType, narration: r.narration, particulars: r.particulars,
        debit, credit, balance: round2(running),
      };
    });

    res.json({ partyType, partyId, openingBalance: round2(opening), entries, closingBalance: round2(running) });
  } catch (err) {
    req.log.error({ err }, "Failed to build party ledger");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /day-book?date=
router.get("/day-book", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { date } = req.query as Record<string, string>;
    const d = date ? new Date(date) : new Date();
    const start = new Date(isNaN(d.getTime()) ? new Date() : d); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setHours(23, 59, 59, 999);

    const vouchers = await db.select().from(journalVouchersTable)
      .where(and(eq(journalVouchersTable.userId, userId), gte(journalVouchersTable.voucherDate, start), lte(journalVouchersTable.voucherDate, end)))
      .orderBy(asc(journalVouchersTable.voucherDate));
    if (vouchers.length === 0) return res.json([]);

    const lines = await db.select().from(journalLinesTable)
      .where(and(eq(journalLinesTable.userId, userId), inArray(journalLinesTable.voucherId, vouchers.map(v => v.id))));
    const accounts = await db.select().from(chartOfAccountsTable).where(eq(chartOfAccountsTable.userId, userId));
    const accountById = new Map(accounts.map(a => [a.id, a]));
    const linesByVoucher = new Map<number, typeof lines>();
    for (const l of lines) {
      const arr = linesByVoucher.get(l.voucherId) ?? [];
      arr.push(l);
      linesByVoucher.set(l.voucherId, arr);
    }

    res.json(vouchers.map(v => ({
      id: v.id, voucherNumber: v.voucherNumber, voucherType: v.voucherType,
      voucherDate: v.voucherDate.toISOString(), narration: v.narration, sourceModule: v.sourceModule,
      lines: (linesByVoucher.get(v.id) ?? []).map(l => {
        const acc = accountById.get(l.accountId);
        return { accountName: acc?.name ?? "—", accountCode: acc?.code ?? "—", debit: safeFloat(l.debit), credit: safeFloat(l.credit), particulars: l.particulars };
      }),
    })));
  } catch (err) {
    req.log.error({ err }, "Failed to build day book");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /trial-balance?asOf=
router.get("/trial-balance", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const asOfDate = parseAsOf((req.query as Record<string, string>).asOf);
    const accounts = await db.select().from(chartOfAccountsTable).where(eq(chartOfAccountsTable.userId, userId)).orderBy(asc(chartOfAccountsTable.code));

    const sums = await db.select({
      accountId: journalLinesTable.accountId,
      debit: sql<string>`coalesce(sum(${journalLinesTable.debit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLinesTable.credit}), 0)`,
    }).from(journalLinesTable)
      .innerJoin(journalVouchersTable, eq(journalLinesTable.voucherId, journalVouchersTable.id))
      .where(and(eq(journalLinesTable.userId, userId), lte(journalVouchersTable.voucherDate, asOfDate)))
      .groupBy(journalLinesTable.accountId);
    const sumByAccount = new Map(sums.map(s => [s.accountId, s]));

    let totalDebit = 0, totalCredit = 0;
    const rows = accounts.map(a => {
      const s = sumByAccount.get(a.id);
      const openingRaw = safeFloat(a.openingBalance);
      const debit = safeFloat(s?.debit) + (a.openingBalanceType === "debit" ? openingRaw : 0);
      const credit = safeFloat(s?.credit) + (a.openingBalanceType === "credit" ? openingRaw : 0);
      const net = debit - credit;
      const rowDebit = net > 0 ? net : 0;
      const rowCredit = net < 0 ? -net : 0;
      totalDebit += rowDebit;
      totalCredit += rowCredit;
      return { accountId: a.id, code: a.code, name: a.name, accountType: a.accountType, debit: round2(rowDebit), credit: round2(rowCredit) };
    }).filter(r => r.debit > 0.001 || r.credit > 0.001);

    res.json({ asOf: asOfDate.toISOString(), rows, totalDebit: round2(totalDebit), totalCredit: round2(totalCredit), balanced: Math.abs(totalDebit - totalCredit) < 0.01 });
  } catch (err) {
    req.log.error({ err }, "Failed to build trial balance");
    res.status(500).json({ error: "Internal server error" });
  }
});

async function netByAccountType(userId: number, types: string[], upTo: Date, from?: Date) {
  const accounts = await db.select().from(chartOfAccountsTable)
    .where(and(eq(chartOfAccountsTable.userId, userId), inArray(chartOfAccountsTable.accountType, types)));
  if (accounts.length === 0) return { accounts, sumByAccount: new Map() };
  const conditions = [eq(journalLinesTable.userId, userId), inArray(journalLinesTable.accountId, accounts.map(a => a.id)), lte(journalVouchersTable.voucherDate, upTo)];
  if (from) conditions.push(gte(journalVouchersTable.voucherDate, from));
  const sums = await db.select({
    accountId: journalLinesTable.accountId,
    debit: sql<string>`coalesce(sum(${journalLinesTable.debit}), 0)`,
    credit: sql<string>`coalesce(sum(${journalLinesTable.credit}), 0)`,
  }).from(journalLinesTable)
    .innerJoin(journalVouchersTable, eq(journalLinesTable.voucherId, journalVouchersTable.id))
    .where(and(...conditions))
    .groupBy(journalLinesTable.accountId);
  return { accounts, sumByAccount: new Map(sums.map(s => [s.accountId, s])) };
}

// GET /profit-loss?from=&to=
router.get("/profit-loss", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { fromDate, toDate } = parseDateRange(req);
    const { accounts, sumByAccount } = await netByAccountType(userId, ["income", "expense"], toDate, fromDate);

    const income: Array<{ accountId: number; code: string; name: string; amount: number }> = [];
    const expense: Array<{ accountId: number; code: string; name: string; amount: number }> = [];
    for (const a of accounts) {
      const s = sumByAccount.get(a.id);
      const debit = safeFloat(s?.debit);
      const credit = safeFloat(s?.credit);
      if (a.accountType === "income") {
        const amount = round2(credit - debit);
        if (Math.abs(amount) > 0.001) income.push({ accountId: a.id, code: a.code, name: a.name, amount });
      } else {
        const amount = round2(debit - credit);
        if (Math.abs(amount) > 0.001) expense.push({ accountId: a.id, code: a.code, name: a.name, amount });
      }
    }
    const totalIncome = round2(income.reduce((s, r) => s + r.amount, 0));
    const totalExpense = round2(expense.reduce((s, r) => s + r.amount, 0));
    res.json({
      period: { from: fromDate.toISOString(), to: toDate.toISOString() },
      income, expense, totalIncome, totalExpense, netProfit: round2(totalIncome - totalExpense),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to build P&L");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /balance-sheet?asOf=
router.get("/balance-sheet", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const asOfDate = parseAsOf((req.query as Record<string, string>).asOf);

    const { accounts, sumByAccount } = await netByAccountType(userId, ["asset", "liability", "equity"], asOfDate);
    const build = (accountType: string) => accounts.filter(a => a.accountType === accountType).map(a => {
      const s = sumByAccount.get(a.id);
      const openingRaw = safeFloat(a.openingBalance);
      const side = normalSideForAccountType(accountType);
      const debit = safeFloat(s?.debit) + (a.openingBalanceType === "debit" ? openingRaw : 0);
      const credit = safeFloat(s?.credit) + (a.openingBalanceType === "credit" ? openingRaw : 0);
      const balance = round2(side === "debit" ? debit - credit : credit - debit);
      return { accountId: a.id, code: a.code, name: a.name, balance };
    }).filter(r => Math.abs(r.balance) > 0.001);

    const assets = build("asset");
    const liabilities = build("liability");
    const equity = build("equity");

    // Cumulative profit/loss since inception, rolled into equity as Retained Earnings —
    // otherwise the balance sheet would never balance since P&L accounts aren't asset/liability/equity.
    const { accounts: plAccounts, sumByAccount: plSums } = await netByAccountType(userId, ["income", "expense"], asOfDate);
    let retainedEarnings = 0;
    for (const a of plAccounts) {
      const s = plSums.get(a.id);
      const debit = safeFloat(s?.debit);
      const credit = safeFloat(s?.credit);
      retainedEarnings += a.accountType === "income" ? (credit - debit) : -(debit - credit);
    }
    retainedEarnings = round2(retainedEarnings);
    if (Math.abs(retainedEarnings) > 0.001) {
      equity.push({ accountId: 0, code: "RE", name: "Retained Earnings (Profit & Loss to date)", balance: retainedEarnings });
    }

    const totalAssets = round2(assets.reduce((s, r) => s + r.balance, 0));
    const totalLiabilities = round2(liabilities.reduce((s, r) => s + r.balance, 0));
    const totalEquity = round2(equity.reduce((s, r) => s + r.balance, 0));

    res.json({
      asOf: asOfDate.toISOString(),
      assets, liabilities, equity,
      totalAssets, totalLiabilities, totalEquity,
      balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 1,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to build balance sheet");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /outstanding — cross-module debtors & creditors. Reads source tables directly
// (not the ledger) since it needs live computed fields like Girvi's accrued interest.
router.get("/outstanding", async (req, res) => {
  try {
    const userId = req.user!.userId;

    // Every row read here is reduced to {name, reference, amount} below, so each query
    // selects only the columns that actually feed that — `select()` with no projection
    // fetches every column of these very wide tables (sales and purchases carry 20+),
    // which is pure wire and parse cost for data that is then dropped.
    //
    // The custom-order and purchase filters used to be "everything this shop ever
    // recorded", narrowed in JS afterwards. Both now discard settled rows in SQL, so the
    // work stops growing with the shop's history and stays proportional to what is
    // genuinely still outstanding. The predicates mirror the old JS filters exactly:
    // a purchase with a NULL paidAmount was treated as fully paid, and a custom order
    // priced at final -> agreed -> estimated, first non-zero winning.
    const outstandingOrderValue = sql`
      coalesce(nullif(${customOrdersTable.finalPrice}, 0),
               nullif(${customOrdersTable.agreedPrice}, 0),
               ${customOrdersTable.estimatedPrice}, 0)
      - coalesce(${customOrdersTable.advancePaid}, 0)`;
    const [pendingSales, activeLoans, openCustomOrders, unpaidPurchases, unpaidRepairs, allCustomers, allSuppliers, allKarigars] = await Promise.all([
      db.select({
        id: salesTable.id, customerName: salesTable.customerName, invoiceNumber: salesTable.invoiceNumber,
        totalAmount: salesTable.totalAmount, paidAmount: salesTable.paidAmount,
      }).from(salesTable).where(and(eq(salesTable.userId, userId), inArray(salesTable.paymentStatus, ["partial", "pending"]))),
      db.select().from(girviLoansTable).where(and(eq(girviLoansTable.userId, userId), inArray(girviLoansTable.status, ["active", "extended"]))),
      db.select({
        id: customOrdersTable.id, customerName: customOrdersTable.customerName,
        orderNumber: customOrdersTable.orderNumber, outstanding: sql<string>`${outstandingOrderValue}`,
      }).from(customOrdersTable)
        .where(and(eq(customOrdersTable.userId, userId), sql`${outstandingOrderValue} > 0.01`)),
      db.select({
        id: purchasesTable.id, supplierName: purchasesTable.supplierName,
        invoiceNumber: purchasesTable.invoiceNumber, totalAmount: purchasesTable.totalAmount,
        paidAmount: purchasesTable.paidAmount,
      }).from(purchasesTable)
        .where(and(
          eq(purchasesTable.userId, userId),
          isNotNull(purchasesTable.paidAmount),
          sql`${purchasesTable.totalAmount} - ${purchasesTable.paidAmount} > 0.01`,
        )),
      db.select({
        id: repairJobsTable.id, customerName: repairJobsTable.customerName,
        actualCost: repairJobsTable.actualCost, estimatedCost: repairJobsTable.estimatedCost,
      }).from(repairJobsTable).where(and(eq(repairJobsTable.userId, userId), inArray(repairJobsTable.status, ["ready", "delivered"]))),
      db.select({ id: customersTable.id, name: customersTable.name, balance: customersTable.balance }).from(customersTable).where(eq(customersTable.userId, userId)),
      db.select({ id: suppliersTable.id, name: suppliersTable.name, openingBalance: suppliersTable.openingBalance, openingBalanceType: suppliersTable.openingBalanceType }).from(suppliersTable).where(eq(suppliersTable.userId, userId)),
      db.select({ id: karigarsTable.id, name: karigarsTable.name, openingBalance: karigarsTable.openingBalance, openingBalanceType: karigarsTable.openingBalanceType }).from(karigarsTable).where(eq(karigarsTable.userId, userId)),
    ]);

    const debtorsSales = pendingSales.map(s => ({
      type: "sale" as const, id: s.id, name: s.customerName,
      reference: s.invoiceNumber, amount: round2(safeFloat(s.totalAmount) - safeFloat(s.paidAmount)),
    })).filter(r => r.amount > 0.01);

    const girviSettings = await getOrCreateGirviSettings(userId);
    const debtorsGirvi = activeLoans.map(l => {
      const m = mapLoan(l, new Date(), girviSettings.overdueGraceDays);
      return { type: "girvi_loan" as const, id: l.id, name: l.customerName, reference: l.loanNumber, amount: round2(m.totalDue) };
    }).filter(r => r.amount > 0.01);

    const debtorsCustomOrders = openCustomOrders.map(o => ({
      type: "custom_order" as const, id: o.id, name: o.customerName,
      reference: o.orderNumber, amount: round2(safeFloat(o.outstanding)),
    })).filter(r => r.amount > 0.01 && r.reference);

    const repairIds = unpaidRepairs.map(r => r.id);
    const repairPaidRows = repairIds.length > 0
      ? await db.select({
          repairJobId: repairPaymentTransactionsTable.repairJobId,
          paid: sql<string>`coalesce(sum(${repairPaymentTransactionsTable.amount}), 0)`,
        }).from(repairPaymentTransactionsTable)
          .where(and(eq(repairPaymentTransactionsTable.userId, userId), inArray(repairPaymentTransactionsTable.repairJobId, repairIds)))
          .groupBy(repairPaymentTransactionsTable.repairJobId)
      : [];
    const repairPaidById = new Map(repairPaidRows.map(r => [r.repairJobId, safeFloat(r.paid)]));
    const debtorsRepairs = unpaidRepairs.map(r => {
      const cost = safeFloat(r.actualCost) || safeFloat(r.estimatedCost);
      const paid = repairPaidById.get(r.id) ?? 0;
      return { type: "repair" as const, id: r.id, name: r.customerName, reference: `Repair #${r.id}`, amount: round2(cost - paid) };
    }).filter(r => r.amount > 0.01);

    const creditorsPurchases = unpaidPurchases.map(p => ({
      type: "purchase" as const, id: p.id, name: p.supplierName, reference: p.invoiceNumber,
      amount: round2(safeFloat(p.totalAmount) - safeFloat(p.paidAmount)),
    })).filter(r => r.amount > 0.01);

    // Pre-software opening balances — not tied to any live sale/purchase/loan row, so they
    // wouldn't otherwise show up here at all. A customer's positive balance is an advance
    // (shop owes them, not a debtor); a negative balance is what they still owe (a debtor).
    const debtorsOpeningCustomers = allCustomers.map(c => ({
      type: "opening_balance" as const, id: c.id, name: c.name, reference: "Opening balance", amount: round2(-safeFloat(c.balance)),
    })).filter(r => r.amount > 0.01);
    const debtorsOpeningSuppliers = allSuppliers.filter(s => s.openingBalanceType === "debit" && safeFloat(s.openingBalance) > 0.01).map(s => ({
      type: "opening_balance" as const, id: s.id, name: s.name, reference: "Opening balance (advance paid)", amount: round2(safeFloat(s.openingBalance)),
    }));
    const debtorsOpeningKarigars = allKarigars.filter(k => k.openingBalanceType === "debit" && safeFloat(k.openingBalance) > 0.01).map(k => ({
      type: "opening_balance" as const, id: k.id, name: k.name, reference: "Opening balance (advance paid)", amount: round2(safeFloat(k.openingBalance)),
    }));
    const creditorsOpeningSuppliers = allSuppliers.filter(s => s.openingBalanceType === "credit" && safeFloat(s.openingBalance) > 0.01).map(s => ({
      type: "opening_balance" as const, id: s.id, name: s.name, reference: "Opening balance", amount: round2(safeFloat(s.openingBalance)),
    }));
    const creditorsOpeningKarigars = allKarigars.filter(k => k.openingBalanceType === "credit" && safeFloat(k.openingBalance) > 0.01).map(k => ({
      type: "opening_balance" as const, id: k.id, name: k.name, reference: "Opening balance (wages due)", amount: round2(safeFloat(k.openingBalance)),
    }));

    const debtors = [...debtorsSales, ...debtorsGirvi, ...debtorsCustomOrders, ...debtorsRepairs, ...debtorsOpeningCustomers, ...debtorsOpeningSuppliers, ...debtorsOpeningKarigars];
    const creditors = [...creditorsPurchases, ...creditorsOpeningSuppliers, ...creditorsOpeningKarigars];

    res.json({
      debtors, creditors,
      totalDebtors: round2(debtors.reduce((s, r) => s + r.amount, 0)),
      totalCreditors: round2(creditors.reduce((s, r) => s + r.amount, 0)),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to build outstanding report");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /gstr3b?from=&to= — outward tax (from sales) vs. input tax credit (from purchases),
// net payable = output - ITC. The GSTR-3B summary a shop files monthly/quarterly.
router.get("/gstr3b", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { fromDate, toDate } = parseDateRange(req);
    const [settings] = await db.select().from(businessSettingsTable).where(eq(businessSettingsTable.userId, userId));
    const shopStateCode = settings?.stateCode ?? null;

    const sales = await db.select().from(salesTable)
      .where(and(eq(salesTable.userId, userId), gte(salesTable.saleDate, fromDate), lte(salesTable.saleDate, toDate), eq(salesTable.status, "completed")));
    const customerIds = [...new Set(sales.map(s => s.customerId).filter((id): id is number => id != null))];
    const customers = customerIds.length > 0 ? await db.select().from(customersTable).where(and(eq(customersTable.userId, userId), inArray(customersTable.id, customerIds))) : [];
    const customerById = new Map(customers.map(c => [c.id, c]));

    let taxableValue = 0, cgst = 0, sgst = 0, igst = 0;
    for (const s of sales) {
      const gst = safeFloat(s.gstAmount);
      const total = safeFloat(s.totalAmount);
      taxableValue += total - gst;
      const customer = s.customerId != null ? customerById.get(s.customerId) : undefined;
      const split = splitGst(gst, shopStateCode, customer?.stateCode);
      cgst += split.cgst; sgst += split.sgst; igst += split.igst;
    }
    const outputTax = round2(cgst + sgst + igst);

    const purchases = await db.select().from(purchasesTable)
      .where(and(eq(purchasesTable.userId, userId), gte(purchasesTable.purchaseDate, fromDate), lte(purchasesTable.purchaseDate, toDate), sql`${purchasesTable.cancelledAt} IS NULL`));
    const itc = round2(purchases.reduce((s, p) => s + (p.gstAmount !== null ? safeFloat(p.gstAmount) : 0), 0));

    res.json({
      period: { from: fromDate.toISOString(), to: toDate.toISOString() },
      outwardTaxableValue: round2(taxableValue),
      cgst: round2(cgst), sgst: round2(sgst), igst: round2(igst), outputTax,
      inputTaxCredit: itc,
      netTaxPayable: round2(Math.max(0, outputTax - itc)),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to build GSTR-3B summary");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /hsn-summary?from=&to= — HSN-wise rollup across sales (finished jewellery, 7113) and
// purchases (bullion, 7108/7106), each with taxable value and tax.
router.get("/hsn-summary", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { fromDate, toDate } = parseDateRange(req);

    const sales = await db.select().from(salesTable)
      .where(and(eq(salesTable.userId, userId), gte(salesTable.saleDate, fromDate), lte(salesTable.saleDate, toDate), eq(salesTable.status, "completed")));
    const salesTaxable = sales.reduce((s, x) => s + (safeFloat(x.totalAmount) - safeFloat(x.gstAmount)), 0);
    const salesTax = sales.reduce((s, x) => s + safeFloat(x.gstAmount), 0);

    const purchases = await db.select().from(purchasesTable)
      .where(and(eq(purchasesTable.userId, userId), gte(purchasesTable.purchaseDate, fromDate), lte(purchasesTable.purchaseDate, toDate), sql`${purchasesTable.cancelledAt} IS NULL`));
    const byHsn = new Map<string, { taxableValue: number; tax: number; count: number }>();
    if (sales.length > 0) byHsn.set(SALES_HSN_CODE, { taxableValue: round2(salesTaxable), tax: round2(salesTax), count: sales.length });
    for (const p of purchases) {
      if (p.gstAmount === null) continue; // no GST recorded on this purchase — nothing to roll up
      const hsn = p.hsnCode ?? purchaseHsn(p.metalType);
      const entry = byHsn.get(hsn) ?? { taxableValue: 0, tax: 0, count: 0 };
      entry.taxableValue += safeFloat(p.taxableValue);
      entry.tax += safeFloat(p.gstAmount);
      entry.count += 1;
      byHsn.set(hsn, entry);
    }

    res.json({
      period: { from: fromDate.toISOString(), to: toDate.toISOString() },
      rows: Array.from(byHsn.entries()).map(([hsnCode, v]) => ({
        hsnCode, description: hsnCode === SALES_HSN_CODE ? "Jewellery (finished)" : hsnCode === "7106" ? "Silver (bullion)" : "Gold (bullion)",
        count: v.count, taxableValue: round2(v.taxableValue), tax: round2(v.tax),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to build HSN summary");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /purchase-register?from=&to= — GST-wise purchase listing, supplier + HSN + tax breakdown.
router.get("/purchase-register", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { fromDate, toDate } = parseDateRange(req);
    const purchases = await db.select().from(purchasesTable)
      .where(and(eq(purchasesTable.userId, userId), gte(purchasesTable.purchaseDate, fromDate), lte(purchasesTable.purchaseDate, toDate)))
      .orderBy(asc(purchasesTable.purchaseDate));
    res.json(purchases.map(p => ({
      id: p.id, invoiceNumber: p.invoiceNumber, purchaseDate: p.purchaseDate.toISOString(),
      supplierName: p.supplierName, metalType: p.metalType, hsnCode: p.hsnCode ?? purchaseHsn(p.metalType),
      taxableValue: p.taxableValue !== null ? safeFloat(p.taxableValue) : safeFloat(p.totalAmount),
      gstRate: p.gstRate !== null ? safeFloat(p.gstRate) : null,
      gstAmount: p.gstAmount !== null ? safeFloat(p.gstAmount) : 0,
      totalAmount: safeFloat(p.totalAmount), cancelled: !!p.cancelledAt,
    })));
  } catch (err) {
    req.log.error({ err }, "Failed to build purchase register");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /sales-register?from=&to= — GST-wise sales listing, B2B (customer GSTIN on file) vs B2C.
router.get("/sales-register", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { fromDate, toDate } = parseDateRange(req);
    const [settings] = await db.select().from(businessSettingsTable).where(eq(businessSettingsTable.userId, userId));
    const shopStateCode = settings?.stateCode ?? null;

    const sales = await db.select().from(salesTable)
      .where(and(eq(salesTable.userId, userId), gte(salesTable.saleDate, fromDate), lte(salesTable.saleDate, toDate)))
      .orderBy(asc(salesTable.saleDate));
    const customerIds = [...new Set(sales.map(s => s.customerId).filter((id): id is number => id != null))];
    const customers = customerIds.length > 0 ? await db.select().from(customersTable).where(and(eq(customersTable.userId, userId), inArray(customersTable.id, customerIds))) : [];
    const customerById = new Map(customers.map(c => [c.id, c]));

    res.json(sales.map(s => {
      const customer = s.customerId != null ? customerById.get(s.customerId) : undefined;
      const gst = safeFloat(s.gstAmount);
      const split = splitGst(gst, shopStateCode, customer?.stateCode);
      return {
        id: s.id, invoiceNumber: s.invoiceNumber, saleDate: s.saleDate.toISOString(),
        customerName: s.customerName, customerGstin: customer?.gstin ?? null,
        isB2B: !!customer?.gstin, hsnCode: SALES_HSN_CODE,
        taxableValue: round2(safeFloat(s.totalAmount) - gst),
        cgst: split.cgst, sgst: split.sgst, igst: split.igst, gstAmount: gst,
        totalAmount: safeFloat(s.totalAmount), status: s.status,
      };
    }));
  } catch (err) {
    req.log.error({ err }, "Failed to build sales register");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /cash-compliance?from=&to= — same-day cash receipts per customer above the shop's
// configured limit, flagged for TCS/Sec.269ST awareness. Mirrors girvi-reports.ts's
// equivalent report, applied here to regular sales payments.
router.get("/cash-compliance", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { fromDate, toDate } = parseDateRange(req);
    const [settings] = await db.select().from(businessSettingsTable).where(eq(businessSettingsTable.userId, userId));
    const limit = settings ? safeFloat(settings.cashTransactionLimit, 200000) : 200000;

    const payments = await db.select().from(paymentTransactionsTable)
      .where(and(eq(paymentTransactionsTable.userId, userId), eq(paymentTransactionsTable.paymentMode, "cash"), gte(paymentTransactionsTable.paidAt, fromDate), lte(paymentTransactionsTable.paidAt, toDate)));

    const byCustomerDay = new Map<string, { customerName: string; date: string; total: number }>();
    for (const p of payments) {
      const day = p.paidAt.toISOString().slice(0, 10);
      const key = `${p.customerName}|${day}`;
      const entry = byCustomerDay.get(key) ?? { customerName: p.customerName, date: day, total: 0 };
      entry.total += safeFloat(p.amount);
      byCustomerDay.set(key, entry);
    }

    const flagged = Array.from(byCustomerDay.values()).filter(e => e.total > limit).sort((a, b) => b.total - a.total);
    res.json({ limit, flagged });
  } catch (err) {
    req.log.error({ err }, "Failed to build cash compliance report");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
