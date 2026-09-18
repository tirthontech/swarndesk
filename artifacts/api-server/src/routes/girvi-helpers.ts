import { db } from "@workspace/db";
import { girviLoansTable, girviCountersTable, girviBranchesTable, girviSettingsTable, businessSettingsTable, girviPaymentsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { TtlCache } from "../lib/cache";

export const VALID_METAL_TYPES = new Set(["gold", "silver"]);
export const VALID_STATUSES = new Set(["active", "redeemed", "forfeited", "extended", "voided"]);
export const VALID_PERIODS = new Set(["daily", "weekly", "monthly", "yearly"]);
export const VALID_PAYMENT_MODES = new Set(["cash", "bank", "upi", "cheque"]);
// "waiver" records the lender choosing to forgive some/all accrued interest —
// no cash changes hands, so it's excluded from "Interest Income" in reports.
export const VALID_PAYMENT_TYPES = new Set(["auto", "interest", "penalty", "principal", "renewal", "waiver"]);
// The subset a client may actually ASK for on POST /girvi/:id/collect-interest.
// "principal" and "renewal" are written by the server itself (redeem, partial-release,
// renew) and have no standalone handling in that endpoint — accepting them there would
// silently book a principal repayment as interest income, so they're rejected as input.
export const VALID_COLLECT_PAYMENT_TYPES = new Set(["auto", "interest", "penalty", "waiver"]);
export const MAX_NOTES_LEN = 1000;
export const MAX_ADDRESS_LEN = 500;

export function safeFloat(val: unknown, fallback = 0): number {
  const n = parseFloat(String(val ?? ""));
  return isFinite(n) ? n : fallback;
}

export function getPeriodDays(period: string): number {
  if (period === "daily") return 1;
  if (period === "weekly") return 7;
  if (period === "yearly") return 365;
  return 30; // monthly default
}

// Indian financial year: April (month index 3) through March.
// fyStartMonth is 1-indexed (default 4 = April) per girvi_settings.financialYearStartMonth.
export function getFinancialYear(date: Date, fyStartMonth = 4): string {
  const month = date.getMonth() + 1; // 1-indexed
  const year = date.getFullYear();
  const startYear = month >= fyStartMonth ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

// Atomically issues the next sequential number for a document type + financial year,
// formatted as "<prefix>/<financialYear>/<0000>". Race-safe via ON CONFLICT row locking.
// fyStartMonth comes from girvi_settings.financialYearStartMonth — every call site already
// holds that settings row, so it's passed in rather than defaulted, otherwise a shop that
// configured a non-April financial year would still get April-labelled numbers.
export async function nextGirviNumber(userId: number, docType: string, prefix: string, asOf = new Date(), fyStartMonth = 4): Promise<string> {
  const financialYear = getFinancialYear(asOf, fyStartMonth);
  const [row] = await db.insert(girviCountersTable)
    .values({ userId, docType, financialYear, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [girviCountersTable.userId, girviCountersTable.docType, girviCountersTable.financialYear],
      set: { lastNumber: sql`${girviCountersTable.lastNumber} + 1` },
    })
    .returning();
  return `${prefix}/${financialYear}/${String(row.lastNumber).padStart(4, "0")}`;
}

// Every user gets a "Main" branch lazily on first use — keeps single-branch
// shops frictionless while still giving multi-branch shops a real model.
export async function ensureDefaultBranch(userId: number): Promise<number> {
  const [existing] = await db.select().from(girviBranchesTable)
    .where(and(eq(girviBranchesTable.userId, userId), eq(girviBranchesTable.isDefault, true)));
  if (existing) return existing.id;
  const [anyBranch] = await db.select().from(girviBranchesTable).where(eq(girviBranchesTable.userId, userId));
  if (anyBranch) return anyBranch.id;
  const [created] = await db.insert(girviBranchesTable)
    .values({ userId, name: "Main", isDefault: true, isActive: true })
    .returning();
  return created.id;
}

// Lazily creates girvi_settings for a user, one-time-prefilled from the main
// business settings as a convenience default only — never read live again.
// Read on virtually every girvi request (the grace-days value feeds every interest
// calculation) and written only from the settings screen. Same rule as the accounting
// caches: only an already-committed row is cached.
const girviSettingsCache = new TtlCache<typeof girviSettingsTable.$inferSelect>(60_000);

export function invalidateGirviSettings(userId: number) {
  girviSettingsCache.delete(String(userId));
}

export async function getOrCreateGirviSettings(userId: number) {
  const cached = girviSettingsCache.get(String(userId));
  if (cached) return cached;
  const [existing] = await db.select().from(girviSettingsTable).where(eq(girviSettingsTable.userId, userId));
  if (existing) {
    girviSettingsCache.set(String(userId), existing);
    return existing;
  }
  const [mainSettings] = await db.select().from(businessSettingsTable).where(eq(businessSettingsTable.userId, userId));
  const [created] = await db.insert(girviSettingsTable).values({
    userId,
    shopName: mainSettings?.businessName || "SwarnDesk Jewellers",
    gstin: mainSettings?.gstin || null,
    address: mainSettings?.address || null,
    mobile: mainSettings?.mobile || null,
    email: mainSettings?.email || null,
  }).returning();
  return created;
}

// Interest accrues on currentPrincipal (= loanAmount - principalPaid) from startDate.
// Two phases: normal (startDate -> dueDate) + penalty (dueDate -> now, at rate+penaltyRate).
//
// graceDays (girvi_settings.overdueGraceDays): real lenders don't pro-rate a
// handful of late days to the rupee — penalty interest simply doesn't start
// accruing until you're graceDays past due. Beyond that window it does accrue
// (the lender can still choose to waive it via a "waiver" payment later; see
// VALID_PAYMENT_TYPES) — this only auto-forgives the routine small overage.
export function calcAccruedInterest(loan: typeof girviLoansTable.$inferSelect, asOf = new Date(), graceDays = 0) {
  const originalPrincipal = safeFloat(loan.loanAmount);
  const principalPaid = safeFloat((loan as any).principalPaid ?? "0");
  const principal = Math.max(0, originalPrincipal - principalPaid);
  const rate = safeFloat(loan.interestRate);
  const penaltyRate = safeFloat(loan.penaltyRate);
  const startDate = new Date(loan.startDate);
  const dueDate = new Date(loan.dueDate);
  const periodDays = getPeriodDays(loan.interestPeriod);

  const daysElapsed = Math.max(0, Math.floor((asOf.getTime() - startDate.getTime()) / 86400000));
  const normalDays = Math.min(daysElapsed, Math.max(0, Math.floor((dueDate.getTime() - startDate.getTime()) / 86400000)));
  const overdueDaysRaw = Math.max(0, Math.floor((asOf.getTime() - dueDate.getTime()) / 86400000));
  const overdueDays = Math.max(0, overdueDaysRaw - Math.max(0, graceDays));

  const normalInterest = Math.round(principal * (rate / 100) * (normalDays / periodDays));
  const penaltyInterest = overdueDays > 0
    ? Math.round(principal * ((rate + penaltyRate) / 100) * (overdueDays / periodDays))
    : 0;

  return { normalInterest, penaltyInterest, total: normalInterest + penaltyInterest, periodDays, overdueDaysRaw, overdueDays };
}

// When loan terms (due date, penalty rate) change without a payment being collected,
// preserve the interest already owed as of "now" instead of letting the recalculation
// under the new terms silently erase it (e.g. pushing the due date forward would
// otherwise retroactively turn already-accrued penalty interest into normal interest).
export function preserveOutstandingBaseline(
  loan: typeof girviLoansTable.$inferSelect,
  changes: Partial<Pick<typeof girviLoansTable.$inferSelect, "dueDate" | "penaltyRate" | "interestRate">>,
  now: Date,
  graceDays = 0,
): string {
  const before = calcAccruedInterest(loan, now, graceDays).total;
  const after = calcAccruedInterest({ ...loan, ...changes }, now, graceDays).total;
  const baselineBefore = safeFloat((loan as any).interestBaseline ?? "0");
  // Outstanding is accrued - (collected - baseline), so holding it steady across a
  // change of accrued from `before` to `after` means moving the baseline by
  // (before - after), NOT (after - before). With the sign the other way round,
  // extending a due date -- which reclassifies penalty interest as normal interest and
  // so lowers `after` -- would REDUCE what the customer owes instead of preserving it.
  return (baselineBefore + (before - after)).toFixed(2);
}

// A loan is a pure "data-entry correction" candidate only until the first real
// money movement (any interest/penalty/principal payment, waiver, or renewal)
// has been recorded against it. Before that point, nothing has been booked
// against the customer's outstanding balance other than the original
// disbursement, so core terms (amount, rate, dates) and pledged items can
// still be safely edited or the whole loan voided. After that point, use the
// normal business actions (collect/renew/redeem/forfeit/partial-release) —
// letting terms change underneath a payment history would silently corrupt
// past interest calculations.
export function isLoanEditable(loan: typeof girviLoansTable.$inferSelect): boolean {
  const noPayments = safeFloat(loan.totalInterestCollected) === 0 && safeFloat((loan as any).principalPaid ?? "0") === 0;
  return noPayments && (loan.status === "active" || loan.status === "extended");
}

export function mapLoan(l: typeof girviLoansTable.$inferSelect, asOf = new Date(), graceDays = 0) {
  const loanAmount = safeFloat(l.loanAmount);
  const principalPaid = safeFloat((l as any).principalPaid ?? "0");
  const currentPrincipal = Math.max(0, loanAmount - principalPaid);
  // interestBaseline = interest already collected (incl. waived) at time of last startDate reset.
  // Outstanding = accrued(from startDate) - (totalCollected - baseline).
  //
  // creditSinceReset is deliberately NOT floored at zero. A baseline set ABOVE what has
  // been collected is how a reset carries an unpaid balance forward onto the fresh cycle
  // (renew does exactly this when the customer's interest payment falls short, and
  // preserveOutstandingBaseline does it when loan terms change). Flooring it at zero threw
  // that carried-forward debt away and quietly forgave the shortfall.
  const interestBaseline = safeFloat((l as any).interestBaseline ?? "0");
  const totalInterestCollected = safeFloat(l.totalInterestCollected);
  const creditSinceReset = totalInterestCollected - interestBaseline;
  // Reported separately, and still floored, because this one is a display figure: cash
  // actually taken in on the current cycle, which can never be negative.
  const collectedSinceReset = Math.max(0, creditSinceReset);

  const isActive = l.status === "active" || l.status === "extended";
  const { normalInterest, penaltyInterest, total: accruedInterest, periodDays, overdueDaysRaw } =
    isActive ? calcAccruedInterest(l, asOf, graceDays) : { normalInterest: 0, penaltyInterest: 0, total: 0, periodDays: getPeriodDays(l.interestPeriod), overdueDaysRaw: 0 };

  const outstandingInterest = Math.max(0, accruedInterest - creditSinceReset);
  const totalDue = currentPrincipal + outstandingInterest;
  const dueDate = new Date(l.dueDate);
  const daysRemaining = Math.floor((dueDate.getTime() - asOf.getTime()) / 86400000);
  // Whether today's penalty interest is still fully (or partially) inside the grace window —
  // surfaced so the UI can show "3 days overdue (within grace)" instead of implying ₹0 is final.
  const withinGracePeriod = isActive && overdueDaysRaw > 0 && overdueDaysRaw <= graceDays;

  const dailyRate = (safeFloat(l.interestRate) / 100) / periodDays;

  return {
    id: l.id,
    loanNumber: l.loanNumber,
    branchId: l.branchId,
    customerId: l.customerId,
    customerName: l.customerName,
    customerMobile: l.customerMobile,
    fatherName: l.fatherName,
    address: l.address,
    kycDocType: l.kycDocType,
    kycDocNumber: l.kycDocNumber,
    pan: l.pan,
    itemDescription: l.itemDescription,
    metalType: l.metalType,
    purity: l.purity,
    grossWeight: safeFloat(l.grossWeight),
    netWeight: safeFloat(l.netWeight),
    estimatedValue: safeFloat(l.estimatedValue),
    loanAmount,
    processingFee: safeFloat(l.processingFee),
    principalPaid,
    currentPrincipal,
    interestRate: safeFloat(l.interestRate),
    penaltyRate: safeFloat(l.penaltyRate),
    interestPeriod: l.interestPeriod,
    periodDays,
    dailyRate: Math.round(dailyRate * 1e6) / 1e6,
    startDate: l.startDate.toISOString(),
    dueDate: l.dueDate.toISOString(),
    status: l.status,
    normalInterest,
    penaltyInterest,
    accruedInterest,
    totalInterestCollected,
    interestWaived: safeFloat((l as any).interestWaived ?? "0"),
    collectedSinceReset,
    outstandingInterest,
    totalDue,
    daysRemaining,
    isOverdue: daysRemaining < 0 && isActive,
    overdueDaysRaw,
    graceDaysApplied: graceDays,
    withinGracePeriod,
    redeemedDate: l.redeemedDate?.toISOString() ?? null,
    redeemedAmount: l.redeemedAmount ? safeFloat(l.redeemedAmount) : null,
    returnVoucherNumber: l.returnVoucherNumber,
    goldSaleValue: l.goldSaleValue ? safeFloat(l.goldSaleValue) : null,
    lossAmount: l.lossAmount ? safeFloat(l.lossAmount) : null,
    notes: l.notes,
    createdAt: l.createdAt.toISOString(),
    isEditable: isLoanEditable(l),
    noticeSentAt: l.noticeSentAt?.toISOString() ?? null,
    noticeNumber: l.noticeNumber,
    disbursementMode: l.disbursementMode,
    disbursementBankAccountId: l.disbursementBankAccountId,
  };
}

// Rolls a loan's item list up into the aggregate fields stored directly on
// girvi_loans (grossWeight/netWeight/estimatedValue/metalType/purity/
// itemDescription). Used both at loan creation (all items) and after a
// partial release (recomputed from whatever's still pledged), so those
// aggregates — and everything derived from them (LTV badge, forfeiture
// default, printed voucher) — always reflect the collateral actually in
// custody rather than what was originally pledged.
//
// Expects each item's grossWeight/netWeight/estimatedValue to already be the
// LINE TOTAL (quantity already multiplied in), matching how girvi_loan_items
// rows are stored — callers working from raw per-unit input must multiply by
// quantity before calling.
export function computeLoanAggregatesFromItems<T extends { metalType: string; purity: string; grossWeight: number; netWeight: number; estimatedValue: number; itemType: string; quantity: number }>(items: T[]) {
  const totalGrossWeight = items.reduce((s, it) => s + it.grossWeight, 0);
  const totalNetWeight = items.reduce((s, it) => s + it.netWeight, 0);
  const totalEstimatedValue = items.reduce((s, it) => s + it.estimatedValue, 0);

  // Primary metal type = most common among items by gross weight
  const metalTotals: Record<string, number> = {};
  items.forEach(it => { metalTotals[it.metalType] = (metalTotals[it.metalType] ?? 0) + it.grossWeight; });
  const primaryMetal = Object.entries(metalTotals).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "gold";

  // Primary purity = purity of primary metal item with most weight
  const primaryItems = items.filter(it => it.metalType === primaryMetal);
  const purityTotals: Record<string, number> = {};
  primaryItems.forEach(it => { purityTotals[it.purity] = (purityTotals[it.purity] ?? 0) + it.grossWeight; });
  const primaryPurity = Object.entries(purityTotals).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "22K";

  // Auto-generate description: "1 Necklace (Gold 22K), 2 Bangles (Gold 22K), 3 Rings (Silver 925)"
  const itemDescription = items.map(it =>
    `${it.quantity} ${it.itemType}${it.quantity > 1 ? "s" : ""} (${it.metalType === "silver" ? "Silver" : "Gold"} ${it.purity})`
  ).join(", ");

  return {
    grossWeight: totalGrossWeight,
    netWeight: totalNetWeight,
    estimatedValue: totalEstimatedValue,
    metalType: primaryMetal,
    purity: primaryPurity,
    itemDescription,
  };
}

export function mapPayment(p: typeof girviPaymentsTable.$inferSelect) {
  return {
    id: p.id,
    loanId: p.loanId,
    loanNumber: p.loanNumber,
    customerName: p.customerName,
    amount: safeFloat(p.amount),
    paymentType: p.paymentType,
    paymentMode: p.paymentMode,
    bankAccountId: p.bankAccountId,
    referenceNumber: p.referenceNumber,
    paymentDate: p.paymentDate.toISOString(),
    notes: p.notes,
    createdAt: p.createdAt.toISOString(),
  };
}
