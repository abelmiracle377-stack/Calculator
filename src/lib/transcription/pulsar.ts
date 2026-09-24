import { getTranscriptionStatus, sortTranscriptLines } from "./transcription";
import type {
  AudioIssueRecord,
  AudioSegmentRecord,
  PulsarClipStatus,
  PulsarJsonExportPackage,
  PulsarQaFinding,
  PulsarQaResult,
  PulsarQaSeverity,
  PulsarReadinessResult,
  PulsarTagDefinition,
  TranscriptionSessionRecord,
  TranscriptAnnotationRecord,
  TranscriptLineRecord,
} from "./types";

export const PULSAR_TAG_VERSION = "pulsar-review-v1";

export const PULSAR_TAG_CATEGORIES = [
  { key: "non_lexical", label: "Non-lexical sounds" },
  { key: "style", label: "Speech style" },
  { key: "background_audio", label: "Background audio" },
  { key: "uncertainty", label: "Uncertainty" },
  { key: "end_of_file", label: "End of clip" },
  { key: "discard", label: "Discard-only" },
] as const;

export const PULSAR_TAG_VOCABULARY: PulsarTagDefinition[] = [
  { category: "non_lexical", displayLabel: "Laughter", insertionValue: "[l]", placementGuidance: "Place where laughter occurs.", insertMode: "append" },
  { category: "non_lexical", displayLabel: "Cough", insertionValue: "[c]", placementGuidance: "Place where the cough occurs.", insertMode: "append" },
  { category: "non_lexical", displayLabel: "Sigh", insertionValue: "[s]", placementGuidance: "Place where the sigh occurs.", insertMode: "append" },
  { category: "non_lexical", displayLabel: "Throat clear", insertionValue: "[t]", placementGuidance: "Place where the throat clear occurs.", insertMode: "append" },
  { category: "non_lexical", displayLabel: "Sneeze", insertionValue: "[z]", placementGuidance: "Place where the sneeze occurs.", insertMode: "append" },
  { category: "non_lexical", displayLabel: "Lip smack", insertionValue: "[p]", placementGuidance: "Place where the lip smack occurs.", insertMode: "append" },
  { category: "non_lexical", displayLabel: "Human noise", insertionValue: "[hn]", placementGuidance: "Use only for a clear foreground human noise without a more specific tag.", insertMode: "append" },
  { category: "non_lexical", displayLabel: "Humming", insertionValue: "<hum>", placementGuidance: "Use alone when the clip is humming only.", insertMode: "standalone", discard: true, standalone: true },
  { category: "non_lexical", displayLabel: "Filled pause", insertionValue: "[fp]", placementGuidance: "Use for a non-lexical filled pause. Spoken um and uh remain words.", insertMode: "append" },
  { category: "non_lexical", displayLabel: "Audio artifact", insertionValue: "[artifact]", placementGuidance: "Place at a technical audio artifact.", insertMode: "append" },
  { category: "style", displayLabel: "Whisper", insertionValue: "<ws>...</ws>", placementGuidance: "Wrap the affected grouped-line text.", insertMode: "wrap", allowedTokens: ["<ws>", "</ws>"], wrapperName: "ws" },
  { category: "style", displayLabel: "Low voice", insertionValue: "<lv>...</lv>", placementGuidance: "Wrap the affected grouped-line text.", insertMode: "wrap", allowedTokens: ["<lv>", "</lv>"], wrapperName: "lv" },
  { category: "style", displayLabel: "Singing", insertionValue: "<sg>...</sg>", placementGuidance: "Wrap the affected grouped-line text.", insertMode: "wrap", allowedTokens: ["<sg>", "</sg>"], wrapperName: "sg" },
  { category: "style", displayLabel: "Cross talk", insertionValue: "<ct>", placementGuidance: "Use as a standalone marker for unintelligible overlapping speech.", insertMode: "standalone", standalone: true },
  { category: "style", displayLabel: "List item", insertionValue: "<i>", placementGuidance: "Append directly to the preceding word.", insertMode: "append_direct" },
  { category: "background_audio", displayLabel: "Background speech", insertionValue: "[bg]", placementGuidance: "Use for speech in the background, not foreground human noise.", insertMode: "append" },
  { category: "uncertainty", displayLabel: "Guessed word", insertionValue: "((word))", placementGuidance: "Wrap a single uncertain word or the current grouped-line text.", insertMode: "wrap" },
  { category: "uncertainty", displayLabel: "Unintelligible portion", insertionValue: "(())", placementGuidance: "Append for a partially unintelligible speech portion. Use alone for a fully unintelligible clip.", insertMode: "append" },
  { category: "end_of_file", displayLabel: "Media speech", insertionValue: "<ms>", placementGuidance: "Append at the end of the relevant clip transcript.", insertMode: "append", endOfFile: true },
  { category: "end_of_file", displayLabel: "Partial whisper", insertionValue: "<pws>", placementGuidance: "Append at the end of the relevant clip transcript.", insertMode: "append", endOfFile: true },
  { category: "discard", displayLabel: "Garbled audio", insertionValue: "<ga>", placementGuidance: "Use alone when the entire clip is garbled.", insertMode: "standalone", discard: true, standalone: true },
  { category: "discard", displayLabel: "No audio", insertionValue: "<na>", placementGuidance: "Use alone when the clip contains no audio.", insertMode: "standalone", discard: true, standalone: true },
  { category: "discard", displayLabel: "No speech", insertionValue: "<ns>", placementGuidance: "Use alone when the clip contains no speech.", insertMode: "standalone", discard: true, standalone: true },
  { category: "discard", displayLabel: "Sensitive audio", insertionValue: "[se]", placementGuidance: "Use alone when the clip is sensitive audio.", insertMode: "standalone", discard: true, standalone: true },
];

const STATIC_DEFINITIONS = new Map<string, PulsarTagDefinition>(PULSAR_TAG_VOCABULARY.flatMap((tag) =>
  (tag.allowedTokens || [tag.insertionValue]).map((token) => [token, tag] as [string, PulsarTagDefinition])
));
const TOKEN_PATTERN = /\[[^\]\r\n]*\]|<\/?[A-Za-z][A-Za-z0-9_-]*>|\(\([^()\r\n]*\)\)/g;
const WRAPPER_PATTERN = /<(\/)?(ws|lv|sg)>/gi;
const GUESSED_WORD_PATTERN = /^\(\([\p{Ll}\p{Nd}]+(?:['-][\p{Ll}\p{Nd}]+)*\)\)$/u;

export function extractPulsarTagCandidates(text: string): string[] {
  return text.match(TOKEN_PATTERN) ?? [];
}

export function isKnownPulsarTag(token: string): boolean {
  return STATIC_DEFINITIONS.has(token) || token === "(())" || GUESSED_WORD_PATTERN.test(token);
}

export function pulsarTagDefinition(token: string): PulsarTagDefinition | undefined {
  return STATIC_DEFINITIONS.get(token) || (GUESSED_WORD_PATTERN.test(token)
    ? PULSAR_TAG_VOCABULARY.find((tag) => tag.insertionValue === "((word))")
    : undefined);
}

export function stripPulsarTags(text: string): string {
  return text.replace(TOKEN_PATTERN, " ").replace(/\s+/g, " ").trim();
}

type FindingRef = Pick<PulsarQaFinding, "line_id" | "segment_id" | "sequence" | "reference_line_id">;
type FindingAdder = (code: string, severity: PulsarQaSeverity, message: string, refs?: FindingRef) => void;

function inspectLineTags(line: TranscriptLineRecord, allLines: TranscriptLineRecord[], add: FindingAdder) {
  const text = line.text || "";
  const tokens = extractPulsarTagCandidates(text);
  const refs = { line_id: line.id, sequence: line.sequence };
  tokens.forEach((token) => {
    if (!isKnownPulsarTag(token)) add("unknown_tag", "error", `Unknown or malformed Pulsar tag ${token}.`, refs);
  });
  const opens = (text.match(/\[/g) || []).length;
  const closes = (text.match(/\]/g) || []).length;
  if (opens !== closes) add("malformed_square_tag", "error", "Square-bracket tag syntax is incomplete.", refs);

  const wrapperStack: string[] = [];
  for (const match of text.matchAll(WRAPPER_PATTERN)) {
    const name = match[2].toLowerCase();
    if (match[1]) {
      if (wrapperStack.pop() !== name) add("malformed_wrapper", "error", `The ${name} wrapper is not balanced.`, refs);
    } else wrapperStack.push(name);
  }
  if (wrapperStack.length) add("malformed_wrapper", "error", `The ${wrapperStack[wrapperStack.length - 1]} wrapper needs a closing tag.`, refs);
  if (/<(ws|lv|sg)>\s*<\/\1>/i.test(text)) add("empty_wrapper", "error", "A speech-style wrapper must contain text.", refs);

  const definitions = tokens.map(pulsarTagDefinition).filter((tag): tag is PulsarTagDefinition => Boolean(tag));
  const discardTokens = tokens.filter((token) => pulsarTagDefinition(token)?.discard);
  if (discardTokens.length) {
    const otherTokens = tokens.filter((token) => !pulsarTagDefinition(token)?.discard);
    if (stripPulsarTags(text) || otherTokens.length || discardTokens.length > 1) {
      add("discard_mixed_content", "error", "A discard tag must stand alone without speech or another tag.", refs);
    }
  }
  const standaloneTokens = definitions.filter((tag) => tag.standalone);
  if (standaloneTokens.length && (stripPulsarTags(text) || tokens.length > standaloneTokens.length)) {
    add("standalone_tag_mixed_content", "error", "A standalone Pulsar tag cannot be mixed with other transcript content.", refs);
  }

  tokens.filter((token) => pulsarTagDefinition(token)?.endOfFile).forEach((token) => {
    const trimmed = text.trim();
    const relevant = line.source_segment_id
      ? allLines.filter((candidate) => candidate.source_segment_id === line.source_segment_id)
      : allLines;
    const lastRelevant = relevant[relevant.length - 1];
    if (!trimmed.endsWith(token) || lastRelevant?.id !== line.id) {
      add("misplaced_end_of_file_tag", "error", `${token} belongs at the end of the relevant clip transcript.`, refs);
    }
  });
}

function summaryFor(findings: PulsarQaFinding[]) {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  const infos = findings.filter((finding) => finding.severity === "info").length;
  return { total: findings.length, errors, warnings, infos, blocking: errors };
}

export function evaluatePulsarQa(input: {
  session: TranscriptionSessionRecord;
  lines: TranscriptLineRecord[];
  segments: AudioSegmentRecord[];
  issues?: AudioIssueRecord[];
  annotations?: TranscriptAnnotationRecord[];
}, ranAt?: string): PulsarQaResult {
  const findings: PulsarQaFinding[] = [];
  const add: FindingAdder = (code, severity, message, refs = {}) => {
    const id = [code, refs.line_id || "", refs.segment_id || "", refs.reference_line_id || ""].join(":");
    if (!findings.some((finding) => finding.id === id)) findings.push({ id, code, severity, message, ...refs });
  };
  const lines = sortTranscriptLines(input.lines);
  const segments = [...input.segments].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const uploaded = segments.filter((segment) => segment.upload_status === "uploaded");

  if (input.session.status === "recording") add("session_still_recording", "error", "Stop the recording before starting Pulsar review.");
  if (input.session.status === "discarded") add("session_discarded", "error", "A discarded session cannot be marked ready for Pulsar review.");
  if (!segments.length || !uploaded.length) add("no_uploaded_clips", "error", "No uploaded audio clips are available for Pulsar review.");

  segments.forEach((segment) => {
    const refs = { segment_id: segment.id, sequence: segment.sequence };
    const hasStart = typeof segment.start_ms === "number" && Number.isFinite(segment.start_ms);
    const hasEnd = typeof segment.end_ms === "number" && Number.isFinite(segment.end_ms);
    if (!hasStart || !hasEnd) add("clip_missing_timing", "error", "This audio clip is missing finite source timing.", refs);
    else if (segment.start_ms < 0 || segment.end_ms < 0) add("clip_negative_timing", "error", "Audio clip timing cannot be negative.", refs);
    else if (segment.start_ms > segment.end_ms) add("clip_start_after_end", "error", "Audio clip start time is after its end time.", refs);
    else if (segment.start_ms === segment.end_ms) add("clip_zero_duration", "error", "Every audio clip needs a non-zero duration.", refs);
    if (segment.upload_status === "pending") add("clip_upload_pending", "error", "This audio clip is still uploading.", refs);
    if (segment.upload_status === "failed") add("clip_upload_failed", "error", "This audio clip did not finish uploading.", refs);
    if (segment.upload_status === "uploaded" && getTranscriptionStatus(segment) !== "completed") add("clip_transcription_incomplete", "error", "Finish or retry transcription for this uploaded clip.", refs);
    if (segment.upload_status === "uploaded" && getTranscriptionStatus(segment) === "completed" && !lines.some((line) => line.source_segment_id === segment.id)) {
      add("clip_missing_transcript", "error", "This completed clip has no grouped transcript line.", refs);
    }
  });

  if (uploaded.some((segment) => getTranscriptionStatus(segment) === "completed") && !lines.length) {
    add("no_transcript_lines", "error", "Completed audio exists, but there are no transcript lines to review.");
  }

  lines.forEach((line) => {
    const refs = { line_id: line.id, sequence: line.sequence };
    if (line.session_id !== input.session.id) add("line_wrong_session", "error", "This transcript line belongs to a different session.", refs);
    inspectLineTags(line, lines, add);
    if (line.kind !== "speech") return;
    const text = line.text?.trim() || "";
    if (!text) add("speech_empty", "error", "Speech content is missing from this line.", refs);
    if (!line.speaker_label?.trim()) add("speaker_missing", "error", "Add a speaker label to this speech line.", refs);
    const hasStart = typeof line.start_ms === "number" && Number.isFinite(line.start_ms);
    const hasEnd = typeof line.end_ms === "number" && Number.isFinite(line.end_ms);
    if (!hasStart || !hasEnd) add("line_missing_timing", "error", "Speech lines need finite start and end timing.", refs);
    else if (line.start_ms < 0 || line.end_ms < 0) add("line_negative_timing", "error", "Speech timing cannot be negative.", refs);
    else if (line.start_ms > line.end_ms) add("line_start_after_end", "error", "Speech line start time is after its end time.", refs);
    else if (line.start_ms === line.end_ms) add("line_zero_duration", "error", "Speech lines need a non-zero timing range.", refs);
    const lexical = stripPulsarTags(line.text || "");
    if (/\p{Lu}/u.test(lexical)) add("uppercase_text", "error", "Pulsar review words must be lowercase.", refs);
    if (/[^\p{L}\p{N}\s'-]/u.test(lexical) || /-{2,}/.test(lexical)) add("forbidden_punctuation", "error", "Use lowercase words with apostrophes or approved single hyphens only.", refs);
  });

  const latestBySpeaker = new Map<string, TranscriptLineRecord>();
  lines.filter((line) => line.kind === "speech").forEach((line) => {
    if (typeof line.start_ms !== "number" || typeof line.end_ms !== "number" || !Number.isFinite(line.start_ms) || !Number.isFinite(line.end_ms) || line.start_ms >= line.end_ms) return;
    const key = line.speaker_label?.trim().toLowerCase();
    if (!key) return;
    const previous = latestBySpeaker.get(key);
    if (previous && line.start_ms < (previous.end_ms as number)) {
      add("same_speaker_overlap", "error", "Adjacent same-speaker speech ranges overlap. Different-speaker overlaps are allowed.", { line_id: line.id, sequence: line.sequence, reference_line_id: previous.id });
    }
    if (!previous || (line.end_ms as number) > (previous.end_ms as number)) latestBySpeaker.set(key, line);
  });

  if (!findings.length) add("qa_passed", "info", "No local Pulsar rule violations found.");
  const result: PulsarQaResult = { findings, summary: summaryFor(findings) };
  const timestamp = ranAt || input.session.pulsar_qa_ran_at;
  if (timestamp) result.ran_at = timestamp;
  return result;
}

export function getPulsarClipStatus(segment: AudioSegmentRecord): PulsarClipStatus {
  return segment.pulsar_review_status || "not_started";
}

export function calculatePulsarReadiness(input: {
  session: TranscriptionSessionRecord;
  lines: TranscriptLineRecord[];
  segments: AudioSegmentRecord[];
  qa: PulsarQaResult;
}): PulsarReadinessResult {
  const uploaded = input.segments.filter((segment) => segment.upload_status === "uploaded");
  const reviewed = uploaded.filter((segment) => getPulsarClipStatus(segment) === "done");
  const unreviewedIds = uploaded.filter((segment) => getPulsarClipStatus(segment) !== "done").map((segment) => segment.id);
  const blockers = input.qa.findings.filter((finding) => finding.severity === "error").map((finding) => ({ ...finding }));
  if (!input.qa.ran_at) blockers.push({ id: "qa_not_run", code: "qa_not_run", severity: "error", message: "Run local Pulsar QA before marking this session ready." });
  if (unreviewedIds.length) blockers.push({ id: "clips_unreviewed", code: "clips_unreviewed", severity: "error", message: `${unreviewedIds.length} uploaded clip${unreviewedIds.length === 1 ? " is" : "s are"} not marked reviewed.` });
  const eligible = blockers.length === 0 && uploaded.length > 0;
  const hasActivity = Boolean(input.lines.length || input.segments.length || input.qa.ran_at || (input.session.pulsar_readiness && input.session.pulsar_readiness !== "not_started"));
  const state = eligible && input.session.pulsar_readiness === "ready" ? "ready" : hasActivity ? "in_progress" : "not_started";
  return {
    state,
    eligible,
    uploaded_clip_count: uploaded.length,
    reviewed_clip_count: reviewed.length,
    unreviewed_segment_ids: unreviewedIds,
    progress_percent: uploaded.length ? Math.round((reviewed.length / uploaded.length) * 100) : 0,
    blockers,
  };
}

export function insertPulsarTag(text: string, tag: PulsarTagDefinition): { ok: true; text: string } | { ok: false; reason: string } {
  const current = text.trim();
  if (tag.standalone && current) return { ok: false, reason: `${tag.displayLabel} must stand alone, so it was not inserted into this line.` };
  if (tag.discard && tag.insertMode === "standalone" && current) return { ok: false, reason: "Discard tags cannot be mixed with existing transcript content." };
  if (tag.insertMode === "wrap") {
    if (!current) return { ok: false, reason: "Write or select existing line text before wrapping it." };
    if (tag.wrapperName) return { ok: true, text: `${tag.allowedTokens?.[0] || `<${tag.wrapperName}>`}${current}${tag.allowedTokens?.[1] || `</${tag.wrapperName}>`}` };
    return { ok: true, text: `((${current}))` };
  }
  if (tag.insertMode === "append_direct") return { ok: true, text: `${text.trimEnd()}${tag.insertionValue}` };
  if (!current) return { ok: true, text: tag.insertionValue };
  return { ok: true, text: `${text.trimEnd()} ${tag.insertionValue}` };
}

export function pulsarExportFilename(title: string, sessionId: string): string {
  const safeTitle = (title || "session").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "session";
  const safeId = (sessionId || "local").replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "local";
  return `${safeTitle}-pulsar-review-${safeId}.json`;
}

export function buildPulsarExportPackage(input: {
  session: TranscriptionSessionRecord;
  lines: TranscriptLineRecord[];
  segments: AudioSegmentRecord[];
  issues: AudioIssueRecord[];
  annotations: TranscriptAnnotationRecord[];
  qa: PulsarQaResult;
  readiness: PulsarReadinessResult;
  exportedAt?: string;
}): PulsarJsonExportPackage {
  const session = input.session;
  return {
    package_type: "verbatim_desk_pulsar_review",
    package_version: "1.0",
    local_only: true,
    exported_at: input.exportedAt || new Date().toISOString(),
    external_submission: { attempted: false, status: "not_submitted", note: "This package is a local browser export. No Labelbox or Vercel submission was attempted." },
    session: {
      id: session.id, title: session.title, status: session.status, source_label: session.source_label || "", review_mode: session.review_mode || "standard",
      transcript_style: session.transcript_style || "full_verbatim", speaker_scheme: session.speaker_scheme || "numbered", language: session.language || "auto",
      language_mode: session.language_mode || "auto", language_preferences: session.language_preferences || [], accent_hint: session.accent_hint || "",
      started_at: session.started_at || "", ended_at: session.ended_at || "", pulsar_readiness: session.pulsar_readiness || "not_started", pulsar_qa_ran_at: session.pulsar_qa_ran_at || "",
    },
    source_timing: {
      duration_ms: session.duration_ms || 0, capture_started_at: session.capture_started_at || "", capture_ended_at: session.capture_ended_at || "",
      meaningful_audio_started_ms: session.meaningful_audio_started_ms, meaningful_audio_ended_ms: session.meaningful_audio_ended_ms,
      leading_silence_ms: session.leading_silence_ms, trailing_silence_ms: session.trailing_silence_ms, audio_phase: session.audio_phase || "waiting", audio_clock_source: session.audio_clock_source,
    },
    transcript_lines: sortTranscriptLines(input.lines).map((line) => ({
      id: line.id, session_id: line.session_id, sequence: line.sequence, kind: line.kind, speaker_label: line.speaker_label || "", text: line.text || "",
      start_ms: line.start_ms, end_ms: line.end_ms, source_segment_id: line.source_segment_id, origin: line.origin, raw_text: line.raw_text,
      edit_state: line.edit_state, cleanup_applied: line.cleanup_applied, audio_event_tags: line.audio_event_tags || [],
    })),
    audio_clips: [...input.segments].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)).map((segment) => ({
      id: segment.id, session_id: segment.session_id, sequence: segment.sequence, audio_url: segment.audio_url, mime_type: segment.mime_type, byte_size: segment.byte_size,
      start_ms: segment.start_ms, end_ms: segment.end_ms, upload_status: segment.upload_status, transcription_status: getTranscriptionStatus(segment), transcription_error: segment.transcription_error,
      detected_language: segment.detected_language, detected_languages: segment.detected_languages || [], speaker_count: segment.speaker_count, word_count: segment.word_count,
      pulsar_review_status: getPulsarClipStatus(segment), is_final_segment: segment.is_final_segment,
    })),
    issues: input.issues.map((issue) => ({ id: issue.id, session_id: issue.session_id, kind: issue.kind, severity: issue.severity, timestamp_ms: issue.timestamp_ms, end_timestamp_ms: issue.end_timestamp_ms, notes: issue.notes || "", source: issue.source, possible: issue.possible })),
    annotations: input.annotations.map((annotation) => ({ id: annotation.id, session_id: annotation.session_id, start_ms: annotation.start_ms, end_ms: annotation.end_ms, label: annotation.label, notes: annotation.notes || "", color: annotation.color, category: annotation.category, sequence: annotation.sequence })),
    tag_vocabulary: { version: PULSAR_TAG_VERSION, tags: PULSAR_TAG_VOCABULARY.map((tag) => ({ ...tag, allowedTokens: tag.allowedTokens ? [...tag.allowedTokens] : undefined })) },
    qa: { ran_at: input.qa.ran_at, findings: input.qa.findings.map((finding) => ({ ...finding })), summary: { ...input.qa.summary } },
    readiness: { ...input.readiness, unreviewed_segment_ids: [...input.readiness.unreviewed_segment_ids], blockers: input.readiness.blockers.map((finding) => ({ ...finding })) },
  };
}
