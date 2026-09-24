import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Clock3, Download, Languages, Loader2, Pause, Play, RefreshCw, RotateCcw, Sparkles, Square, Volume2 } from "lucide-react";
import { TranslationResult } from "@/entities";
import { synthesizeTranslationAudio, translateTranscriptSegment } from "@/functions";
import { Button } from "@/components/ui/button";
import { formatTimestampRange } from "@/lib/transcription/format";
import { getTranscriptionStatus, languageLabel } from "@/lib/transcription/transcription";
import { normalizeTranslationSourceLanguage, normalizeTranslationTargetLanguage } from "@/lib/transcription/translation";
import type { AudioSegmentRecord, TranslationAudioJobResult, TranslationJobResult, TranslationLineSnapshot, TranslationResultRecord, TranscriptLineRecord, TranscriptionSessionRecord } from "@/lib/transcription/types";

type TranslationPanelProps = { session: TranscriptionSessionRecord; segments: AudioSegmentRecord[]; lines: TranscriptLineRecord[] };
type JsonRecord = Record<string, unknown>;
type StatusTone = "ready" | "working" | "failed" | "waiting";

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
  }
  return "";
}

function cleanedMessage(value: unknown): string {
  return errorText(value)
    .replace(/^api request failed:\s*/i, "")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[private link]")
    .replace(/\b(?:bearer|token|api[_ -]?key|secret|password|authorization)\s*[:=]?\s*[^\s,;]+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

function safeMessage(value: unknown, fallback: string): string {
  return (cleanedMessage(value) || fallback).slice(0, 320);
}

function isLegacyRequestFormatFailure(value: unknown): boolean {
  const message = cleanedMessage(value).toLowerCase();
  return /send (?:a )?json request body|json request body is required|valid json request body|(?:content[- ]type|text\/plain).{0,120}(?:json|body)|(?:json|body).{0,120}(?:content[- ]type|text\/plain)/i.test(message);
}

function isTransportFailure(value: unknown): boolean {
  const message = cleanedMessage(value).toLowerCase();
  return !message || /api request failed|failed to fetch|network(?:error| request| failure)?|load failed|cors|content[- ]type|send (?:a )?json request body|valid json request body|json request body is required|timed? out|timeout|connection (?:reset|refused|failed)|\b[45]\d{2}\b|internal server|unexpected(?: error| response)?/i.test(message);
}

function stageMessage(value: unknown, fallback: string): string {
  const message = cleanedMessage(value);
  return isTransportFailure(message) ? fallback : message.slice(0, 320);
}

function translationErrorMessage(value: unknown): string {
  return stageMessage(value, "Translation request was rejected. Retry this segment.");
}

function audioErrorMessage(value: unknown): string {
  return stageMessage(value, "Translated audio could not be reached. Retry this clip.");
}

function responseEnvelope(value: unknown): JsonRecord {
  let candidate = value;
  if (typeof candidate === "string") { try { candidate = JSON.parse(candidate); } catch { return {}; } }
  if (!candidate || typeof candidate !== "object") return {};
  const record = candidate as JsonRecord;
  if (typeof record.source_segment_id === "string" && typeof record.id === "string") return { ok: true, status: record.status, result: record };
  if (record.ok !== undefined || record.error !== undefined || record.status !== undefined || record.audio_status !== undefined) return record;
  if (record.result !== undefined) return responseEnvelope(record.result);
  if (record.data !== undefined) return responseEnvelope(record.data);
  return record;
}

function parseResult(value: unknown): TranslationResultRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as JsonRecord;
  if (typeof row.id !== "string" || typeof row.source_segment_id !== "string" || !["translating", "completed", "failed"].includes(String(row.status))) return null;
  return { ...row, lines: Array.isArray(row.lines) ? row.lines as TranslationLineSnapshot[] : [] } as unknown as TranslationResultRecord;
}

function parseResults(value: unknown): TranslationResultRecord[] {
  return Array.isArray(value) ? value.map(parseResult).filter((row): row is TranslationResultRecord => Boolean(row)) : [];
}

function displayLanguage(value: unknown, fallback = "Pending"): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const normalized = normalizeTranslationSourceLanguage(value);
  return normalized === "auto" ? "Auto Detect" : languageLabel(normalized);
}

function matchesSettings(result: TranslationResultRecord, source: string, target: string): boolean {
  return Boolean(result.requested_source_language && result.target_language)
    && normalizeTranslationSourceLanguage(result.requested_source_language) === source
    && normalizeTranslationTargetLanguage(result.target_language) === target;
}

function requestKey(sessionId: string, segmentId: string, source: string, target: string): string {
  return `${sessionId}:${segmentId}:${source}:${target}`;
}

function audioKey(sessionId: string, result: TranslationResultRecord): string {
  return `${sessionId}:${result.id}:${result.source_hash || ""}:${result.settings_hash || ""}`;
}

function safeAudioUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch { return ""; }
}

function hasTranslatedSpeech(result: TranslationResultRecord): boolean {
  return result.lines.some((line) => line.kind === "speech" && typeof line.translated_text === "string" && line.translated_text.replace(/\[[^\]\r\n]{0,240}\]/g, " ").trim().length > 0);
}

function hasCurrentAudio(result: TranslationResultRecord): boolean {
  const audioGeneratedAt = result.audio_generated_at ? Date.parse(result.audio_generated_at) : Number.NaN;
  const translatedAt = result.translated_at ? Date.parse(result.translated_at) : Number.NaN;
  return result.audio_status === "completed"
    && Boolean(safeAudioUrl(result.audio_url))
    && Number.isFinite(audioGeneratedAt)
    && (!Number.isFinite(translatedAt) || audioGeneratedAt >= translatedAt);
}

function sourceStatusText(segment: AudioSegmentRecord): string {
  const status = getTranscriptionStatus(segment);
  if (segment.upload_status !== "uploaded") return "Waiting for upload";
  if (status === "transcribing") return "Transcribing source";
  if (status === "failed") return "Source needs retry";
  if (status === "completed") return "Ready to translate";
  return "Waiting for source transcript";
}

function statusBadge(text: string, tone: StatusTone) {
  const Icon = tone === "ready" ? CheckCircle2 : tone === "working" ? Loader2 : tone === "failed" ? AlertCircle : Clock3;
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${tone === "ready" ? "border-emerald-400/30 text-emerald-200" : tone === "working" ? "border-amber-300/30 text-amber-200" : tone === "failed" ? "border-red-300/30 text-red-200" : "border-border text-muted-foreground"}`}><Icon className={`h-3 w-3 ${tone === "working" ? "animate-spin" : ""}`} aria-hidden="true" />{text}</span>;
}

function SnapshotPair({ line }: { line: TranslationLineSnapshot }) {
  const timing = line.start_ms != null ? formatTimestampRange(line.start_ms, line.end_ms) : "";
  const metadata = <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground"><span>Line {line.sequence + 1}</span>{line.speaker_label && <span>{line.speaker_label}</span>}{timing && <span className="font-mono">{timing}</span>}</div>;
  return <div className="grid gap-2 lg:grid-cols-2"><div className="rounded-xl border border-border bg-background/30 p-3"><div className="mb-2 flex items-center justify-between gap-2"><span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Original source</span>{metadata}</div><p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{line.source_text || "No source text"}</p></div><div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-3"><div className="mb-2 flex items-center justify-between gap-2"><span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-200">Translated text</span>{metadata}</div><p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{line.translated_text || "No translated text was returned."}</p></div></div>;
}

function TranslationAudioControls({ result, segmentNumber, targetLanguage, busy, localError, onRetryAudio, onRetryTranslation }: { result: TranslationResultRecord; segmentNumber: number; targetLanguage: string; busy: boolean; localError?: string; onRetryAudio: () => void; onRetryTranslation: () => void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playerError, setPlayerError] = useState("");
  const audioUrl = safeAudioUrl(result.audio_url);
  const hasAudio = hasCurrentAudio(result);
  const hasText = hasTranslatedSpeech(result);
  const audioError = playerError || localError || (result.audio_error ? audioErrorMessage(result.audio_error) : "");
  const working = busy || result.audio_status === "synthesizing";
  const audioTone: StatusTone = hasAudio ? "ready" : working ? "working" : !hasText || result.audio_status === "failed" || Boolean(audioError) || (result.audio_status === "completed" && !hasAudio) ? "failed" : "waiting";
  const audioLabel = hasAudio ? "Audio ready" : working ? "Preparing audio" : audioTone === "failed" ? "Audio unavailable" : "Audio queued";

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.currentTime = 0; }
    setPlaying(false);
    setPlayerError("");
  }, [audioUrl, result.id, result.audio_status]);

  const play = async () => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    setPlayerError("");
    if (audio.ended || (Number.isFinite(audio.duration) && audio.currentTime >= audio.duration)) audio.currentTime = 0;
    try { await audio.play(); setPlaying(true); } catch { setPlaying(false); setPlayerError("This saved audio could not be played here. Try downloading the clip instead."); }
  };
  const pause = () => { audioRef.current?.pause(); setPlaying(false); };
  const replay = async () => { const audio = audioRef.current; if (!audio) return; audio.currentTime = 0; await play(); };
  const stop = () => { const audio = audioRef.current; if (audio) { audio.pause(); audio.currentTime = 0; } setPlaying(false); };

  return <div className="rounded-xl border border-sky-300/20 bg-sky-300/[0.04] p-3" aria-label={`Translated voice output for segment ${segmentNumber}`}>
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="flex items-start gap-2"><Volume2 className="mt-0.5 h-4 w-4 text-sky-200" aria-hidden="true" /><div><strong className="text-sm">Translated voice · {displayLanguage(targetLanguage, "Target language")}</strong><p className="tx-help mt-1">A saved multilingual voice clip keeps the translated text separate from source timing and speaker labels.</p></div></div>{statusBadge(audioLabel, audioTone)}</div>
    {!hasText && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-300/20 bg-red-300/[0.04] p-3"><p className="tx-error-inline">Translated speech is empty. Retry the translation before creating audio.</p><Button type="button" size="sm" variant="outline" className="tx-btn-ghost shrink-0" onClick={onRetryTranslation}><RotateCcw className="h-3.5 w-3.5" />Retry translation</Button></div>}
    {hasText && working && <p className="tx-help mt-3 flex items-center gap-2" role="status"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Preparing a saved voice clip for this translation…</p>}
    {hasText && !working && audioTone === "failed" && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-300/20 bg-red-300/[0.04] p-3" role="alert"><p className="tx-error-inline">{audioError || "Translated audio could not be generated. Retry this clip."}</p><Button type="button" size="sm" variant="outline" className="tx-btn-ghost shrink-0" onClick={onRetryAudio}><RotateCcw className="h-3.5 w-3.5" />Retry audio</Button></div>}
    {hasAudio && <div className="mt-3 space-y-2"><audio ref={audioRef} preload="metadata" src={audioUrl} className="sr-only" aria-label={`Play translated audio for segment ${segmentNumber}`} onEnded={() => setPlaying(false)} onError={() => { setPlaying(false); setPlayerError("This saved audio could not be loaded. Try downloading the clip instead."); }} /><div className="flex flex-wrap items-center gap-2"><Button type="button" size="sm" className="tx-btn-primary" onClick={() => void (playing ? pause() : play())}>{playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}{playing ? "Pause" : "Play"}</Button><Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={() => void replay()}><RotateCcw className="h-3.5 w-3.5" />Replay</Button><Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={stop}><Square className="h-3.5 w-3.5" />Stop</Button><a href={audioUrl} download={`translated-segment-${segmentNumber}.mp3`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-background/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Download className="h-3.5 w-3.5" />Save audio</a></div>{playerError && <p className="tx-error-inline" role="alert">{playerError}</p>}</div>}
  </div>;
}

function TranslationSegmentCard({ segment, result, current, busy, localError, audioBusy, audioError, sourceLines, sourceLanguage, targetLanguage, onRetry, onRetryAudio }: { segment: AudioSegmentRecord; result?: TranslationResultRecord; current: boolean; busy: boolean; localError?: string; audioBusy: boolean; audioError?: string; sourceLines: TranscriptLineRecord[]; sourceLanguage: string; targetLanguage: string; onRetry: () => void; onRetryAudio: () => void }) {
  const sourceReady = getTranscriptionStatus(segment) === "completed";
  const retryable = sourceReady && !busy && (Boolean(localError) || Boolean(result && (result.status === "failed" || !current)));
  const snapshots = result?.lines?.slice().sort((a, b) => a.sequence - b.sequence) || [];
  const previewLines = sourceLines.filter((line) => line.kind === "speech" && line.text?.trim()).slice(0, 2);
  const status = !sourceReady ? sourceStatusText(segment) : busy || result?.status === "translating" ? "Translating" : result?.status === "completed" && current ? "Translated" : result?.status === "failed" ? "Translation failed" : result ? "Settings changed" : "Ready to translate";
  const tone: StatusTone = !sourceReady ? "waiting" : busy || result?.status === "translating" ? "working" : result?.status === "failed" ? "failed" : result?.status === "completed" && current ? "ready" : "waiting";
  const error = result?.error ? translationErrorMessage(result.error) : localError;
  return <article className="rounded-2xl border border-border bg-background/25 p-3 sm:p-4" aria-labelledby={`translation-segment-${segment.id}`}>
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs font-semibold text-[hsl(var(--coral))]">Segment #{segment.sequence + 1}</span>{statusBadge(status, tone)}</div><h4 id={`translation-segment-${segment.id}`} className="mt-2 text-sm font-semibold">{displayLanguage(result?.requested_source_language || sourceLanguage, "Current source")} to {displayLanguage(result?.target_language || targetLanguage, "Current target")}</h4><div className="mt-2 flex flex-wrap gap-1.5 text-[10px]"><span className="rounded-full border border-border px-2 py-1 text-muted-foreground">Requested: {displayLanguage(result?.requested_source_language || sourceLanguage, "Current source")}</span><span className="rounded-full border border-border px-2 py-1 text-muted-foreground">Detected: {displayLanguage(result?.detected_source_language || segment.detected_language || segment.detected_languages?.[0])}</span><span className="rounded-full border border-border px-2 py-1 text-muted-foreground">Target: {displayLanguage(result?.target_language || targetLanguage, "Current target")}</span></div></div>{retryable && <Button type="button" size="sm" variant="outline" className="tx-btn-ghost shrink-0" onClick={onRetry}><RotateCcw className="h-3.5 w-3.5" />Retry translation</Button>}</div>
    {!sourceReady && <p className="tx-help mt-3">{sourceStatusText(segment)}. Translation becomes available after the saved source transcript is complete.</p>}
    {sourceReady && !result && <div className="mt-3 space-y-3">{error && <div className="tx-error-inline flex items-start gap-2" role="alert"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>{error}</span></div>}<p className="tx-help" role={busy ? "status" : undefined}>{busy ? "Sending this saved source segment for translation…" : error ? "Translation failed. Retry this segment." : "The source transcript is complete. Translation will start automatically."}</p>{previewLines.length > 0 && <div className="rounded-xl border border-border bg-background/20 p-3"><span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Source transcript snapshot</span>{previewLines.map((line) => <p key={line.id} className="mt-2 line-clamp-2 text-sm text-foreground">{line.text}</p>)}</div>}</div>}
    {sourceReady && result && <div className="mt-3 space-y-3">{error && <div className="tx-error-inline flex items-start gap-2" role="alert"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>{error}</span></div>}{!current && result.status !== "failed" && <p className="rounded-lg border border-amber-300/20 bg-amber-300/[0.04] px-3 py-2 text-xs text-amber-100">The session languages changed. Retry this segment to create a translation with the current settings.</p>}{result.status === "translating" && <p className="tx-help" role="status"><Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />The saved source lines are being translated. This panel will update when the result is ready.</p>}{snapshots.length > 0 ? <div className="space-y-2">{snapshots.map((line) => <SnapshotPair key={line.source_line_id} line={line} />)}</div> : result.status === "completed" ? <p className="tx-help">The source transcript has no lines to display for this segment.</p> : <p className="tx-help">Source line snapshots will appear when translation completes.</p>}{result.status === "completed" && current && <TranslationAudioControls result={result} segmentNumber={segment.sequence + 1} targetLanguage={result.target_language || targetLanguage} busy={audioBusy} localError={audioError} onRetryAudio={onRetryAudio} onRetryTranslation={onRetry} />}</div>}
  </article>;
}

export function TranslationPanel({ session, segments, lines }: TranslationPanelProps) {
  const sourceLanguage = normalizeTranslationSourceLanguage(session.translation_source_language);
  const targetLanguage = normalizeTranslationTargetLanguage(session.translation_target_language);
  const sessionIdRef = useRef(session.id);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(new Set<string>());
  const attemptedRef = useRef(new Set<string>());
  const audioInFlightRef = useRef(new Set<string>());
  const audioAttemptedRef = useRef(new Set<string>());
  const [results, setResults] = useState<TranslationResultRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [resultsLoaded, setResultsLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [activeKeys, setActiveKeys] = useState<Set<string>>(new Set());
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({});
  const [audioActiveKeys, setAudioActiveKeys] = useState<Set<string>>(new Set());
  const [audioRequestErrors, setAudioRequestErrors] = useState<Record<string, string>>({});
  sessionIdRef.current = session.id;

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const loadResults = useCallback(async () => {
    const requestedSessionId = session.id;
    setLoading(true); setLoadError("");
    try {
      const rows = await TranslationResult.filter({ session_id: requestedSessionId }, "-updated_at", 200);
      if (mountedRef.current && sessionIdRef.current === requestedSessionId) setResults(parseResults(rows));
    } catch (error) {
      if (mountedRef.current && sessionIdRef.current === requestedSessionId) setLoadError(isTransportFailure(error) ? "Saved translations could not be loaded. Try again." : safeMessage(error, "Saved translations could not be loaded. Try again."));
    } finally {
      if (mountedRef.current && sessionIdRef.current === requestedSessionId) { setLoading(false); setResultsLoaded(true); }
    }
  }, [session.id]);
  useEffect(() => { attemptedRef.current.clear(); inFlightRef.current.clear(); audioAttemptedRef.current.clear(); audioInFlightRef.current.clear(); setResults([]); setRequestErrors({}); setActiveKeys(new Set()); setAudioRequestErrors({}); setAudioActiveKeys(new Set()); setResultsLoaded(false); void loadResults(); }, [loadResults]);

  const resultBySegment = useMemo(() => new Map(results.map((result) => [result.source_segment_id, result])), [results]);
  const readySegments = useMemo(() => segments.filter((segment) => getTranscriptionStatus(segment) === "completed"), [segments]);
  const mergeResult = useCallback((next: TranslationResultRecord) => setResults((current) => [next, ...current.filter((result) => result.source_segment_id !== next.source_segment_id)]), []);
  const setActive = useCallback((key: string, active: boolean) => setActiveKeys((current) => { const next = new Set(current); if (active) next.add(key); else next.delete(key); return next; }), []);
  const setAudioActive = useCallback((key: string, active: boolean) => setAudioActiveKeys((current) => { const next = new Set(current); if (active) next.add(key); else next.delete(key); return next; }), []);
  const runTranslation = useCallback(async (segmentId: string, key: string) => {
    if (inFlightRef.current.has(key)) return;
    const requestedSessionId = session.id;
    inFlightRef.current.add(key); setActive(key, true); setRequestErrors((current) => { const next = { ...current }; delete next[key]; return next; });
    try {
      const raw = await translateTranscriptSegment({ session_id: requestedSessionId, segment_id: segmentId });
      const payload = responseEnvelope(raw) as TranslationJobResult & JsonRecord;
      const next = parseResult(payload.result);
      const stillCurrent = mountedRef.current && sessionIdRef.current === requestedSessionId;
      if (stillCurrent && next) mergeResult(next);
      if (payload.ok === false || payload.status === "failed" || next?.status === "failed") { if (stillCurrent && !next) setRequestErrors((current) => ({ ...current, [key]: translationErrorMessage(payload.error) })); return; }
      if (!next) throw new Error("The translation response did not include a saved result.");
    } catch (error) {
      if (mountedRef.current && sessionIdRef.current === requestedSessionId) { setRequestErrors((current) => ({ ...current, [key]: translationErrorMessage(error) })); void loadResults(); }
    } finally {
      inFlightRef.current.delete(key);
      if (mountedRef.current && sessionIdRef.current === requestedSessionId) setActive(key, false);
    }
  }, [loadResults, mergeResult, session.id, setActive]);

  useEffect(() => {
    if (!resultsLoaded || loadError) return;
    readySegments.forEach((segment) => {
      const result = resultBySegment.get(segment.id);
      const current = result ? matchesSettings(result, sourceLanguage, targetLanguage) : false;
      const key = requestKey(session.id, segment.id, sourceLanguage, targetLanguage);
      const retryLegacy = Boolean(result && current && result.status === "failed" && isLegacyRequestFormatFailure(result.error));
      if (result && current && result.status === "completed") return;
      if (result && current && result.status === "translating") return;
      if (result && current && result.status === "failed" && !retryLegacy) return;
      if (attemptedRef.current.has(key) || inFlightRef.current.has(key)) return;
      attemptedRef.current.add(key);
      void runTranslation(segment.id, key);
    });
  }, [loadError, readySegments, resultBySegment, resultsLoaded, runTranslation, session.id, sourceLanguage, targetLanguage]);

  const runAudio = useCallback(async (result: TranslationResultRecord, key: string) => {
    if (audioInFlightRef.current.has(key) || result.status !== "completed" || !hasTranslatedSpeech(result)) return;
    const requestedSessionId = session.id;
    audioInFlightRef.current.add(key); setAudioActive(key, true); setAudioRequestErrors((current) => { const next = { ...current }; delete next[key]; return next; });
    try {
      const raw = await synthesizeTranslationAudio({ session_id: requestedSessionId, translation_result_id: result.id });
      const payload = responseEnvelope(raw) as TranslationAudioJobResult & JsonRecord;
      const next = parseResult(payload.result);
      const stillCurrent = mountedRef.current && sessionIdRef.current === requestedSessionId;
      if (stillCurrent && next) mergeResult(next);
      if (payload.ok === false || payload.audio_status === "failed" || next?.audio_status === "failed") { if (stillCurrent && !next) setAudioRequestErrors((current) => ({ ...current, [key]: audioErrorMessage(payload.error) })); return; }
      if (!next) throw new Error("The audio response did not include a saved result.");
    } catch (error) {
      if (mountedRef.current && sessionIdRef.current === requestedSessionId) { setAudioRequestErrors((current) => ({ ...current, [key]: audioErrorMessage(error) })); void loadResults(); }
    } finally {
      audioInFlightRef.current.delete(key);
      if (mountedRef.current && sessionIdRef.current === requestedSessionId) setAudioActive(key, false);
    }
  }, [loadResults, mergeResult, session.id, setAudioActive]);

  useEffect(() => {
    if (!resultsLoaded || loadError) return;
    results.forEach((result) => {
      if (result.session_id !== session.id || result.status !== "completed" || !matchesSettings(result, sourceLanguage, targetLanguage) || !hasTranslatedSpeech(result)) return;
      const key = audioKey(session.id, result);
      const retryLegacy = result.audio_status === "failed" && isLegacyRequestFormatFailure(result.audio_error);
      if (hasCurrentAudio(result)) return;
      if ((!retryLegacy && result.audio_status === "failed") || audioAttemptedRef.current.has(key) || audioInFlightRef.current.has(key)) return;
      audioAttemptedRef.current.add(key);
      void runAudio(result, key);
    });
  }, [loadError, results, resultsLoaded, runAudio, session.id, sourceLanguage, targetLanguage]);

  const triggerSegment = (segment: AudioSegmentRecord) => {
    if (!readySegments.some((item) => item.id === segment.id)) return;
    const key = requestKey(session.id, segment.id, sourceLanguage, targetLanguage);
    const result = resultBySegment.get(segment.id);
    if (result?.status === "completed" && matchesSettings(result, sourceLanguage, targetLanguage)) return;
    if (result?.status === "translating" && matchesSettings(result, sourceLanguage, targetLanguage)) return;
    void runTranslation(segment.id, key);
  };
  const triggerAudio = (result: TranslationResultRecord) => {
    const key = audioKey(session.id, result);
    audioAttemptedRef.current.add(key);
    void runAudio(result, key);
  };
  const attentionSegments = readySegments.filter((segment) => { const result = resultBySegment.get(segment.id); return Boolean(result && !activeKeys.has(requestKey(session.id, segment.id, sourceLanguage, targetLanguage)) && (result.status === "failed" || !matchesSettings(result, sourceLanguage, targetLanguage))); });
  const sourceLinesBySegment = useMemo(() => { const grouped = new Map<string, TranscriptLineRecord[]>(); lines.forEach((line) => { if (!line.source_segment_id) return; grouped.set(line.source_segment_id, [...(grouped.get(line.source_segment_id) || []), line]); }); return grouped; }, [lines]);
  const sortedSegments = useMemo(() => [...segments].sort((a, b) => a.sequence - b.sequence), [segments]);

  return <section className="tx-panel space-y-4" aria-labelledby={`translation-panel-title-${session.id}`}>
    <div className="tx-panel-head"><div><p className="tx-kicker">Segment translation</p><h3 id={`translation-panel-title-${session.id}`}>Source beside translation</h3><p className="tx-help mt-1">Each completed source clip is translated from its saved transcript lines. Source timing and speaker labels stay unchanged.</p></div><span className="tx-count-chip">{readySegments.length} ready</span></div>
    <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-3"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2"><Languages className="h-4 w-4 text-emerald-200" aria-hidden="true" /><strong className="text-sm">{displayLanguage(sourceLanguage)} to {displayLanguage(targetLanguage)}</strong></div><p className="tx-help mt-1">Translation and saved voice output run one source segment at a time. Original timing and speaker labels remain unchanged.</p></div><div className="flex flex-wrap gap-2"><Button type="button" size="sm" className="tx-btn-primary" onClick={() => readySegments.forEach(triggerSegment)} disabled={loading || Boolean(loadError) || readySegments.length === 0}><Sparkles className="h-3.5 w-3.5" />Translate all ready</Button>{attentionSegments.length > 0 && <Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={() => attentionSegments.forEach(triggerSegment)}><RotateCcw className="h-3.5 w-3.5" />Retry {attentionSegments.length} needing attention</Button>}</div></div></div>
    {loading && <p className="tx-help flex items-center gap-2" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading saved translation results…</p>}
    {!loading && loadError && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-300/25 bg-red-300/[0.04] p-3" role="alert"><span className="tx-error-inline">{loadError}</span><Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={() => void loadResults()}><RefreshCw className="h-3.5 w-3.5" />Reload results</Button></div>}
    {!loading && !loadError && sortedSegments.length === 0 && <div className="rounded-xl border border-dashed border-border p-5 text-center"><p className="text-sm font-semibold">No audio segments yet</p><p className="tx-help mt-1">Finish a capture or submit audio. The translation panel will pick up each completed source segment.</p></div>}
    {!loading && !loadError && sortedSegments.length > 0 && <div className="space-y-3">{sortedSegments.map((segment) => { const key = requestKey(session.id, segment.id, sourceLanguage, targetLanguage); const result = resultBySegment.get(segment.id); const resultAudioKey = result ? audioKey(session.id, result) : ""; return <TranslationSegmentCard key={segment.id} segment={segment} result={result} current={result ? matchesSettings(result, sourceLanguage, targetLanguage) : false} busy={activeKeys.has(key)} localError={requestErrors[key]} audioBusy={Boolean(resultAudioKey && audioActiveKeys.has(resultAudioKey))} audioError={resultAudioKey ? audioRequestErrors[resultAudioKey] : undefined} sourceLines={sourceLinesBySegment.get(segment.id) || []} sourceLanguage={sourceLanguage} targetLanguage={targetLanguage} onRetry={() => triggerSegment(segment)} onRetryAudio={() => { if (result) triggerAudio(result); }} />; })}</div>}
    <p className="tx-help border-t border-border pt-3">Translated voice output is generated automatically after each completed text result. Audio stays separate from the source transcript, timing, and speaker labels.</p>
  </section>;
}
