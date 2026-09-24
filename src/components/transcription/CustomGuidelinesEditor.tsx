import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { AlertTriangle, CheckCircle2, FileText, FileUp, LoaderCircle, LockKeyhole, RefreshCw, Save, Trash2, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { processCustomGuidelineFile } from "@/functions";
import { uploadFile } from "@/integrations/core";
import { auditCustomGuidelineConflicts, classifyCustomGuidelineFile, customGuidelineStatusLabel, isCustomGuidelineReady, MAX_CUSTOM_GUIDELINE_FILE_BYTES, mergeCustomGuidelineSources, normalizeCustomGuidelineText, processCustomGuideline, processCustomGuidelineSources, safeCustomGuidelineName, sanitizeCustomGuidelineSource, sanitizeCustomGuidelineSources } from "@/lib/transcription/custom-guidelines";
import type { CustomGuidelineConflict, CustomGuidelineProcessingResult } from "@/lib/transcription/custom-guidelines";
import type { CustomGuidelineSource, CustomGuidelineSourceRecord, TranscriptionSessionRecord } from "@/lib/transcription/types";

interface CustomGuidelinesEditorProps {
  session: TranscriptionSessionRecord;
  saving: boolean;
  onChange: (patch: Partial<TranscriptionSessionRecord>) => void | Promise<boolean | void>;
}
type EditorSource = CustomGuidelineSourceRecord & { id: string; processing?: boolean };

let sourceSequence = 0;
const nextSourceId = () => `guideline-source-${Date.now()}-${sourceSequence++}`;

function statusIcon(status: CustomGuidelineProcessingResult["status"], processing = false) {
  if (processing) return <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />;
  if (status === "ready") return <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />;
  if (status === "empty") return <FileText className="h-3.5 w-3.5" aria-hidden="true" />;
  return <XCircle className="h-3.5 w-3.5" aria-hidden="true" />;
}

function categoryLabel(category: CustomGuidelineSource): string {
  if (category === "text") return "Direct prompt";
  if (["txt", "md", "csv", "json", "yaml", "xml", "log", "srt", "vtt"].includes(category)) return "Plain text";
  if (category === "doc" || category === "docx") return category.toUpperCase();
  if (category === "pdf") return "PDF";
  if (category === "zip") return "ZIP archive";
  return "Image / OCR";
}

function responseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { return responseObject(JSON.parse(value)); } catch { return {}; } }
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return record.result !== undefined ? responseObject(record.result) : record;
}

function safeErrorMessage(value: unknown, fallback = "The guideline file could not be processed."): string {
  const collect = (candidate: unknown, depth: number): string => {
    if (depth > 5) return "";
    if (candidate instanceof Error) return candidate.message;
    if (typeof candidate === "string") return candidate;
    if (!candidate || typeof candidate !== "object") return "";
    const record = candidate as Record<string, unknown>;
    for (const key of ["error", "message", "details", "reason", "response", "data", "result"]) {
      const found = collect(record[key], depth + 1);
      if (found) return found;
    }
    return "";
  };
  const text = collect(value, 0)
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[private link]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[credential redacted]")
    .replace(/\b(?:api[_ -]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1: [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 520);
  return text || fallback;
}

function checkedSource(record: CustomGuidelineSourceRecord): CustomGuidelineSourceRecord {
  const text = normalizeCustomGuidelineText(record.text);
  if (!text || record.status !== "ready") return { ...record, text, character_count: text.length, message: record.message || (text ? "This source needs attention before it can be combined." : "No readable guideline text was found in this source.") };
  const checked = processCustomGuideline(text, record.category);
  return { ...record, text, status: checked.status, message: checked.status === "ready" ? "" : checked.message, character_count: text.length };
}

function failureSource(name: string, category: CustomGuidelineSource, messageText: string): CustomGuidelineSourceRecord {
  return { name: safeCustomGuidelineName(name), category, text: "", status: "unsupported", message: safeErrorMessage(messageText), character_count: 0 };
}

function hydrateSession(session: TranscriptionSessionRecord) {
  const persisted = sanitizeCustomGuidelineSources(session.custom_guideline_sources);
  if (persisted.length) {
    const direct = persisted.find((item) => item.category === "text");
    return { directPrompt: direct?.text || "", directLabel: direct?.name || "Pasted or typed guidelines", sources: persisted.filter((item) => item !== direct).map((item) => ({ ...item, id: nextSourceId() })) };
  }
  return { directPrompt: session.custom_guideline_text || "", directLabel: session.custom_guideline_source_label || "Saved guideline", sources: [] as EditorSource[] };
}

function editorSourceRecord(source: EditorSource): CustomGuidelineSourceRecord {
  const { id: _id, processing: _processing, ...record } = source;
  return record;
}

function editorSourceRecords(sources: EditorSource[]): CustomGuidelineSourceRecord[] {
  return sources.map(editorSourceRecord);
}

function buildGuidelineRecords(directPrompt: string, directLabel: string, sourceRecords: CustomGuidelineSourceRecord[]): CustomGuidelineSourceRecord[] {
  const directText = normalizeCustomGuidelineText(directPrompt);
  const direct = directText
    ? checkedSource({ name: safeCustomGuidelineName(directLabel, "Pasted or typed guidelines"), category: "text", text: directText, status: "ready", message: "", character_count: directText.length })
    : null;
  return direct ? [direct, ...sourceRecords] : sourceRecords;
}

function extractedReviewText(records: CustomGuidelineSourceRecord[]): string {
  return mergeCustomGuidelineSources(records);
}

function sourceReviewBlock(source: CustomGuidelineSourceRecord): string {
  const name = safeCustomGuidelineName(source.name);
  return `--- Source: ${name} ---\n${normalizeCustomGuidelineText(source.text)}\n--- End source: ${name} ---`;
}

function replaceReviewFragment(value: string, target: string, replacement: string): string | null {
  if (!target) return null;
  const index = value.indexOf(target);
  return index < 0 ? null : `${value.slice(0, index)}${replacement}${value.slice(index + target.length)}`;
}

type ReviewSourceChange = { before: CustomGuidelineSourceRecord; after: CustomGuidelineSourceRecord[] };
type ReviewSync = { text: string; edited: boolean; refreshed: boolean };

function syncReviewAfterSourceChanges(reviewText: string, reviewEdited: boolean, previousRecords: CustomGuidelineSourceRecord[], nextRecords: CustomGuidelineSourceRecord[], changes: ReviewSourceChange[]): ReviewSync {
  const refreshedText = extractedReviewText(nextRecords);
  const previousText = extractedReviewText(previousRecords);
  if (!reviewEdited || normalizeCustomGuidelineText(reviewText) === normalizeCustomGuidelineText(previousText)) return { text: refreshedText, edited: false, refreshed: false };
  let nextText = reviewText;
  for (const change of changes) {
    if (!normalizeCustomGuidelineText(change.before.text)) continue;
    const replacements = change.after.filter((record) => normalizeCustomGuidelineText(record.text));
    const replacementBlocks = replacements.map(sourceReviewBlock).join("\n\n");
    let updated = replaceReviewFragment(nextText, sourceReviewBlock(change.before), replacementBlocks);
    if (updated === null) {
      const replacement = replacements.length === 1 ? normalizeCustomGuidelineText(replacements[0].text) : replacementBlocks;
      updated = replaceReviewFragment(nextText, normalizeCustomGuidelineText(change.before.text), replacement);
    }
    if (updated === null) return { text: refreshedText, edited: false, refreshed: true };
    nextText = updated;
  }
  return { text: normalizeCustomGuidelineText(nextText), edited: true, refreshed: false };
}

function appendAddedSourceReview(reviewText: string, reviewEdited: boolean, previousRecords: CustomGuidelineSourceRecord[], nextRecords: CustomGuidelineSourceRecord[], additions: CustomGuidelineSourceRecord[]): ReviewSync {
  const extracted = additions.filter((record) => normalizeCustomGuidelineText(record.text));
  const refreshedText = extractedReviewText(nextRecords);
  if (!extracted.length) return reviewEdited ? { text: reviewText, edited: true, refreshed: false } : { text: refreshedText, edited: false, refreshed: false };
  const previousText = extractedReviewText(previousRecords);
  if (!reviewEdited || normalizeCustomGuidelineText(reviewText) === normalizeCustomGuidelineText(previousText)) return { text: refreshedText, edited: false, refreshed: false };
  const additionText = extracted.map(sourceReviewBlock).join("\n\n");
  const base = normalizeCustomGuidelineText(reviewText);
  return { text: base ? `${base}\n\n${additionText}` : additionText, edited: true, refreshed: false };
}

export function CustomGuidelinesEditor({ session, saving, onChange }: CustomGuidelinesEditorProps) {
  const initial = useMemo(() => hydrateSession(session), [session.id]);
  const [directPrompt, setDirectPrompt] = useState(initial.directPrompt);
  const [directLabel, setDirectLabel] = useState(initial.directLabel);
  const [sources, setSources] = useState<EditorSource[]>(initial.sources);
  const [reviewText, setReviewText] = useState(session.custom_guideline_text || initial.directPrompt);
  const [reviewEdited, setReviewEdited] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [auditIssue, setAuditIssue] = useState<CustomGuidelineProcessingResult | null>(null);
  const [notice, setNotice] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const replaceSourceId = useRef<string | null>(null);
  const locked = Boolean(session.custom_guideline_locked_at) || session.status === "recording";
  const savedText = session.custom_guideline_text || "";
  const savedReady = isCustomGuidelineReady(session.custom_guideline_status, savedText);

  useEffect(() => {
    if (dirty || processing) return;
    const next = hydrateSession(session);
    setDirectPrompt(next.directPrompt);
    setDirectLabel(next.directLabel);
    setSources(next.sources);
    setReviewText(session.custom_guideline_text || next.directPrompt);
    setReviewEdited(false);
    setAuditIssue(null);
  }, [dirty, processing, session.custom_guideline_message, session.custom_guideline_saved_at, session.custom_guideline_source_label, session.custom_guideline_sources, session.custom_guideline_status, session.custom_guideline_text]);

  const records = useMemo<CustomGuidelineSourceRecord[]>(() => buildGuidelineRecords(directPrompt, directLabel, editorSourceRecords(sources)), [directLabel, directPrompt, sources]);
  const preview = useMemo(() => processCustomGuidelineSources(records), [records]);
  const reviewed = useMemo(() => processCustomGuideline(reviewText, "text"), [reviewText]);
  const reviewIsAuthority = useMemo(() => {
    if (reviewEdited) return true;
    if (dirty || !savedText) return false;
    const saved = normalizeCustomGuidelineText(savedText);
    const review = normalizeCustomGuidelineText(reviewText);
    const sourcePreview = normalizeCustomGuidelineText(preview.text);
    return Boolean(saved && review && review === saved && review !== sourcePreview);
  }, [dirty, preview.text, reviewEdited, reviewText, savedText]);
  const effective = useMemo(() => reviewIsAuthority ? reviewed : preview, [preview, reviewed, reviewIsAuthority]);
  const reviewAuditRecord = useMemo<CustomGuidelineSourceRecord>(() => ({
    name: "Extracted Guidelines — Review/Edit",
    category: "text",
    text: reviewed.text,
    status: reviewed.status,
    message: reviewed.message,
    character_count: reviewed.character_count,
  }), [reviewed]);
  const auditRecords = reviewIsAuthority ? [reviewAuditRecord] : records;
  const display = dirty ? (auditIssue || effective) : { status: session.custom_guideline_status || "empty", text: savedText, message: session.custom_guideline_message || (savedReady ? "Guidelines are ready for this session." : ""), character_count: savedText.length } as CustomGuidelineProcessingResult;
  const displayConflicts = display.conflicts || [];
  const saveDisabled = locked || saving || processing || effective.status !== "ready" || Boolean(effective.block_save) || Boolean(auditIssue?.block_save);
  const sourceCharacterCount = records.reduce((total, item) => total + item.character_count, 0);

  useEffect(() => {
    if (!dirty || processing || reviewEdited) return;
    setReviewText(extractedReviewText(records));
  }, [dirty, processing, records, reviewEdited]);

  const markDirty = () => { setDirty(true); setAuditIssue(null); setNotice(""); };
  const syncDirectPromptChange = (value: string, nextLabel: string) => {
    const previousRecords = records;
    const nextRecords = buildGuidelineRecords(value, nextLabel, editorSourceRecords(sources));
    const activeReviewEdited = reviewEdited || reviewIsAuthority;
    const previousDirect = normalizeCustomGuidelineText(directPrompt)
      ? previousRecords.find((record) => record.category === "text") || null
      : null;
    const nextDirect = normalizeCustomGuidelineText(value)
      ? nextRecords.find((record) => record.category === "text") || null
      : null;
    const reviewSync = previousDirect
      ? syncReviewAfterSourceChanges(reviewText, activeReviewEdited, previousRecords, nextRecords, [{ before: previousDirect, after: nextDirect ? [nextDirect] : [] }])
      : nextDirect
        ? appendAddedSourceReview(reviewText, activeReviewEdited, previousRecords, nextRecords, [nextDirect])
        : syncReviewAfterSourceChanges(reviewText, activeReviewEdited, previousRecords, nextRecords, []);
    markDirty();
    setDirectPrompt(value);
    setDirectLabel(nextLabel);
    setReviewText(reviewSync.text);
    setReviewEdited(reviewSync.edited);
    if (reviewSync.refreshed) setNotice("The review text was refreshed from the current sources. Check it before saving.");
  };
  const updatePrompt = (value: string) => {
    const nextLabel = value === savedText && session.custom_guideline_source_label ? session.custom_guideline_source_label : "Pasted or typed guidelines";
    syncDirectPromptChange(value, nextLabel);
  };
  const updateReview = (value: string) => { setReviewText(value); setReviewEdited(true); markDirty(); };

  const readFile = async (file: File): Promise<CustomGuidelineSourceRecord[]> => {
    const info = classifyCustomGuidelineFile(file);
    const category = info.source || "text";
    if (!info.supported) return [failureSource(file.name, category, info.reason || "This file type is not supported.")];
    if (file.size > MAX_CUSTOM_GUIDELINE_FILE_BYTES) return [failureSource(file.name, category, "This file is larger than 10 MB. Choose a smaller guideline file.")];
    const serverReadable = category === "doc" || category === "docx" || category === "zip" || category === "pdf" || category === "image" || ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"].includes(category);
    if (serverReadable) {
      const uploaded = await uploadFile({ file });
      if (!uploaded.file_url) throw new Error("The upload could not be prepared for reading.");
      const raw = await processCustomGuidelineFile({ file_url: uploaded.file_url, original_name: file.name, mime_type: file.type, session_id: session.id });
      const payload = responseObject(raw);
      if (!Array.isArray(payload.sources)) throw new Error(safeErrorMessage(payload.error || raw, `The ${category.toUpperCase()} file could not be read.`));
      return payload.sources.map((item, index) => checkedSource(sanitizeCustomGuidelineSource(item) || failureSource(`${file.name} entry ${index + 1}`, category, "This source result was invalid and could not be included.")));
    }
    if (["txt", "md", "csv", "json", "yaml", "xml", "log", "srt", "vtt"].includes(category)) {
      return [checkedSource({ name: safeCustomGuidelineName(file.name), category, text: await file.text(), status: "ready", message: "", character_count: 0 })];
    }
    return [failureSource(file.name, category, "This supported file could not be identified for reading. Check its extension or paste the instructions directly.")];
  };

  const handleFiles = async (selected: File[], replacingId: string | null = null) => {
    if (locked || !selected.length) return;
    const replacementIndex = replacingId ? sources.findIndex((item) => item.id === replacingId) : -1;
    const actualReplacingId = replacementIndex >= 0 ? replacingId : null;
    const files = actualReplacingId ? selected.slice(0, 1) : selected;
    const pending = files.map((file) => ({ id: actualReplacingId || nextSourceId(), name: safeCustomGuidelineName(file.name), category: classifyCustomGuidelineFile(file).source || "text", text: "", status: "empty" as const, message: "Reading this source…", character_count: 0, processing: true }));
    const previousRecords = records;
    const previousSourceRecords = editorSourceRecords(sources);
    const replacedRecord = replacementIndex >= 0 ? previousSourceRecords[replacementIndex] : null;
    markDirty();
    setProcessing(true);
    setSources((current) => actualReplacingId ? current.map((item) => item.id === actualReplacingId ? pending[0] : item) : [...current, ...pending]);
    const resolvedRecords: CustomGuidelineSourceRecord[] = [];
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const pendingId = pending[index].id;
        let next: CustomGuidelineSourceRecord[];
        try { next = await readFile(file); }
        catch (error) { next = [failureSource(file.name, pending[index].category, safeErrorMessage(error))]; }
        if (!next.length) next = [failureSource(file.name, pending[index].category, "No readable guideline text was returned from this file.")];
        resolvedRecords.push(...next);
        setSources((current) => current.flatMap((item) => item.id === pendingId ? next.map((record) => ({ ...record, id: nextSourceId() })) : item));
      }
      const nextSourceRecords = actualReplacingId && replacementIndex >= 0
        ? previousSourceRecords.flatMap((record, index) => index === replacementIndex ? resolvedRecords : [record])
        : [...previousSourceRecords, ...resolvedRecords];
      const nextRecords = buildGuidelineRecords(directPrompt, directLabel, nextSourceRecords);
      const reviewSync = actualReplacingId && replacedRecord
        ? syncReviewAfterSourceChanges(reviewText, reviewEdited || reviewIsAuthority, previousRecords, nextRecords, [{ before: replacedRecord, after: resolvedRecords }])
        : appendAddedSourceReview(reviewText, reviewEdited || reviewIsAuthority, previousRecords, nextRecords, resolvedRecords);
      setReviewText(reviewSync.text);
      setReviewEdited(reviewSync.edited);
      const allReady = resolvedRecords.length > 0 && resolvedRecords.every((record) => record.status === "ready" && Boolean(normalizeCustomGuidelineText(record.text)));
      const outcome = allReady
        ? `${files.length === 1 ? files[0].name : `${files.length} guideline files`} loaded successfully.`
        : "Some guideline sources need attention. Review the specific source message(s), then save.";
      const reviewNotice = reviewSync.refreshed ? " The review text was refreshed from the current sources. Check it before saving." : " Review the extracted instructions, then save.";
      setNotice(`${outcome}${reviewNotice}`);
    } catch (error) {
      console.error("Could not process custom guideline files", error);
      const message = safeErrorMessage(error, "The guideline files could not be processed. Try again.");
      setSources((current) => current.map((item) => pending.some((candidate) => candidate.id === item.id)
        ? { ...item, processing: false, status: "unsupported", text: "", character_count: 0, message }
        : item));
      setNotice(message);
    } finally {
      setProcessing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const chooseFiles = (sourceId: string | null = null) => { if (locked || processing) return; replaceSourceId.current = sourceId; fileInputRef.current?.click(); };
  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = "";
    const replacement = replaceSourceId.current;
    replaceSourceId.current = null;
    void handleFiles(selected, replacement).catch((error) => {
      console.error("Could not start custom guideline processing", error);
      setProcessing(false);
      setNotice(safeErrorMessage(error, "The guideline files could not be processed. Try again."));
    });
  };
  const removeSource = (id: string) => {
    if (locked || processing) return;
    const sourceIndex = sources.findIndex((item) => item.id === id);
    if (sourceIndex < 0) return;
    const previousRecords = records;
    const previousSourceRecords = editorSourceRecords(sources);
    const removedRecord = previousSourceRecords[sourceIndex];
    const nextSourceRecords = previousSourceRecords.filter((_, index) => index !== sourceIndex);
    const nextRecords = buildGuidelineRecords(directPrompt, directLabel, nextSourceRecords);
    const reviewSync = syncReviewAfterSourceChanges(reviewText, reviewEdited || reviewIsAuthority, previousRecords, nextRecords, [{ before: removedRecord, after: [] }]);
    markDirty();
    setSources((current) => current.filter((item) => item.id !== id));
    setReviewText(reviewSync.text);
    setReviewEdited(reviewSync.edited);
    if (reviewSync.refreshed) setNotice("The review text was refreshed from the remaining sources. Check it before saving.");
  };
  const clearPrompt = () => { if (locked || processing) return; syncDirectPromptChange("", "Pasted or typed guidelines"); };

  const saveGuideline = async () => {
    if (saveDisabled) return;
    setProcessing(true);
    setAuditIssue(null);
    let result = effective;
    if (result.status === "ready" && (reviewIsAuthority || records.length > 1)) {
      const audit = await auditCustomGuidelineConflicts(auditRecords);
      if (!audit.ok) {
        const blocked = { ...result, status: "unsupported" as const, text: "", message: audit.error || "The conflict audit could not complete. Try saving again.", character_count: 0, block_save: true };
        setAuditIssue(blocked); setNotice(blocked.message); setProcessing(false); return;
      }
      if (audit.conflicts.length) {
        const details = audit.conflicts.slice(0, 4).map((item) => `“${item.source_a}” vs “${item.source_b}”: ${item.reason}`).join(" ");
        result = { ...result, status: "conflict", message: `Resolve these conflicting instructions before capture. ${details}`, conflicts: audit.conflicts, block_save: true };
      }
    }
    if (result.block_save || result.status !== "ready") { setAuditIssue(result); setNotice(result.message); setProcessing(false); return; }
    const savedSources = records.map((record) => sanitizeCustomGuidelineSource(record)).filter((record): record is CustomGuidelineSourceRecord => Boolean(record));
    const label = savedSources.length === 1 ? savedSources[0].name : savedSources.length ? `${savedSources.length} guideline sources` : "";
    const saved = await onChange({ custom_guideline_text: result.text, custom_guideline_source_label: label, custom_guideline_status: "ready", custom_guideline_message: "", custom_guideline_saved_at: result.text ? new Date().toISOString() : "", custom_guideline_sources: savedSources });
    setProcessing(false);
    if (saved === false) { setNotice("The guidelines could not be saved. Try again."); return; }
    setReviewText(result.text); setReviewEdited(false); setDirty(false); setAuditIssue(null); setNotice("Guidelines loaded and saved. Custom Guidelines is ready.");
  };

  const removeGuideline = async () => {
    if (locked || saving || processing || (!savedText && !directPrompt && !sources.length && !reviewText)) return;
    setProcessing(true);
    const saved = await onChange({ custom_guideline_text: "", custom_guideline_source_label: "", custom_guideline_status: "empty", custom_guideline_message: "", custom_guideline_saved_at: "", custom_guideline_sources: [] });
    setProcessing(false);
    if (saved === false) { setNotice("The guidelines could not be removed. Try again."); return; }
    setDirectPrompt(""); setDirectLabel("Pasted or typed guidelines"); setSources([]); setReviewText(""); setReviewEdited(false); setDirty(false); setAuditIssue(null); setNotice("Custom guidelines removed from this session.");
  };

  return <div className="tx-custom-guidelines tx-field-wide" aria-label="Custom transcription guidelines">
    <div className="tx-custom-guidelines-head"><div><div className="tx-field-label-row"><Label htmlFor={`custom-guideline-text-${session.id}`}>Custom transcription guidelines</Label><span className={`tx-guideline-status status-${display.status}`}>{statusIcon(display.status)}{customGuidelineStatusLabel(display.status)}</span></div><p className="tx-help">Type a direct prompt or combine files. The app extracts the instructions, keeps source order, and preserves timing, speakers, and sound-event markers.</p></div>{locked && <span className="tx-guideline-lock"><LockKeyhole className="h-3.5 w-3.5" />Guideline locked for this capture</span>}</div>
    <div className="tx-guideline-prompt-head"><Label htmlFor={`custom-guideline-text-${session.id}`}>Direct prompt <span className="tx-label-optional">Optional</span></Label>{directPrompt && !locked && <Button type="button" variant="ghost" size="sm" className="tx-guideline-clear" onClick={clearPrompt} disabled={processing}><X className="h-3.5 w-3.5" />Clear prompt</Button>}</div>
    <Textarea id={`custom-guideline-text-${session.id}`} value={directPrompt} onChange={(event) => updatePrompt(event.target.value)} disabled={locked || processing} placeholder="For example: preserve contractions, use sentence case, and keep the speaker's words verbatim." className="tx-guideline-textarea" aria-describedby={`custom-guideline-help-${session.id}`} />
    <div className="tx-guideline-meta"><span id={`custom-guideline-help-${session.id}`} className="tx-help">{sourceCharacterCount.toLocaleString()} extracted characters{preview.character_count && preview.character_count !== sourceCharacterCount ? `, ${preview.character_count.toLocaleString()} combined` : ""} of 12,000 characters</span>{directPrompt && <span className="tx-guideline-source"><FileText className="h-3.5 w-3.5" />{directLabel}</span>}</div>
    <div className="tx-guideline-source-list" aria-label="Loaded guideline sources">{sources.map((source) => <div key={source.id} className={`tx-guideline-source-row status-${source.status}`}><div className="tx-guideline-source-row-head"><span className="tx-guideline-source-icon" aria-label={customGuidelineStatusLabel(source.status)} title={customGuidelineStatusLabel(source.status)}>{statusIcon(source.status, source.processing)}</span><div className="tx-guideline-source-copy"><strong title={source.name}>{source.name}</strong><span>{categoryLabel(source.category)} · {source.character_count.toLocaleString()} characters · {customGuidelineStatusLabel(source.status)}</span></div><div className="tx-guideline-source-controls">{!locked && <><Button type="button" variant="ghost" size="sm" className="tx-guideline-source-button" onClick={() => chooseFiles(source.id)} disabled={processing}><RefreshCw className="h-3.5 w-3.5" />Replace</Button><Button type="button" variant="ghost" size="sm" className="tx-guideline-source-button is-danger" onClick={() => removeSource(source.id)} disabled={processing}><X className="h-3.5 w-3.5" />Remove</Button></>}</div></div>{source.message && <p className={`tx-guideline-source-message is-${source.status}`} role={source.status === "ready" ? "status" : "alert"}>{source.message}</p>}</div>)}</div>
    <div className="tx-guideline-review">
      <div className="tx-guideline-prompt-head"><Label htmlFor={`custom-guideline-review-${session.id}`}>Extracted Guidelines — Review/Edit</Label><span className="tx-label-optional">{reviewEdited ? "Edited review" : "Ready to review"}</span></div>
      <Textarea id={`custom-guideline-review-${session.id}`} value={reviewText} onChange={(event) => updateReview(event.target.value)} disabled={locked || processing} placeholder="Extracted instructions will appear here. Review or correct them before saving." className="tx-guideline-textarea tx-guideline-review-textarea" aria-describedby={`custom-guideline-review-help-${session.id}`} />
      <p id={`custom-guideline-review-help-${session.id}`} className="tx-help">This is the exact instruction text that will be saved and followed during Custom Guidelines transcription. {reviewText.length.toLocaleString()} of 12,000 characters.</p>
    </div>
    <div className="tx-guideline-actions"><button type="button" className={`tx-guideline-upload ${locked || processing ? "is-disabled" : ""}`} onClick={() => chooseFiles()} disabled={locked || processing}><FileUp className="h-3.5 w-3.5" />Add guideline files</button><input ref={fileInputRef} id={`custom-guideline-file-${session.id}`} type="file" accept="image/*,.doc,.docx,.pdf,.txt,.md,.markdown,.csv,.json,.yaml,.yml,.xml,.log,.srt,.vtt,.zip" multiple className="sr-only" onChange={onFileInput} disabled={locked || processing} /><Button type="button" size="sm" className="tx-btn-primary" onClick={() => void saveGuideline()} disabled={saveDisabled}><Save className="h-3.5 w-3.5" />{processing ? "Reading…" : "Save guidelines"}</Button><Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={() => void removeGuideline()} disabled={locked || saving || processing || (!savedText && !directPrompt && !sources.length && !reviewText)}><Trash2 className="h-3.5 w-3.5" />Remove all</Button></div>
    {processing && <p className="tx-guideline-message is-working" role="status">Reading files and checking the combined instructions…</p>}
    {!processing && display.message && <p className={`tx-guideline-message is-${display.status}`} role={display.status === "ready" ? "status" : "alert"}>{display.status === "ready" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}{display.message}</p>}
    {!processing && displayConflicts.length > 0 && <div className="tx-guideline-conflicts" role="alert"><strong>Conflict details</strong>{displayConflicts.map((conflict: CustomGuidelineConflict, index) => <div key={`${conflict.source_a}-${conflict.source_b}-${index}`}><span>{conflict.source_a} vs {conflict.source_b}</span><p>“{conflict.excerpt_a}” / “{conflict.excerpt_b}”</p><small>{conflict.reason}</small></div>)}</div>}
    {!processing && notice && <p className="tx-guideline-notice" role="status">{notice}</p>}
    {!processing && !savedReady && session.custom_guideline_status === "ready" && <p className="tx-guideline-message is-conflict" role="alert">The saved guideline is incomplete. Save it again before starting Custom Guidelines.</p>}
  </div>;
}
