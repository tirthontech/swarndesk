import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useBackClose } from "@/hooks/use-back-close";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { ShortcutsHelpDialog, ShortcutsHelpButton } from "@/components/ShortcutsHelp";
import { PageHelpButton, PageHelpDialog } from "@/components/PageHelp";
import { InfoTooltip } from "@/components/InfoTooltip";
import { useGetSettings, useGetCurrentRates } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Banknote, AlertTriangle, CheckCircle2, TrendingDown, TrendingUp,
  Plus, RefreshCw, XCircle, ChevronDown, ChevronUp, Calendar,
  MessageCircle, Search, Clock, Coins, Scale, Pencil, Tag,
  RotateCcw, Flame, ArrowLeftRight, PackageCheck, Send, PlusCircle, Bell,
} from "lucide-react";
import { API, authHeader, getAuthHeaders } from "./api";
import type { Loan, LoanItem, Payment, Rates, Branch, Summary, PartialRelease, GirviSettings } from "./types";
import { printInterestReceipt, openGirviVoucher, openReturnVoucher, openPartialReleaseVoucher, printForfeitureNotice, computeLiveEstValue } from "./vouchers";
import NewLoanDialog from "./NewLoanDialog";
import EditLoanDialog from "./EditLoanDialog";
import TopUpDialog from "./TopUpDialog";
import DueDatePresets from "./DueDatePresets";
import { BankAccountSelect } from "@/components/BankAccountSelect";

function toVikramSamvat(date: Date): string {
  const day = date.getDate();
  const month = date.getMonth();
  const year = date.getFullYear();
  const vsYear = year + (month >= 3 ? 57 : 56);
  const hindiMonths = ["चैत्र", "वैशाख", "ज्येष्ठ", "आषाढ़", "श्रावण", "भाद्रपद", "आश्विन", "कार्तिक", "मार्गशीर्ष", "पौष", "माघ", "फाल्गुन"];
  const vsMonth = hindiMonths[(month + 9) % 12];
  return `${day} ${vsMonth}, वि.सं. ${vsYear}`;
}

function calcDaysElapsed(startDate: string) {
  return Math.floor((Date.now() - new Date(startDate).getTime()) / 86400000);
}

export default function LoansTab({ branches, autoOpenNew }: { branches: Branch[]; autoOpenNew?: boolean }) {
  const { toast } = useToast();
  const { data: settings } = useGetSettings();
  const { data: rates } = useGetCurrentRates();

  const [loans, setLoans] = useState<Loan[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("active");
  const [dueFilter, setDueFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [calendarMode, setCalendarMode] = useState<"en" | "hi">("en");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [loanPayments, setLoanPayments] = useState<Record<number, Payment[]>>({});
  const [loanItems, setLoanItems] = useState<Record<number, LoanItem[]>>({});
  const [loanReleases, setLoanReleases] = useState<Record<number, PartialRelease[]>>({});

  const [showNewLoan, setShowNewLoan] = useState(false);
  const [editLoan, setEditLoan] = useState<Loan | null>(null);
  const [topUpLoan, setTopUpLoan] = useState<Loan | null>(null);
  const [girviSettings, setGirviSettings] = useState<GirviSettings | null>(null);
  const [followUps, setFollowUps] = useState<Loan[]>([]);
  const [followUpsCollapsed, setFollowUpsCollapsed] = useState(false);
  const [serialQuery, setSerialQuery] = useState("");
  const [serialResults, setSerialResults] = useState<{ item: Pick<LoanItem, "id" | "itemType" | "quantity" | "metalType" | "purity" | "grossWeight" | "netWeight" | "estimatedValue" | "notes" | "itemCode" | "status">; loan: Loan }[]>([]);
  const [serialSearching, setSerialSearching] = useState(false);
  const [actionLoan, setActionLoan] = useState<Loan | null>(null);
  const [actionType, setActionType] = useState<"redeem" | "forfeit" | "extend" | "collect" | "renew" | "transfer" | "partialRelease" | null>(null);
  const [goldSaleValue, setGoldSaleValue] = useState("");
  const [newDueDate, setNewDueDate] = useState("");
  const [collectAmount, setCollectAmount] = useState("");
  const [collectType, setCollectType] = useState("auto");
  const [collectMode, setCollectMode] = useState("cash");
  const [collectBankAccountId, setCollectBankAccountId] = useState<number | null>(null);
  const [collectDate, setCollectDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [collectNotes, setCollectNotes] = useState("");
  const [renewInterestPaid, setRenewInterestPaid] = useState("");
  const [renewNewDueDate, setRenewNewDueDate] = useState("");
  const [renewMode, setRenewMode] = useState("cash");
  const [renewBankAccountId, setRenewBankAccountId] = useState<number | null>(null);
  const [renewNotes, setRenewNotes] = useState("");
  const [redeemConfirmed, setRedeemConfirmed] = useState(false);
  const [waiveRedeemInterest, setWaiveRedeemInterest] = useState("0");
  const [redeemMode, setRedeemMode] = useState("cash");
  const [redeemBankAccountId, setRedeemBankAccountId] = useState<number | null>(null);
  const [transferItemIds, setTransferItemIds] = useState<number[]>([]);
  const [transferToBranchId, setTransferToBranchId] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [releaseItemIds, setReleaseItemIds] = useState<number[]>([]);
  const [releaseAmount, setReleaseAmount] = useState("0");
  const [releaseMode, setReleaseMode] = useState("cash");
  const [releaseBankAccountId, setReleaseBankAccountId] = useState<number | null>(null);
  const [releaseNotes, setReleaseNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [lastPayment, setLastPayment] = useState<Payment | null>(null);
  const [lastRelease, setLastRelease] = useState<{ release: PartialRelease; loan: Loan; releasedItems: LoanItem[]; remainingItems: LoanItem[] } | null>(null);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const [pageHelpOpen, setPageHelpOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoOpenNew) setShowNewLoan(true);
  }, [autoOpenNew]);

  const closeNewLoan = useCallback(() => setShowNewLoan(false), []);
  const closeActionDialog = useCallback(() => {
    setActionLoan(null); setActionType(null); setRedeemConfirmed(false);
    setCollectBankAccountId(null); setCollectDate(new Date().toISOString().split("T")[0]);
    setRenewMode("cash"); setRenewBankAccountId(null);
    setRedeemMode("cash"); setRedeemBankAccountId(null); setReleaseBankAccountId(null);
  }, []);
  useBackClose(showNewLoan, closeNewLoan);
  useBackClose(!!actionLoan, closeActionDialog);

  useEffect(() => {
    if (!lastPayment) return;
    const t = setTimeout(() => setLastPayment(null), 10000);
    return () => clearTimeout(t);
  }, [lastPayment]);

  useEffect(() => {
    if (!lastRelease) return;
    const t = setTimeout(() => setLastRelease(null), 15000);
    return () => clearTimeout(t);
  }, [lastRelease]);

  const shopName = settings?.businessName ?? "SwarnDesk Jewellers";
  const shopAddress = settings?.address ?? "";
  const shopMobile = settings?.mobile ?? "";

  // Summary drives the stat cards AND the filter-tab counts, so it has to be refreshed
  // after anything that moves money — including the collect/renew path below, which
  // deliberately patches the loans list in place rather than reloading it.
  const loadSummary = useCallback(async () => {
    try {
      const r = await fetch(`${API}/stats/summary`, { headers: authHeader() });
      if (r.ok) setSummary(await r.json());
    } catch { /* silent — the stat cards keep their last known values */ }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (dueFilter !== "all") params.set("due", dueFilter);
      const [loansRes] = await Promise.all([
        fetch(`${API}?${params}`, { headers: authHeader() }),
        loadSummary(),
      ]);
      if (loansRes.ok) setLoans(await loansRes.json());
      else if (loansRes.status !== 401) toast({ title: "Failed to load loans", variant: "destructive" });
    } catch {
      toast({ title: "Network error — please check your connection", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [statusFilter, dueFilter, loadSummary]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // "Today's Follow-Ups" — independent of whatever filter tab is selected, so
  // it always reflects overdue/due-soon loans across the whole book.
  const loadFollowUps = useCallback(async () => {
    try {
      const r = await fetch(`${API}/follow-ups`, { headers: authHeader() });
      if (r.ok) setFollowUps(await r.json());
    } catch { /* silent — non-critical panel */ }
  }, []);

  useEffect(() => {
    loadFollowUps();
    (async () => {
      try {
        const r = await fetch(`${API}/settings`, { headers: authHeader() });
        if (r.ok) setGirviSettings(await r.json());
      } catch { /* silent */ }
    })();
  }, [loadFollowUps]);

  const loadPayments = async (loanId: number) => {
    if (loanPayments[loanId]) return;
    try {
      const r = await fetch(`${API}/${loanId}/payments`, { headers: authHeader() });
      if (r.ok) { const data = await r.json(); setLoanPayments(prev => ({ ...prev, [loanId]: data })); }
    } catch { /* silent */ }
  };

  const loadItems = async (loanId: number) => {
    if (loanItems[loanId]) return;
    try {
      const r = await fetch(`${API}/${loanId}/items`, { headers: authHeader() });
      if (r.ok) { const data = await r.json(); setLoanItems(prev => ({ ...prev, [loanId]: data })); }
    } catch { /* silent */ }
  };

  const loadReleases = async (loanId: number) => {
    if (loanReleases[loanId]) return;
    try {
      const r = await fetch(`${API}/${loanId}/partial-releases`, { headers: authHeader() });
      if (r.ok) { const data = await r.json(); setLoanReleases(prev => ({ ...prev, [loanId]: data })); }
    } catch { /* silent */ }
  };

  const handleExpand = (id: number) => {
    setExpandedId(expandedId === id ? null : id);
    if (expandedId !== id) { loadPayments(id); loadItems(id); loadReleases(id); }
  };

  // Look up a pledged item by the shop's own tag/serial number (written on the
  // item at pledge time) and jump straight to the loan it belongs to — for
  // when a customer walks in with just the tag, not their loan number.
  useEffect(() => {
    if (!serialQuery.trim() || serialQuery.trim().length < 2) { setSerialResults([]); return; }
    let cancelled = false;
    setSerialSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`${API}/items/search?code=${encodeURIComponent(serialQuery.trim())}`, { headers: authHeader() });
        if (r.ok && !cancelled) setSerialResults(await r.json());
      } catch { /* ignore */ } finally { if (!cancelled) setSerialSearching(false); }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [serialQuery]);

  const jumpToLoan = (loan: Loan) => {
    setStatusFilter("all");
    setDueFilter("all");
    setSearch(loan.loanNumber);
    setDateFrom("");
    setDateTo("");
    setSerialQuery("");
    setSerialResults([]);
    setExpandedId(loan.id);
    loadPayments(loan.id); loadItems(loan.id); loadReleases(loan.id);
  };

  const filteredLoans = useMemo(() => {
    let result = loans;
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(l =>
        l.customerName.toLowerCase().includes(q) ||
        l.loanNumber.toLowerCase().includes(q) ||
        l.customerMobile.includes(q) ||
        (l.itemDescription ?? "").toLowerCase().includes(q) ||
        (l.address ?? "").toLowerCase().includes(q)
      );
    }
    // Pledge-date range — compared in the shop's local date (not a raw UTC slice of the
    // ISO string), so a loan pledged late at night still lands on the calendar day the
    // owner actually entered it on.
    if (dateFrom || dateTo) {
      result = result.filter(l => {
        const d = new Date(l.startDate);
        const pledgeDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (dateFrom && pledgeDate < dateFrom) return false;
        if (dateTo && pledgeDate > dateTo) return false;
        return true;
      });
    }
    return result;
  }, [loans, search, dateFrom, dateTo]);

  const customerExposure = useMemo(() => {
    const map: Record<string, { name: string; mobile: string; loans: Loan[]; totalDue: number }> = {};
    filteredLoans.filter(l => l.status === "active" || l.status === "extended").forEach(l => {
      const key = l.customerMobile;
      if (!map[key]) map[key] = { name: l.customerName, mobile: l.customerMobile, loans: [], totalDue: 0 };
      map[key].loans.push(l);
      map[key].totalDue += l.totalDue;
    });
    return Object.values(map).filter(c => c.loans.length > 1).sort((a, b) => b.totalDue - a.totalDue);
  }, [filteredLoans]);

  const formatDateDisplay = (iso: string) => {
    const d = new Date(iso);
    return calendarMode === "hi" ? toVikramSamvat(d) : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  };

  const branchName = (id: number | null) => branches.find(b => b.id === id)?.name ?? "—";

  const handleAction = async () => {
    if (!actionLoan || !actionType) return;
    setSubmitting(true);
    try {
      if (actionType === "transfer") {
        if (transferItemIds.length === 0) { toast({ title: "Select at least one item to transfer", variant: "destructive" }); setSubmitting(false); return; }
        if (!transferToBranchId) { toast({ title: "Select a destination branch", variant: "destructive" }); setSubmitting(false); return; }
        const r = await fetch(`${API}/transfers`, {
          method: "POST", headers: getAuthHeaders(),
          body: JSON.stringify({ loanId: actionLoan.id, itemIds: transferItemIds, toBranchId: parseInt(transferToBranchId), reason: transferReason.trim() || null }),
        });
        if (!r.ok) throw new Error((await r.json()).error ?? "Failed");
        toast({ title: "Items transferred" });
        setLoanItems(prev => { const n = { ...prev }; delete n[actionLoan.id]; return n; });
        setActionLoan(null); setActionType(null);
        setTransferItemIds([]); setTransferToBranchId(""); setTransferReason("");
        setSubmitting(false);
        return;
      }

      if (actionType === "partialRelease") {
        if (releaseItemIds.length === 0) { toast({ title: "Select at least one item to release", variant: "destructive" }); setSubmitting(false); return; }
        const pledgedCount = (loanItems[actionLoan.id] ?? []).filter(it => it.status === "pledged").length;
        if (releaseItemIds.length >= pledgedCount) {
          toast({ title: "That's every pledged item — use Redeem to close out the loan instead", variant: "destructive" });
          setSubmitting(false); return;
        }
        const amt = parseFloat(releaseAmount) || 0;
        if (amt < 0) { toast({ title: "Amount cannot be negative", variant: "destructive" }); setSubmitting(false); return; }
        if (amt > actionLoan.totalDue + 0.01) {
          toast({ title: `Amount exceeds total amount due (${formatCurrency(actionLoan.totalDue)})`, variant: "destructive" });
          setSubmitting(false); return;
        }
        const r = await fetch(`${API}/${actionLoan.id}/partial-release`, {
          method: "POST", headers: getAuthHeaders(),
          body: JSON.stringify({ itemIds: releaseItemIds, amount: amt, paymentMode: releaseMode, bankAccountId: releaseBankAccountId, notes: releaseNotes.trim() || null }),
        });
        if (!r.ok) throw new Error((await r.json()).error ?? "Failed");
        const result: { loan: Loan; release: PartialRelease; releasedItems: LoanItem[] } = await r.json();
        const previousItems = loanItems[actionLoan.id] ?? [];
        const remainingItems = previousItems.filter(it => !releaseItemIds.includes(it.id));
        setLoans(prev => prev.map(l => l.id === actionLoan.id ? result.loan : l));
        setLoanItems(prev => { const n = { ...prev }; delete n[actionLoan.id]; return n; });
        setLoanPayments(prev => { const n = { ...prev }; delete n[actionLoan.id]; return n; });
        setLoanReleases(prev => { const n = { ...prev }; delete n[actionLoan.id]; return n; });
        setLastRelease({ release: result.release, loan: result.loan, releasedItems: result.releasedItems, remainingItems });
        toast({ title: `${releaseItemIds.length} item${releaseItemIds.length !== 1 ? "s" : ""} released. Print voucher below.` });
        loadSummary();
        loadFollowUps();
        setActionLoan(null); setActionType(null);
        setReleaseItemIds([]); setReleaseAmount("0"); setReleaseMode("cash"); setReleaseBankAccountId(null); setReleaseNotes("");
        setSubmitting(false);
        return;
      }

      let url = `${API}/${actionLoan.id}`;
      let method = "PATCH";
      let body: Record<string, unknown> = {};

      if (actionType === "collect") {
        url = `${API}/${actionLoan.id}/collect-interest`;
        method = "POST";
        const amt = parseFloat(collectAmount);
        if (!isFinite(amt) || amt <= 0) { toast({ title: "Enter a valid positive amount", variant: "destructive" }); setSubmitting(false); return; }
        if (collectType === "auto" && amt > actionLoan.totalDue + 0.01) {
          toast({ title: `Amount exceeds total due (${formatCurrency(actionLoan.totalDue)})`, variant: "destructive" });
          setSubmitting(false); return;
        }
        if (collectType === "waiver" && amt > actionLoan.outstandingInterest + 0.01) {
          toast({ title: `Cannot waive more than the outstanding interest (${formatCurrency(actionLoan.outstandingInterest)})`, variant: "destructive" });
          setSubmitting(false); return;
        }
        body = {
          amount: amt, paymentType: collectType,
          paymentMode: collectType === "waiver" ? undefined : collectMode,
          bankAccountId: collectType === "waiver" ? undefined : collectBankAccountId,
          paymentDate: collectDate ? new Date(collectDate).toISOString() : undefined,
          notes: collectNotes.trim() || null,
        };
      } else if (actionType === "renew") {
        url = `${API}/${actionLoan.id}/renew`;
        method = "POST";
        const paid = parseFloat(renewInterestPaid);
        body = {
          interestPaid: isFinite(paid) && paid >= 0 ? paid : 0,
          newDueDate: renewNewDueDate ? new Date(renewNewDueDate).toISOString() : null,
          paymentMode: renewMode,
          bankAccountId: renewBankAccountId,
          notes: renewNotes.trim() || null,
        };
      } else if (actionType === "redeem") {
        if (!redeemConfirmed) {
          toast({ title: "Please confirm the pledged item(s) have been returned", variant: "destructive" });
          setSubmitting(false); return;
        }
        const waive = parseFloat(waiveRedeemInterest) || 0;
        if (waive < 0 || waive > actionLoan.outstandingInterest + 0.01) {
          toast({ title: `Waived interest must be between 0 and ${formatCurrency(actionLoan.outstandingInterest)}`, variant: "destructive" });
          setSubmitting(false); return;
        }
        body = { status: "redeemed", waiveInterest: waive, paymentMode: redeemMode, bankAccountId: redeemBankAccountId };
      } else if (actionType === "forfeit") {
        const saleVal = parseFloat(goldSaleValue);
        if (!isFinite(saleVal) || saleVal < 0) { toast({ title: "Enter a valid gold sale value (0 or more)", variant: "destructive" }); setSubmitting(false); return; }
        body = { status: "forfeited", goldSaleValue: saleVal };
      } else if (actionType === "extend") {
        if (!newDueDate) { toast({ title: "Select a new due date", variant: "destructive" }); setSubmitting(false); return; }
        const nd = new Date(newDueDate);
        if (isNaN(nd.getTime())) { toast({ title: "Invalid due date", variant: "destructive" }); setSubmitting(false); return; }
        body = { status: "extended", newDueDate: nd.toISOString() };
      }

      const r = await fetch(url, { method, headers: getAuthHeaders(), body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed");

      if (actionType === "collect" || actionType === "renew") {
        const updatedLoan: Loan = await r.json();
        setLoanPayments(prev => { const n = { ...prev }; delete n[actionLoan.id]; return n; });
        const pRes = await fetch(`${API}/${actionLoan.id}/payments`, { headers: authHeader() });
        if (pRes.ok) {
          const payments: Payment[] = await pRes.json();
          setLoanPayments(prev => ({ ...prev, [actionLoan.id]: payments }));
          if (payments.length > 0 && actionType === "collect" && collectType !== "waiver") setLastPayment(payments[0]);
        }
        setLoans(prev => prev.map(l => l.id === actionLoan.id ? updatedLoan : l));
        if (actionType === "collect") {
          const amt = parseFloat(collectAmount);
          const amtStr = isFinite(amt) ? amt.toLocaleString("en-IN") : "0";
          toast({ title: collectType === "waiver" ? `₹${amtStr} interest waived.` : `₹${amtStr} collected. Print receipt below.` });
        } else {
          toast({ title: "Loan renewed — interest clock reset!" });
        }
        loadSummary();
        loadFollowUps();
      } else {
        const msgs: Record<string, string> = {
          redeem: "Loan redeemed successfully! Return voucher generated.",
          forfeit: "Loan forfeited & loss recorded. Return voucher generated.",
          extend: "Loan extended to new due date",
        };
        toast({ title: msgs[actionType] });
        loadAll();
        loadFollowUps();
      }

      setActionLoan(null); setActionType(null);
      setGoldSaleValue(""); setNewDueDate("");
      setCollectAmount(""); setCollectNotes(""); setCollectType("auto"); setCollectMode("cash");
      setRenewInterestPaid(""); setRenewNewDueDate(""); setRenewNotes("");
      setRedeemConfirmed(false);
    } catch (err) {
      toast({ title: (err as Error).message || "Failed", variant: "destructive" });
    } finally { setSubmitting(false); }
  };

  const handleSendNotice = async (loan: Loan) => {
    const noticeDays = girviSettings?.forfeitureNoticeDays ?? 15;
    if (!window.confirm(`Send a forfeiture notice for loan ${loan.loanNumber}? This starts the ${noticeDays}-day notice period required before this loan can be forfeited.`)) return;
    try {
      const r = await fetch(`${API}/${loan.id}/send-notice`, { method: "POST", headers: getAuthHeaders() });
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed");
      const updated: Loan = await r.json();
      setLoans(prev => prev.map(l => l.id === updated.id ? updated : l));
      toast({ title: "Forfeiture notice sent — printing now" });
      printForfeitureNotice(updated, shopName, shopAddress, shopMobile, noticeDays, girviSettings ?? undefined);
    } catch (err) {
      toast({ title: (err as Error).message || "Failed to send notice", variant: "destructive" });
    }
  };

  const handleTopUp = (updated: Loan) => {
    setLoans(prev => prev.map(l => l.id === updated.id ? updated : l));
    setLoanItems(prev => { const n = { ...prev }; delete n[updated.id]; return n; });
    setLoanPayments(prev => { const n = { ...prev }; delete n[updated.id]; return n; });
    loadAll();
    loadFollowUps();
  };

  const sendWaReminder = (loan: Loan, type: "due" | "overdue") => {
    const dueText = type === "overdue"
      ? `is OVERDUE by ${Math.abs(loan.daysRemaining)} days`
      : `is due in ${loan.daysRemaining} days`;
    const msg = `Namaskar ${loan.customerName} ji,\n\nYour Girvi loan ${loan.loanNumber} ${dueText}.\n\nPrincipal: ${formatCurrency(loan.currentPrincipal)} | Interest due: ${formatCurrency(loan.outstandingInterest)} | Total due: ${formatCurrency(loan.totalDue)}\n\nKindly visit our store to redeem your ${loan.metalType} (${loan.purity}) at your earliest convenience.\n\n— ${shopName}`;
    const digits = loan.customerMobile.replace(/\D/g, "");
    const fullMobile = digits.length === 10 ? `91${digits}` : digits;
    window.open(`https://wa.me/${fullMobile}?text=${encodeURIComponent(msg)}`, "_blank");
  };

  const sendBulkOverdueReminders = () => {
    const overdue = loans.filter(l => l.isOverdue);
    if (overdue.length === 0) { toast({ title: "No overdue loans" }); return; }
    overdue.forEach(loan => sendWaReminder(loan, "overdue"));
    toast({ title: `WhatsApp opened for ${overdue.length} overdue customer${overdue.length !== 1 ? "s" : ""}` });
  };

  // Single-key shortcuts — paused while the New Loan dialog or an action dialog is open.
  const shortcutsEnabled = !showNewLoan && !actionLoan && !shortcutsHelpOpen;
  useKeyboardShortcuts([
    { key: "/", description: "Focus loan search", action: () => searchInputRef.current?.focus() },
    { key: "n", description: "New Girvi loan", action: () => setShowNewLoan(true) },
    { key: "o", description: "Jump to Overdue tab", action: () => { setStatusFilter("active"); setDueFilter("overdue"); } },
    { key: "r", description: "Recalculate loans", action: () => loadAll() },
    { key: "?", description: "Show this help", action: () => setShortcutsHelpOpen(true) },
  ], shortcutsEnabled);

  const FILTER_TABS = [
    { key: "active|all", label: "Active", count: summary?.totalActive },
    { key: "active|overdue", label: "Overdue", count: summary?.overdueCount, urgent: true },
    { key: "active|week", label: "Due This Week", count: summary?.dueSoonCount },
    { key: "extended|all", label: "Extended", count: undefined },
    { key: "redeemed|all", label: "Redeemed", count: undefined },
    { key: "forfeited|all", label: "Forfeited", count: undefined },
    { key: "voided|all", label: "Voided", count: undefined },
    { key: "all|all", label: "All", count: summary?.totalLoans },
  ];

  const activeTabKey = `${statusFilter}|${dueFilter}`;
  const setTab = (key: string) => {
    const [s, d] = key.split("|");
    setStatusFilter(s);
    setDueFilter(d);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Banknote className="w-6 h-6 text-primary" />
            Girvi Loans
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">Gold & silver collateral loans with live interest</p>
          <div className="mt-1 flex items-center gap-3">
            <ShortcutsHelpButton onClick={() => setShortcutsHelpOpen(true)} />
            <PageHelpButton onClick={() => setPageHelpOpen(true)} />
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex gap-2 flex-wrap">
            {(summary?.overdueCount ?? 0) > 0 && (
              <Button variant="outline" size="sm" onClick={sendBulkOverdueReminders} className="gap-1.5 border-orange-400/40 text-orange-600 hover:bg-orange-50">
                <MessageCircle className="w-3.5 h-3.5" />Remind {summary!.overdueCount} Overdue
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setCalendarMode(c => c === "en" ? "hi" : "en")} className="gap-1.5">
              <Calendar className="w-3.5 h-3.5" />{calendarMode === "en" ? "हिंदी तिथि" : "English Date"}
            </Button>
            <Button variant="outline" size="sm" onClick={loadAll} disabled={loading} className="gap-1.5">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />Recalculate
            </Button>
            <Button size="sm" onClick={() => setShowNewLoan(true)} className="gap-1.5">
              <Plus className="w-3.5 h-3.5" />New Girvi
            </Button>
          </div>
          {calendarMode === "hi" && (
            <p className="text-[11px] text-muted-foreground">
              Dates shown in Vikram Samvat (विक्रम संवत) — years look ~57 higher than English calendar, this is expected.
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        {[
          { label: "Active Loans", value: (summary?.totalActive ?? 0).toString(), icon: Banknote, color: "text-primary", bg: "bg-primary/10" },
          { label: "Total Lent", value: formatCurrency(summary?.totalLent ?? 0), icon: TrendingDown, color: "text-blue-500", bg: "bg-blue-500/10" },
          { label: "Interest Accrued", value: formatCurrency(summary?.totalInterestAccrued ?? 0), icon: TrendingUp, color: "text-green-500", bg: "bg-green-500/10" },
          { label: "Collected", value: formatCurrency(summary?.totalInterestCollected ?? 0), icon: Coins, color: "text-emerald-600", bg: "bg-emerald-500/10" },
          { label: "Overdue", value: (summary?.overdueCount ?? 0).toString(), icon: AlertTriangle, color: "text-orange-500", bg: "bg-orange-500/10" },
          { label: "Total Loss", value: formatCurrency(summary?.totalLoss ?? 0), icon: XCircle, color: "text-red-500", bg: "bg-red-500/10" },
        ].map(card => (
          <Card key={card.label} className="border-border">
            <CardContent className="p-3">
              <div className={`w-8 h-8 rounded-lg ${card.bg} flex items-center justify-center mb-2`}>
                <card.icon className={`w-4 h-4 ${card.color}`} />
              </div>
              <div className="text-base font-bold">{card.value}</div>
              <div className="text-xs text-muted-foreground">{card.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {((summary?.totalGoldWeight ?? 0) > 0 || (summary?.totalSilverWeight ?? 0) > 0) && (
        <div className="flex gap-3 flex-wrap">
          {(summary?.totalGoldWeight ?? 0) > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-xs text-amber-800 font-medium">
              <Scale className="w-3.5 h-3.5" />
              Gold in custody: {summary!.totalGoldWeight.toFixed(3)} g
            </div>
          )}
          {(summary?.totalSilverWeight ?? 0) > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-50 border border-slate-200 text-xs text-slate-700 font-medium">
              <Scale className="w-3.5 h-3.5" />
              Silver in custody: {summary!.totalSilverWeight.toFixed(3)} g
            </div>
          )}
        </div>
      )}

      {followUps.length > 0 && (
        <Card className="border-indigo-300 bg-indigo-50/40">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2 text-indigo-800">
                <Bell className="w-4 h-4" />
                Today's Follow-Ups ({followUps.length})
              </CardTitle>
              <button type="button" className="text-xs text-indigo-700 hover:underline" onClick={() => setFollowUpsCollapsed(v => !v)}>
                {followUpsCollapsed ? "Show" : "Hide"}
              </button>
            </div>
          </CardHeader>
          {!followUpsCollapsed && (
            <CardContent className="space-y-1.5">
              {followUps.map(l => (
                <div key={l.id} className="flex items-center justify-between gap-2 flex-wrap px-3 py-2 rounded-lg bg-white border border-indigo-200 text-xs">
                  <div>
                    <span className="font-medium">{l.customerName}</span>
                    <span className="text-muted-foreground ml-2 font-mono">{l.loanNumber}</span>
                    <span className={`ml-2 font-semibold ${l.isOverdue ? "text-red-600" : "text-amber-600"}`}>
                      {l.isOverdue ? `${Math.abs(l.daysRemaining)}d overdue` : l.daysRemaining === 0 ? "due today" : `due in ${l.daysRemaining}d`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{formatCurrency(l.totalDue)}</span>
                    <Button size="sm" variant="outline" className="h-6 text-[11px] gap-1" onClick={() => sendWaReminder(l, l.isOverdue ? "overdue" : "due")}>
                      <MessageCircle className="w-3 h-3" />WhatsApp
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          )}
        </Card>
      )}

      {customerExposure.length > 0 && (
        <Card className="border-amber-300 bg-amber-50/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-amber-800">
              <AlertTriangle className="w-4 h-4" />
              High-Exposure Customers (multiple active loans)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              {customerExposure.map(c => (
                <div key={c.mobile} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-amber-200 text-sm">
                  <div>
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-muted-foreground">{c.loans.length} loans · Total due: <strong className="text-amber-800">{formatCurrency(c.totalDue)}</strong></div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-border">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5">
              {FILTER_TABS.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setTab(tab.key)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    activeTabKey === tab.key
                      ? tab.urgent ? "bg-orange-500 text-white border-orange-500" : "bg-primary text-primary-foreground border-primary"
                      : tab.urgent && (tab.count ?? 0) > 0 ? "border-orange-300 text-orange-600 hover:bg-orange-50" : "border-border text-muted-foreground hover:border-primary/40"
                  }`}
                >
                  {tab.label}{tab.count !== undefined ? ` (${tab.count})` : ""}
                </button>
              ))}
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  placeholder="Search by customer, loan number, mobile, item, or village/town/city..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="pl-9 h-8 text-sm"
                />
              </div>
              <div className="relative flex-1 sm:max-w-xs">
                <Tag className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Find by item serial / tag no..."
                  value={serialQuery}
                  onChange={e => setSerialQuery(e.target.value)}
                  className="pl-9 h-8 text-sm"
                />
                {serialQuery.trim().length >= 2 && (
                  <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-border bg-popover shadow-md">
                    {serialSearching ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground">Searching...</div>
                    ) : serialResults.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground">No items found for "{serialQuery}"</div>
                    ) : (
                      serialResults.map(({ item, loan }) => (
                        <button
                          type="button"
                          key={item.id}
                          onClick={() => jumpToLoan(loan)}
                          className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-muted/50 text-left border-b border-border last:border-0"
                        >
                          <span>
                            <span className="font-mono font-semibold">{item.itemCode}</span>
                            <span className="text-muted-foreground"> · {item.itemType} · {loan.customerName}</span>
                          </span>
                          <span className="font-mono text-muted-foreground">{loan.loanNumber}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Calendar className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className="text-xs text-muted-foreground">Pledge Date</span>
              <Input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                max={dateTo || undefined}
                className="h-8 text-xs w-auto"
                data-testid="input-loan-date-from"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                min={dateFrom || undefined}
                className="h-8 text-xs w-auto"
                data-testid="input-loan-date-to"
              />
              {(dateFrom || dateTo) && (
                <button
                  type="button"
                  onClick={() => { setDateFrom(""); setDateTo(""); }}
                  className="text-xs text-primary hover:underline"
                  data-testid="button-clear-date-filter"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
          {(search || dateFrom || dateTo) && (
            <p className="text-xs text-muted-foreground mt-1">
              {filteredLoans.length} result{filteredLoans.length !== 1 ? "s" : ""}
              {search ? ` for "${search}"` : ""}
              {(dateFrom || dateTo) ? ` pledged ${dateFrom ? `from ${dateFrom}` : ""}${dateFrom && dateTo ? " " : ""}${dateTo ? `to ${dateTo}` : ""}` : ""}
            </p>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {loading && loans.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">Loading loans...</div>
          ) : filteredLoans.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              {search || dateFrom || dateTo ? `No loans found${search ? ` for "${search}"` : ""}${(dateFrom || dateTo) ? " in that date range" : ""}.` : "No loans in this category."}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filteredLoans.map(loan => (
                <LoanRow
                  key={loan.id}
                  loan={loan}
                  expanded={expandedId === loan.id}
                  payments={loanPayments[loan.id]}
                  items={loanItems[loan.id]}
                  releases={loanReleases[loan.id]}
                  rates={rates}
                  branchName={branchName(loan.branchId)}
                  calendarMode={calendarMode}
                  formatDateDisplay={formatDateDisplay}
                  shopName={shopName}
                  shopAddress={shopAddress}
                  shopMobile={shopMobile}
                  girviSettings={girviSettings}
                  onExpand={() => handleExpand(loan.id)}
                  onAction={(type) => {
                    setActionLoan(loan);
                    setActionType(type);
                    if (type === "extend") {
                      const d = new Date(loan.dueDate); d.setDate(d.getDate() + 30);
                      setNewDueDate(d.toISOString().split("T")[0]);
                    }
                    if (type === "collect") setCollectAmount(String(Math.round(loan.outstandingInterest)));
                    if (type === "renew") {
                      setRenewInterestPaid(String(Math.round(loan.outstandingInterest)));
                      const d = new Date(); d.setDate(d.getDate() + 90);
                      setRenewNewDueDate(d.toISOString().split("T")[0]);
                    }
                    if (type === "forfeit") {
                      const liveVal = computeLiveEstValue(loan, loanItems[loan.id], rates);
                      setGoldSaleValue(String(Math.round(liveVal ?? loan.estimatedValue)));
                    }
                    if (type === "redeem") {
                      setWaiveRedeemInterest("0");
                    }
                    if (type === "transfer") {
                      loadItems(loan.id);
                      setTransferItemIds([]);
                      setTransferToBranchId("");
                      setTransferReason("");
                    }
                    if (type === "partialRelease") {
                      loadItems(loan.id);
                      setReleaseItemIds([]);
                      setReleaseAmount("0");
                      setReleaseMode("cash");
                      setReleaseNotes("");
                    }
                  }}
                  onWaReminder={sendWaReminder}
                  onEdit={() => setEditLoan(loan)}
                  onSendNotice={() => handleSendNotice(loan)}
                  onTopUp={() => setTopUpLoan(loan)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ShortcutsHelpDialog
        open={shortcutsHelpOpen}
        onClose={() => setShortcutsHelpOpen(false)}
        title="Girvi Shortcuts"
        shortcuts={[
          { keys: "/", description: "Focus loan search" },
          { keys: "N", description: "New Girvi loan" },
          { keys: "O", description: "Jump to Overdue tab" },
          { keys: "R", description: "Recalculate loans" },
          { keys: "?", description: "Show this help" },
        ]}
      />

      <PageHelpDialog
        open={pageHelpOpen}
        onClose={() => setPageHelpOpen(false)}
        title="Girvi Loans"
        description="This is where you manage gold/silver pawn loans — from pledging an item and disbursing cash, through collecting interest, to closing the loan out by redemption, renewal, or forfeiture."
        sections={[
          {
            heading: "Everyday actions",
            items: [
              "New Girvi — pledge an item and disburse a new loan",
              "Collect Interest — record any payment; splits between interest and principal automatically",
              "Renew — collect interest and push the due date out, resetting the interest clock",
              "Top-Up — lend more against the same (or newly added) collateral",
              "Redeem — customer pays everything owed and takes their item(s) back",
            ],
          },
          {
            heading: "Less common actions",
            items: [
              "Extend — push the due date without collecting anything",
              "Transfer Items — move pledged items to another branch, or reassign the loan to a different customer",
              "Release Items — return some (not all) pledged items against a partial payment",
              "Send Forfeiture Notice / Forfeit — once a loan is badly overdue, notice must be sent and the notice period must pass before you can keep/sell the pledge",
            ],
          },
          {
            heading: "Terms you'll see",
            items: [
              "LTV — the loan amount as a % of the collateral's current market value; higher = riskier for the shop",
              "Grace Period — days after the due date before penalty interest starts (set in Settings)",
              "Today's Follow-Ups — overdue/due-soon loans worth calling about today",
            ],
          },
        ]}
      />

      <NewLoanDialog
        open={showNewLoan}
        onClose={() => setShowNewLoan(false)}
        onCreated={() => { setShowNewLoan(false); loadAll(); }}
        rates={rates}
        branches={branches}
      />

      <EditLoanDialog
        open={!!editLoan}
        loan={editLoan}
        onClose={() => setEditLoan(null)}
        onUpdated={(updated) => {
          setLoans(prev => prev.map(l => l.id === updated.id ? updated : l));
          setEditLoan(updated);
          setLoanItems(prev => { const n = { ...prev }; delete n[updated.id]; return n; });
        }}
        onDeleted={(loanId) => {
          setEditLoan(null);
          setLoans(prev => prev.filter(l => l.id !== loanId));
          loadAll();
        }}
      />

      <TopUpDialog
        open={!!topUpLoan}
        loan={topUpLoan}
        onClose={() => setTopUpLoan(null)}
        onToppedUp={handleTopUp}
        rates={rates}
      />

      <Dialog open={!!actionLoan} onOpenChange={v => { if (!v) { setActionLoan(null); setActionType(null); setRedeemConfirmed(false); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {actionType === "collect" && <><Coins className="w-4 h-4 text-emerald-600" />Collect Interest (Byaj Vasuli)</>}
              {actionType === "renew" && <><RotateCcw className="w-4 h-4 text-blue-500" />Renew Loan</>}
              {actionType === "redeem" && <><CheckCircle2 className="w-4 h-4 text-green-600" />Confirm Redemption</>}
              {actionType === "forfeit" && <><XCircle className="w-4 h-4 text-destructive" />Forfeit Gold</>}
              {actionType === "extend" && <><Clock className="w-4 h-4" />Extend Due Date</>}
              {actionType === "transfer" && <><ArrowLeftRight className="w-4 h-4 text-blue-500" />Transfer Items</>}
              {actionType === "partialRelease" && <><PackageCheck className="w-4 h-4 text-teal-600" />Release Items</>}
            </DialogTitle>
          </DialogHeader>
          {actionLoan && (
            <div className="space-y-4">
              {actionType !== "transfer" && actionType !== "partialRelease" && (
                <div className="p-3 rounded-lg bg-muted/30 border border-border text-xs space-y-1">
                  <div className="flex justify-between"><span className="text-muted-foreground">Customer</span><strong>{actionLoan.customerName}</strong></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Loan #</span><span className="font-mono">{actionLoan.loanNumber}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Collateral</span><span>{actionLoan.metalType.toUpperCase()} {actionLoan.purity} · {actionLoan.grossWeight.toFixed(3)}g</span></div>
                  {actionLoan.itemDescription && <div className="flex justify-between"><span className="text-muted-foreground">Items</span><span className="text-right max-w-[55%]">{actionLoan.itemDescription}</span></div>}
                  <div className="flex justify-between border-t border-border pt-1"><span className="text-muted-foreground">Original loan</span><span>{formatCurrency(actionLoan.loanAmount)}</span></div>
                  {actionLoan.principalPaid > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Principal repaid</span><span className="text-emerald-600">−{formatCurrency(actionLoan.principalPaid)}</span></div>}
                  <div className="flex justify-between font-medium"><span className="text-muted-foreground">Current principal</span><span>{formatCurrency(actionLoan.currentPrincipal)}</span></div>
                  <div className="flex justify-between border-t border-border pt-1"><span className="text-muted-foreground">Interest accrued</span><span>{formatCurrency(actionLoan.accruedInterest)}</span></div>
                  {actionLoan.penaltyInterest > 0 && <div className="flex justify-between text-orange-600"><span>Penalty interest</span><span>{formatCurrency(actionLoan.penaltyInterest)}</span></div>}
                  <div className="flex justify-between"><span className="text-muted-foreground">Collected (this cycle)</span><span className="text-emerald-600">−{formatCurrency(actionLoan.collectedSinceReset)}</span></div>
                  <div className="flex justify-between font-semibold text-sm"><span>Outstanding interest</span><span className="text-primary">{formatCurrency(actionLoan.outstandingInterest)}</span></div>
                  <div className="flex justify-between items-baseline border-t border-border pt-1.5 mt-0.5">
                    <span className="font-semibold">Total due (principal + int.)</span>
                    <span className="font-extrabold text-lg text-primary">{formatCurrency(actionLoan.totalDue)}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground pt-0.5">
                    Rate: {actionLoan.interestRate}% per {actionLoan.interestPeriod} · ≈ {formatCurrency(Math.round(actionLoan.currentPrincipal * actionLoan.dailyRate))}/day <span className="opacity-70">({(actionLoan.dailyRate * 100).toFixed(4)}%/day)</span>
                  </div>
                </div>
              )}

              {actionType === "collect" && (
                <div className="space-y-3">
                  {actionLoan.withinGracePeriod && (
                    <div className="p-2 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-800">
                      This loan is {actionLoan.overdueDaysRaw} day{actionLoan.overdueDaysRaw !== 1 ? "s" : ""} past due, within the {actionLoan.graceDaysApplied}-day grace period — no penalty interest has accrued yet.
                    </div>
                  )}
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">{collectType === "waiver" ? "Amount to waive (₹)" : "Amount received (₹)"}</label>
                    <Input type="number" value={collectAmount} onChange={e => setCollectAmount(e.target.value)} placeholder={collectType === "waiver" ? "Interest to forgive" : "Any amount, any time"} className="h-9" autoFocus />
                    {collectType === "waiver" && <p className="text-xs text-muted-foreground mt-1">Outstanding interest: {formatCurrency(actionLoan.outstandingInterest)}</p>}
                  </div>

                  {collectAmount !== "" && parseFloat(collectAmount) > 0 && collectType === "auto" && (() => {
                    const amt = parseFloat(collectAmount);
                    const outstanding = actionLoan.outstandingInterest;
                    const principal = actionLoan.currentPrincipal;
                    if (amt > actionLoan.totalDue + 0.01) {
                      return (
                        <div className="p-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                          ⚠ Amount exceeds total due ({formatCurrency(actionLoan.totalDue)}). Reduce the amount — this payment will be rejected.
                        </div>
                      );
                    }
                    if (amt <= outstanding) {
                      return (
                        <div className="p-2 rounded-lg bg-emerald-50 border border-emerald-200 text-xs space-y-0.5">
                          <div className="font-medium text-emerald-800">Interest payment</div>
                          <div className="text-emerald-700">₹{amt.toLocaleString("en-IN")} → reduces outstanding interest</div>
                          <div className="text-emerald-600">After payment: {formatCurrency(outstanding - amt)} interest remaining</div>
                        </div>
                      );
                    } else {
                      const interestPortion = outstanding;
                      const principalPortion = amt - interestPortion;
                      const newPrincipal = principal - principalPortion;
                      const fullySettled = newPrincipal <= 0;
                      return (
                        <div className={`p-2 rounded-lg border text-xs space-y-1 ${fullySettled ? "bg-green-50 border-green-300" : "bg-blue-50 border-blue-200"}`}>
                          <div className={`font-medium ${fullySettled ? "text-green-800" : "text-blue-800"}`}>
                            {fullySettled ? "Loan fully settled!" : "Auto-allocation"}
                          </div>
                          {interestPortion > 0 && <div className="text-blue-700">₹{interestPortion.toLocaleString("en-IN")} → settles outstanding interest</div>}
                          <div className={fullySettled ? "text-green-700 font-semibold" : "text-blue-700"}>
                            ₹{principalPortion.toLocaleString("en-IN")} → reduces principal ({formatCurrency(principal)} → {formatCurrency(Math.max(0, newPrincipal))})
                          </div>
                          {!fullySettled && <div className="text-muted-foreground text-[10px]">Interest clock resets on new principal of {formatCurrency(Math.max(0, newPrincipal))}</div>}
                          {fullySettled && <div className="text-green-700 font-medium">Gold can be returned — a Return Voucher will be generated</div>}
                        </div>
                      );
                    }
                  })()}

                  <div>
                    <label className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                      Type
                      <InfoTooltip text="Auto-allocate: pays off outstanding interest first, then any leftover reduces principal. Interest only / Penalty: doesn't touch principal. Waiver: forgives interest without any cash changing hands." />
                    </label>
                    <Select value={collectType} onValueChange={setCollectType}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Auto-allocate (interest first, then principal)</SelectItem>
                        <SelectItem value="interest">Interest only (Byaj)</SelectItem>
                        <SelectItem value="penalty">Penalty / Overdue charge</SelectItem>
                        <SelectItem value="waiver">Waive interest (forgive — no cash received)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {collectType !== "waiver" && (
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Payment mode</label>
                      <Select value={collectMode} onValueChange={v => { setCollectMode(v); setCollectBankAccountId(null); }}>
                        <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="cash">Cash</SelectItem>
                          <SelectItem value="bank">Bank Transfer</SelectItem>
                          <SelectItem value="upi">UPI</SelectItem>
                          <SelectItem value="cheque">Cheque</SelectItem>
                        </SelectContent>
                      </Select>
                      <BankAccountSelect paymentMode={collectMode} bankAccountId={collectBankAccountId} onChange={setCollectBankAccountId} className="mt-2" />
                    </div>
                  )}

                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">
                      Date {collectType === "waiver" ? "of waiver" : "collected"} <span className="text-muted-foreground/60">defaults to today — backdate if entering this late</span>
                    </label>
                    <Input type="date" value={collectDate} max={new Date().toISOString().split("T")[0]} onChange={e => setCollectDate(e.target.value)} className="h-9" />
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Notes (optional)</label>
                    <Textarea value={collectNotes} onChange={e => setCollectNotes(e.target.value)} placeholder={collectType === "waiver" ? "e.g. Customer 15 days late, waived as a courtesy" : "e.g. Cash paid, hand receipt"} rows={2} className="text-sm resize-y" />
                  </div>
                  {collectType !== "auto" && collectType !== "waiver" && (
                    <p className="text-xs text-muted-foreground">Interest-only or penalty payments do not change the principal or reset the clock.</p>
                  )}
                  {collectType === "waiver" && (
                    <p className="text-xs text-muted-foreground">Recorded as its own entry so reports don't count it as cash income — it still clears the outstanding interest on this loan.</p>
                  )}
                </div>
              )}

              {actionType === "renew" && (
                <div className="space-y-3">
                  <div className="p-2 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-800">
                    Renewing resets the interest clock to today for future interest — but it does not erase what's already owed.
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Interest collected today (₹)</label>
                    <Input type="number" value={renewInterestPaid} onChange={e => setRenewInterestPaid(e.target.value)} placeholder="0 if nothing collected now" className="h-9" autoFocus />
                    <p className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mt-1.5">
                      ⚠ Any interest you don't collect now stays outstanding on this loan — it does NOT reset to zero.
                    </p>
                  </div>
                  {parseFloat(renewInterestPaid) > 0 && (
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Payment mode</label>
                      <Select value={renewMode} onValueChange={v => { setRenewMode(v); setRenewBankAccountId(null); }}>
                        <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="cash">Cash</SelectItem>
                          <SelectItem value="bank">Bank Transfer</SelectItem>
                          <SelectItem value="upi">UPI</SelectItem>
                          <SelectItem value="cheque">Cheque</SelectItem>
                        </SelectContent>
                      </Select>
                      <BankAccountSelect paymentMode={renewMode} bankAccountId={renewBankAccountId} onChange={setRenewBankAccountId} className="mt-2" />
                    </div>
                  )}
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">New due date</label>
                    <Input type="date" value={renewNewDueDate} onChange={e => setRenewNewDueDate(e.target.value)} min={new Date().toISOString().split("T")[0]} className="h-9" />
                    <DueDatePresets from={new Date()} onPick={setRenewNewDueDate} />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Notes (optional)</label>
                    <Textarea value={renewNotes} onChange={e => setRenewNotes(e.target.value)} placeholder="e.g. Customer renewed verbally" rows={2} className="text-sm resize-y" />
                  </div>
                </div>
              )}

              {actionType === "redeem" && (() => {
                const waive = Math.min(actionLoan.outstandingInterest, Math.max(0, parseFloat(waiveRedeemInterest) || 0));
                const cashDue = actionLoan.currentPrincipal + actionLoan.outstandingInterest - waive;
                return (
                <div className="space-y-2">
                  <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-xs text-green-800 space-y-1">
                    <div>Collect <strong>{formatCurrency(cashDue)}</strong> from the customer and return the pledged {actionLoan.metalType} ornament(s).</div>
                    <div className="text-[10px] space-y-0.5">
                      <div>Principal: {formatCurrency(actionLoan.currentPrincipal)}</div>
                      <div>Interest due: {formatCurrency(actionLoan.outstandingInterest)}{waive > 0 ? ` (of which ${formatCurrency(waive)} waived)` : ""}</div>
                    </div>
                    {actionLoan.itemDescription && <div className="mt-1 font-medium">Items: {actionLoan.itemDescription}</div>}
                    <div className="mt-1 text-[10px]">A numbered Return Voucher will be generated for this redemption.</div>
                  </div>
                  {actionLoan.outstandingInterest > 0 && (
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">
                        Waive some interest? (₹, optional) <span className="text-muted-foreground/60">your call — e.g. customer is well past the grace period</span>
                      </label>
                      <Input
                        type="number"
                        value={waiveRedeemInterest}
                        onChange={e => setWaiveRedeemInterest(e.target.value)}
                        placeholder="0"
                        className="h-9"
                      />
                    </div>
                  )}
                  {cashDue > 0 && (
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Payment mode</label>
                      <Select value={redeemMode} onValueChange={v => { setRedeemMode(v); setRedeemBankAccountId(null); }}>
                        <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="cash">Cash</SelectItem>
                          <SelectItem value="bank">Bank Transfer</SelectItem>
                          <SelectItem value="upi">UPI</SelectItem>
                          <SelectItem value="cheque">Cheque</SelectItem>
                        </SelectContent>
                      </Select>
                      <BankAccountSelect paymentMode={redeemMode} bankAccountId={redeemBankAccountId} onChange={setRedeemBankAccountId} className="mt-2" />
                    </div>
                  )}
                  <label className="flex items-start gap-2 p-2.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-900 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={redeemConfirmed}
                      onChange={e => setRedeemConfirmed(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>I confirm the pledged item(s) have been physically returned to the customer</span>
                  </label>
                </div>
                );
              })()}

              {actionType === "forfeit" && (
                <div className="space-y-2">
                  <div className="p-2 rounded-lg bg-muted/40 border border-border text-xs text-muted-foreground">
                    Forfeiting means the customer will <strong>NOT</strong> get their pledged gold back. The shop keeps the item.
                  </div>
                  <label className="text-xs text-muted-foreground block">Amount received from selling the gold (₹)</label>
                  <Input type="number" value={goldSaleValue} onChange={e => setGoldSaleValue(e.target.value)} className="h-9" />
                  {goldSaleValue && !isNaN(parseFloat(goldSaleValue)) && (
                    <p className={`text-xs p-2 rounded border ${parseFloat(goldSaleValue) < actionLoan.totalDue ? "bg-red-50 text-red-700 border-red-200" : "bg-green-50 text-green-700 border-green-200"}`}>
                      {parseFloat(goldSaleValue) < actionLoan.totalDue
                        ? `⚠ Net loss: ${formatCurrency(actionLoan.totalDue - parseFloat(goldSaleValue))}`
                        : `✓ Net gain: ${formatCurrency(parseFloat(goldSaleValue) - actionLoan.totalDue)}`}
                    </p>
                  )}
                </div>
              )}

              {actionType === "extend" && (
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground block">Current due: {formatDateDisplay(actionLoan.dueDate)}</label>
                  <Input type="date" value={newDueDate} min={new Date().toISOString().split("T")[0]} onChange={e => setNewDueDate(e.target.value)} className="h-9" />
                  <DueDatePresets from={new Date(actionLoan.dueDate)} onPick={setNewDueDate} />
                  <p className="text-xs text-muted-foreground">Interest continues from original start date. Consider collecting outstanding interest first. Quick picks extend from the current due date.</p>
                </div>
              )}

              {actionType === "transfer" && (
                <div className="space-y-3">
                  <div className="text-xs text-muted-foreground">Loan {actionLoan.loanNumber} · {actionLoan.customerName}</div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Items to transfer</label>
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {(loanItems[actionLoan.id] ?? []).filter(it => it.status === "pledged").map(it => (
                        <label key={it.id} className="flex items-center gap-2 p-2 rounded-lg border border-border text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            checked={transferItemIds.includes(it.id)}
                            onChange={e => setTransferItemIds(prev => e.target.checked ? [...prev, it.id] : prev.filter(id => id !== it.id))}
                          />
                          <span>{it.quantity}× {it.itemType} — {it.metalType === "silver" ? "Silver" : "Gold"} {it.purity} · {it.grossWeight.toFixed(3)}g</span>
                        </label>
                      ))}
                      {(loanItems[actionLoan.id] ?? []).filter(it => it.status === "pledged").length === 0 && (
                        <p className="text-xs text-muted-foreground">No transferable items (all already returned/transferred/forfeited).</p>
                      )}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Destination branch</label>
                    <Select value={transferToBranchId} onValueChange={setTransferToBranchId}>
                      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select branch" /></SelectTrigger>
                      <SelectContent>
                        {branches.filter(b => b.isActive && b.id !== actionLoan.branchId).map(b => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Reason (optional)</label>
                    <Input value={transferReason} onChange={e => setTransferReason(e.target.value)} placeholder="e.g. Customer requested pickup at other branch" className="h-9" />
                  </div>
                </div>
              )}

              {actionType === "partialRelease" && (() => {
                const pledged = (loanItems[actionLoan.id] ?? []).filter(it => it.status === "pledged");
                const totalPledgedValue = pledged.reduce((s, it) => s + it.estimatedValue, 0);
                const selected = pledged.filter(it => releaseItemIds.includes(it.id));
                const selectedValue = selected.reduce((s, it) => s + it.estimatedValue, 0);
                const valueShare = totalPledgedValue > 0 ? selectedValue / totalPledgedValue : 0;
                const recommendedAmount = Math.round(actionLoan.currentPrincipal * valueShare);
                const selectingAll = releaseItemIds.length > 0 && releaseItemIds.length >= pledged.length;
                const amt = parseFloat(releaseAmount) || 0;
                return (
                <div className="space-y-3">
                  <div className="text-xs text-muted-foreground">Loan {actionLoan.loanNumber} · {actionLoan.customerName} · {pledged.length} item{pledged.length !== 1 ? "s" : ""} currently pledged</div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Items to release</label>
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {pledged.map(it => (
                        <label key={it.id} className="flex items-center gap-2 p-2 rounded-lg border border-border text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            checked={releaseItemIds.includes(it.id)}
                            onChange={e => {
                              const nextIds = e.target.checked ? [...releaseItemIds, it.id] : releaseItemIds.filter(id => id !== it.id);
                              setReleaseItemIds(nextIds);
                              const nextSelected = pledged.filter(p => nextIds.includes(p.id));
                              const nextValue = nextSelected.reduce((s, p) => s + p.estimatedValue, 0);
                              const nextShare = totalPledgedValue > 0 ? nextValue / totalPledgedValue : 0;
                              setReleaseAmount(String(Math.round(actionLoan.currentPrincipal * nextShare)));
                            }}
                          />
                          <span>{it.quantity}× {it.itemType} — {it.metalType === "silver" ? "Silver" : "Gold"} {it.purity} · {it.grossWeight.toFixed(3)}g · {formatCurrency(it.estimatedValue)}</span>
                        </label>
                      ))}
                      {pledged.length === 0 && <p className="text-xs text-muted-foreground">No pledged items to release.</p>}
                    </div>
                  </div>
                  {selectingAll && (
                    <div className="p-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                      That's every pledged item — use <strong>Redeem</strong> instead to close out the whole loan.
                    </div>
                  )}
                  {releaseItemIds.length > 0 && !selectingAll && (
                    <div className="p-2 rounded-lg bg-teal-50 border border-teal-200 text-xs text-teal-800 space-y-0.5">
                      <div>Selected items are {(valueShare * 100).toFixed(0)}% of the {formatCurrency(totalPledgedValue)} currently pledged.</div>
                      <div>Recommended paydown to keep the loan-to-value ratio unchanged: <strong>{formatCurrency(recommendedAmount)}</strong></div>
                      <div className="text-teal-700/80">This is guidance, not a requirement — you can collect more, less, or nothing now.</div>
                    </div>
                  )}
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Amount collected now (₹) <span className="text-muted-foreground/60">optional</span></label>
                    <Input type="number" value={releaseAmount} onChange={e => setReleaseAmount(e.target.value)} placeholder="0" className="h-9" />
                    {amt === 0 && releaseItemIds.length > 0 && (
                      <p className="text-xs text-amber-700 mt-1">No payment being collected — releasing collateral without paydown raises the LTV on what's left pledged.</p>
                    )}
                  </div>
                  {amt > 0 && (
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Payment mode</label>
                      <Select value={releaseMode} onValueChange={v => { setReleaseMode(v); setReleaseBankAccountId(null); }}>
                        <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="cash">Cash</SelectItem>
                          <SelectItem value="bank">Bank Transfer</SelectItem>
                          <SelectItem value="upi">UPI</SelectItem>
                          <SelectItem value="cheque">Cheque</SelectItem>
                        </SelectContent>
                      </Select>
                      <BankAccountSelect paymentMode={releaseMode} bankAccountId={releaseBankAccountId} onChange={setReleaseBankAccountId} className="mt-2" />
                    </div>
                  )}
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Notes (optional)</label>
                    <Textarea value={releaseNotes} onChange={e => setReleaseNotes(e.target.value)} placeholder="e.g. Customer took back 2 of 5 items" rows={2} className="text-sm resize-y" />
                  </div>
                </div>
                );
              })()}

              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => { setActionLoan(null); setActionType(null); setRedeemConfirmed(false); }}>Cancel</Button>
                <Button
                  size="sm"
                  variant={actionType === "forfeit" ? "destructive" : "default"}
                  className={actionType === "collect" || actionType === "renew" ? "bg-emerald-600 hover:bg-emerald-700" : actionType === "redeem" ? "bg-green-600 hover:bg-green-700" : actionType === "partialRelease" ? "bg-teal-600 hover:bg-teal-700" : ""}
                  onClick={handleAction}
                  disabled={
                    submitting ||
                    (actionType === "redeem" && !redeemConfirmed) ||
                    (actionType === "partialRelease" && (
                      releaseItemIds.length === 0 ||
                      releaseItemIds.length >= (loanItems[actionLoan.id] ?? []).filter(it => it.status === "pledged").length
                    ))
                  }
                >
                  {submitting ? "Processing..." :
                   actionType === "collect" ? `${collectType === "waiver" ? "Waive" : "Collect"} ₹${parseFloat(collectAmount || "0").toLocaleString("en-IN")}` :
                   actionType === "renew" ? "Renew Loan" :
                   actionType === "redeem" ? "Confirm Redemption" :
                   actionType === "forfeit" ? "Forfeit & Record" :
                   actionType === "transfer" ? "Transfer Items" :
                   actionType === "partialRelease" ? `Release ${releaseItemIds.length || ""} Item${releaseItemIds.length !== 1 ? "s" : ""}` :
                   "Extend Due Date"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {lastPayment && actionLoan === null && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-3 text-sm">
          <CheckCircle2 className="w-4 h-4" />
          Payment recorded
          <Button
            size="sm"
            variant="secondary"
            className="h-7 text-xs gap-1"
            onClick={() => {
              const loan = loans.find(l => l.id === lastPayment.loanId);
              if (loan) {
                printInterestReceipt(lastPayment, loan, shopName, shopAddress, shopMobile);
              }
              setLastPayment(null);
            }}
          >
            Print Receipt
          </Button>
        </div>
      )}

      {lastRelease && actionLoan === null && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-teal-600 text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-3 text-sm">
          <PackageCheck className="w-4 h-4" />
          {lastRelease.releasedItems.length} item{lastRelease.releasedItems.length !== 1 ? "s" : ""} released
          <Button
            size="sm"
            variant="secondary"
            className="h-7 text-xs gap-1"
            onClick={() => {
              openPartialReleaseVoucher(lastRelease.release, lastRelease.loan, lastRelease.releasedItems, lastRelease.remainingItems, shopName, shopAddress, shopMobile);
              setLastRelease(null);
            }}
          >
            Print Voucher
          </Button>
        </div>
      )}
    </div>
  );
}

function LoanRow({
  loan, expanded, payments, items, releases, rates, branchName, calendarMode, formatDateDisplay,
  shopName, shopAddress, shopMobile, girviSettings,
  onExpand, onAction, onWaReminder, onEdit, onSendNotice, onTopUp,
}: {
  loan: Loan;
  expanded: boolean;
  payments?: Payment[];
  items?: LoanItem[];
  releases?: PartialRelease[];
  rates?: Rates;
  branchName: string;
  calendarMode: "en" | "hi";
  formatDateDisplay: (iso: string) => string;
  shopName: string;
  shopAddress: string;
  shopMobile: string;
  girviSettings: GirviSettings | null;
  onExpand: () => void;
  onAction: (type: "redeem" | "forfeit" | "extend" | "collect" | "renew" | "transfer" | "partialRelease") => void;
  onWaReminder: (loan: Loan, type: "due" | "overdue") => void;
  onEdit: () => void;
  onSendNotice: () => void;
  onTopUp: () => void;
}) {
  const isActive = loan.status === "active" || loan.status === "extended";
  const liveEstValue = computeLiveEstValue(loan, items, rates);
  const pledgedCount = (items ?? []).filter(it => it.status === "pledged").length;
  const noticeDays = girviSettings?.forfeitureNoticeDays ?? 15;
  const noticeSentAt = loan.noticeSentAt ? new Date(loan.noticeSentAt) : null;
  const forfeitureEligibleFrom = noticeSentAt ? new Date(noticeSentAt.getTime() + noticeDays * 86400000) : null;
  const forfeitureEligible = !!forfeitureEligibleFrom && new Date() >= forfeitureEligibleFrom;

  return (
    <div className={`px-3 md:px-4 py-3 ${loan.isOverdue ? "bg-red-50/50 dark:bg-red-950/10" : ""}`}>
      <div className="flex items-center justify-between gap-2 md:gap-4 cursor-pointer" onClick={onExpand}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{loan.customerName}</span>
            <span className="text-xs text-muted-foreground font-mono hidden sm:inline">{loan.loanNumber}</span>
            <Badge
              variant={loan.status === "active" ? (loan.isOverdue ? "destructive" : "default") : loan.status === "redeemed" ? "secondary" : "outline"}
              className="text-xs"
            >
              {loan.isOverdue ? "OVERDUE" : loan.status.toUpperCase()}
            </Badge>
            <Badge variant="outline" className="text-[10px]">{branchName}</Badge>
            {loan.isOverdue && <Flame className="w-3.5 h-3.5 text-orange-500" />}
            {isActive && (liveEstValue ?? loan.estimatedValue) > 0 && (
              <span
                className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                  loan.currentPrincipal / (liveEstValue ?? loan.estimatedValue) > 0.8 ? "bg-red-100 text-red-700" :
                  loan.currentPrincipal / (liveEstValue ?? loan.estimatedValue) > 0.6 ? "bg-amber-100 text-amber-700" :
                  "bg-green-100 text-green-700"
                }`}
                title="LTV = loan amount as a % of the gold's current market value. Higher means less safety margin."
              >
                LTV {((loan.currentPrincipal / (liveEstValue ?? loan.estimatedValue)) * 100).toFixed(0)}%
              </span>
            )}
            {isActive && (liveEstValue ?? loan.estimatedValue) > 0 && (
              <InfoTooltip text="LTV (Loan-to-Value) = current principal owed ÷ the collateral's live market value. Above ~80% means the loan is only thinly covered by the gold/silver backing it." />
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 truncate">
            {loan.metalType.toUpperCase()} {loan.purity} · {loan.grossWeight.toFixed(3)}g ·{" "}
            {loan.interestRate}%/{loan.interestPeriod}{loan.penaltyRate > 0 ? `+${loan.penaltyRate}%OD` : ""}
            {loan.principalPaid > 0 && <span className="text-emerald-600"> · bal {formatCurrency(loan.currentPrincipal)}</span>}
            {loan.itemDescription && <span className="hidden md:inline"> · {loan.itemDescription}</span>}
            <span className="hidden sm:inline"> · Due: {formatDateDisplay(loan.dueDate)}</span>
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-sm font-bold text-primary">{formatCurrency(loan.totalDue)}</div>
          <div className="text-xs text-muted-foreground hidden sm:block">
            {formatCurrency(loan.currentPrincipal)} + {formatCurrency(loan.outstandingInterest)} int.
          </div>
          {loan.totalInterestCollected - loan.interestWaived > 0 && (
            <div className="text-[10px] text-emerald-600">✓ {formatCurrency(loan.totalInterestCollected - loan.interestWaived)} coll.</div>
          )}
          {loan.interestWaived > 0 && (
            <div className="text-[10px] text-blue-600">waived {formatCurrency(loan.interestWaived)}</div>
          )}
        </div>
        <div className="text-muted-foreground flex-shrink-0">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </div>

      {expanded && (
        <div className="mt-4 space-y-4">
          <div className="p-3 rounded-xl bg-muted/20 border border-border grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div>
              <div className="text-muted-foreground mb-1 font-medium">Collateral</div>
              <div className="font-medium">{loan.metalType.toUpperCase()} {loan.purity}</div>
              <div>Gross: {loan.grossWeight.toFixed(3)}g</div>
              <div title="Net weight (pure metal, after removing stones/other material) is what the loan value is based on">
                Net: {loan.netWeight.toFixed(3)}g <span className="text-muted-foreground">(used for valuation)</span>
              </div>
              <div className="text-muted-foreground">At pledge: {formatCurrency(loan.estimatedValue)}</div>
              {liveEstValue !== null && (
                <div className={`font-medium ${liveEstValue < loan.estimatedValue ? "text-orange-600" : "text-emerald-600"}`}>
                  Live rate: {formatCurrency(liveEstValue)}
                  {liveEstValue !== loan.estimatedValue && (
                    <span className="text-[10px] ml-1">({liveEstValue > loan.estimatedValue ? "+" : ""}{formatCurrency(liveEstValue - loan.estimatedValue)})</span>
                  )}
                </div>
              )}
              {loan.itemDescription && <div className="mt-1 text-muted-foreground italic">{loan.itemDescription}</div>}
              {items && items.length > 0 && (
                <div className="mt-2 space-y-1">
                  {items.map(it => {
                    const itLive = rates ? Math.round(it.netWeight * (it.metalType === "silver" ? rates.silver : it.purity === "24K" ? rates.gold24k : it.purity === "18K" ? rates.gold18k : rates.gold22k)) : null;
                    return (
                      <div key={it.id} className="text-[10px] text-muted-foreground">
                        {it.quantity}× {it.itemType} ({it.metalType === "silver" ? "Ag" : "Au"} {it.purity}) · {it.grossWeight.toFixed(3)}g
                        {itLive !== null ? ` · Live: ${formatCurrency(itLive)}` : ` · ${formatCurrency(it.estimatedValue)}`}
                        {it.itemCode && <span className="ml-1 font-mono text-foreground/70">#{it.itemCode}</span>}
                        {it.status !== "pledged" && <span className="ml-1 italic">[{it.status}]</span>}
                        {it.notes && <span className="block">{it.notes}</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div>
              <div className="text-muted-foreground mb-1 font-medium">Loan Terms</div>
              <div className="font-medium">{formatCurrency(loan.loanAmount)} original</div>
              {loan.principalPaid > 0 && <div className="text-emerald-600">−{formatCurrency(loan.principalPaid)} repaid</div>}
              {loan.principalPaid > 0 && <div className="font-semibold text-primary">{formatCurrency(loan.currentPrincipal)} current principal</div>}
              <div className="mt-1">{loan.interestRate}%/{loan.interestPeriod}{loan.penaltyRate > 0 ? ` +${loan.penaltyRate}% OD` : ""}</div>
              <div className="text-[10px] text-muted-foreground">≈ {formatCurrency(Math.round(loan.currentPrincipal * loan.dailyRate))}/day <span className="opacity-70">({(loan.dailyRate * 100).toFixed(4)}%/day)</span></div>
              <div className="mt-1">Start: {formatDateDisplay(loan.startDate)}</div>
              <div>Due: {formatDateDisplay(loan.dueDate)}</div>
              <div className="mt-1 text-[10px]">KYC: {loan.kycDocType ? loan.kycDocType.replace(/_/g, " ").toUpperCase() : "—"} {loan.kycDocNumber ?? ""}</div>
              {loan.fatherName && <div className="text-[10px] text-muted-foreground">F/H Name: {loan.fatherName}</div>}
              {loan.address && <div className="text-[10px] text-muted-foreground whitespace-pre-line">Address: {loan.address}</div>}
            </div>
            <div>
              <div className="text-muted-foreground mb-1 font-medium">Interest Breakdown</div>
              <div>Normal int.: {formatCurrency(loan.normalInterest)}</div>
              {loan.penaltyInterest > 0 && <div className="text-orange-600">Penalty int.: {formatCurrency(loan.penaltyInterest)}</div>}
              <div>Total accrued: {formatCurrency(loan.accruedInterest)}</div>
              <div className="text-emerald-600">Collected (cycle): −{formatCurrency(loan.collectedSinceReset)}</div>
              <div className={`font-semibold mt-1 ${loan.isOverdue ? "text-destructive" : "text-primary"}`}>
                Outstanding: {formatCurrency(loan.outstandingInterest)}
              </div>
              <div className="text-muted-foreground">
                {loan.daysRemaining >= 0
                  ? `${loan.daysRemaining} days remaining`
                  : <span className="text-destructive font-medium">{Math.abs(loan.daysRemaining)} days OVERDUE</span>}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground mb-1 font-medium">Days Elapsed</div>
              <div className="font-bold text-lg">{calcDaysElapsed(loan.startDate)}</div>
              <div className="text-muted-foreground">days from start</div>
              <div className="mt-2 font-bold text-primary">{formatCurrency(loan.totalDue)}</div>
              <div className="text-muted-foreground text-[10px]">Total due today</div>
            </div>
          </div>

          {releases && releases.length > 0 && (
            <div className="rounded-lg border border-teal-200 bg-teal-50/40 divide-y divide-teal-200/60">
              <div className="px-3 py-1.5 text-xs font-semibold text-teal-800 flex items-center gap-1.5">
                <PackageCheck className="w-3.5 h-3.5" />Partial Releases ({releases.length})
              </div>
              {releases.map(r => (
                <div key={r.id} className="flex items-center justify-between px-3 py-1.5 text-xs">
                  <div>
                    <span className="font-mono">{r.releaseNumber}</span>
                    <span className="text-muted-foreground ml-2">{r.itemsDescription}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{new Date(r.releaseDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</span>
                    <span className="font-semibold text-teal-700">{formatCurrency(r.principalSettled + r.interestSettled)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {isActive && (
            <div className="flex gap-2 flex-wrap">
              {loan.isEditable && (
                <Button size="sm" variant="outline" className="gap-1.5 border-blue-400/50 text-blue-700 hover:bg-blue-50" onClick={onEdit}>
                  <Pencil className="w-3.5 h-3.5" />Edit
                </Button>
              )}
              <Button size="sm" className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => onAction("collect")}>
                <Coins className="w-3.5 h-3.5" />Collect Interest
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onAction("renew")}>
                <RotateCcw className="w-3.5 h-3.5" />Renew
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onAction("extend")}>
                <Clock className="w-3.5 h-3.5" />Extend
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onAction("transfer")}>
                <ArrowLeftRight className="w-3.5 h-3.5" />Transfer Items
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5 border-indigo-400/50 text-indigo-700 hover:bg-indigo-50" onClick={onTopUp}>
                <PlusCircle className="w-3.5 h-3.5" />Top-Up
              </Button>
              {pledgedCount > 1 && (
                <Button size="sm" variant="outline" className="gap-1.5 border-teal-400/50 text-teal-700 hover:bg-teal-50" onClick={() => onAction("partialRelease")}>
                  <PackageCheck className="w-3.5 h-3.5" />Release Items
                </Button>
              )}
              <Button size="sm" className="gap-1.5 bg-green-600 hover:bg-green-700 text-white" onClick={() => onAction("redeem")}>
                <CheckCircle2 className="w-3.5 h-3.5" />Redeem
              </Button>
              {loan.isOverdue && !noticeSentAt && (
                <Button size="sm" variant="outline" className="gap-1.5 border-red-400/50 text-red-700 hover:bg-red-50" onClick={onSendNotice}>
                  <Send className="w-3.5 h-3.5" />Send Forfeiture Notice
                </Button>
              )}
              {loan.isOverdue && noticeSentAt && !forfeitureEligible && (
                <span className="text-[11px] text-muted-foreground self-center px-1 flex items-center gap-1.5">
                  Notice sent {formatDateDisplay(noticeSentAt.toISOString())} — forfeitable from {forfeitureEligibleFrom ? formatDateDisplay(forfeitureEligibleFrom.toISOString()) : "—"}
                  <button type="button" className="text-primary hover:underline" onClick={() => printForfeitureNotice(loan, shopName, shopAddress, shopMobile, noticeDays, girviSettings ?? undefined)}>
                    Reprint
                  </button>
                </span>
              )}
              {loan.isOverdue && forfeitureEligible && (
                <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => onAction("forfeit")}>
                  <XCircle className="w-3.5 h-3.5" />Forfeit
                </Button>
              )}
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onWaReminder(loan, loan.isOverdue ? "overdue" : "due")}>
                <MessageCircle className="w-3.5 h-3.5" />WhatsApp
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5 ml-auto" onClick={() => openGirviVoucher(loan, shopName, shopAddress, shopMobile, items, rates, payments)}>
                Print Voucher
              </Button>
            </div>
          )}
          {!isActive && (
            <div className="flex gap-2 flex-wrap">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openGirviVoucher(loan, shopName, shopAddress, shopMobile, items, rates, payments)}>
                Print Pledge Voucher
              </Button>
              {(loan.status === "redeemed" || loan.status === "forfeited") && (
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openReturnVoucher(loan, shopName, shopAddress, shopMobile, payments)}>
                  Print Return Voucher
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
