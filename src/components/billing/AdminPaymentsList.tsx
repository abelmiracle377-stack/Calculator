import { useState } from "react";
import { Check, Clock3, Eye, RefreshCw, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatBillingDate, formatBillingMoney, methodLabel } from "@/lib/billing/manualPayments";
import type { AdminPaymentRow, NotificationStatus, ProtectedReceiptPayload } from "@/lib/billing/types";

interface AdminPaymentsListProps {
  payments: AdminPaymentRow[];
  busyPaymentId: string;
  receipt: ProtectedReceiptPayload | null;
  receiptLoading: boolean;
  onInspectReceipt: (payment: AdminPaymentRow) => void;
  onCloseReceipt: () => void;
  onApprove: (paymentId: string, note: string) => Promise<void>;
  onReject: (paymentId: string, note: string) => Promise<void>;
}

type Decision = { id: string; action: "approve" | "reject" } | null;
function Tag({ children, tone = "muted" }: { children: string; tone?: "muted" | "active" | "pending" | "rejected" | "approved" }) { return <span className={`billing-tag billing-tag-${tone}`}>{children}</span>; }
function notificationLabel(status: NotificationStatus): string { return status === "SENT" ? "Sent" : status === "FAILED" ? "Failed" : status === "SKIPPED" ? "Skipped" : "Not attempted"; }
function notificationTone(status: NotificationStatus): "muted" | "pending" | "rejected" | "approved" { return status === "SENT" ? "approved" : status === "FAILED" ? "rejected" : status === "SKIPPED" ? "pending" : "muted"; }
function NoticeStatus({ label, status, attemptedAt, error }: { label: string; status: NotificationStatus; attemptedAt: string; error: string }) {
  return <div className="billing-notification-status"><div><span>{label}</span><Tag tone={notificationTone(status)}>{notificationLabel(status)}</Tag></div>{attemptedAt && <small>{formatBillingDate(attemptedAt)}</small>}{status === "FAILED" && error && <small className="is-error">{error}</small>}</div>;
}

export function AdminPaymentsList({ payments, busyPaymentId, receipt, receiptLoading, onInspectReceipt, onCloseReceipt, onApprove, onReject }: AdminPaymentsListProps) {
  const [decision, setDecision] = useState<Decision>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const beginDecision = (id: string, action: "approve" | "reject") => { setDecision((current) => current?.id === id && current.action === action ? current : { id, action }); setDecisionNote(""); };
  const confirmDecision = async (payment: AdminPaymentRow) => {
    if (!decision || decision.id !== payment.id) return;
    if (decision.action === "approve") await onApprove(payment.id, decisionNote); else await onReject(payment.id, decisionNote);
    setDecision(null); setDecisionNote("");
  };

  return <div className="billing-payments-list"><div className="billing-list-heading"><div><p className="billing-section-kicker">Payment review</p><h3>Review submitted payments</h3></div><span className="billing-help">Inspect private receipt documents and verify funds before approving or rejecting a submission.</span></div>
    {!payments.length && <div className="billing-empty-state"><Clock3 className="h-5 w-5" /><p>No payment submissions yet.</p></div>}
    {payments.map((payment) => {
      const isBusy = busyPaymentId === payment.id; const isConfirming = decision?.id === payment.id; const statusTone = payment.status === "APPROVED" ? "approved" : payment.status === "REJECTED" ? "rejected" : "pending";
      return <article className="billing-payment-row" key={payment.id}>
        <div className="billing-payment-row-top"><div><strong>{payment.owner_email}</strong><span>{methodLabel(payment.payment_method)} · {payment.country}</span></div><div className="billing-payment-tags"><Tag tone={payment.payment_method === "CRYPTO" ? "active" : "muted"}>{payment.payment_method === "CRYPTO" ? "CRYPTO" : "BANK_TRANSFER"}</Tag><Tag tone={statusTone}>{payment.status}</Tag></div></div>
        <div className="billing-payment-facts"><div><span>Expected</span><strong>{formatBillingMoney(payment.expected_amount, payment.expected_currency)}</strong></div><div><span>Claimed</span><strong>{formatBillingMoney(payment.claimed_amount, payment.claimed_currency)}</strong></div><div><span>Payment date</span><strong>{formatBillingDate(payment.payment_date)}</strong></div><div><span>Submitted</span><strong>{formatBillingDate(payment.submitted_at)}</strong></div>{payment.verification_at && <div><span>Decision</span><strong>{formatBillingDate(payment.verification_at)}</strong></div>}</div>
        <div className="billing-payment-meta"><span>Reference: <strong>{payment.transaction_reference || "Not provided"}</strong></span>{payment.exchange_rate > 0 && <span>Rate: <strong>{payment.exchange_rate} · {formatBillingDate(payment.exchange_rate_timestamp)}</strong></span>}<span>Payment ID: <strong>{payment.id}</strong></span></div>
        {payment.crypto_name && <p className="billing-payment-note"><strong>Crypto:</strong> {payment.crypto_name} · {payment.crypto_network}</p>}
        {payment.note && <p className="billing-payment-note"><strong>User note:</strong> {payment.note}</p>}
        {payment.status === "REJECTED" && payment.admin_reason && <p className="billing-payment-note billing-payment-rejection"><strong>Rejection reason:</strong> {payment.admin_reason}</p>}
        {payment.status === "APPROVED" && <p className="billing-payment-note billing-payment-approved"><strong>Premium {payment.premium_status === "EXPIRED" ? "period ended" : "granted"}:</strong> {formatBillingDate(payment.premium_start)} to {formatBillingDate(payment.premium_end)}</p>}
        <div className="billing-notification-grid"><NoticeStatus label="Administrator email" status={payment.admin_notification_status} attemptedAt={payment.admin_notification_attempted_at} error={payment.admin_notification_error} /><NoticeStatus label="Payer email" status={payment.payer_notification_status} attemptedAt={payment.payer_notification_attempted_at} error={payment.payer_notification_error} /></div>
        <div className="billing-payment-actions"><Button type="button" size="sm" variant="outline" title={payment.receipt_id ? "Open the private submitted receipt" : "No receipt was submitted"} aria-label={payment.receipt_id ? `Inspect receipt for ${payment.owner_email}` : "No receipt was submitted"} onClick={() => onInspectReceipt(payment)} disabled={!payment.receipt_id || isBusy}><Eye className="h-3.5 w-3.5" />{payment.receipt_id ? "Inspect receipt" : "No receipt"}</Button>{payment.status === "PENDING" && <><Button type="button" size="sm" className="billing-approve-button" title="Approve after verifying the transfer" aria-label={`Approve payment from ${payment.owner_email}`} onClick={() => beginDecision(payment.id, "approve")} disabled={isBusy}><Check className="h-3.5 w-3.5" />Approve</Button><Button type="button" size="sm" variant="outline" className="billing-reject-button" title="Reject this payment submission" aria-label={`Reject payment from ${payment.owner_email}`} onClick={() => beginDecision(payment.id, "reject")} disabled={isBusy}><X className="h-3.5 w-3.5" />Reject</Button></>}</div>
        {isConfirming && <div className="billing-decision-box"><p>Confirm {decision?.action === "approve" ? "approval" : "rejection"}. {decision?.action === "approve" ? "Premium will start or extend by one calendar month after you verify the transfer." : "This payment will remain without Premium access."}</p><Textarea value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} maxLength={2000} placeholder={decision?.action === "approve" ? "Optional verification note" : "Optional rejection reason"} /><div className="billing-row-actions"><Button type="button" size="sm" className={decision?.action === "approve" ? "billing-approve-button" : "billing-reject-button"} onClick={() => void confirmDecision(payment)} disabled={isBusy}>{isBusy && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}Confirm {decision?.action === "approve" ? "approval" : "rejection"}</Button><Button type="button" size="sm" variant="ghost" onClick={() => setDecision(null)} disabled={isBusy}>Cancel</Button></div></div>}
      </article>;
    })}
    <Dialog open={Boolean(receiptLoading || receipt)} onOpenChange={(open) => { if (!open) onCloseReceipt(); }}><DialogContent className="billing-receipt-dialog"><DialogHeader><DialogTitle>Private receipt inspection</DialogTitle><DialogDescription>This image is visible only in the administrator view. It is payment evidence, not automatic proof of settlement.</DialogDescription></DialogHeader>{receiptLoading && <div className="billing-loading"><RefreshCw className="h-4 w-4 animate-spin" />Loading protected receipt…</div>}{receipt && <div className="billing-receipt-inspection"><img src={receipt.payload_data} alt={`Receipt ${receipt.original_filename}`} /><div><span>{receipt.original_filename}</span><span>{receipt.mime_type} · {Math.round(receipt.byte_size / 1024)} KB</span></div></div>}<Button type="button" variant="outline" onClick={onCloseReceipt}><X className="h-4 w-4" />Close</Button></DialogContent></Dialog>
  </div>;
}
