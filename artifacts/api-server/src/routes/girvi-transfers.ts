import { Router } from "express";
import { db } from "@workspace/db";
import { girviTransfersTable, girviTransferItemsTable, girviLoansTable, girviLoanItemsTable, girviCustomersTable, girviBranchesTable } from "@workspace/db";
import { eq, and, desc, inArray } from "drizzle-orm";
import { getOrCreateGirviSettings, nextGirviNumber, safeFloat } from "./girvi-helpers";

const router = Router();

function mapTransfer(t: typeof girviTransfersTable.$inferSelect) {
  return {
    id: t.id,
    transferNumber: t.transferNumber,
    loanId: t.loanId,
    fromBranchId: t.fromBranchId,
    toBranchId: t.toBranchId,
    fromCustomerId: t.fromCustomerId,
    toCustomerId: t.toCustomerId,
    transferDate: t.transferDate.toISOString(),
    reason: t.reason,
    notes: t.notes,
    returnedAt: t.returnedAt?.toISOString() ?? null,
    returnVoucherNumber: t.returnVoucherNumber,
    returnNotes: t.returnNotes,
    isReturned: !!t.returnedAt,
    createdAt: t.createdAt.toISOString(),
  };
}

router.get("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { loanId, status } = req.query as Record<string, string>;
    let transfers = await db.select().from(girviTransfersTable)
      .where(eq(girviTransfersTable.userId, userId))
      .orderBy(desc(girviTransfersTable.createdAt));
    if (loanId) {
      const lid = parseInt(loanId);
      if (!isNaN(lid)) transfers = transfers.filter(t => t.loanId === lid);
    }
    if (status === "returned") transfers = transfers.filter(t => !!t.returnedAt);
    else if (status === "active") transfers = transfers.filter(t => !t.returnedAt);
    res.json(transfers.map(mapTransfer));
  } catch (err) {
    req.log.error({ err }, "Failed to list girvi transfers");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const data = req.body;
    const loanId = parseInt(data.loanId);
    if (isNaN(loanId)) return res.status(400).json({ error: "Invalid loanId" });

    const [loan] = await db.select().from(girviLoansTable)
      .where(and(eq(girviLoansTable.id, loanId), eq(girviLoansTable.userId, userId)));
    if (!loan) return res.status(404).json({ error: "Loan not found" });
    if (loan.status !== "active" && loan.status !== "extended") {
      return res.status(400).json({ error: "Can only transfer items from active or extended loans" });
    }

    const itemIds: number[] = Array.isArray(data.itemIds) ? data.itemIds.map((n: unknown) => parseInt(String(n))).filter((n: number) => !isNaN(n)) : [];
    if (itemIds.length === 0) return res.status(400).json({ error: "Select at least one item to transfer" });

    const items = await db.select().from(girviLoanItemsTable)
      .where(and(eq(girviLoanItemsTable.loanId, loanId), eq(girviLoanItemsTable.userId, userId), inArray(girviLoanItemsTable.id, itemIds)));
    if (items.length !== itemIds.length) return res.status(400).json({ error: "One or more items not found on this loan" });
    const notPledged = items.find(it => it.status !== "pledged");
    if (notPledged) return res.status(400).json({ error: `Item "${notPledged.itemType}" is not currently pledged (status: ${notPledged.status})` });

    let toBranchId: number | null = null;
    if (data.toBranchId !== undefined && data.toBranchId !== null && data.toBranchId !== "") {
      toBranchId = parseInt(data.toBranchId);
      if (isNaN(toBranchId)) return res.status(400).json({ error: "Invalid toBranchId" });
      const [branch] = await db.select().from(girviBranchesTable)
        .where(and(eq(girviBranchesTable.id, toBranchId), eq(girviBranchesTable.userId, userId)));
      if (!branch) return res.status(404).json({ error: "Destination branch not found" });
    }

    let toCustomerId: number | null = null;
    if (data.toCustomerId !== undefined && data.toCustomerId !== null && data.toCustomerId !== "") {
      toCustomerId = parseInt(data.toCustomerId);
      if (isNaN(toCustomerId)) return res.status(400).json({ error: "Invalid toCustomerId" });
      const [customer] = await db.select().from(girviCustomersTable)
        .where(and(eq(girviCustomersTable.id, toCustomerId), eq(girviCustomersTable.userId, userId)));
      if (!customer) return res.status(404).json({ error: "Destination customer not found" });
    }

    if (toBranchId === null && toCustomerId === null) {
      return res.status(400).json({ error: "Provide a destination branch and/or destination customer" });
    }

    // All selected items must currently sit at the same branch — a loan whose
    // items were split across branches by an earlier partial transfer could
    // otherwise have a transfer recorded (and its voucher/register printed)
    // under the wrong origin branch for every item but the first selected.
    const distinctBranches = new Set(items.map(it => it.currentBranchId ?? loan.branchId));
    if (distinctBranches.size > 1) {
      return res.status(400).json({ error: "Selected items are currently at different branches — transfer them separately, one branch at a time" });
    }
    const fromBranchId = items[0]?.currentBranchId ?? loan.branchId;
    const fromCustomerId = loan.customerId;
    const reason = data.reason ? String(data.reason).trim() || null : null;
    const notes = data.notes ? String(data.notes).trim() || null : null;
    const now = new Date();

    const settings = await getOrCreateGirviSettings(userId);
    const transferNumber = await nextGirviNumber(userId, "transfer", settings.transferPrefix, now, settings.financialYearStartMonth);

    const transfer = await db.transaction(async tx => {
      const [created] = await tx.insert(girviTransfersTable).values({
        userId,
        transferNumber,
        loanId,
        fromBranchId,
        toBranchId,
        fromCustomerId: toCustomerId !== null ? fromCustomerId : null,
        toCustomerId,
        transferDate: now,
        reason,
        notes,
      }).returning();

      for (const itemId of itemIds) {
        await tx.insert(girviTransferItemsTable).values({ userId, transferId: created.id, loanItemId: itemId });
      }

      if (toBranchId !== null) {
        await tx.update(girviLoanItemsTable)
          .set({ status: "transferred", currentBranchId: toBranchId })
          .where(and(eq(girviLoanItemsTable.userId, userId), inArray(girviLoanItemsTable.id, itemIds)));
      }

      if (toCustomerId !== null) {
        const [newCustomer] = await tx.select().from(girviCustomersTable)
          .where(and(eq(girviCustomersTable.id, toCustomerId), eq(girviCustomersTable.userId, userId)));
        await tx.update(girviLoansTable).set({
          customerId: newCustomer.id,
          customerName: newCustomer.name,
          customerMobile: newCustomer.mobile,
          fatherName: newCustomer.fatherName,
          address: newCustomer.address,
          kycDocType: newCustomer.idProofType,
          kycDocNumber: newCustomer.idProofNumber,
          pan: newCustomer.pan,
          updatedAt: now,
        }).where(and(eq(girviLoansTable.id, loanId), eq(girviLoansTable.userId, userId)));
      }

      return created;
    });

    res.status(201).json(mapTransfer(transfer));
  } catch (err) {
    req.log.error({ err }, "Failed to create girvi transfer");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:id — correct the reason/notes recorded against a transfer. The branch/customer/
// items moved aren't editable here (that would mean unwinding and reapplying real stock and
// custody changes) — use the item movement itself and a fresh transfer/return for that.
router.patch("/:id", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const data = req.body;

    const updateData: Record<string, unknown> = {};
    if (data.reason !== undefined) updateData.reason = data.reason ? String(data.reason).trim() || null : null;
    if (data.notes !== undefined) updateData.notes = data.notes ? String(data.notes).trim() || null : null;

    const [updated] = await db.update(girviTransfersTable).set(updateData)
      .where(and(eq(girviTransfersTable.id, id), eq(girviTransfersTable.userId, userId)))
      .returning();
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(mapTransfer(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update girvi transfer");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Items included in a specific transfer (for printing the transfer voucher).
router.get("/:id/items", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const [transfer] = await db.select().from(girviTransfersTable)
      .where(and(eq(girviTransfersTable.id, id), eq(girviTransfersTable.userId, userId)));
    if (!transfer) return res.status(404).json({ error: "Not found" });

    const transferItems = await db.select().from(girviTransferItemsTable).where(eq(girviTransferItemsTable.transferId, id));
    const loanItemIds = transferItems.map(ti => ti.loanItemId);
    if (loanItemIds.length === 0) return res.json([]);
    const items = await db.select().from(girviLoanItemsTable)
      .where(and(eq(girviLoanItemsTable.userId, userId), inArray(girviLoanItemsTable.id, loanItemIds)));
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
    req.log.error({ err }, "Failed to get transfer items");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Transfer Return — brings transferred items/custody back, with its own linked voucher number.
router.post("/:id/return", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const [transfer] = await db.select().from(girviTransfersTable)
      .where(and(eq(girviTransfersTable.id, id), eq(girviTransfersTable.userId, userId)));
    if (!transfer) return res.status(404).json({ error: "Not found" });
    if (transfer.returnedAt) return res.status(400).json({ error: "This transfer has already been returned" });

    const [loan] = await db.select().from(girviLoansTable)
      .where(and(eq(girviLoansTable.id, transfer.loanId), eq(girviLoansTable.userId, userId)));
    if (!loan) return res.status(404).json({ error: "Linked loan not found" });

    const now = new Date();
    const returnNotes = req.body.notes ? String(req.body.notes).trim() || null : null;
    const settings = await getOrCreateGirviSettings(userId);
    const returnVoucherNumber = await nextGirviNumber(userId, "transfer_return", `${settings.transferPrefix}-RTN`, now, settings.financialYearStartMonth);

    await db.transaction(async tx => {
      if (transfer.toBranchId !== null) {
        const transferItems = await tx.select().from(girviTransferItemsTable).where(eq(girviTransferItemsTable.transferId, id));
        const loanItemIds = transferItems.map(ti => ti.loanItemId);
        if (loanItemIds.length > 0) {
          // Only revert items still marked "transferred" — a loan item that's since
          // been redeemed/forfeited must keep its terminal status.
          const currentItems = await tx.select().from(girviLoanItemsTable)
            .where(and(eq(girviLoanItemsTable.userId, userId), inArray(girviLoanItemsTable.id, loanItemIds)));
          const stillTransferred = currentItems.filter(it => it.status === "transferred").map(it => it.id);
          if (stillTransferred.length > 0) {
            await tx.update(girviLoanItemsTable)
              .set({ status: "pledged", currentBranchId: transfer.fromBranchId ?? loan.branchId })
              .where(and(eq(girviLoanItemsTable.userId, userId), inArray(girviLoanItemsTable.id, stillTransferred)));
          }
        }
      }

      if (transfer.toCustomerId !== null && transfer.fromCustomerId !== null && loan.customerId === transfer.toCustomerId) {
        const [originalCustomer] = await tx.select().from(girviCustomersTable)
          .where(and(eq(girviCustomersTable.id, transfer.fromCustomerId), eq(girviCustomersTable.userId, userId)));
        if (originalCustomer) {
          await tx.update(girviLoansTable).set({
            customerId: originalCustomer.id,
            customerName: originalCustomer.name,
            customerMobile: originalCustomer.mobile,
            fatherName: originalCustomer.fatherName,
            address: originalCustomer.address,
            kycDocType: originalCustomer.idProofType,
            kycDocNumber: originalCustomer.idProofNumber,
            pan: originalCustomer.pan,
            updatedAt: now,
          }).where(and(eq(girviLoansTable.id, loan.id), eq(girviLoansTable.userId, userId)));
        }
      }

      await tx.update(girviTransfersTable)
        .set({ returnedAt: now, returnVoucherNumber, returnNotes })
        .where(and(eq(girviTransfersTable.id, id), eq(girviTransfersTable.userId, userId)));
    });

    const [updated] = await db.select().from(girviTransfersTable).where(eq(girviTransfersTable.id, id));
    res.json(mapTransfer(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to return girvi transfer");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
