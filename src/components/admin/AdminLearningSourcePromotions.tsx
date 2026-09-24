import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, FileCheck2, FileText, LifeBuoy, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { adminLearningAction, isLearningAccessDenied } from "@/lib/admin/learningAccess";
import { formatBillingDate } from "@/lib/billing/manualPayments";
import type { AiLearningAdminActionResponse, AiLearningAction, AiLearningSourceOption, AiLearningSourcesResponse } from "@/lib/learning/types";

type PromotionAction = Extract<AiLearningAction, "create_from_assistant" | "create_from_document_guidance" | "create_from_support_resolution">;
type Props = { refreshToken?: number; onDenied: () => void; onPendingChanged?: () => Promise<void> | void };

function safeText(value: string, max = 1_600): string { return value.trim().replace(/https?:\/\/[^\s"'<>]+/gi, "[link]").slice(0, max); }
function preview(value: string, fallback = "Not recorded"): string { return safeText(value) || fallback; }
function dateLabel(value: string): string { return value ? formatBillingDate(value) : "Not recorded"; }
function targetLabel(value: string): string { return value === "ASSISTANT" ? "Signed-in assistant" : value === "TRANSCRIPT_AND_TRANSLATION" ? "Transcript and translation" : "Protected target"; }
function categoryLabel(value: string): string { return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Other"; }
function kindLabel(value: string): string { return value === "assistant_answer" ? "Assistant answer" : value === "document_guidance" ? "Document guidance" : value === "support_resolution" ? "Support resolution" : value === "repeated_pattern" ? "Repeated pattern" : "Protected source"; }
function DataPoint({ label, value }: { label: string; value: string | number }) { return <div className="admin-data-point"><span>{label}</span><strong>{typeof value === "number" ? value : preview(value)}</strong></div>; }
function Excerpt({ label, detail, text }: { label: string; detail: string; text: string }) { if (!text.trim()) return null; return <div className="admin-detail-card mt-0"><div className="admin-detail-card-heading"><FileText className="h-4 w-4" /><div><strong>{label}</strong><span>{detail}</span></div></div><p className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background/40 p-3 text-xs leading-relaxed text-foreground">{preview(text)}</p></div>; }
function References({ labels }: { labels: string[] }) { const safeLabels = labels.map((label) => safeText(label, 180)).filter(Boolean).slice(0, 8); if (!safeLabels.length) return null; return <div className="admin-detail-card"><div className="admin-detail-card-heading"><FileCheck2 className="h-4 w-4" /><div><strong>Safe source references</strong><span>Page, section, or line labels only</span></div></div><div className="mt-2 flex flex-wrap gap-1.5">{safeLabels.map((label) => <span key={label} className="admin-status admin-status-not-initialized">{label}</span>)}</div></div>; }

function SourceCard({ source, action, busy, onPromote }: { source: AiLearningSourceOption; action: PromotionAction; busy: string; onPromote: (action: PromotionAction, source: AiLearningSourceOption) => void }) {
  const isDocument = action === "create_from_document_guidance";
  const isSupport = action === "create_from_support_resolution";
  const key = `${action}:${source.id}`;
  const heading = isDocument ? preview(source.source_document_name, "Document-grounded answer") : isSupport ? "Resolved support request" : preview(source.source_question_excerpt, "Administrator-selected answer");
  const excerptLabel = isSupport ? "Selected resolution" : isDocument ? "Document-grounded answer" : "Source excerpt";
  const excerptText = isSupport ? source.source_resolution_excerpt : source.source_answer_excerpt;
  return <article className="admin-user-detail">
    <div className="admin-user-detail-head"><div><p className="admin-section-kicker">{kindLabel(source.source_kind)}</p><h4>{heading}</h4><p>Eligible source for promotion · {dateLabel(source.approved_at)}</p></div><div className="flex flex-wrap justify-end gap-2"><span className="admin-status admin-status-premium-active">{targetLabel(source.target_surface)}</span><span className="admin-status admin-status-not-initialized">{categoryLabel(source.category)}</span></div></div>
    <div className="admin-data-grid"><DataPoint label="Source owner" value={source.source_owner_email} /><DataPoint label="Evidence count" value={1} /><DataPoint label="Occurrence count" value={source.occurrence_count || 1} />{isDocument && <DataPoint label="Document" value={source.source_document_name} />}</div>
    <div className="mt-3 grid gap-3 md:grid-cols-2"><Excerpt label="Source question" detail="Bounded administrator review context" text={source.source_question_excerpt} /><Excerpt label={excerptLabel} detail={isSupport ? "Only the administrator-authored summary is eligible" : "Bounded source content, never a full document"} text={excerptText} /></div>
    <References labels={source.source_reference_labels} />
    <div className="mt-3 flex items-center justify-between gap-3"><p className="text-xs leading-relaxed text-muted-foreground">{preview(source.rationale, "Ready for human review before promotion.")}</p><Button type="button" className="admin-primary-button mt-0 shrink-0" onClick={() => onPromote(action, source)} disabled={Boolean(busy)}>{busy === key && <RefreshCw className="h-4 w-4 animate-spin" />}Create pending proposal</Button></div>
  </article>;
}

function PatternCard({ source, selected, disabled, onToggle }: { source: AiLearningSourceOption; selected: boolean; disabled: boolean; onToggle: () => void }) {
  return <label className={`admin-user-detail flex cursor-pointer gap-3 transition-colors ${selected ? "border-[hsl(var(--coral)/0.55)] bg-[hsl(var(--coral)/0.08)]" : ""}`}><input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[hsl(var(--coral))]" checked={selected} disabled={disabled} onChange={onToggle} aria-label={`Select approved ${categoryLabel(source.category)} evidence`} /><span className="min-w-0 flex-1"><span className="flex flex-wrap items-start justify-between gap-2"><span><span className="admin-section-kicker">Approved evidence</span><strong className="mt-1 block text-sm text-foreground">{preview(source.final_rule, "Approved rule")}</strong></span><span className="admin-status admin-status-premium-active">{targetLabel(source.target_surface)}</span></span><span className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4"><DataPoint label="Category" value={categoryLabel(source.category)} /><DataPoint label="Evidence count" value={1} /><DataPoint label="Occurrences" value={source.occurrence_count || 1} /><DataPoint label="Approved" value={dateLabel(source.approved_at)} /></span></span></label>;
}

export function AdminLearningSourcePromotions({ refreshToken = 0, onDenied, onPendingChanged }: Props) {
  const [sources, setSources] = useState<AiLearningSourcesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [selectedPatternIds, setSelectedPatternIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadSources = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const next = await adminLearningAction<AiLearningSourcesResponse>({ action: "list_sources" });
      setSources({ ok: next.ok === true, assistant_answers: Array.isArray(next.assistant_answers) ? next.assistant_answers : [], document_guidance: Array.isArray(next.document_guidance) ? next.document_guidance : [], support_resolutions: Array.isArray(next.support_resolutions) ? next.support_resolutions : [], pattern_items: Array.isArray(next.pattern_items) ? next.pattern_items : [] });
    } catch (requestError) {
      console.error("Could not load administrator learning sources", requestError);
      if (isLearningAccessDenied(requestError)) onDenied(); else setError("Approved learning sources could not be loaded. Try again.");
    } finally { setLoading(false); }
  }, [onDenied]);

  useEffect(() => { void loadSources(); }, [loadSources, refreshToken]);

  const sourceGroups = useMemo(() => [
    { title: "General assistant answers", description: "Select an administrator-reviewed answer that was not grounded in an uploaded document.", items: sources?.assistant_answers || [], action: "create_from_assistant" as PromotionAction, empty: "No eligible general assistant answers are available." },
    { title: "Document-grounded answers", description: "Promote a bounded answer with its safe document name and exact references, never the full file.", items: sources?.document_guidance || [], action: "create_from_document_guidance" as PromotionAction, empty: "No eligible document-grounded answers are available." },
    { title: "Resolved support requests", description: "Only the administrator-authored resolution summary can become a pending assistant proposal.", items: sources?.support_resolutions || [], action: "create_from_support_resolution" as PromotionAction, empty: "No resolved support summaries are available." },
  ], [sources]);

  const promote = async (action: PromotionAction, source: AiLearningSourceOption) => {
    if (busy) return;
    const sourceId = action === "create_from_support_resolution" ? source.source_support_request_id || source.id : source.source_message_id || source.id;
    const payload = action === "create_from_support_resolution" ? { action, support_request_id: sourceId } : { action, message_id: sourceId };
    const key = `${action}:${source.id}`;
    setBusy(key); setError(""); setNotice("");
    try {
      const result = await adminLearningAction<AiLearningAdminActionResponse>(payload);
      setNotice(result.duplicate || result.created === false ? "This source already has a pending or reviewed proposal. Nothing was activated." : "Pending proposal created. It remains inactive until an administrator edits and approves it.");
      setSelectedPatternIds([]);
      await loadSources();
      await onPendingChanged?.();
    } catch (requestError) {
      console.error("Could not promote administrator learning source", requestError);
      if (isLearningAccessDenied(requestError)) onDenied(); else setError(requestError instanceof Error ? safeText(requestError.message, 260) : "The pending proposal could not be created. Nothing was activated.");
    } finally { setBusy(""); }
  };

  const patternItems = sources?.pattern_items || [];
  const selectedPatternItems = patternItems.filter((item) => selectedPatternIds.includes(item.id));
  const firstPattern = selectedPatternItems[0];
  const patternHint = selectedPatternItems.length < 2 ? "Select at least two approved active items." : "The protected service will verify the same owner, private scope, target, category, and session context.";
  const togglePattern = (id: string) => setSelectedPatternIds((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length >= 12 ? current : [...current, id]);
  const createPattern = async () => {
    if (busy || selectedPatternIds.length < 2) return;
    setBusy("pattern"); setError(""); setNotice("");
    try {
      const result = await adminLearningAction<AiLearningAdminActionResponse>({ action: "create_from_pattern", item_ids: selectedPatternIds });
      setNotice(result.duplicate || result.created === false ? "This approved evidence already has a pending or reviewed pattern proposal. Nothing was activated." : "Pending pattern proposal created. It remains inactive until an administrator edits and approves it.");
      setSelectedPatternIds([]); await loadSources(); await onPendingChanged?.();
    } catch (requestError) {
      console.error("Could not create administrator learning pattern", requestError);
      if (isLearningAccessDenied(requestError)) onDenied(); else setError(requestError instanceof Error ? safeText(requestError.message, 260) : "The pending pattern could not be created. Nothing was activated.");
    } finally { setBusy(""); }
  };

  return <section className="mt-8 border-t border-[hsl(var(--line)/0.8)] pt-6" aria-labelledby="admin-learning-sources-heading">
    <div className="admin-section-heading"><div><p className="admin-section-kicker">Explicit administrator action</p><h3 id="admin-learning-sources-heading">Promote approved sources</h3><p>Choose bounded assistant evidence to create a private pending proposal. Source promotion never approves or activates a rule.</p></div><Button type="button" variant="outline" className="admin-header-button" onClick={() => void loadSources()} disabled={loading || Boolean(busy)}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh sources</Button></div>
    <div className="admin-scope-note"><ShieldCheck className="h-4 w-4" /><span><strong>Review remains mandatory.</strong> Every created record is pending and inactive until an administrator edits the wording, saves a final rule, and approves it. Private notes, full documents, URLs, provider identifiers, and support transcripts stay out of these source cards.</span></div>
    {error && <div className="admin-feedback is-error" role="alert"><AlertTriangle className="h-4 w-4" />{error}</div>}
    {notice && <div className="admin-feedback is-success" role="status"><Check className="h-4 w-4" />{notice}</div>}
    {loading && !sources ? <div className="admin-loading"><RefreshCw className="h-4 w-4 animate-spin" />Loading approved learning sources…</div> : !sources ? <div className="admin-empty"><AlertTriangle className="h-5 w-5" /><p>Approved source options are unavailable.</p><span>Use Refresh sources to try the protected service again.</span></div> : <div className="mt-4 grid gap-6">{sourceGroups.map((group) => <div key={group.action}><div className="mb-3"><p className="text-sm font-semibold text-foreground">{group.title}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{group.description}</p></div>{group.items.length ? <div className="grid gap-3">{group.items.map((source) => <SourceCard key={source.id} source={source} action={group.action} busy={busy} onPromote={(action, item) => void promote(action, item)} />)}</div> : <div className="admin-empty"><Sparkles className="h-5 w-5" /><p>{group.empty}</p></div>}</div>)}
      <div><div className="mb-3"><p className="text-sm font-semibold text-foreground">Repeated approved patterns</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Select two or more compatible approved active items. The server synthesizes one bounded candidate and checks owner, scope, target, category, and context again.</p></div>{patternItems.length ? <div className="grid gap-3">{patternItems.map((source) => <PatternCard key={source.id} source={source} selected={selectedPatternIds.includes(source.id)} disabled={Boolean(busy) || (!selectedPatternIds.includes(source.id) && selectedPatternIds.length >= 12)} onToggle={() => togglePattern(source.id)} />)}</div> : <div className="admin-empty"><LifeBuoy className="h-5 w-5" /><p>No approved active evidence is available for a repeated pattern.</p><span>Approve compatible private rules before selecting a repeated pattern.</span></div>}<div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[hsl(var(--line))] bg-[hsl(var(--ink)/0.28)] p-3"><div className="text-xs leading-relaxed text-muted-foreground"><strong className="text-foreground">{selectedPatternItems.length} selected.</strong> {patternHint}{firstPattern && selectedPatternItems.length > 1 && <span className="block mt-1">Starting target: {targetLabel(firstPattern.target_surface)} · category: {categoryLabel(firstPattern.category)}. Full compatibility is checked privately.</span>}</div><Button type="button" className="admin-primary-button mt-0" onClick={() => void createPattern()} disabled={Boolean(busy) || selectedPatternIds.length < 2}>{busy === "pattern" && <RefreshCw className="h-4 w-4 animate-spin" />}Create pending pattern</Button></div></div>
    </div>}
  </section>;
}
