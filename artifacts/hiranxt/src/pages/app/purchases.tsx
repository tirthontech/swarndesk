import React, { useState, useEffect } from "react";
import { formatCurrency, formatDate, formatWeight } from "@/lib/utils";
import {
  useListPurchases, useCreatePurchase, useUpdatePurchase, useCancelPurchase,
  useListSuppliers, useCreateSupplier, useUpdateSupplier, useDeleteSupplier,
  getListPurchasesQueryKey, getListSuppliersQueryKey,
} from "@workspace/api-client-react";
import type { PurchaseInput, PurchaseUpdate } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useForm } from "react-hook-form";
import { Plus, Pencil, Ban, Users2, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { PageHelpButton, PageHelpDialog } from "@/components/PageHelp";
import { InfoTooltip } from "@/components/InfoTooltip";
import { BankAccountSelect } from "@/components/BankAccountSelect";

interface PurchaseForm {
  supplierId: string; supplierName: string; metalType: string; purity: string;
  grossWeight: number; netWeight: number; fineWeight: number;
  ratePerGram: number; makingCharges: number; totalAmount: number; paidAmount: number; paymentMode: string;
  metalPaidWeight: number; metalPaidPurity: string;
  gstRate: string; purchaseDate: string; notes: string;
}

// Same fixed purity options as inventory.tsx / billing.tsx, for consistency across the app.
const PURITIES = ["24K", "22K", "18K", "14K", "925", "999", "Unspecified"];

// Fine gold/silver content as a % of gross weight, by purity/touch — used to auto-derive
// Fine Weight from Net Weight instead of asking the shop owner to work it out by hand.
const PURITY_PERCENT: Record<string, number> = {
  "24K": 100, "22K": 91.6, "18K": 75, "14K": 58.3, "925": 92.5, "999": 99.9, "Unspecified": 100,
};

// A plain number Input with a fixed, non-editable unit suffix ("gm", "%") shown inline at
// the right edge — so the shop owner sees "20 gm" without the unit ever entering the value.
function UnitInput({ suffix, className, ...props }: React.ComponentProps<"input"> & { suffix: string }) {
  return (
    <div className="relative">
      <Input type="number" className={`pr-10 ${className ?? ""}`} {...props} />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>
    </div>
  );
}

export default function Purchases() {
  const [addOpen, setAddOpen] = useState(false);
  const [editPurchase, setEditPurchase] = useState<any | null>(null);
  const [suppliersOpen, setSuppliersOpen] = useState(false);
  const [supplierForm, setSupplierForm] = useState({ id: 0, name: "", mobile: "", address: "", gstin: "", email: "", openingBalance: "0", openingBalanceType: "credit" as "debit" | "credit" });
  const [supplierDialogOpen, setSupplierDialogOpen] = useState(false);
  const [pageHelpOpen, setPageHelpOpen] = useState(false);
  const [bankAccountId, setBankAccountId] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: purchases, isLoading } = useListPurchases();
  const { data: suppliers } = useListSuppliers();
  const createPurchase = useCreatePurchase();
  const updatePurchase = useUpdatePurchase();
  const cancelPurchase = useCancelPurchase();
  const createSupplier = useCreateSupplier();
  const updateSupplier = useUpdateSupplier();
  const deleteSupplier = useDeleteSupplier();

  const { register, handleSubmit, reset, setValue, watch } = useForm<PurchaseForm>({
    defaultValues: { metalType: "gold", purity: "22K", paymentMode: "cash", purchaseDate: new Date().toISOString().split("T")[0] }
  });

  const netWeight = watch("netWeight");
  const ratePerGram = watch("ratePerGram");
  const makingChargesWatch = watch("makingCharges");
  const totalAmountWatch = watch("totalAmount");
  const metalTypeWatch = watch("metalType") ?? "gold";
  const purityWatch = watch("purity") ?? "22K";
  const paymentModeWatch = watch("paymentMode") ?? "cash";
  const supplierIdWatch = watch("supplierId") ?? "";

  // Fine weight = pure-metal-equivalent weight = Net Weight × purity%. Auto-derived so the
  // owner doesn't have to work out the touch conversion by hand; still editable afterward.
  useEffect(() => {
    const nw = parseFloat(String(netWeight));
    if (!isFinite(nw) || nw <= 0) return;
    const pct = PURITY_PERCENT[purityWatch] ?? 100;
    setValue("fineWeight", Math.round(nw * (pct / 100) * 1000) / 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [netWeight, purityWatch]);

  const invalidatePurchases = () => queryClient.invalidateQueries({ queryKey: getListPurchasesQueryKey() });
  const invalidateSuppliers = () => queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });

  const onSelectSupplier = (id: string) => {
    setValue("supplierId", id);
    const s = (suppliers ?? []).find(s => String(s.id) === id);
    if (s) setValue("supplierName", s.name);
  };

  const onSubmit = (data: PurchaseForm) => {
    const makingCharges = parseFloat(String(makingChargesWatch)) || 0;
    const total = data.totalAmount > 0
      ? parseFloat(String(data.totalAmount))
      : (parseFloat(String(netWeight)) * parseFloat(String(ratePerGram)) || 0) + makingCharges;
    const payload: PurchaseInput & { makingCharges: number; metalPaidWeight?: number; metalPaidPurity?: string } = {
      supplierName: data.supplierName,
      supplierId: data.supplierId ? parseInt(data.supplierId) : null,
      metalType: data.metalType,
      purity: data.purity,
      grossWeight: parseFloat(String(data.grossWeight)),
      netWeight: parseFloat(String(data.netWeight)),
      fineWeight: parseFloat(String(data.fineWeight || data.netWeight)),
      ratePerGram: parseFloat(String(data.ratePerGram)),
      makingCharges,
      totalAmount: total,
      paidAmount: data.paidAmount !== undefined && String(data.paidAmount) !== "" ? parseFloat(String(data.paidAmount)) : total,
      paymentMode: data.paymentMode,
      bankAccountId,
      gstRate: data.gstRate ? parseFloat(data.gstRate) : undefined,
      purchaseDate: new Date(data.purchaseDate).toISOString(),
      notes: data.notes || null,
      ...(data.paymentMode === "fine" ? {
        metalPaidWeight: data.metalPaidWeight ? parseFloat(String(data.metalPaidWeight)) : undefined,
        metalPaidPurity: data.metalPaidPurity || undefined,
      } : {}),
    };
    createPurchase.mutate({ data: payload }, {
      onSuccess: () => {
        invalidatePurchases();
        toast({ title: "Purchase recorded" });
        setAddOpen(false);
        setBankAccountId(null);
        reset();
      },
      onError: () => toast({ title: "Failed to record purchase", variant: "destructive" }),
    });
  };

  const openEdit = (p: any) => {
    setEditPurchase(p);
    setBankAccountId(p.bankAccountId ?? null);
    reset({
      supplierId: p.supplierId ? String(p.supplierId) : "",
      supplierName: p.supplierName,
      metalType: p.metalType,
      purity: p.purity,
      grossWeight: p.grossWeight,
      netWeight: p.netWeight,
      fineWeight: p.fineWeight,
      ratePerGram: p.ratePerGram,
      makingCharges: p.makingCharges ?? 0,
      totalAmount: p.totalAmount,
      paidAmount: p.paidAmount,
      paymentMode: p.paymentMode,
      metalPaidWeight: p.metalPaidWeight ?? undefined,
      metalPaidPurity: p.metalPaidPurity ?? "",
      gstRate: p.gstRate != null ? String(p.gstRate) : "",
      purchaseDate: p.purchaseDate.split("T")[0],
      notes: p.notes ?? "",
    });
  };

  const onEditSubmit = (data: PurchaseForm) => {
    if (!editPurchase) return;
    const payload: PurchaseUpdate & { makingCharges: number; metalPaidWeight?: number; metalPaidPurity?: string } = {
      supplierName: data.supplierName,
      supplierId: data.supplierId ? parseInt(data.supplierId) : null,
      metalType: data.metalType,
      purity: data.purity,
      grossWeight: parseFloat(String(data.grossWeight)),
      netWeight: parseFloat(String(data.netWeight)),
      fineWeight: parseFloat(String(data.fineWeight || data.netWeight)),
      ratePerGram: parseFloat(String(data.ratePerGram)),
      makingCharges: parseFloat(String(data.makingCharges)) || 0,
      totalAmount: parseFloat(String(data.totalAmount)),
      paidAmount: parseFloat(String(data.paidAmount)),
      paymentMode: data.paymentMode,
      bankAccountId,
      gstRate: data.gstRate ? parseFloat(data.gstRate) : null,
      purchaseDate: new Date(data.purchaseDate).toISOString(),
      notes: data.notes || null,
      ...(data.paymentMode === "fine" ? {
        metalPaidWeight: data.metalPaidWeight ? parseFloat(String(data.metalPaidWeight)) : undefined,
        metalPaidPurity: data.metalPaidPurity || undefined,
      } : {}),
    };
    updatePurchase.mutate({
      id: editPurchase.id,
      data: payload
    }, {
      onSuccess: () => {
        invalidatePurchases();
        toast({ title: "Purchase updated" });
        setEditPurchase(null);
        setBankAccountId(null);
        reset();
      },
      onError: (err: any) => toast({ title: err?.error ?? "Failed to update — payments may already be collected", variant: "destructive" }),
    });
  };

  const handleCancel = (id: number) => {
    if (!confirm("Cancel this purchase? Its journal entry will be reversed.")) return;
    cancelPurchase.mutate({ id }, {
      onSuccess: () => { invalidatePurchases(); toast({ title: "Purchase cancelled" }); },
      onError: (err: any) => toast({ title: err?.error ?? "Failed to cancel — payments may already be collected", variant: "destructive" }),
    });
  };

  const openNewSupplier = () => { setSupplierForm({ id: 0, name: "", mobile: "", address: "", gstin: "", email: "", openingBalance: "0", openingBalanceType: "credit" }); setSupplierDialogOpen(true); };
  const openEditSupplier = (s: any) => { setSupplierForm({ id: s.id, name: s.name, mobile: s.mobile, address: s.address ?? "", gstin: s.gstin ?? "", email: s.email ?? "", openingBalance: String(s.openingBalance ?? 0), openingBalanceType: s.openingBalanceType ?? "credit" }); setSupplierDialogOpen(true); };

  const saveSupplier = () => {
    if (!supplierForm.name.trim() || !supplierForm.mobile.trim()) {
      toast({ title: "Name and mobile are required", variant: "destructive" }); return;
    }
    const payload = {
      name: supplierForm.name.trim(), mobile: supplierForm.mobile.trim(), address: supplierForm.address || null, gstin: supplierForm.gstin || null, email: supplierForm.email || null,
      openingBalance: parseFloat(supplierForm.openingBalance) || 0, openingBalanceType: supplierForm.openingBalanceType,
    };
    if (supplierForm.id > 0) {
      updateSupplier.mutate({ id: supplierForm.id, data: payload }, {
        onSuccess: () => { invalidateSuppliers(); toast({ title: "Supplier updated" }); setSupplierDialogOpen(false); },
        onError: () => toast({ title: "Failed to update supplier", variant: "destructive" }),
      });
    } else {
      createSupplier.mutate({ data: payload }, {
        onSuccess: () => { invalidateSuppliers(); toast({ title: "Supplier added" }); setSupplierDialogOpen(false); },
        onError: () => toast({ title: "Failed to add supplier", variant: "destructive" }),
      });
    }
  };

  const removeSupplier = (id: number) => {
    if (!confirm("Delete this supplier?")) return;
    deleteSupplier.mutate({ id }, {
      onSuccess: () => { invalidateSuppliers(); toast({ title: "Supplier deleted" }); },
      onError: () => toast({ title: "Failed to delete supplier", variant: "destructive" }),
    });
  };

  const renderPurchaseForm = (submitFn: (d: PurchaseForm) => void, submitLabel: string, pending: boolean) => (
    <form onSubmit={handleSubmit(submitFn)} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">Supplier</label>
          <Select value={supplierIdWatch} onValueChange={onSelectSupplier}>
            <SelectTrigger data-testid="select-purchase-supplier"><SelectValue placeholder="Select an existing supplier (optional)" /></SelectTrigger>
            <SelectContent>
              {(suppliers ?? []).map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">Supplier Name *</label>
          <Input {...register("supplierName", { required: true })} placeholder="Mehta Gold Suppliers" data-testid="input-supplier-name" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Metal Type / Form</label>
          <Select value={metalTypeWatch} onValueChange={v => setValue("metalType", v)}>
            <SelectTrigger data-testid="select-metal-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="gold">Gold</SelectItem>
              <SelectItem value="silver">Silver</SelectItem>
              <SelectItem value="bullion">Bullion</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Purity</label>
          <Select value={purityWatch} onValueChange={v => setValue("purity", v)}>
            <SelectTrigger data-testid="select-purchase-purity"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PURITIES.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Gross Weight (g) *</label>
          <UnitInput suffix="gm" step="0.001" {...register("grossWeight", { required: true })} data-testid="input-purchase-gross" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Net Weight (g) *</label>
          <UnitInput suffix="gm" step="0.001" {...register("netWeight", { required: true })} data-testid="input-purchase-net" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
            Fine Weight (g) — auto
            <InfoTooltip text="Fine weight = pure metal equivalent after adjusting for purity — e.g. 100g of 22K gold (91.6% pure) is about 91.6g fine weight. Auto-calculated from Net Weight × purity; edit to override." />
          </label>
          <UnitInput suffix="gm" step="0.001" {...register("fineWeight")} placeholder="Auto-calculated from Net Weight × purity" data-testid="input-purchase-fine" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Rate per gram (₹) *</label>
          <Input type="number" {...register("ratePerGram", { required: true })} data-testid="input-purchase-rate" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Making Charges (₹, optional)</label>
          <Input type="number" {...register("makingCharges")} placeholder="0" data-testid="input-purchase-making-charges" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Total Amount (₹, optional)</label>
          <Input type="number" {...register("totalAmount")} placeholder="Auto-calculated if blank" data-testid="input-purchase-total" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">GST Rate (optional)</label>
          <UnitInput suffix="%" step="0.1" {...register("gstRate")} placeholder="Leave blank if no GST" data-testid="input-purchase-gst-rate" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Payment Mode</label>
          <Select value={paymentModeWatch} onValueChange={v => { setValue("paymentMode", v); setBankAccountId(null); }}>
            <SelectTrigger data-testid="select-purchase-payment-mode"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="cash">Cash</SelectItem>
              <SelectItem value="bank">Bank</SelectItem>
              <SelectItem value="upi">UPI</SelectItem>
              <SelectItem value="fine">Fine (Metal Exchange)</SelectItem>
              <SelectItem value="credit">Credit (unpaid)</SelectItem>
              <SelectItem value="partial">Partial</SelectItem>
            </SelectContent>
          </Select>
          <BankAccountSelect paymentMode={paymentModeWatch} bankAccountId={bankAccountId} onChange={setBankAccountId} className="mt-2" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            {paymentModeWatch === "fine" ? "Value Settled in Metal (₹)" : "Paid Amount (₹)"}
          </label>
          <Input type="number" {...register("paidAmount")} placeholder={`Default: full ${totalAmountWatch ? formatCurrency(totalAmountWatch) : "amount"}`} data-testid="input-purchase-paid" />
          {paymentModeWatch === "fine" && (
            <p className="text-xs text-muted-foreground mt-1">Rupee value of the gold/silver handed to the supplier instead of cash — booked against your metal stock, not Cash/Bank.</p>
          )}
        </div>
        {paymentModeWatch === "fine" && (
          <>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Metal Paid Weight</label>
              <UnitInput suffix="gm" step="0.001" {...register("metalPaidWeight")} placeholder="Weight of gold/silver handed over" data-testid="input-purchase-metal-paid-weight" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Metal Paid Touch / Purity</label>
              <Select value={watch("metalPaidPurity") || purityWatch} onValueChange={v => setValue("metalPaidPurity", v)}>
                <SelectTrigger data-testid="select-purchase-metal-paid-purity"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PURITIES.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </>
        )}
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Purchase Date</label>
          <Input type="date" {...register("purchaseDate")} data-testid="input-purchase-date" />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">Notes</label>
          <Input {...register("notes")} data-testid="input-purchase-notes" />
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => { setAddOpen(false); setEditPurchase(null); }}>Cancel</Button>
        <Button type="submit" disabled={pending} data-testid="button-submit-purchase">
          {pending ? "Saving..." : submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );

  return (
    <div className="space-y-5 max-w-7xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Purchases</h1>
          <p className="text-muted-foreground text-sm">Track metal receipts and supplier purchases</p>
          <div className="mt-1"><PageHelpButton onClick={() => setPageHelpOpen(true)} /></div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setSuppliersOpen(true)} className="gap-2" data-testid="button-manage-suppliers">
            <Users2 className="w-4 h-4" />Suppliers
          </Button>
          <Button onClick={() => { reset({ metalType: "gold", purity: "22K", paymentMode: "cash", purchaseDate: new Date().toISOString().split("T")[0] }); setAddOpen(true); }} className="gap-2" data-testid="button-add-purchase">
            <Plus className="w-4 h-4" />New Purchase
          </Button>
        </div>
      </div>

      <Card className="border-border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground text-xs">
                <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">Invoice</th>
                <th className="px-4 py-3 text-left font-medium">Supplier</th>
                <th className="px-4 py-3 text-left font-medium">Metal</th>
                <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Gross Wt.</th>
                <th className="px-4 py-3 text-right font-medium">Fine Wt.</th>
                <th className="px-4 py-3 text-right font-medium hidden md:table-cell">Rate/g</th>
                <th className="px-4 py-3 text-right font-medium">Total</th>
                <th className="px-4 py-3 text-right font-medium hidden lg:table-cell">Balance</th>
                <th className="px-4 py-3 text-left font-medium hidden sm:table-cell">Date</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">Loading...</td></tr>}
              {!isLoading && (!purchases || purchases.length === 0) && (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center">
                    <div className="text-muted-foreground mb-3">No purchases recorded yet.</div>
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAddOpen(true)} data-testid="button-add-first-purchase">
                      <Plus className="w-3.5 h-3.5" />
                      Record First Purchase
                    </Button>
                  </td>
                </tr>
              )}
              {(purchases ?? []).map(p => (
                <tr key={p.id} className={`border-b border-border hover:bg-muted/10 ${p.cancelledAt ? "opacity-50" : ""}`} data-testid={`row-purchase-${p.id}`}>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground hidden sm:table-cell">{p.invoiceNumber}</td>
                  <td className="px-4 py-3 font-medium">{p.supplierName}{p.cancelledAt && <Badge variant="secondary" className="ml-2 text-[10px]">Cancelled</Badge>}</td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className="capitalize">{p.metalType} {p.purity}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground hidden md:table-cell">{formatWeight(p.grossWeight)}</td>
                  <td className="px-4 py-3 text-right text-muted-foreground">{formatWeight(p.fineWeight)}</td>
                  <td className="px-4 py-3 text-right text-muted-foreground hidden md:table-cell">₹{p.ratePerGram.toLocaleString("en-IN")}</td>
                  <td className="px-4 py-3 text-right font-semibold text-primary">{formatCurrency(p.totalAmount)}</td>
                  <td className="px-4 py-3 text-right text-muted-foreground hidden lg:table-cell">{p.balanceAmount > 0 ? formatCurrency(p.balanceAmount) : "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs hidden sm:table-cell">{formatDate(p.purchaseDate)}</td>
                  <td className="px-4 py-3 text-right">
                    {!p.cancelledAt && (
                      <div className="flex justify-end gap-1">
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(p)} data-testid={`button-edit-purchase-${p.id}`}><Pencil className="w-3.5 h-3.5" /></Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-red-600" onClick={() => handleCancel(p.id)} data-testid={`button-cancel-purchase-${p.id}`}><Ban className="w-3.5 h-3.5" /></Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Record Purchase</DialogTitle></DialogHeader>
          {renderPurchaseForm(onSubmit, "Record Purchase", createPurchase.isPending)}
        </DialogContent>
      </Dialog>

      <Dialog open={!!editPurchase} onOpenChange={open => { if (!open) setEditPurchase(null); }}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit Purchase</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground -mt-2">Amount/weight fields can only be changed before any follow-up payment has been collected.</p>
          {renderPurchaseForm(onEditSubmit, "Save Changes", updatePurchase.isPending)}
        </DialogContent>
      </Dialog>

      {/* Suppliers management */}
      <Dialog open={suppliersOpen} onOpenChange={setSuppliersOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="flex items-center justify-between gap-2"><span>Suppliers</span><Button size="sm" className="gap-1.5" onClick={openNewSupplier}><Plus className="w-3.5 h-3.5" />Add</Button></DialogTitle></DialogHeader>
          <div className="space-y-1.5">
            {(suppliers ?? []).length === 0 && <p className="text-sm text-muted-foreground py-6 text-center">No suppliers yet.</p>}
            {(suppliers ?? []).map(s => (
              <div key={s.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-border text-sm">
                <div>
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-muted-foreground">{s.mobile}{s.gstin ? ` · ${s.gstin}` : ""}</div>
                  {!!s.openingBalance && s.openingBalance > 0 && (
                    <div className="text-[11px] text-muted-foreground">Opening: {formatCurrency(s.openingBalance)} {s.openingBalanceType === "debit" ? "Dr" : "Cr"}</div>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEditSupplier(s)}><Pencil className="w-3.5 h-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-red-600" onClick={() => removeSupplier(s.id)}><Trash2 className="w-3.5 h-3.5" /></Button>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={supplierDialogOpen} onOpenChange={setSupplierDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{supplierForm.id > 0 ? "Edit Supplier" : "New Supplier"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Name *</Label><Input value={supplierForm.name} onChange={e => setSupplierForm(f => ({ ...f, name: e.target.value }))} /></div>
            <div><Label>Mobile *</Label><Input value={supplierForm.mobile} onChange={e => setSupplierForm(f => ({ ...f, mobile: e.target.value }))} /></div>
            <div><Label>GSTIN</Label><Input value={supplierForm.gstin} onChange={e => setSupplierForm(f => ({ ...f, gstin: e.target.value }))} /></div>
            <div><Label>Address</Label><Input value={supplierForm.address} onChange={e => setSupplierForm(f => ({ ...f, address: e.target.value }))} /></div>
            <div><Label>Email</Label><Input value={supplierForm.email} onChange={e => setSupplierForm(f => ({ ...f, email: e.target.value }))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Opening Balance</Label><Input type="number" value={supplierForm.openingBalance} onChange={e => setSupplierForm(f => ({ ...f, openingBalance: e.target.value }))} /></div>
              <div>
                <Label className="flex items-center gap-1">
                  Balance Side
                  <InfoTooltip text="What this supplier was already owed (or had already been paid in advance) before you started using this software. Credit = you owe them; Debit = you paid in advance." />
                </Label>
                <Select value={supplierForm.openingBalanceType} onValueChange={v => setSupplierForm(f => ({ ...f, openingBalanceType: v as "debit" | "credit" }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="credit">Credit (you owe them)</SelectItem>
                    <SelectItem value="debit">Debit (you paid in advance)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={saveSupplier} disabled={createSupplier.isPending || updateSupplier.isPending}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PageHelpDialog
        open={pageHelpOpen}
        onClose={() => setPageHelpOpen(false)}
        title="Purchases"
        description="Records of gold/silver bought in from suppliers — raw metal or bullion coming into your shop, separate from finished-item sales."
        sections={[
          {
            heading: "What you can do here",
            items: [
              "New Purchase — record a metal receipt from a supplier",
              "Suppliers — add/edit the supplier list used when recording a purchase",
              "Edit / Cancel — corrections are only allowed before any follow-up payment is collected against a purchase",
            ],
          },
          {
            heading: "Terms you'll see",
            items: [
              "Fine Weight — the pure-metal equivalent of the weight purchased, adjusted for purity",
              "Balance — how much of the total purchase amount is still unpaid to the supplier",
              "Payment Mode: Credit — nothing paid yet, the full amount is owed",
            ],
          },
        ]}
      />
    </div>
  );
}
