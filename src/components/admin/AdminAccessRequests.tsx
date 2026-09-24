import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Clock3, Inbox, Mail, RefreshCw, Reply, Search, ShieldCheck, StickyNote, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AdminReplyComposer, type AdminReplyPayload } from "@/components/admin/AdminReplyComposer";
import { adminAccessAction, isAdminAccessDenied } from "@/lib/admin/adminAccess";
import { formatBillingDate } from "@/lib/billing/manualPayments";

type RequestStatus = "NEW" | "REVIEWED" | "APPROVED";
type AccessRequestRow = { id: string; name: string; contact_email: string; message: string; submitted_at: string; status: RequestStatus; private_note: string; reviewed_by: string; reviewed_at: string; approved_by: string; approved_at: string };
type SupportReply = { id: string; role: string; message_text: string; source: string; access_request_id: string; recipient_email: string; subject: string; delivery_status: string; sent_at: string };
type AccessRequestsResponse = { requests: AccessRequestRow[]; counts: { total: number; new: number; reviewed: number; approved: number } };
type AccessRequestDetailResponse = { request: AccessRequestRow; replies: SupportReply[] };
type AdminReplyResult = { ok: boolean; message_id: string; delivery_status: string; sent_at: string };
type AdminAccessRequestsProps = { refreshToken?: number; onDenied: () => void };

const STATUS_OPTIONS: { value: RequestStatus; label: string }[] = [{ value: "NEW", label: "New" }, { value: "REVIEWED", label: "Reviewed" }, { value: "APPROVED", label: "Approved" }];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function statusClass(status: RequestStatus): string { return `admin-status ${status === "APPROVED" ? "admin-status-premium-active" : status === "REVIEWED" ? "admin-status-payment-pending" : "admin-status-not-initialized"}`; }
function statusLabel(status: RequestStatus): string { return STATUS_OPTIONS.find((option) => option.value === status)?.label || "New"; }
function dateLabel(value: string): string { return value ? formatBillingDate(value) : "Not recorded"; }
function validEmail(value: string): boolean { return EMAIL_PATTERN.test((value || "").trim().toLowerCase()); }
function Metric({ label, value, tone = "" }: { label: string; value: number | string; tone?: string }) { return <div className={`admin-metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>Protected request inbox</small></div>; }

export function AdminAccessRequests({ refreshToken = 0, onDenied }: AdminAccessRequestsProps) {
  const [response, setResponse] = useState<AccessRequestsResponse | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<AccessRequestDetailResponse | null>(null);
  const [replyingRequestId, setReplyingRequestId] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<RequestStatus | "">("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const next = await adminAccessAction<AccessRequestsResponse>({ action: "access_requests", search: search.trim().slice(0, 120), status: status || "ALL" });
      setResponse(next); setNotes(Object.fromEntries((next.requests || []).map((request) => [request.id, request.private_note || ""])));
    } catch (requestError) {
      if (isAdminAccessDenied(requestError)) onDenied(); else setError("The private access request inbox could not be loaded. Try again.");
    } finally { setLoading(false); }
  }, [onDenied, search, status]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 240); return () => window.clearTimeout(timer); }, [load, refreshToken]);

  const openReply = async (request: AccessRequestRow) => {
    if (!validEmail(request.contact_email) || busy) return;
    setBusy(`detail:${request.id}`); setError(""); setNotice("");
    try {
      const next = await adminAccessAction<AccessRequestDetailResponse>({ action: "access_request_detail", access_request_id: request.id });
      setSelectedDetail(next); setReplyingRequestId(request.id);
    } catch (requestError) {
      if (isAdminAccessDenied(requestError)) onDenied(); else setError("That access request detail could not be opened. Try again.");
    } finally { setBusy(""); }
  };

  const sendReply = async ({ targetId, subject, body }: AdminReplyPayload) => {
    setBusy(`reply:${targetId}`); setError(""); setNotice("");
    try {
      const result = await adminAccessAction<AdminReplyResult>({ action: "send_admin_reply", target_kind: "access_request", access_request_id: targetId, subject, body });
      if (result.ok !== true) throw new Error("The email could not be sent. Nothing was changed.");
      setNotice(`Reply sent to ${selectedDetail?.request.contact_email || "the stored requester address"}. The protected history was updated.`);
      try {
        await load();
        const detail = await adminAccessAction<AccessRequestDetailResponse>({ action: "access_request_detail", access_request_id: targetId });
        setSelectedDetail(detail);
      } catch { setError("The reply was sent, but the detail view could not refresh. Use Refresh to view the updated history."); }
    } catch (requestError) {
      if (isAdminAccessDenied(requestError)) { onDenied(); throw new Error("Your administrator session has expired. Sign in again to reply."); }
      const message = requestError instanceof Error && requestError.message ? requestError.message : "The email could not be sent. Nothing was changed.";
      setError(message); throw new Error(message);
    } finally { setBusy(""); }
  };

  const updateRequest = async (request: AccessRequestRow, nextStatus: RequestStatus) => {
    if (busy) return;
    const key = `${request.id}:${nextStatus}`; setBusy(key); setError(""); setNotice("");
    try {
      await adminAccessAction({ action: "update_access_request", request_id: request.id, status: nextStatus, private_note: (notes[request.id] || "").trim() });
      setNotice(`${statusLabel(nextStatus)} status saved for ${request.name || request.contact_email}.`); await load();
    } catch (requestError) {
      if (isAdminAccessDenied(requestError)) onDenied(); else setError("That request could not be updated. Nothing was changed.");
    } finally { setBusy(""); }
  };

  const requests = response?.requests || [];
  const filtered = Boolean(search.trim() || status);
  return <section className="admin-users-panel" aria-labelledby="admin-access-requests-heading">
    <div className="admin-section-heading"><div><p className="admin-section-kicker">Private workflow inbox</p><h3 id="admin-access-requests-heading">Access requests</h3><p>Review signed-out requests captured alongside Buildy Contacts. Names, email addresses, and messages are read-only snapshots here, while status and private notes stay in this protected workflow.</p></div><Button type="button" variant="outline" className="admin-header-button" onClick={() => void load()} disabled={loading || Boolean(busy)}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button></div>
    <div className="admin-scope-note"><ShieldCheck className="h-4 w-4" /><span><strong>Contacts remain the primary CRM record.</strong> This inbox adds review status and private administrator context without editing or replacing the contact.</span></div>
    <div className="admin-directory-toolbar"><label className="admin-search-field"><Search aria-hidden="true" /><Input value={search} onChange={(event) => setSearch(event.target.value)} maxLength={120} placeholder="Search name, email, or request" aria-label="Search access requests" className="tx-input" /></label><select className="admin-filter-select" value={status} onChange={(event) => setStatus(event.target.value as RequestStatus | "")} aria-label="Filter access requests by status"><option value="">All statuses</option>{STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><span className="admin-result-count">{response ? `${requests.length} shown` : "Loading"}</span></div>
    {error && <div className="admin-feedback is-error" role="alert"><AlertTriangle className="h-4 w-4" />{error}</div>}
    {notice && <div className="admin-feedback is-success" role="status"><Check className="h-4 w-4" />{notice}</div>}
    <div className="admin-metric-grid"><Metric label="All requests" value={response?.counts.total ?? "—"} /><Metric label="New" value={response?.counts.new ?? "—"} tone="is-amber" /><Metric label="Reviewed" value={response?.counts.reviewed ?? "—"} tone="is-coral" /><Metric label="Approved" value={response?.counts.approved ?? "—"} tone="is-mint" /></div>
    {loading && !response ? <div className="admin-loading"><RefreshCw className="h-4 w-4 animate-spin" />Loading access requests…</div> : !requests.length ? <div className="admin-empty mt-4"><Inbox className="h-5 w-5" /><p>{filtered ? "No access requests match these filters." : "No access requests have been captured yet."}</p><span>{filtered ? "Try a different name, email, message, or status." : "New signed-out requests will appear here after Contacts saves successfully."}</span></div> : <div className="mt-4 grid gap-4">{requests.map((request) => {
      const detail = selectedDetail?.request.id === request.id ? selectedDetail : null;
      return <article className="admin-user-detail" key={request.id}><div className="admin-user-detail-head"><div><p className="admin-section-kicker">Access request</p><h4>{request.name || "Unnamed visitor"}</h4><p><Mail className="h-3.5 w-3.5" />{request.contact_email || "Email not recorded"}</p></div><div className="flex flex-wrap items-center justify-end gap-2"><span className={statusClass(request.status)}>{statusLabel(request.status)}</span><span className="admin-status admin-status-not-initialized"><Clock3 className="mr-1 h-3 w-3" />{dateLabel(request.submitted_at)}</span>{validEmail(request.contact_email) && <Button type="button" variant="outline" className="admin-header-button" onClick={() => void openReply(request)} disabled={Boolean(busy)}>{busy === `detail:${request.id}` && <RefreshCw className="h-4 w-4 animate-spin" />}<Reply className="h-4 w-4" />Reply by email</Button>}</div></div><div className="admin-detail-card"><div className="admin-detail-card-heading"><Inbox className="h-4 w-4" /><div><strong>Request message</strong><span>Read-only snapshot from the public form</span></div></div><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{request.message || "No message was provided."}</p></div><div className="admin-note-card"><div className="admin-detail-card-heading"><StickyNote className="h-4 w-4" /><div><strong>Private administrator note</strong><span>Only authorized administrators can read or change this note.</span></div></div><Textarea value={notes[request.id] || ""} onChange={(event) => setNotes((current) => ({ ...current, [request.id]: event.target.value }))} maxLength={2000} placeholder="Add context for this review" aria-label={`Private note for ${request.name || request.contact_email}`} /><div className="mt-3 flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-muted-foreground">Choose a status to save the note.</span><div className="admin-history-tabs" role="group" aria-label={`Status for ${request.name || request.contact_email}`}>{STATUS_OPTIONS.map((option) => <button type="button" key={option.value} className={request.status === option.value ? "is-active" : ""} aria-pressed={request.status === option.value} onClick={() => void updateRequest(request, option.value)} disabled={Boolean(busy)}>{busy === `${request.id}:${option.value}` && <RefreshCw className="mr-1 inline h-3 w-3 animate-spin" />}{option.label}</button>)}</div></div></div>{detail && <div className="admin-detail-card mt-4"><div className="flex items-start justify-between gap-3"><div className="admin-detail-card-heading"><Mail className="h-4 w-4" /><div><strong>Protected email history</strong><span>{detail.replies.length ? `${detail.replies.length} administrator repl${detail.replies.length === 1 ? "y" : "ies"}` : "No administrator replies yet"}</span></div></div><Button type="button" variant="outline" className="admin-header-button" onClick={() => { setSelectedDetail(null); setReplyingRequestId(""); }} disabled={Boolean(busy)}><X className="h-4 w-4" />Close</Button></div>{detail.replies.length ? <div className="mt-3 grid gap-2">{detail.replies.map((reply) => <div key={reply.id} className="rounded-xl border border-[hsl(var(--line))] bg-[hsl(var(--ink)/0.22)] p-3"><div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground"><span className="font-semibold text-foreground">Administrator · {reply.subject || "No subject"}</span><span>{dateLabel(reply.sent_at)}</span></div><div className="mt-2 flex flex-wrap items-center gap-2"><span className="text-[11px] text-muted-foreground">To {reply.recipient_email || detail.request.contact_email}</span><span className="admin-status admin-status-premium-active">{reply.delivery_status || "Sent"}</span></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{reply.message_text}</p></div>)}</div> : <p className="mt-3 text-sm text-muted-foreground">Replies sent from this panel will appear here with their delivery state.</p>}{replyingRequestId === request.id && <AdminReplyComposer key={`${detail.request.id}:${replyingRequestId}`} targetKind="access_request" targetId={detail.request.id} recipientEmail={detail.request.contact_email} defaultSubject="Re: Your Verbatim Desk access request" onSend={sendReply} onCancel={() => setReplyingRequestId("")} />}</div>}</article>;
    })}</div>}
  </section>;
}
