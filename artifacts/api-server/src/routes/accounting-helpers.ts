import { db } from "@workspace/db";
import {
  chartOfAccountsTable, accountingCountersTable, accountingSettingsTable, businessSettingsTable,
  journalVouchersTable, journalLinesTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { TtlCache } from "../lib/cache";

// Db transaction type used across the route files (tx param of db.transaction callback).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
// Anything that can run a query: the pool-backed `db`, or an open transaction.
//
// Helpers that may be called from inside someone else's db.transaction MUST take
// this and default to `db`. Using the module-level `db` while a transaction is open
// checks out a SECOND connection from the pool: the write then commits even if the
// surrounding transaction rolls back (gap-y counters, orphaned settings rows), and
// under load — pg's pool defaults to max 10 — every busy transaction waiting on a
// second connection that only a finishing transaction can release deadlocks the pool.
export type DbExecutor = typeof db | Tx;

export function safeFloat(val: unknown, fallback = 0): number {
  const n = parseFloat(String(val ?? ""));
  return isFinite(n) ? n : fallback;
}

// Indian financial year: April (month index 3) through March, same convention as Girvi.
export function getFinancialYear(date: Date, fyStartMonth = 4): string {
  const month = date.getMonth() + 1;
  const year = date.getFullYear();
  const startYear = month >= fyStartMonth ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

// Atomic, gap-free voucher numbering — literal port of girvi's nextGirviNumber.
// fyStartMonth comes from accounting_settings.financialYearStartMonth; callers that
// already hold the settings row pass it in, the rest let it be looked up here. Passing
// nothing would silently hardcode an April financial year and mislabel every voucher
// number for a shop that configured a different one.
export async function nextVoucherNumber(userId: number, docType: string, prefix: string, asOf = new Date(), exec: DbExecutor = db, fyStartMonth?: number): Promise<string> {
  const startMonth = fyStartMonth ?? (await getOrCreateAccountingSettings(userId, exec)).financialYearStartMonth;
  const financialYear = getFinancialYear(asOf, startMonth);
  const [row] = await exec.insert(accountingCountersTable)
    .values({ userId, docType, financialYear, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [accountingCountersTable.userId, accountingCountersTable.docType, accountingCountersTable.financialYear],
      set: { lastNumber: sql`${accountingCountersTable.lastNumber} + 1` },
    })
    .returning();
  return `${prefix}/${financialYear}/${String(row.lastNumber).padStart(4, "0")}`;
}

// Settings are read on essentially every accounting request and edited almost never.
// Only rows that already existed are cached — a row created inside a caller's transaction
// may still be rolled back, and caching it would leave this process serving an id that
// was never committed.
const accountingSettingsCache = new TtlCache<typeof accountingSettingsTable.$inferSelect>(60_000);

export function invalidateAccountingSettings(userId: number) {
  accountingSettingsCache.delete(String(userId));
}

export async function getOrCreateAccountingSettings(userId: number, exec: DbExecutor = db) {
  const cached = accountingSettingsCache.get(String(userId));
  if (cached) return cached;
  const [existing] = await exec.select().from(accountingSettingsTable).where(eq(accountingSettingsTable.userId, userId));
  if (existing) {
    accountingSettingsCache.set(String(userId), existing);
    return existing;
  }
  const [mainSettings] = await exec.select().from(businessSettingsTable).where(eq(businessSettingsTable.userId, userId));
  const [created] = await exec.insert(accountingSettingsTable).values({
    userId,
    financialYearStartMonth: 4,
  }).returning();
  void mainSettings; // nothing to seed from today — reserved for future defaults (e.g. FY start by locale)
  return created;
}

// ─── Default Chart of Accounts ──────────────────────────────────────────────
// Every other module posts against these symbolic keys rather than raw account
// ids, so integration code never has to know real account ids.
export const DEFAULT_ACCOUNTS = [
  { key: "CASH", code: "1001", name: "Cash in Hand", accountType: "asset", accountSubType: "cash" },
  { key: "BANK", code: "1002", name: "Bank Account", accountType: "asset", accountSubType: "bank" },
  { key: "ACCOUNTS_RECEIVABLE", code: "1101", name: "Accounts Receivable (Debtors)", accountType: "asset", accountSubType: "accounts_receivable" },
  { key: "INVENTORY_GOLD", code: "1201", name: "Inventory - Gold", accountType: "asset", accountSubType: "inventory" },
  { key: "INVENTORY_SILVER", code: "1202", name: "Inventory - Silver", accountType: "asset", accountSubType: "inventory" },
  { key: "INVENTORY_OTHER", code: "1203", name: "Inventory - Other", accountType: "asset", accountSubType: "inventory" },
  { key: "GIRVI_LOANS_RECEIVABLE", code: "1301", name: "Girvi Loans Receivable", accountType: "asset", accountSubType: "other" },
  { key: "FORFEITED_GOLD_STOCK", code: "1302", name: "Forfeited Gold Stock", accountType: "asset", accountSubType: "inventory" },
  { key: "FIXED_ASSETS", code: "1401", name: "Fixed Assets", accountType: "asset", accountSubType: "fixed_asset" },
  // ITC — GST paid on purchases is a claim against the government (an asset) until it's
  // offset against output GST payable, not an expense.
  { key: "INPUT_GST_CREDIT", code: "1501", name: "Input GST Credit (ITC)", accountType: "asset", accountSubType: "other" },
  { key: "ACCOUNTS_PAYABLE", code: "2001", name: "Accounts Payable (Creditors)", accountType: "liability", accountSubType: "accounts_payable" },
  { key: "GST_PAYABLE", code: "2101", name: "GST Payable", accountType: "liability", accountSubType: "other" },
  { key: "CAPITAL_ACCOUNT", code: "3001", name: "Capital Account", accountType: "equity", accountSubType: "capital" },
  { key: "SALES_REVENUE", code: "4001", name: "Sales Revenue", accountType: "income", accountSubType: "direct_income" },
  { key: "REPAIR_INCOME", code: "4002", name: "Repair Income", accountType: "income", accountSubType: "direct_income" },
  { key: "CUSTOM_ORDER_INCOME", code: "4003", name: "Custom Order Income", accountType: "income", accountSubType: "direct_income" },
  { key: "INTEREST_INCOME", code: "4004", name: "Interest Income (Girvi)", accountType: "income", accountSubType: "indirect_income" },
  { key: "PROCESSING_FEE_INCOME", code: "4005", name: "Processing Fee Income", accountType: "income", accountSubType: "indirect_income" },
  { key: "OTHER_INCOME", code: "4006", name: "Other Income", accountType: "income", accountSubType: "indirect_income" },
  { key: "PURCHASES", code: "5001", name: "Purchases", accountType: "expense", accountSubType: "direct_expense" },
  { key: "KARIGAR_WAGES_EXPENSE", code: "5002", name: "Karigar Wages Expense", accountType: "expense", accountSubType: "direct_expense" },
  { key: "RENT_EXPENSE", code: "5101", name: "Rent Expense", accountType: "expense", accountSubType: "indirect_expense" },
  { key: "SALARY_EXPENSE", code: "5102", name: "Salary Expense", accountType: "expense", accountSubType: "indirect_expense" },
  { key: "ELECTRICITY_EXPENSE", code: "5103", name: "Electricity Expense", accountType: "expense", accountSubType: "indirect_expense" },
  { key: "FORFEITURE_LOSS", code: "5104", name: "Forfeiture Loss (Girvi)", accountType: "expense", accountSubType: "indirect_expense" },
  { key: "MISC_EXPENSE", code: "5199", name: "Miscellaneous Expense", accountType: "expense", accountSubType: "indirect_expense" },
] as const;

export type DefaultAccountKey = typeof DEFAULT_ACCOUNTS[number]["key"];

// Idempotently seeds any missing default accounts for the user, returns a
// key -> accountId map. Called lazily by every posting call site (and by the
// Chart of Accounts list endpoint), same lazy-init pattern as Girvi settings.
// Key -> account id, stable for the life of a shop once seeded. Previously re-read (a
// full scan of the shop's chart of accounts) on every single posting — every sale,
// purchase, repair, custom order and girvi payment paid for it.
const defaultAccountsCache = new TtlCache<Record<DefaultAccountKey, number>>(300_000);

export function invalidateDefaultAccounts(userId: number) {
  defaultAccountsCache.delete(String(userId));
}

export async function getOrCreateDefaultAccounts(userId: number, exec: DbExecutor = db): Promise<Record<DefaultAccountKey, number>> {
  const cached = defaultAccountsCache.get(String(userId));
  if (cached) return cached;
  const existing = await exec.select({
    id: chartOfAccountsTable.id, code: chartOfAccountsTable.code,
  }).from(chartOfAccountsTable).where(eq(chartOfAccountsTable.userId, userId));
  const byCode = new Map(existing.map(a => [a.code, a]));
  const missing = DEFAULT_ACCOUNTS.filter(a => !byCode.has(a.code));
  if (missing.length > 0) {
    const inserted = await exec.insert(chartOfAccountsTable).values(
      missing.map(a => ({
        userId, code: a.code, name: a.name, accountType: a.accountType,
        accountSubType: a.accountSubType, isSystemAccount: true,
      }))
    ).onConflictDoNothing().returning();
    for (const a of inserted) byCode.set(a.code, a);
  }
  const map = {} as Record<DefaultAccountKey, number>;
  for (const a of DEFAULT_ACCOUNTS) {
    const row = byCode.get(a.code);
    if (row) map[a.key] = row.id;
  }
  // Only cache a map read wholly from already-committed rows. If this call had to seed
  // anything, the insert may belong to a caller's transaction that later rolls back.
  if (missing.length === 0) defaultAccountsCache.set(String(userId), map);
  return map;
}

export function cashOrBankKey(paymentMode: string | null | undefined): "CASH" | "BANK" {
  return paymentMode === "upi" || paymentMode === "card" || paymentMode === "bank" || paymentMode === "cheque" ? "BANK" : "CASH";
}

// True if `bankAccountId` is a real, active, bank-subtype account belonging to this user —
// call this from the route (before opening its own db.transaction) to turn a bad id into a
// clean 400 instead of a foreign-key-shaped 500 once posted.
export async function isValidBankAccount(userId: number, bankAccountId: number): Promise<boolean> {
  const [row] = await db.select({ id: chartOfAccountsTable.id }).from(chartOfAccountsTable)
    .where(and(
      eq(chartOfAccountsTable.id, bankAccountId), eq(chartOfAccountsTable.userId, userId),
      eq(chartOfAccountsTable.accountSubType, "bank"), eq(chartOfAccountsTable.isActive, true),
    ));
  return !!row;
}

// Resolves which chart-of-accounts row a cash/bank/upi/card/cheque payment should post
// against: Cash-in-Hand for cash-like modes; for bank-like modes, the caller's explicit
// bankAccountId (already validated via isValidBankAccount) if given, else the shop's
// designated default bank account, else the single seeded system "Bank Account" so shops
// that never set up multiple banks keep working exactly as before.
export async function resolveMoneyAccountId(
  userId: number,
  paymentMode: string | null | undefined,
  bankAccountId: number | null | undefined,
  defaults: Record<DefaultAccountKey, number>,
  exec: DbExecutor = db,
): Promise<number> {
  if (cashOrBankKey(paymentMode) === "CASH") return defaults.CASH;
  if (bankAccountId) return bankAccountId;
  const [defaultBank] = await exec.select({ id: chartOfAccountsTable.id }).from(chartOfAccountsTable)
    .where(and(
      eq(chartOfAccountsTable.userId, userId), eq(chartOfAccountsTable.accountSubType, "bank"),
      eq(chartOfAccountsTable.isActive, true), eq(chartOfAccountsTable.isDefaultBank, true),
    ));
  return defaultBank?.id ?? defaults.BANK;
}

export type PartyType = "none" | "customer" | "supplier" | "karigar" | "girvi_customer";

export interface JournalLineInput {
  accountId: number;
  debit?: number;
  credit?: number;
  partyType?: PartyType;
  partyId?: number | null;
  particulars?: string | null;
}

export interface PostJournalEntryInput {
  userId: number;
  voucherDate?: Date;
  voucherType: "sales" | "purchase" | "receipt" | "payment" | "journal" | "contra";
  narration?: string | null;
  sourceModule: "sales" | "purchases" | "girvi" | "repairs" | "custom_orders" | "karigars" | "manual";
  sourceId?: number | null;
  lines: JournalLineInput[];
}

// The core posting primitive. Every module that moves money calls this from
// inside its OWN db.transaction (pass that transaction's `tx`) so the journal
// entry commits or rolls back atomically with the originating write. Throws
// on an unbalanced entry — that's a programming bug, not a user input error,
// so callers should let it propagate and roll back the whole transaction.
export async function postJournalEntry(tx: Tx, input: PostJournalEntryInput) {
  const lines = input.lines.filter(l => (l.debit ?? 0) > 0.001 || (l.credit ?? 0) > 0.001);
  if (lines.length === 0) throw new Error("postJournalEntry: at least one non-zero line is required");

  const totalDebit = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`postJournalEntry: unbalanced entry (debit ${totalDebit.toFixed(2)} != credit ${totalCredit.toFixed(2)}) for ${input.sourceModule}#${input.sourceId ?? "manual"}`);
  }

  const settings = await getOrCreateAccountingSettings(input.userId, tx);
  const voucherDate = input.voucherDate ?? new Date();
  const docType = input.voucherType === "receipt" ? "receipt" : input.voucherType === "payment" ? "payment" : "journal";
  const prefix = docType === "receipt" ? settings.receiptPrefix : docType === "payment" ? settings.paymentPrefix : settings.journalPrefix;
  const voucherNumber = await nextVoucherNumber(input.userId, docType, prefix, voucherDate, tx, settings.financialYearStartMonth);

  const [voucher] = await tx.insert(journalVouchersTable).values({
    userId: input.userId,
    voucherNumber,
    voucherType: input.voucherType,
    voucherDate,
    narration: input.narration ?? null,
    sourceModule: input.sourceModule,
    sourceId: input.sourceId ?? null,
  }).returning();

  await tx.insert(journalLinesTable).values(lines.map(l => ({
    userId: input.userId,
    voucherId: voucher.id,
    accountId: l.accountId,
    debit: (l.debit ?? 0).toFixed(2),
    credit: (l.credit ?? 0).toFixed(2),
    partyType: l.partyType ?? "none",
    partyId: l.partyId ?? null,
    particulars: l.particulars ?? null,
  })));

  return voucher;
}

// Voids a voucher without deleting it — inserts a mirror-image reversing
// voucher (debits <-> credits swapped) and links the two for a full audit trail.
// Core implementation takes the transaction explicitly so callers that need the
// reversal to commit/rollback atomically with their own writes (e.g. a girvi
// loan correction that reverses the original disbursement and posts a
// corrected one in the same breath) can pass their own `tx` in.
export async function reverseVoucherTx(tx: Tx, userId: number, voucherId: number, narration?: string) {
  const [voucher] = await tx.select().from(journalVouchersTable)
    .where(and(eq(journalVouchersTable.id, voucherId), eq(journalVouchersTable.userId, userId)));
  if (!voucher) throw Object.assign(new Error("Voucher not found"), { statusCode: 404 });
  if (voucher.reversedByVoucherId) throw Object.assign(new Error("Voucher already voided"), { statusCode: 400 });

  const lines = await tx.select().from(journalLinesTable)
    .where(and(eq(journalLinesTable.voucherId, voucherId), eq(journalLinesTable.userId, userId)));

  const settings = await getOrCreateAccountingSettings(userId, tx);
  const voucherNumber = await nextVoucherNumber(userId, "journal", settings.journalPrefix, new Date(), tx, settings.financialYearStartMonth);
  const [reversal] = await tx.insert(journalVouchersTable).values({
    userId,
    voucherNumber,
    voucherType: "journal",
    voucherDate: new Date(),
    narration: narration ?? `Reversal of ${voucher.voucherNumber}`,
    sourceModule: voucher.sourceModule,
    sourceId: voucher.sourceId,
    reversesVoucherId: voucher.id,
  }).returning();

  await tx.insert(journalLinesTable).values(lines.map(l => ({
    userId,
    voucherId: reversal.id,
    accountId: l.accountId,
    debit: l.credit,
    credit: l.debit,
    partyType: l.partyType,
    partyId: l.partyId,
    particulars: l.particulars,
  })));

  await tx.update(journalVouchersTable).set({ reversedByVoucherId: reversal.id })
    .where(eq(journalVouchersTable.id, voucher.id));

  return reversal;
}

export async function reverseVoucher(userId: number, voucherId: number, narration?: string) {
  return db.transaction(tx => reverseVoucherTx(tx, userId, voucherId, narration));
}
