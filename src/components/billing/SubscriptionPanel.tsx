import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, ChevronDown, Clock3, LockKeyhole, MailCheck, RefreshCw, Upload, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SubscriptionDetails } from "@/components/billing/SubscriptionDetails";
import { BillingRequestError, formatBillingDate, formatBillingMoney, getPaymentOptions, getUserBillingStatus, methodLabel, prepareReceiptImage, submitManualPayment, validateReceiptFile } from "@/lib/billing/manualPayments";
import type { NotificationStatus, PaymentMethod, PaymentMethodOption, PaymentOptionsResponse, UserAccessStatusResponse, UserBillingStatusResponse, UserSubmissionSummary } from "@/lib/billing/types";

interface SubscriptionPanelProps {
  refreshKey?: number;
  accessStatus?: UserAccessStatusResponse | null;
  accessStatusLoading?: boolean;
  accessStatusError?: string;
  onAccessStatusRefresh?: () => void | Promise<void>;
}

function localDateTimeValue() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function cryptoCurrencyValue(name: string): string {
  const value = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  return value.length >= 2 ? value : "USD";
}

function accessStateLabel(status: UserAccessStatusResponse["status"], pending: boolean) {
  if (status === "TRIALING") return "TRIAL ACTIVE";
  if (status === "PREMIUM_ACTIVE") return "PREMIUM ACTIVE";
  if (status === "PAYMENT_PENDING" || pending) return "PAYMENT VERIFICATION PENDING";
  if (status === "PREMIUM_EXPIRED") return "PREMIUM EXPIRED";
  if (status === "TRIAL_EXPIRED") return "TRIAL ENDED";
  if (status === "ADMIN_RESTRICTED") return "ACCESS RESTRICTED";
  return "PREMIUM AVAILABLE";
}

function accessNoticeCopy(status?: UserAccessStatusResponse["status"] | null): { title: string; description: string } | null {
  if (status === "TRIAL_EXPIRED") return { title: "Your free trial has ended.", description: "Upgrade to Premium to continue using audio transcription." };
  if (status === "PREMIUM_EXPIRED") return { title: "Your Premium access has expired.", description: "Upgrade to Premium to continue using audio transcription." };
  if (status === "PAYMENT_PENDING") return { title: "Payment verification pending.", description: "Your payment evidence is awaiting review. Transcription access stays restricted until approval." };
  if (status === "ADMIN_RESTRICTED") return { title: "Transcription access is restricted.", description: "Audio transcription is temporarily unavailable. Your saved sessions remain intact." };
  return null;
}

type TrialAccessCopy = {
  tone: "success" | "pending" | "rejected";
  title: string;
  description: string;
};

function trialAccessCopy(accessStatus?: UserAccessStatusResponse | null): TrialAccessCopy | null {
  if (!accessStatus) return null;
  const trialEnd = accessStatus.trial_end ? formatBillingDate(accessStatus.trial_end) : "";
  if (accessStatus.status === "TRIALING") return {
    tone: "success",
    title: "7-day free trial active.",
    description: trialEnd ? `Your transcription access is available through ${trialEnd}.` : "Your trial end date will appear when access details are available.",
  };
  if (accessStatus.status === "PAYMENT_PENDING") return {
    tone: "pending",
    title: "Payment approval is still required.",
    description: trialEnd ? `Your trial end date is ${trialEnd}. Premium access has not been approved yet.` : "Premium access has not been approved yet. Transcription access remains restricted until approval.",
  };
  if (accessStatus.status === "TRIAL_EXPIRED") return {
    tone: "rejected",
    title: "Your 7-day free trial has ended.",
    description: "Transcription remains restricted until active Premium approval.",
  };
  if (accessStatus.status === "PREMIUM_EXPIRED") return {
    tone: "rejected",
    title: "Premium access has expired.",
    description: "Your original 7-day free trial has ended, so transcription remains restricted until active Premium approval.",
  };
  return null;
}

function notificationCopy(status: NotificationStatus): string {
  if (status === "SENT") return "A decision email was sent to your sign-in address.";
  if (status === "FAILED") return "The decision was saved, but email delivery was unavailable.";
  if (status === "SKIPPED") return "The decision was saved. No email notice was sent.";
  return "";
}

function submissionLabel(status: UserSubmissionSummary["status"]): string {
  return status === "APPROVED" ? "Payment approved" : status === "REJECTED" ? "Payment rejected" : "Awaiting verification";
}

function BillingHistory({ billingStatus }: { billingStatus: UserBillingStatusResponse }) {
  const submissions = billingStatus.submissions || [];
  const subscription = billingStatus.subscription;
  if (!submissions.length && subscription.status === "NONE") return null;
  return <section className="billing-history" aria-labelledby="billing-history-heading">
    <div className="billing-history-heading"><div><p className="billing-section-kicker">Your account</p><h3 id="billing-history-heading">Payment history</h3></div><span className="billing-help">Only your own submissions and Premium dates appear here.</span></div>
    {submissions.length ? <ol className="billing-history-list">{submissions.map((submission) => {
      const expired = submission.status === "APPROVED" && Boolean(submission.premium_end) && Date.parse(submission.premium_end) <= Date.now();
      return <li className={`billing-history-item is-${submission.status.toLowerCase()}`} key={submission.id}>
        <div className="billing-history-marker" aria-hidden>{submission.status === "APPROVED" ? <CheckCircle2 /> : submission.status === "REJECTED" ? <XCircle /> : <Clock3 />}</div>
        <div className="billing-history-body">
          <div className="billing-history-item-head"><div><strong>{submissionLabel(submission.status)}</strong><span>{methodLabel(submission.payment_method)} · {formatBillingDate(submission.submitted_at)}</span></div><span className="billing-tag">{submission.status}</span></div>
          <p className="billing-history-amount">Submitted {formatBillingMoney(submission.claimed_amount, submission.claimed_currency)}{submission.transaction_reference ? ` · Reference ${submission.transaction_reference}` : ""}</p>
          {submission.status === "APPROVED" && submission.premium_start && <p className="billing-history-period">Premium: {formatBillingDate(submission.premium_start)} to {formatBillingDate(submission.premium_end)}{expired ? " · This period has ended" : ""}</p>}
          {submission.status === "REJECTED" && submission.admin_reason && <p className="billing-history-note">Review note: {submission.admin_reason}</p>}
          {submission.notification_status !== "NOT_ATTEMPTED" && <p className={`billing-history-notification is-${submission.notification_status.toLowerCase()}`}><MailCheck className="h-3.5 w-3.5" />{notificationCopy(submission.notification_status)}</p>}
        </div>
      </li>;
    })}</ol> : <p className="billing-history-empty">No payment submissions have been recorded.</p>}
    {subscription.status === "EXPIRED" && <p className="billing-history-expired"><XCircle className="h-4 w-4" />Premium access has expired. A new approved payment is required for another calendar month.</p>}
  </section>;
}

export function SubscriptionPanel({ refreshKey = 0, accessStatus, accessStatusLoading = false, accessStatusError = "", onAccessStatusRefresh }: SubscriptionPanelProps) {
  const [options, setOptions] = useState<PaymentOptionsResponse | null>(null);
  const [billingStatus, setBillingStatus] = useState<UserBillingStatusResponse | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethod | "">("");
  const [cryptoOptionId, setCryptoOptionId] = useState("");
  const [claimedAmount, setClaimedAmount] = useState("");
  const [claimedCurrency, setClaimedCurrency] = useState("");
  const [paymentDate, setPaymentDate] = useState(localDateTimeValue);
  const [transactionReference, setTransactionReference] = useState("");
  const [note, setNote] = useState("");
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState("");
  const receiptInputRef = useRef<HTMLInputElement | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [retry, setRetry] = useState(0);

  const loadBilling = async () => {
    setLoading(true);
    setError("");
    try {
      const [nextOptions, nextStatus] = await Promise.all([getPaymentOptions(), getUserBillingStatus()]);
      setOptions(nextOptions);
      setBillingStatus(nextStatus);
      setSelectedMethod((current) => nextOptions.methods.some((item) => item.id === current) ? current : (nextOptions.methods[0]?.id || ""));
    } catch (requestError) {
      console.error("Could not load Premium details", requestError);
      setError(requestError instanceof BillingRequestError ? requestError.message : "Premium details are temporarily unavailable.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadBilling(); }, [refreshKey, retry, accessStatus?.status]);
  useEffect(() => {
    const shouldOpen = accessStatus?.status === "TRIAL_EXPIRED" || accessStatus?.status === "PREMIUM_EXPIRED" || accessStatus?.status === "PAYMENT_PENDING";
    if (shouldOpen) setCheckoutOpen(true);
  }, [accessStatus?.status]);

  const selectedOption = useMemo<PaymentMethodOption | undefined>(() => options?.methods.find((item) => item.id === selectedMethod), [options, selectedMethod]);
  const selectedCrypto = selectedOption?.crypto_options?.find((item) => item.id === cryptoOptionId) || selectedOption?.crypto_options?.[0];
  const pendingSubmission = billingStatus?.submissions.find((item) => item.status === "PENDING");
  const rejectedSubmission = billingStatus?.submissions.find((item) => item.status === "REJECTED");
  const accessNotice = accessNoticeCopy(accessStatus?.status);
  const trialAccess = !accessStatusLoading && !accessStatusError ? trialAccessCopy(accessStatus) : null;

  useEffect(() => {
    if (!selectedOption) return;
    if (selectedOption.id === "CRYPTO") {
      const nextCrypto = selectedOption.crypto_options?.some((item) => item.id === cryptoOptionId) ? cryptoOptionId : (selectedOption.crypto_options?.[0]?.id || "");
      setCryptoOptionId(nextCrypto);
      setClaimedCurrency(cryptoCurrencyValue(selectedOption.crypto_options?.find((item) => item.id === nextCrypto)?.name || "USD"));
    } else {
      setCryptoOptionId("");
      setClaimedCurrency(selectedOption.expected_currency.trim().toUpperCase());
    }
    setClaimedAmount(String(selectedOption.expected_amount));
  }, [cryptoOptionId, selectedMethod, options, selectedOption]);

  useEffect(() => {
    if (!receiptFile) {
      setReceiptPreview("");
      return;
    }
    const url = URL.createObjectURL(receiptFile);
    setReceiptPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [receiptFile]);

  const clearReceipt = () => {
    setReceiptFile(null);
    if (receiptInputRef.current) receiptInputRef.current.value = "";
  };

  const handleReceipt = (file: File | undefined) => {
    if (!file) {
      clearReceipt();
      return;
    }
    const validation = validateReceiptFile(file);
    if (validation) {
      setError(validation);
      clearReceipt();
      return;
    }
    setError("");
    setSuccessMessage("");
    setReceiptFile(file);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pendingSubmission) {
      setError("Payment verification is already pending for this account.");
      return;
    }
    if (!selectedOption) {
      setError("Choose an enabled payment method first.");
      return;
    }
    if (!receiptFile) {
      setError("A payment receipt image is required.");
      return;
    }
    const amount = Number(claimedAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter the amount you paid.");
      return;
    }
    const expectedCurrency = selectedOption.expected_currency.trim().toUpperCase();
    const normalizedCurrency = claimedCurrency.trim().toUpperCase();
    if (selectedOption.id !== "CRYPTO" && normalizedCurrency !== expectedCurrency) { setError(`This payment method accepts ${expectedCurrency} only. Use the fixed currency shown.`); setClaimedCurrency(expectedCurrency); return; }
    setSubmitting(true);
    setError("");
    setSuccessMessage("");
    try {
      const prepared = await prepareReceiptImage(receiptFile);
      const response = await submitManualPayment({ method: selectedOption.id, crypto_option_id: selectedCrypto?.id || "", claimed_amount: amount, claimed_currency: selectedOption.id === "CRYPTO" ? normalizedCurrency : expectedCurrency, payment_date: new Date(paymentDate).toISOString(), transaction_reference: transactionReference, note, receipt: { data: prepared.data, mime_type: prepared.mimeType, original_filename: prepared.originalFilename } });
      setBillingStatus(response);
      setSuccessMessage(response.notification?.message || "Payment submitted. Your evidence is saved for review.");
      clearReceipt();
      setTransactionReference("");
      setNote("");
      setPaymentDate(localDateTimeValue());
      try { await onAccessStatusRefresh?.(); } catch (refreshError) { console.error("Could not refresh transcription access", refreshError); }
    } catch (submitError) {
      console.error("Could not submit manual payment", submitError);
      setError(submitError instanceof Error ? submitError.message : "The payment could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  };

  const subscription = billingStatus?.subscription;
  const isPremiumActive = accessStatus?.status === "PREMIUM_ACTIVE";
  const statusText = accessStatus ? accessStateLabel(accessStatus.status, Boolean(pendingSubmission)) : accessStatusLoading ? "CHECKING ACCESS" : accessStatusError ? "ACCESS UNAVAILABLE" : "PREMIUM AVAILABLE";
  const statusTone = isPremiumActive ? "active" : accessStatus?.status === "PAYMENT_PENDING" || pendingSubmission ? "pending" : accessStatus?.status === "PREMIUM_EXPIRED" || accessStatus?.status === "TRIAL_EXPIRED" || accessStatus?.status === "ADMIN_RESTRICTED" ? "expired" : "available";
  const isUsaBankTransfer = selectedOption?.id === "USA_BANK_TRANSFER";
  const offerAmount = isUsaBankTransfer && selectedOption ? formatBillingMoney(selectedOption.expected_amount, selectedOption.expected_currency) : formatBillingMoney(options?.base_amount_usd ?? 20, "USD");
  const offerCurrency = isUsaBankTransfer ? selectedOption?.expected_currency || "USD" : "USD";
  const offerLabel = isUsaBankTransfer ? "USA bank transfer offer" : "Premium";
  const offerNote = isUsaBankTransfer ? "The USA destination uses the discounted rate. One month begins after approval, with no automatic renewals." : "Standard price for one month. Access begins after approval, with no automatic renewals.";

  return <section className="billing-shell" aria-labelledby="premium-heading">
    <div className="billing-header-row"><div><p className="billing-eyebrow">Access layer</p><h2 id="premium-heading">Premium transcription access</h2><p className="billing-subtitle">Choose a payment method and upload proof. Access starts after the payment is verified.</p></div></div>
    <div className={`billing-offer-row ${checkoutOpen ? "is-open" : ""}`}>
      <button type="button" className="billing-offer-trigger" aria-label={checkoutOpen ? "Hide Premium payment options" : "Choose a payment method for Premium"} aria-expanded={checkoutOpen} aria-controls="premium-checkout" onClick={() => { setCheckoutOpen((current) => !current); setSuccessMessage(""); }}>
        <span className="billing-offer-content"><span className="billing-offer-label">{offerLabel}</span><strong className="billing-offer-price">{offerAmount} <small>{offerCurrency} / 1 month</small></strong><span className="billing-offer-note">{offerNote}</span></span>
        <span className="billing-offer-cta"><span>{checkoutOpen ? "Hide payment options" : "Choose a payment method"}</span><ChevronDown className="billing-offer-chevron" aria-hidden="true" /></span>
      </button>
      <div className={`billing-status billing-status-${statusTone}`} aria-live="polite">{isPremiumActive ? <CheckCircle2 /> : accessStatus?.status === "TRIALING" ? <Clock3 /> : pendingSubmission || accessStatus?.status === "PAYMENT_PENDING" ? <Clock3 /> : accessStatus?.status === "PREMIUM_EXPIRED" || accessStatus?.status === "TRIAL_EXPIRED" || accessStatus?.status === "ADMIN_RESTRICTED" ? <XCircle /> : <Upload />}<span>{statusText}</span></div>
    </div>
    {accessStatus?.status === "TRIALING" && <div className="billing-period"><span>Trial access ends</span><strong>{formatBillingDate(accessStatus.trial_end)}</strong></div>}
    {subscription && (accessStatus?.status === "PREMIUM_ACTIVE" || accessStatus?.status === "PREMIUM_EXPIRED") && <div className="billing-period"><span>Premium started</span><strong>{formatBillingDate(subscription.premium_start)}</strong><span>{isPremiumActive ? "Valid until" : "Expired on"}</span><strong>{formatBillingDate(subscription.premium_end)}</strong>{isPremiumActive && <span>Payment: {methodLabel(subscription.payment_method)}</span>}</div>}
    {trialAccess && <div className={`billing-feedback billing-feedback-${trialAccess.tone}`} role="status">{trialAccess.tone === "success" ? <CheckCircle2 className="h-4 w-4" /> : trialAccess.tone === "pending" ? <Clock3 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}<span><strong>{trialAccess.title}</strong> {trialAccess.description}</span></div>}
    {accessNotice && <div className={`billing-feedback billing-feedback-${accessStatus?.status === "PAYMENT_PENDING" ? "pending" : "rejected"}`} role="status"><Clock3 className="h-4 w-4" /><span><strong>{accessNotice.title}</strong> {accessNotice.description}</span></div>}
    {accessStatusError && <div className="billing-feedback billing-feedback-error" role="alert"><XCircle className="h-4 w-4" /><span>{accessStatusError}</span></div>}
    {pendingSubmission && <div className="billing-feedback billing-feedback-pending"><Clock3 className="h-4 w-4" /><span>Your {methodLabel(pendingSubmission.payment_method)} receipt is awaiting verification. Premium stays inactive until approval.</span></div>}
    {!pendingSubmission && rejectedSubmission && <div className="billing-feedback billing-feedback-rejected"><XCircle className="h-4 w-4" /><span>Payment verification was not approved. You can submit new payment evidence below.</span></div>}
    {successMessage && <div className="billing-feedback billing-feedback-success" role="status"><CheckCircle2 className="h-4 w-4" /><span>{successMessage}</span></div>}
    {error && <div className="billing-feedback billing-feedback-error" role="alert"><XCircle className="h-4 w-4" /><span>{error}</span></div>}
    {billingStatus && <BillingHistory billingStatus={billingStatus} />}

    {checkoutOpen && <div id="premium-checkout" className="billing-checkout" aria-label="Premium checkout">
      {loading ? <div className="billing-loading"><RefreshCw className="h-4 w-4 animate-spin" />Loading payment options…</div> : options && <>
        <div className="billing-method-section"><div className="billing-method-heading"><div><p className="billing-section-kicker">Choose your payment method</p><p className="billing-help">Select an available destination to see its receiving details and exact payment amount.</p></div><span className="billing-base-price">Base price {formatBillingMoney(options.base_amount_usd, "USD")}</span></div>{options.methods.length ? <div className="billing-method-choices" role="radiogroup" aria-label="Payment method">{options.methods.map((method) => <button key={method.id} type="button" role="radio" aria-checked={selectedMethod === method.id} aria-label={`${method.label}, send ${formatBillingMoney(method.expected_amount, method.expected_currency)}`} className={`billing-method-choice ${selectedMethod === method.id ? "is-selected" : ""}`} onClick={() => { setSelectedMethod(method.id); setError(""); setSuccessMessage(""); }}><span>{method.label}</span><small><span>Send</span><strong>{formatBillingMoney(method.expected_amount, method.expected_currency)}</strong></small></button>)}</div> : <div className="billing-empty-methods"><div className="billing-empty-methods-copy"><span className="billing-empty-methods-icon" aria-hidden="true"><LockKeyhole className="h-4 w-4" /></span><div><strong>Payment methods are temporarily unavailable</strong><p>Please check back later. No payment can be submitted until an available destination appears.</p></div></div></div>}{options.unavailable_methods.length > 0 && <div className="billing-unavailable-methods" aria-live="polite">{options.unavailable_methods.map((method) => <span key={method.id}><strong>{method.label}:</strong> {method.reason}</span>)}</div>}</div>
        {selectedOption && <SubscriptionDetails option={selectedOption} cryptoOptionId={cryptoOptionId} onCryptoOptionChange={setCryptoOptionId} />}
        {selectedOption && <form className="billing-submission-form" onSubmit={(event) => void submit(event)}><div className="billing-form-heading"><div><p className="billing-section-kicker">Payment verification</p><h3>Upload your payment proof</h3></div><span className="billing-required-note">Receipt required</span></div><div className="billing-form-grid"><div className="billing-field-group"><Label htmlFor="billing-amount">Amount paid</Label><Input id="billing-amount" type="number" min="0.01" step="0.01" value={claimedAmount} onChange={(event) => setClaimedAmount(event.target.value)} required /><span className="billing-field-help">Expected: {formatBillingMoney(selectedOption.expected_amount, selectedOption.expected_currency)}</span></div><div className="billing-field-group"><Label htmlFor="billing-currency">{selectedOption.id === "CRYPTO" ? "Currency or token" : "Payment currency (fixed)"}</Label><Input id="billing-currency" className={selectedOption.id === "CRYPTO" ? undefined : "billing-currency-fixed"} value={selectedOption.id === "CRYPTO" ? claimedCurrency : selectedOption.expected_currency.trim().toUpperCase()} onChange={selectedOption.id === "CRYPTO" ? (event) => setClaimedCurrency(event.target.value) : undefined} readOnly={selectedOption.id !== "CRYPTO"} aria-readonly={selectedOption.id !== "CRYPTO"} maxLength={12} required /><span className="billing-field-help">{selectedOption.id === "CRYPTO" ? "Use the token ticker shown for your selected destination." : `This bank destination accepts ${selectedOption.expected_currency.trim().toUpperCase()} only.`}</span></div><div className="billing-field-group"><Label htmlFor="billing-date">Payment date and time</Label><Input id="billing-date" type="datetime-local" value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} required /></div><div className="billing-field-group"><Label htmlFor="billing-reference">Transaction / reference ID <span>(optional)</span></Label><Input id="billing-reference" value={transactionReference} onChange={(event) => setTransactionReference(event.target.value)} maxLength={160} placeholder="e.g. bank reference" /></div></div><div className="billing-field-group"><Label htmlFor="billing-note">Note <span>(optional)</span></Label><Textarea id="billing-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} placeholder="Add context that helps with payment review." /></div><div className="billing-receipt-field"><Label htmlFor="billing-receipt">Payment receipt image <span className="billing-label-required">required</span></Label><Input ref={receiptInputRef} id="billing-receipt" type="file" accept="image/jpeg,image/jpg,image/png,image/webp" onChange={(event) => handleReceipt(event.target.files?.[0])} required={!receiptFile} disabled={Boolean(pendingSubmission)} /><span className="billing-field-help">JPG, JPEG, PNG, or WEBP. Your image is protected during payment review.</span>{receiptPreview && <div className="billing-receipt-preview"><img src={receiptPreview} alt="Selected payment receipt preview" /><button type="button" onClick={clearReceipt} disabled={Boolean(pendingSubmission)}>Remove image</button></div>}</div><div className="billing-submit-row"><p><LockKeyhole className="h-3.5 w-3.5" />Receipt evidence is private. It confirms what you submitted, but does not confirm funds arrived.</p><Button type="submit" className="tx-btn-primary" disabled={submitting || Boolean(pendingSubmission)}>{submitting ? <><RefreshCw className="h-4 w-4 animate-spin" />Submitting…</> : pendingSubmission ? "Awaiting verification" : "Submit for verification"}</Button></div></form>}
      </>}
    </div>}
    {!loading && error && !options && <button type="button" className="billing-retry" onClick={() => setRetry((value) => value + 1)}>Try loading payment options again</button>}
  </section>;
}
