import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  BarChart3,
  CalendarDays,
  CircleDollarSign,
  Clock3,
  History,
  MailCheck,
  MailWarning,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AdminCryptoOptions, type CryptoDraft } from "@/components/billing/AdminCryptoOptions";
import { AdminPaymentsList } from "@/components/billing/AdminPaymentsList";
import { AdminSettingsForm } from "@/components/billing/AdminSettingsForm";
import {
  adminBillingAction,
  formatBillingDate,
  formatBillingMoney,
  isBillingAccessDenied,
} from "@/lib/billing/manualPayments";
import type {
  ActivityTrendPoint,
  AdminDecisionResponse,
  AdminOverview,
  AdminPaymentRow,
  AdminSettings,
  BillingAuditRow,
  CryptoOption,
  ProtectedReceiptPayload,
} from "@/lib/billing/types";

export type AdminPaymentView = "billing" | "settings" | "all";
interface AdminPaymentPanelProps {
  view?: AdminPaymentView;
  onClose: () => void;
  onBillingChanged: () => void;
}

const EMPTY_SETTINGS: AdminSettings = {
  id: "", settings_key: "default", premium_price_usd: 20,
  nigeria_enabled: false, nigeria_bank_name: "", nigeria_account_name: "", nigeria_account_number: "", nigeria_instructions: "", nigeria_ngn_rate: 0, nigeria_rate_timestamp: "",
  uk_enabled: false, uk_account_holder_name: "", uk_bank_name: "", uk_account_number: "", uk_sort_code: "", uk_iban: "", uk_bic_swift: "", uk_bank_address: "", uk_account_holder_address: "", uk_instructions: "", uk_gbp_rate: 0, uk_rate_timestamp: "",
  usa_enabled: false, usa_account_holder_name: "", usa_bank_name: "", usa_account_number: "", usa_routing_number: "", usa_bank_address: "", usa_account_holder_address: "", usa_instructions: "",
};
type SettingsResponse = { settings: AdminSettings; crypto_options: CryptoOption[] };
type PaymentsResponse = { payments: AdminPaymentRow[] };
type ReceiptResponse = { receipt: ProtectedReceiptPayload };
type DecisionNotice = { tone: "success" | "warning"; message: string };

function CountCard({ label, value, tone = "" }: { label: string; value: number | string; tone?: string }) {
  return <div className={`billing-count-card ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}
function trendDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(date) : value;
}
function activityLabel(action: string): string {
  const labels: Record<string, string> = {
    SUBMISSION_CREATED: "Payment submitted", PAYMENT_APPROVED: "Payment approved", PAYMENT_REJECTED: "Payment rejected",
    SUBSCRIPTION_EXTENDED: "Premium period granted", SUBSCRIPTION_EXPIRED: "Premium expired", SETTINGS_SAVED: "Payment settings saved",
    CRYPTO_OPTION_ADDED: "Crypto destination added", CRYPTO_OPTION_EDITED: "Crypto destination edited", CRYPTO_OPTION_DELETED: "Crypto destination deleted",
    NOTIFICATION_ATTEMPTED: "Notification attempted",
  };
  return labels[action] || action.replaceAll("_", " ").toLowerCase();
}
function actorLabel(actor: string): string {
  return actor.trim().toLowerCase() === "system" || !actor.trim() ? "System" : "Administrator";
}

function TrendChart({ points }: { points: ActivityTrendPoint[] }) {
  const maxTotal = Math.max(1, ...points.map((point) => point.submissions + point.approvals + point.rejections + point.expirations));
  const totalActivity = points.reduce((sum, point) => sum + point.submissions + point.approvals + point.rejections + point.expirations, 0);
  return <div className="billing-trend-panel"><div className="billing-analytics-subhead"><div><strong>30-day activity</strong><span>Submission, decision, and expiration events from real billing records.</span></div><span className="billing-trend-total">{totalActivity} events</span></div><div className="billing-trend-chart" role="img" aria-label="Thirty day billing activity trend">{points.map((point) => { const total = point.submissions + point.approvals + point.rejections + point.expirations; return <div className="billing-trend-column" key={point.date} title={`${trendDate(point.date)}: ${point.submissions} submissions, ${point.approvals} approvals, ${point.rejections} rejections, ${point.expirations} expirations`}><div className="billing-trend-stack" style={{ height: total ? `${Math.max(5, (total / maxTotal) * 100)}%` : "0%" }}>{total > 0 && <><span className="is-submissions" style={{ height: `${(point.submissions / total) * 100}%` }} /><span className="is-approvals" style={{ height: `${(point.approvals / total) * 100}%` }} /><span className="is-rejections" style={{ height: `${(point.rejections / total) * 100}%` }} /><span className="is-expirations" style={{ height: `${(point.expirations / total) * 100}%` }} /></>}</div></div>; })}</div><div className="billing-trend-axis"><span>{points[0] ? trendDate(points[0].date) : "30 days ago"}</span><span>Today</span></div><div className="billing-trend-legend"><span className="is-submissions">Submissions</span><span className="is-approvals">Approvals</span><span className="is-rejections">Rejections</span><span className="is-expirations">Expirations</span></div></div>;
}

function AnalyticsSection({ overview }: { overview: AdminOverview }) {
  const totals = overview.approved_local_currency_totals || [];
  return <section className="billing-analytics" aria-labelledby="billing-analytics-heading"><div className="billing-analytics-heading"><div><p className="billing-section-kicker">Internal reporting</p><h3 id="billing-analytics-heading">Billing activity</h3><p className="billing-help">These figures summarize approved manual payments. The USD total uses each payment's saved expected amount, includes the USA discount, and converts NGN and GBP through each payment's saved exchange rate. It is not recurring revenue.</p></div><CalendarDays className="h-5 w-5" /></div><div className="billing-analytics-summary"><div className="billing-analytics-card is-primary"><CircleDollarSign className="h-4 w-4" /><span>Approved recorded value</span><strong>{formatBillingMoney(overview.approved_volume_usd || 0, "USD")}</strong><small>{overview.counts.approved} approved payment{overview.counts.approved === 1 ? "" : "s"} valued from saved payment details</small></div><div className="billing-analytics-card"><span>Approved local currency totals</span>{totals.length ? <div className="billing-local-totals">{totals.map((total) => <strong key={total.currency}>{formatBillingMoney(total.amount, total.currency)}</strong>)}</div> : <strong className="billing-analytics-empty-value">No approved NGN or GBP totals yet</strong>}<small>Only claimed NGN and GBP amounts are included.</small></div></div><TrendChart points={overview.activity_trend || []} /></section>;
}

function ActivityFeed({ rows }: { rows: BillingAuditRow[] }) {
  return <section className="billing-activity-panel" aria-labelledby="billing-activity-heading"><div className="billing-activity-heading"><div><p className="billing-section-kicker">Protected history</p><h3 id="billing-activity-heading">Recent billing activity</h3><p className="billing-help">Safe audit metadata only. Receipt contents never appear here.</p></div><History className="h-5 w-5" /></div>{rows.length ? <ol className="billing-audit-list">{rows.map((row) => <li className="billing-audit-item" key={row.id}><div className="billing-audit-marker" aria-hidden><Clock3 className="h-3.5 w-3.5" /></div><div><div className="billing-audit-top"><strong>{activityLabel(row.action)}</strong><span>{formatBillingDate(row.created_at)}</span></div><p>{row.summary}</p><div className="billing-audit-meta"><span>Actor: {actorLabel(row.actor_email)}</span>{row.subject_email && <span>User: {row.subject_email}</span>}{row.related_payment_id && <span>Payment: {row.related_payment_id}</span>}{row.related_subscription_id && <span>Subscription: {row.related_subscription_id}</span>}</div></div></li>)}</ol> : <div className="billing-empty-state"><History className="h-5 w-5" /><p>No billing activity has been recorded yet.</p></div>}</section>;
}

export function AdminPaymentPanel({ view = "all", onClose, onBillingChanged }: AdminPaymentPanelProps) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [settings, setSettings] = useState<AdminSettings>(EMPTY_SETTINGS);
  const [cryptoOptions, setCryptoOptions] = useState<CryptoOption[]>([]);
  const [payments, setPayments] = useState<AdminPaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingCrypto, setSavingCrypto] = useState(false);
  const [busyPaymentId, setBusyPaymentId] = useState("");
  const [receipt, setReceipt] = useState<ProtectedReceiptPayload | null>(null);
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [error, setError] = useState("");
  const [decisionNotice, setDecisionNotice] = useState<DecisionNotice | null>(null);
  const showBilling = view === "billing" || view === "all";
  const showSettings = view === "settings" || view === "all";

  const loadAdmin = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    setError("");
    try {
      const [nextOverview, nextSettings, nextPayments] = await Promise.all([
        adminBillingAction<AdminOverview>({ action: "overview" }),
        adminBillingAction<SettingsResponse>({ action: "settings" }),
        adminBillingAction<PaymentsResponse>({ action: "payments" }),
      ]);
      setOverview(nextOverview);
      setSettings(nextSettings.settings || EMPTY_SETTINGS);
      setCryptoOptions(nextSettings.crypto_options || []);
      setPayments(nextPayments.payments || []);
      setAccessDenied(false);
    } catch (requestError) {
      console.error("Could not load administrator billing panel", requestError);
      if (isBillingAccessDenied(requestError)) {
        setAccessDenied(true);
        setOverview(null);
        setPayments([]);
        setCryptoOptions([]);
      } else {
        setError(requestError instanceof Error ? requestError.message : "The administrator panel could not be loaded.");
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);
  useEffect(() => { void loadAdmin(); }, [loadAdmin]);

  const saveSettings = async () => {
    setSavingSettings(true); setError("");
    try {
      const response = await adminBillingAction<{ settings: AdminSettings }>({ action: "save_settings", settings });
      setSettings(response.settings);
      await loadAdmin(true);
    } catch (saveError) {
      console.error("Could not save payment settings", saveError);
      setError(saveError instanceof Error ? saveError.message : "Payment settings could not be saved.");
    } finally { setSavingSettings(false); }
  };
  const saveCrypto = async (draft: CryptoDraft) => {
    setSavingCrypto(true); setError("");
    try { await adminBillingAction({ action: "crypto_save", ...draft }); await loadAdmin(true); }
    catch (saveError) { console.error("Could not save crypto destination", saveError); setError(saveError instanceof Error ? saveError.message : "The cryptocurrency destination could not be saved."); }
    finally { setSavingCrypto(false); }
  };
  const deleteCrypto = async (id: string) => {
    if (!window.confirm("Remove this cryptocurrency destination? Users will no longer see it.")) return;
    setSavingCrypto(true); setError("");
    try { await adminBillingAction({ action: "crypto_delete", id }); await loadAdmin(true); }
    catch (deleteError) { console.error("Could not delete crypto destination", deleteError); setError(deleteError instanceof Error ? deleteError.message : "The cryptocurrency destination could not be removed."); }
    finally { setSavingCrypto(false); }
  };
  const inspectReceipt = async (payment: AdminPaymentRow) => {
    if (!payment.receipt_id) return;
    setReceipt(null); setReceiptLoading(true); setError("");
    try { const response = await adminBillingAction<ReceiptResponse>({ action: "receipt", receipt_id: payment.receipt_id, payment_id: payment.id }); setReceipt(response.receipt); }
    catch (receiptError) { console.error("Could not load protected receipt", receiptError); setError(receiptError instanceof Error ? receiptError.message : "The receipt could not be opened."); }
    finally { setReceiptLoading(false); }
  };
  const decide = async (paymentId: string, action: "approve" | "reject", note: string) => {
    setBusyPaymentId(paymentId); setError(""); setDecisionNotice(null);
    try {
      const response = await adminBillingAction<AdminDecisionResponse>({ action, payment_id: paymentId, admin_notes: note, reason: note });
      setDecisionNotice({ tone: response.notification?.status === "SENT" ? "success" : "warning", message: response.notification?.message || `${action === "approve" ? "Approval" : "Rejection"} saved.` });
      await loadAdmin(true); onBillingChanged();
    } catch (decisionError) { console.error(`Could not ${action} payment`, decisionError); setError(decisionError instanceof Error ? decisionError.message : `The payment could not be ${action}d.`); }
    finally { setBusyPaymentId(""); }
  };

  if (accessDenied) return <section className="billing-admin-shell" aria-labelledby="admin-denied-heading"><div className="billing-admin-top"><div><p className="billing-eyebrow">Private controls</p><h2 id="admin-denied-heading">Page not found</h2><p className="billing-subtitle">This protected workspace could not be opened.</p></div><Button type="button" variant="outline" onClick={onClose}><ArrowLeft className="h-4 w-4" />Back to overview</Button></div><div className="billing-access-denied"><ShieldCheck className="h-8 w-8" /><h3>This protected area is unavailable</h3><p>Your sign-in could not open this private workspace.</p></div></section>;
  if (loading) return <section className="billing-admin-shell"><div className="billing-loading"><RefreshCw className="h-4 w-4 animate-spin" />Loading private payment controls…</div></section>;

  const counts = overview?.counts;
  const title = view === "settings" ? "Payment settings" : "Payment review";
  const subtitle = view === "settings" ? "Keep manual payment destinations accurate and ready for user checkout." : "Review submitted payments, inspect private receipt documents, and make explicit manual approval or rejection decisions.";
  return <section className="billing-admin-shell" aria-labelledby="admin-panel-heading"><div className="billing-admin-top"><div><p className="billing-eyebrow">Private controls</p><h2 id="admin-panel-heading">{title}</h2><p className="billing-subtitle">{subtitle}</p></div><div className="billing-admin-top-actions"><Button type="button" variant="outline" onClick={() => void loadAdmin(true)} disabled={refreshing}><RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />Refresh</Button><Button type="button" className="tx-btn-primary" onClick={onClose}><ArrowLeft className="h-4 w-4" />Back to overview</Button></div></div>
    {error && <div className="billing-feedback billing-feedback-error" role="alert">{error}</div>}
    {decisionNotice && <div className={`billing-feedback billing-feedback-${decisionNotice.tone}`} role="status">{decisionNotice.tone === "success" ? <MailCheck className="h-4 w-4" /> : <MailWarning className="h-4 w-4" />}<span>{decisionNotice.message}</span></div>}
    {showBilling && <><div className="billing-admin-notice"><BarChart3 className="h-4 w-4" /><span>Approval is manual. A receipt, reference ID, or screenshot never activates Premium by itself.</span></div><div className="billing-count-grid"><CountCard label="Total users" value={counts?.total_users ?? "—"} /><CountCard label="Pending payments" value={counts?.pending ?? 0} tone="is-pending" /><CountCard label="Active Premium" value={counts?.active ?? 0} tone="is-active" /><CountCard label="Expired Premium" value={counts?.expired ?? 0} /><CountCard label="Approved payments" value={counts?.approved ?? 0} tone="is-active" /><CountCard label="Rejected payments" value={counts?.rejected ?? 0} tone="is-rejected" /></div>{overview && <AnalyticsSection overview={overview} />}{overview && <ActivityFeed rows={overview.recent_activity || []} />}<AdminPaymentsList payments={payments} busyPaymentId={busyPaymentId} receipt={receipt} receiptLoading={receiptLoading} onInspectReceipt={(payment) => void inspectReceipt(payment)} onCloseReceipt={() => { setReceipt(null); setReceiptLoading(false); }} onApprove={(id, note) => decide(id, "approve", note)} onReject={(id, note) => decide(id, "reject", note)} /></>}
    {showSettings && <><AdminSettingsForm settings={settings} saving={savingSettings} onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))} onSave={() => void saveSettings()} /><AdminCryptoOptions options={cryptoOptions} saving={savingCrypto} onSave={(draft) => void saveCrypto(draft)} onDelete={(id) => void deleteCrypto(id)} /></>}
  </section>;
}
