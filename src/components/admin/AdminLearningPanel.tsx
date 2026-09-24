import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Clock3, FileCheck2, FileText, Pencil, RefreshCw, ShieldCheck, Sparkles, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AdminLearningSourcePromotions } from "@/components/admin/AdminLearningSourcePromotions";
import { adminLearningAction, isLearningAccessDenied } from "@/lib/admin/learningAccess";
import { formatBillingDate } from "@/lib/billing/manualPayments";
import type { AiLearningAdminResponse, AiLearningCategory, AiLearningItemRecord } from "@/lib/learning/types";

const MAX_RULE_LENGTH = 1200;
const MAX_NOTE_LENGTH = 2000;
const CATEGORY_OPTIONS: { value: AiLearningCategory; label: string }[] = [
  { value: "transcription_style", label: "Transcription style" },
  { value: "wording", label: "Wording" },
  { value: "terminology", label: "Terminology" },
  { value: "punctuation", label: "Punctuation" },
  { value: "assistant_guidance", label: "Assistant guidance" },
  { value: "document_guidance", label: "Document guidance" },
  { value: "support_resolution", label: "Support resolution" },
  { value: "repeated_pattern", label: "Repeated pattern" },
  { value: "other", label: "Other" },
];

type LearningDraft = { proposedRule: string; finalRule: string; category: AiLearningCategory; note: string };
type AdminLearningPanelProps = { refreshToken?: number; onDenied: () => void };

function safeDisplay(value: string, max = 1600): string { return value.trim().replace(/https?:\/\/[^\s"'<>]+/gi, "[link]").slice(0, max); }
function valueOrFallback(value: string, fallback = "Not recorded"): string { return safeDisplay(value) || fallback; }
function dateLabel(value: string): string { return value ? formatBillingDate(value) : "Not recorded"; }
function categoryLabel(category: AiLearningCategory | string): string { return CATEGORY_OPTIONS.find((option) => option.value === category)?.label || category.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Other"; }
function sourceKindLabel(kind: string): string { return kind === "transcript_correction" ? "Transcript evidence" : kind === "assistant_answer" ? "Assistant answer" : kind === "document_guidance" ? "Document guidance" : kind === "support_resolution" ? "Support resolution" : kind === "repeated_pattern" ? "Repeated pattern" : "Protected source"; }
function targetLabel(target: string): string { return target === "ASSISTANT" ? "Signed-in assistant" : target === "TRANSCRIPT_AND_TRANSLATION" ? "Transcript and translation" : "Protected target"; }
function draftFor(item: AiLearningItemRecord): LearningDraft { return { proposedRule: item.proposed_rule, finalRule: item.final_rule, category: item.category, note: item.note }; }
function Metric({ label, value, tone }: { label: string; value: number | string; tone: string }) { return <div className={`admin-metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>Protected learning records</small></div>; }
function DataPoint({ label, value }: { label: string; value: string | number }) { return <div className="admin-data-point"><span>{label}</span><strong>{typeof value === "number" ? value : valueOrFallback(value)}</strong></div>; }
function EvidenceText({ label, detail, text }: { label: string; detail: string; text: string }) { if (!text.trim()) return null; return <div className="admin-detail-card mt-0"><div className="admin-detail-card-heading"><FileText className="h-4 w-4" /><div><strong>{label}</strong><span>{detail}</span></div></div><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background/40 p-3 text-xs leading-relaxed text-foreground">{valueOrFallback(text)}</pre></div>; }
function ReferenceLabels({ labels }: { labels: string[] }) { const safeLabels = labels.map((label) => safeDisplay(label, 180)).filter(Boolean).slice(0, 8); if (!safeLabels.length) return null; return <div className="admin-detail-card"><div className="admin-detail-card-heading"><FileCheck2 className="h-4 w-4" /><div><strong>Source references</strong><span>Safe page, section, or line labels returned by the protected service</span></div></div><div className="mt-2 flex flex-wrap gap-1.5">{safeLabels.map((label, index) => <span key={`${label}-${index}`} className="admin-status admin-status-not-initialized">{label}</span>)}</div></div>; }
function PendingSourceEvidence({ item }: { item: AiLearningItemRecord }) {
  if (item.source_kind === "transcript_correction") return <div className="mt-3 grid gap-3 md:grid-cols-2"><EvidenceText label="Original transcript snapshot" detail="Bounded transcript evidence" text={item.original_text_snapshot} /><EvidenceText label="Human correction" detail="Bounded transcript evidence" text={item.corrected_text_snapshot} /></div>;
  return <div className="mt-3 grid gap-3 md:grid-cols-2"><EvidenceText label="Source question" detail="Bounded administrator review context" text={item.source_question_excerpt} /><EvidenceText label={item.source_kind === "support_resolution" ? "Selected resolution" : item.source_kind === "document_guidance" ? "Document-grounded answer" : item.source_kind === "repeated_pattern" ? "Approved evidence" : "Source excerpt"} detail={item.source_kind === "support_resolution" ? "Administrator-authored summary only" : "Bounded source excerpt, never a full document"} text={item.source_resolution_excerpt || item.source_answer_excerpt || item.proposed_rule} /></div>;
}

export function AdminLearningPanel({ refreshToken = 0, onDenied }: AdminLearningPanelProps) {
  const [response, setResponse] = useState<AiLearningAdminResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState<LearningDraft | null>(null);
  const [error, setError] = useState("");
  const [pendingError, setPendingError] = useState("");
  const [notice, setNotice] = useState("");
  const pendingReviewRef = useRef<HTMLElement | null>(null);
  const focusAfterPromotionRef = useRef(false);

  const loadPending = useCallback(async () => {
    setLoading(true);
    setPendingError("");
    try {
      setResponse(await adminLearningAction<AiLearningAdminResponse>({ action: "list_pending" }));
    } catch (requestError) {
      console.error("Could not load administrator learning review", requestError);
      setResponse(null);
      if (isLearningAccessDenied(requestError)) onDenied();
      else setPendingError("The private learning review could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }, [onDenied]);

  useEffect(() => { void loadPending(); }, [loadPending, refreshToken]);

  const focusPendingReview = useCallback(() => {
    const section = pendingReviewRef.current;
    if (!section) return;
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    section.focus({ preventScroll: true });
  }, []);
  const refreshPendingAfterPromotion = useCallback(async () => {
    focusAfterPromotionRef.current = true;
    await loadPending();
  }, [loadPending]);

  useEffect(() => {
    if (loading || !focusAfterPromotionRef.current) return;
    focusAfterPromotionRef.current = false;
    window.requestAnimationFrame(() => focusPendingReview());
  }, [focusPendingReview, loading, response]);

  const startEdit = (item: AiLearningItemRecord) => { setEditingId(item.id); setDraft(draftFor(item)); setError(""); setNotice(""); };
  const cancelEdit = () => { setEditingId(""); setDraft(null); };
  const updateDraft = (patch: Partial<LearningDraft>) => setDraft((current) => current ? { ...current, ...patch } : current);

  const saveEdit = async (item: AiLearningItemRecord) => {
    if (!draft || busy) return;
    const proposedRule = draft.proposedRule.trim();
    if (!proposedRule) { setError("Add a proposed rule before saving this pending edit."); return; }
    setBusy(`edit:${item.id}`); setError(""); setNotice("");
    try {
      await adminLearningAction({ action: "edit_pending", item_id: item.id, proposed_rule: proposedRule.slice(0, MAX_RULE_LENGTH), final_rule: draft.finalRule.trim().slice(0, MAX_RULE_LENGTH), category: draft.category, note: draft.note.trim().slice(0, MAX_NOTE_LENGTH) });
      setNotice("Pending item updated. It remains inactive until an administrator approves it."); cancelEdit(); await loadPending();
    } catch (requestError) { console.error("Could not edit pending learning item", requestError); if (isLearningAccessDenied(requestError)) onDenied(); else setError("The pending learning item could not be saved. Nothing was changed."); }
    finally { setBusy(""); }
  };

  const decide = async (item: AiLearningItemRecord, action: "approve" | "reject") => {
    if (busy) return;
    if (action === "approve" && !item.final_rule.trim()) { setError("Add and save a final rule before approving this item."); return; }
    const reviewNote = editingId === item.id && draft ? draft.note : item.note;
    const payload = action === "reject" && reviewNote.trim() ? { action, item_id: item.id, note: reviewNote.trim().slice(0, MAX_NOTE_LENGTH) } : { action, item_id: item.id };
    setBusy(`${action}:${item.id}`); setError(""); setNotice("");
    try { await adminLearningAction(payload); setNotice(action === "approve" ? "Learning rule approved for the private project scope." : "Learning item rejected and kept out of approved knowledge."); cancelEdit(); await loadPending(); }
    catch (requestError) { console.error(`Could not ${action} pending learning item`, requestError); if (isLearningAccessDenied(requestError)) onDenied(); else setError(`The learning item could not be ${action === "approve" ? "approved" : "rejected"}. Nothing was changed.`); }
    finally { setBusy(""); }
  };

  const items = response?.items;
  return <section className="admin-users-panel" aria-labelledby="admin-learning-heading">
    <div className="admin-section-heading"><div><p className="admin-section-kicker">Human approval gate</p><h3 id="admin-learning-heading">AI learning review</h3><p>Review correction candidates before they can influence future sessions. Every approved rule stays limited to its private project scope.</p></div><Button type="button" variant="outline" className="admin-header-button" onClick={() => void loadPending()} disabled={loading || Boolean(busy)}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button></div>
    <div className="admin-scope-note"><ShieldCheck className="h-4 w-4" /><span><strong>Private project scope.</strong> Pending and rejected items never enter approved AI knowledge. This review surface does not grant organization or global access.</span></div>
    <div className="admin-metric-grid"><Metric label="Pending review" value={response?.counts.pending ?? "—"} tone="is-amber" /><Metric label="Approved rules" value={response?.counts.approved ?? "—"} tone="is-mint" /><Metric label="Rejected items" value={response?.counts.rejected ?? "—"} tone="is-coral" /></div>
    {error && <div className="admin-feedback is-error" role="alert"><AlertTriangle className="h-4 w-4" />{error}</div>}
    {notice && <div className="admin-feedback is-success" role="status"><Check className="h-4 w-4" />{notice}</div>}

    <section ref={pendingReviewRef} id="admin-pending-review" tabIndex={-1} className="mt-6 scroll-mt-6 outline-none" aria-labelledby="admin-pending-review-heading">
      <div className="admin-section-heading"><div><p className="admin-section-kicker">Review queue</p><h3 id="admin-pending-review-heading">Pending review</h3><p>Review each proposal before it can influence the private project. Edit and decision actions stay with the pending item.</p></div><Button type="button" variant="outline" className="admin-header-button" onClick={() => void loadPending()} disabled={loading || Boolean(busy)}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh pending</Button></div>
      {pendingError && <div className="admin-feedback is-error" role="alert"><AlertTriangle className="h-4 w-4" />{pendingError}</div>}
      {loading && !response ? <div className="admin-loading"><RefreshCw className="h-4 w-4 animate-spin" />Loading pending learning items…</div> : !response ? <div className="admin-empty"><XCircle className="h-5 w-5" /><p>Pending learning items are unavailable.</p><span>Use Refresh pending above to try the protected review again.</span><Button type="button" variant="outline" className="admin-header-button mt-2" onClick={() => void loadPending()} disabled={loading || Boolean(busy)}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh pending items</Button></div> : !items?.length ? <div className="admin-empty"><Sparkles className="h-5 w-5" /><p>There is nothing to approve or edit right now.</p><span>Pending proposals appear here after a real learning source is promoted or a meaningful correction is submitted. When one loads, its Edit pending rule, Approve, and Reject actions appear beside it.</span></div> : <div className="mt-4 grid gap-4">{items.map((item) => {
        const isEditing = editingId === item.id && Boolean(draft); const itemBusy = busy.endsWith(`:${item.id}`); const evidenceCount = item.evidence_item_ids.length || (item.source_kind === "repeated_pattern" ? 0 : 1);
        return <article className="admin-user-detail" key={item.id}><div className="admin-user-detail-head"><div><p className="admin-section-kicker">{sourceKindLabel(item.source_kind)}</p><h4>Pending learning item</h4><p><Clock3 className="h-3.5 w-3.5" />Submitted {dateLabel(item.submitted_at)}</p></div><div className="flex flex-wrap items-center justify-end gap-2"><span className="admin-status admin-status-payment-pending">Pending admin review</span><span className="admin-status admin-status-premium-active">{targetLabel(item.target_surface)}</span></div></div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[hsl(var(--line))] bg-[hsl(var(--ink)/0.28)] p-3" aria-label="Pending learning actions"><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" className="admin-header-button" onClick={() => startEdit(item)} disabled={Boolean(busy) || loading}><Pencil className="h-4 w-4" />Edit pending rule</Button><Button type="button" className="admin-primary-button" onClick={() => void decide(item, "approve")} disabled={Boolean(busy) || loading || !item.final_rule.trim()}>{itemBusy && busy.startsWith("approve:") && <RefreshCw className="h-4 w-4 animate-spin" />}<Check className="h-4 w-4" />Approve</Button><Button type="button" className="admin-danger-button" onClick={() => void decide(item, "reject")} disabled={Boolean(busy) || loading}>{itemBusy && busy.startsWith("reject:") && <RefreshCw className="h-4 w-4 animate-spin" />}<XCircle className="h-4 w-4" />Reject</Button></div>{!item.final_rule.trim() && <span className="text-xs text-muted-foreground">Save a final rule before approval.</span>}</div>
          <PendingSourceEvidence item={item} />
          {item.source_document_name && <DataPoint label="Source document" value={item.source_document_name} />}
          {Array.isArray(item.source_reference_labels) && <ReferenceLabels labels={item.source_reference_labels} />}
          <div className="admin-detail-card"><div className="admin-detail-card-heading"><Sparkles className="h-4 w-4" /><div><strong>Proposed learned rule</strong><span>{categoryLabel(item.category)} · Inactive until approved</span></div></div><p className="mt-2 rounded-lg border border-border bg-background/40 p-3 text-xs leading-relaxed text-foreground">{valueOrFallback(item.proposed_rule)}</p>{item.final_rule && <p className="admin-detail-muted"><strong>Saved final rule:</strong> {valueOrFallback(item.final_rule)}</p>}</div>
          <div className="admin-data-grid"><DataPoint label="Source owner" value={item.source_owner_email} /><DataPoint label="Source kind" value={sourceKindLabel(item.source_kind)} /><DataPoint label="Target surface" value={targetLabel(item.target_surface)} /><DataPoint label="Evidence count" value={evidenceCount} /><DataPoint label="Occurrence count" value={item.occurrence_count || 1} /><DataPoint label="Project scope" value="Private project scope" /><DataPoint label="Review mode" value={item.review_mode} /><DataPoint label="Session mode" value={item.session_mode} /><DataPoint label="Transcript style" value={item.transcript_style} /><DataPoint label="Source language" value={item.source_language} /><DataPoint label="Target language" value={item.target_language} /><DataPoint label="Category" value={categoryLabel(item.category)} /></div>
          <div className="admin-detail-card"><div className="admin-detail-card-heading"><FileText className="h-4 w-4" /><div><strong>Why this was suggested</strong><span>The explanation is supplied with the bounded review item.</span></div></div><p className="admin-detail-muted">{valueOrFallback(item.rationale)}</p></div>
          {isEditing && draft && <form className="admin-detail-card" onSubmit={(event) => { event.preventDefault(); void saveEdit(item); }}><div className="admin-detail-card-heading"><Pencil className="h-4 w-4" /><div><strong>Edit pending rule</strong><span>Saving keeps this item pending and inactive.</span></div></div><div className="mt-3 grid gap-3"><label className="grid gap-1.5 text-xs text-muted-foreground" htmlFor={`proposed-rule-${item.id}`}>Proposed rule<Textarea id={`proposed-rule-${item.id}`} value={draft.proposedRule} onChange={(event) => updateDraft({ proposedRule: event.target.value })} maxLength={MAX_RULE_LENGTH} /></label><label className="grid gap-1.5 text-xs text-muted-foreground" htmlFor={`final-rule-${item.id}`}>Final rule for approval<Textarea id={`final-rule-${item.id}`} value={draft.finalRule} onChange={(event) => updateDraft({ finalRule: event.target.value })} maxLength={MAX_RULE_LENGTH} placeholder="Write the approved wording or leave it empty while reviewing" /></label><label className="grid gap-1.5 text-xs text-muted-foreground" htmlFor={`category-${item.id}`}>Category<select id={`category-${item.id}`} className="min-h-10 rounded-md border border-border bg-background/40 px-3 text-xs text-foreground" value={draft.category} onChange={(event) => updateDraft({ category: event.target.value as AiLearningCategory })}>{CATEGORY_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label className="grid gap-1.5 text-xs text-muted-foreground" htmlFor={`note-${item.id}`}>Private admin note<span className="text-[11px] text-muted-foreground">Optional, visible only in the protected review.</span><Textarea id={`note-${item.id}`} value={draft.note} onChange={(event) => updateDraft({ note: event.target.value })} maxLength={MAX_NOTE_LENGTH} /></label></div><div className="mt-3 flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" className="admin-header-button" onClick={cancelEdit} disabled={Boolean(busy)}>Cancel</Button><Button type="submit" className="admin-primary-button" disabled={Boolean(busy)}>{busy === `edit:${item.id}` && <RefreshCw className="h-4 w-4 animate-spin" />}Save pending edit</Button></div></form>}
        </article>;
      })}</div>}
    </section>

    <AdminLearningSourcePromotions refreshToken={refreshToken} onDenied={onDenied} onPendingChanged={refreshPendingAfterPromotion} />
  </section>;
}
