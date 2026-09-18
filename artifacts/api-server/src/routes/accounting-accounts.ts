import { Router } from "express";
import { db } from "@workspace/db";
import { chartOfAccountsTable, journalLinesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getOrCreateDefaultAccounts, invalidateDefaultAccounts, safeFloat } from "./accounting-helpers";

const router = Router();

const VALID_ACCOUNT_TYPES = new Set(["asset", "liability", "equity", "income", "expense"]);
const VALID_SUB_TYPES = new Set([
  "cash", "bank", "accounts_receivable", "accounts_payable", "inventory", "fixed_asset",
  "capital", "direct_income", "indirect_income", "direct_expense", "indirect_expense", "other",
]);

function mapAccount(a: typeof chartOfAccountsTable.$inferSelect) {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    accountType: a.accountType,
    accountSubType: a.accountSubType,
    isSystemAccount: a.isSystemAccount,
    openingBalance: safeFloat(a.openingBalance),
    openingBalanceType: a.openingBalanceType,
    isActive: a.isActive,
    bankName: a.bankName,
    bankAccountNumber: a.bankAccountNumber,
    bankIfsc: a.bankIfsc,
    isDefaultBank: a.isDefaultBank,
    createdAt: a.createdAt.toISOString(),
  };
}

// GET / — list all accounts, seeding the default Chart of Accounts on first call
router.get("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    await getOrCreateDefaultAccounts(userId);
    const accounts = await db.select().from(chartOfAccountsTable)
      .where(eq(chartOfAccountsTable.userId, userId))
      .orderBy(chartOfAccountsTable.code);
    res.json(accounts.map(mapAccount));
  } catch (err) {
    req.log.error({ err }, "Failed to list accounts");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /banks — active bank-subtype accounts only, for payment-mode pickers across the app
router.get("/banks", async (req, res) => {
  try {
    const userId = req.user!.userId;
    await getOrCreateDefaultAccounts(userId);
    const accounts = await db.select().from(chartOfAccountsTable)
      .where(and(eq(chartOfAccountsTable.userId, userId), eq(chartOfAccountsTable.accountSubType, "bank"), eq(chartOfAccountsTable.isActive, true)))
      .orderBy(chartOfAccountsTable.name);
    res.json(accounts.map(mapAccount));
  } catch (err) {
    req.log.error({ err }, "Failed to list bank accounts");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST / — create a custom (non-system) account
router.post("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const data = req.body;
    const code = String(data.code ?? "").trim();
    const name = String(data.name ?? "").trim();
    if (!code) return res.status(400).json({ error: "Account code is required" });
    if (!name) return res.status(400).json({ error: "Account name is required" });
    if (!VALID_ACCOUNT_TYPES.has(data.accountType)) return res.status(400).json({ error: "Invalid account type" });
    const accountSubType = VALID_SUB_TYPES.has(data.accountSubType) ? data.accountSubType : "other";
    const openingBalanceType = data.openingBalanceType === "credit" ? "credit" : "debit";

    const [existing] = await db.select().from(chartOfAccountsTable)
      .where(and(eq(chartOfAccountsTable.userId, userId), eq(chartOfAccountsTable.code, code)));
    if (existing) return res.status(409).json({ error: `Account code "${code}" already exists` });

    const isDefaultBank = accountSubType === "bank" && !!data.isDefaultBank;
    if (isDefaultBank) {
      await db.update(chartOfAccountsTable).set({ isDefaultBank: false })
        .where(and(eq(chartOfAccountsTable.userId, userId), eq(chartOfAccountsTable.accountSubType, "bank")));
    }

    invalidateDefaultAccounts(userId);
    const [created] = await db.insert(chartOfAccountsTable).values({
      userId,
      code,
      name,
      accountType: data.accountType,
      accountSubType,
      isSystemAccount: false,
      openingBalance: safeFloat(data.openingBalance, 0).toFixed(2),
      openingBalanceType,
      bankName: accountSubType === "bank" && data.bankName ? String(data.bankName).trim() || null : null,
      bankAccountNumber: accountSubType === "bank" && data.bankAccountNumber ? String(data.bankAccountNumber).trim() || null : null,
      bankIfsc: accountSubType === "bank" && data.bankIfsc ? String(data.bankIfsc).trim().toUpperCase() || null : null,
      isDefaultBank,
    }).returning();
    res.status(201).json(mapAccount(created));
  } catch (err) {
    req.log.error({ err }, "Failed to create account");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:id — edit an account. System accounts can be renamed and have their
// opening balance adjusted, but never have their code/type changed (other
// modules match system accounts by `code` — see getOrCreateDefaultAccounts in
// accounting-helpers.ts — so re-coding one would make it look "missing" and
// get silently re-seeded as a duplicate) and never deactivated/deleted.
router.patch("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const [account] = await db.select().from(chartOfAccountsTable)
      .where(and(eq(chartOfAccountsTable.id, id), eq(chartOfAccountsTable.userId, userId)));
    if (!account) return res.status(404).json({ error: "Not found" });

    const data = req.body;
    const updates: Partial<typeof chartOfAccountsTable.$inferInsert> = {};
    if (data.name !== undefined) {
      const name = String(data.name).trim();
      if (!name) return res.status(400).json({ error: "Account name cannot be empty" });
      updates.name = name;
    }
    if (data.isActive !== undefined) {
      if (account.isSystemAccount && data.isActive === false) {
        return res.status(400).json({ error: "System accounts cannot be deactivated" });
      }
      updates.isActive = !!data.isActive;
      // An inactive account being "the default" is meaningless and would leave payment
      // pickers silently falling back to the system Bank Account with no visible reason —
      // clear the flag so a new default has to be chosen explicitly.
      if (data.isActive === false && account.accountSubType === "bank" && account.isDefaultBank) {
        updates.isDefaultBank = false;
      }
    }
    if (data.openingBalance !== undefined) updates.openingBalance = safeFloat(data.openingBalance, 0).toFixed(2);
    if (data.openingBalanceType !== undefined) updates.openingBalanceType = data.openingBalanceType === "credit" ? "credit" : "debit";

    if (data.code !== undefined) {
      if (account.isSystemAccount) return res.status(400).json({ error: "System account codes cannot be changed" });
      const code = String(data.code).trim();
      if (!code) return res.status(400).json({ error: "Account code cannot be empty" });
      if (code !== account.code) {
        const [dupe] = await db.select().from(chartOfAccountsTable)
          .where(and(eq(chartOfAccountsTable.userId, userId), eq(chartOfAccountsTable.code, code)));
        if (dupe) return res.status(409).json({ error: `Account code "${code}" already exists` });
      }
      updates.code = code;
    }
    if (data.accountType !== undefined) {
      if (account.isSystemAccount) return res.status(400).json({ error: "System account types cannot be changed" });
      if (!VALID_ACCOUNT_TYPES.has(data.accountType)) return res.status(400).json({ error: "Invalid account type" });
      updates.accountType = data.accountType;
    }
    if (data.accountSubType !== undefined) {
      if (account.isSystemAccount) return res.status(400).json({ error: "System account types cannot be changed" });
      updates.accountSubType = VALID_SUB_TYPES.has(data.accountSubType) ? data.accountSubType : "other";
    }
    const effectiveSubType = (updates.accountSubType as string | undefined) ?? account.accountSubType;
    if (data.bankName !== undefined) updates.bankName = data.bankName ? String(data.bankName).trim() || null : null;
    if (data.bankAccountNumber !== undefined) updates.bankAccountNumber = data.bankAccountNumber ? String(data.bankAccountNumber).trim() || null : null;
    if (data.bankIfsc !== undefined) updates.bankIfsc = data.bankIfsc ? String(data.bankIfsc).trim().toUpperCase() || null : null;
    if (data.isDefaultBank !== undefined) {
      const wantsDefault = !!data.isDefaultBank && effectiveSubType === "bank";
      if (wantsDefault) {
        await db.update(chartOfAccountsTable).set({ isDefaultBank: false })
          .where(and(eq(chartOfAccountsTable.userId, userId), eq(chartOfAccountsTable.accountSubType, "bank")));
      }
      updates.isDefaultBank = wantsDefault;
    }

    invalidateDefaultAccounts(userId);
    const [updated] = await db.update(chartOfAccountsTable).set(updates)
      .where(and(eq(chartOfAccountsTable.id, id), eq(chartOfAccountsTable.userId, userId)))
      .returning();
    res.json(mapAccount(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update account");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:id — hard-delete a custom account, but only if it's never been posted to.
// System accounts can never be deleted (other modules post to them by id).
router.delete("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const [account] = await db.select().from(chartOfAccountsTable)
      .where(and(eq(chartOfAccountsTable.id, id), eq(chartOfAccountsTable.userId, userId)));
    if (!account) return res.status(404).json({ error: "Not found" });
    if (account.isSystemAccount) return res.status(400).json({ error: "System accounts cannot be deleted" });

    const [line] = await db.select({ id: journalLinesTable.id }).from(journalLinesTable)
      .where(and(eq(journalLinesTable.userId, userId), eq(journalLinesTable.accountId, id))).limit(1);
    if (line) return res.status(400).json({ error: "Cannot delete an account that already has journal entries — deactivate it instead" });

    invalidateDefaultAccounts(userId);
    await db.delete(chartOfAccountsTable).where(and(eq(chartOfAccountsTable.id, id), eq(chartOfAccountsTable.userId, userId)));
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Failed to delete account");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
