import { getCadenceMarks } from "./transcription";
import type {
  TranscriptAnnotationRecord,
  TranscriptLineRecord,
  TranscriptStyle,
  TimestampCadence,
} from "./types";

const TAG_PATTERN = /\[[^\]\r\n]{1,160}\]/g;
const FILLER_PATTERN = /(^|[\s,(;:])(?:um+|uh+|er+|ah+|hmm+)(?=$|[\s,.;:!?])/gi;
const EMPHATIC_WORDS = new Set(["no", "yes", "very", "so", "never", "okay"]);

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

/** Full session time with fixed hours and hundredths, used for speech ranges. */
export function formatSessionTimestamp(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms || 0));
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(Math.floor((safeMs % 1000) / 10))}`;
}

/** Kept for existing issue and timeline displays. */
export function formatTimestamp(ms: number): string {
  return formatSessionTimestamp(ms);
}

/** Required export timestamp form, with hours and no decimals. */
export function formatExportTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(Math.max(0, Math.round(ms || 0)) / 1000));
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor((totalSeconds % 3600) / 60))}:${pad(totalSeconds % 60)}`;
}

/** Legacy precise tag for editor-adjacent surfaces. Export marks use formatExportTimestampTag. */
export function formatTimestampTag(ms: number): string {
  return `[${formatSessionTimestamp(ms)}]`;
}

export function formatExportTimestampTag(ms: number): string {
  return `[${formatExportTimestamp(ms)}]`;
}

export function formatLineTimestampRange(line: TranscriptLineRecord): string | null {
  if (line.start_ms == null && line.end_ms == null) return null;
  const start = line.start_ms ?? line.end_ms ?? 0;
  const end = Math.max(start, line.end_ms ?? start);
  return `[${formatSessionTimestamp(start)}–${formatSessionTimestamp(end)}]`;
}

/** Formats a source position without inventing an end when a provider omitted it. */
export function formatTimestampRange(startMs: number, endMs?: number): string {
  const start = formatSessionTimestamp(startMs);
  if (endMs == null || endMs <= startMs) return `[${start}]`;
  return `[${start}–${formatSessionTimestamp(endMs)}]`;
}

export function formatIssueTimestampRange(timestampMs: number, endTimestampMs?: number): string {
  return formatTimestampRange(timestampMs, endTimestampMs);
}

function protectTags(text: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  const protectedText = text.replace(TAG_PATTERN, (tag) => {
    const index = tags.length;
    tags.push(tag);
    return `__TX_TAG_${index}__`;
  });
  return { text: protectedText, tags };
}

function restoreTags(text: string, tags: string[]): string {
  return tags.reduce((current, tag, index) => current.replaceAll(`__TX_TAG_${index}__`, tag), text);
}

function removeNonEmphaticRepeats(text: string): string {
  return text.replace(/\b([A-Za-z][A-Za-z']*)\s+\1\b/gi, (match, word: string, offset: number, source: string) => {
    const before = source.slice(0, offset);
    const after = source.slice(offset + match.length);
    if (EMPHATIC_WORDS.has(word.toLowerCase()) || /[,;:]\s*$/.test(before) || /^\s*[,;:]/.test(after)) return match;
    return word;
  });
}

function cleanTextBody(text: string): string {
  let cleaned = text
    .replace(/\bgotcha\b/gi, "got you")
    .replace(/\bgonna\b/gi, "going to")
    .replace(/\bwanna\b/gi, "want to")
    .replace(/\bkinda\b/gi, "kind of")
    .replace(/\bgotta\b/gi, "have to")
    .replace(/\bbetcha\b/gi, "bet you")
    .replace(/\bdunno\b/gi, "don't know")
    .replace(/\B'cause\b/gi, "because")
    .replace(/\b(?:yeah|yep|yap|yup|mm[\s-]?hmm)\b/gi, "yes")
    .replace(/\buh[\s-]?huh\b/gi, "yes")
    .replace(/\bmm[\s-]?mm\b/gi, "no")
    .replace(/\buh[\s-]?uh\b/gi, "no")
    .replace(/\balright\b/gi, "all right")
    .replace(/\b(?:ok|okay)\b/gi, "Okay")
    .replace(/\b([A-Za-z]{1,5})-([A-Za-z][A-Za-z']*)\b/gi, (match, prefix: string, word: string) =>
      word.toLowerCase().startsWith(prefix.toLowerCase()) ? word : match
    )
    .replace(/\b([A-Za-z]{1,3})(?:-\1)+-([A-Za-z][A-Za-z']*)\b/gi, "$2")
    .replace(/\b([A-Za-z]{1,3})-\1\b/gi, "$1")
    .replace(FILLER_PATTERN, "$1")
    .replace(/(^|[,;:]\s*)(?:you know|i mean|well)(?=\s*[,.;:]|\s*$)/gi, "$1")
    .replace(/(^|[,;:]\s*)(?:sort of|kind of)(?=\s*[,.;:]|\s*$)/gi, "$1");

  cleaned = removeNonEmphaticRepeats(cleaned)
    .replace(/!+/g, ".")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:?])/g, "$1")
    .trim()
    .replace(/(^|[.!?]\s+)([a-z])/g, (_, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`);
  return cleaned;
}

/** Conservative clean-verbatim display. Bracketed event tags are protected byte-for-byte. */
export function applyCleanVerbatim(raw: string): string {
  if (!raw) return "";
  const protectedValue = protectTags(raw);
  return restoreTags(cleanTextBody(protectedValue.text), protectedValue.tags).replace(/\s{2,}/g, " ").trim();
}

export interface LinePreviewParts {
  timing: string | null;
  speaker: string;
  text: string;
}

export function linePreviewParts(line: TranscriptLineRecord, style: TranscriptStyle): LinePreviewParts {
  const text = style === "clean_verbatim" ? applyCleanVerbatim(line.text || "") : (line.text || "").trim();
  if (line.kind === "timestamp") return { timing: formatExportTimestampTag(line.start_ms ?? 0), speaker: "", text: "" };
  if (line.kind === "marker") {
    const marker = text || "Marker";
    const unclear = /^\[(?:inaudible|unintelligible) \d{2}:\d{2}:\d{2}\]$/.test(marker);
    const automatic = Boolean(line.automatic_marker || (line.origin === "generated" && line.audio_event_source === "provider"));
    if (unclear) return { timing: null, speaker: "", text: marker };
    if (automatic) {
      return { timing: line.start_ms != null ? formatTimestampRange(line.start_ms, line.end_ms) : null, speaker: "", text: marker };
    }
    return { timing: line.start_ms != null ? formatExportTimestampTag(line.start_ms) : null, speaker: "", text: `Note: ${marker}` };
  }
  return {
    timing: formatLineTimestampRange(line),
    speaker: line.speaker_label?.trim() || "Speaker 1",
    text,
  };
}

export function formatLineForPreview(line: TranscriptLineRecord, style: TranscriptStyle): string {
  const parts = linePreviewParts(line, style);
  return [parts.timing, parts.speaker ? `${parts.speaker}:` : "", parts.text].filter(Boolean).join(" ").trim();
}

export function formatAnnotationForPreview(annotation: TranscriptAnnotationRecord): string {
  const start = formatExportTimestampTag(annotation.start_ms);
  const end = formatExportTimestampTag(annotation.end_ms);
  const label = annotation.label.trim() || "Untitled section";
  const notes = annotation.notes?.trim();
  return `${start} to ${end} | ${label}${notes ? `: ${notes}` : ""}`;
}

export type PreviewRow = {
  key: string;
  text: string;
  kind: "line" | "annotation" | "timestamp";
  line?: TranscriptLineRecord;
};

export function buildPreviewRows(
  lines: TranscriptLineRecord[],
  annotations: TranscriptAnnotationRecord[],
  style: TranscriptStyle,
  cadence: TimestampCadence | string = "manual",
  durationMs = 0
): PreviewRow[] {
  const sortedLines = [...lines].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const sortedAnnotations = [...annotations].sort((a, b) => (a.start_ms - b.start_ms) || (a.sequence - b.sequence));
  const cadenceMarks = getCadenceMarks(sortedLines, durationMs, cadence);
  const manualMarks = sortedLines.filter((line) => line.kind === "timestamp").map((line) => line.start_ms ?? 0);
  const rows: PreviewRow[] = [];
  let annotationIndex = 0;
  let cadenceIndex = 0;
  const pushCadenceBefore = (time: number) => {
    while (cadenceIndex < cadenceMarks.length && cadenceMarks[cadenceIndex] <= time) {
      const mark = cadenceMarks[cadenceIndex];
      if (!manualMarks.some((manual) => Math.abs(manual - mark) < 500)) rows.push({ key: `cadence-${mark}`, text: formatExportTimestampTag(mark), kind: "timestamp" });
      cadenceIndex += 1;
    }
  };

  sortedLines.forEach((line) => {
    const lineTime = line.start_ms ?? line.end_ms ?? 0;
    while (annotationIndex < sortedAnnotations.length && sortedAnnotations[annotationIndex].start_ms <= lineTime) {
      const annotation = sortedAnnotations[annotationIndex];
      rows.push({ key: `annotation-${annotation.id}`, text: formatAnnotationForPreview(annotation), kind: "annotation" });
      annotationIndex += 1;
    }
    pushCadenceBefore(lineTime);
    rows.push({ key: `line-${line.id}`, text: formatLineForPreview(line, style), kind: line.kind === "timestamp" ? "timestamp" : "line", line });
  });
  while (annotationIndex < sortedAnnotations.length) {
    const annotation = sortedAnnotations[annotationIndex];
    rows.push({ key: `annotation-${annotation.id}`, text: formatAnnotationForPreview(annotation), kind: "annotation" });
    annotationIndex += 1;
  }
  pushCadenceBefore(Number.POSITIVE_INFINITY);
  return rows;
}

export function buildPlainTextExport(
  lines: TranscriptLineRecord[],
  style: TranscriptStyle,
  title: string,
  annotations: TranscriptAnnotationRecord[] = [],
  cadence: TimestampCadence | string = "manual",
  durationMs = 0
): string {
  const header = [
    title || "Untitled session",
    `Style: ${style === "clean_verbatim" ? "Clean verbatim" : "Full verbatim"}`,
    "Speech ranges use full recording time with hundredths. Export timestamp marks use [HH:MM:SS].",
    "Sound-event tags stay in square brackets and are preserved from the audio transcription.",
    "",
  ].join("\n");
  const body = buildPreviewRows(lines, annotations, style, cadence, durationMs)
    .map((row) => row.text)
    .filter(Boolean)
    .join("\n");
  return `${header}${body || "(No transcript lines yet)"}\n`;
}

export function defaultSpeakers(scheme: string | undefined, custom: string[] | undefined): string[] {
  if (scheme === "letters") return ["A", "B", "C", "D"];
  if (scheme === "custom" && custom?.length) return custom;
  return ["Speaker 1", "Speaker 2", "Speaker 3", "Speaker 4"];
}

export function statusLabel(status: string): string {
  switch (status) {
    case "recording": return "Recording";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "discarded": return "Discarded";
    default: return status;
  }
}

export function issueLabel(kind: string): string {
  switch (kind) {
    case "clipping": return "Clipping";
    case "possible_clipping": return "Possible clipping";
    case "possible_pop_click": return "Possible pop or click";
    case "possible_distortion": return "Possible distortion";
    case "silence": return "Prolonged silence";
    case "leading_silence": return "Leading silence";
    case "trailing_silence": return "Trailing silence";
    case "source_signal_start": return "Meaningful audio started";
    case "source_signal_end": return "Meaningful audio ended";
    case "missing_audio": return "Missing audio";
    case "sharing_ended": return "Sharing ended";
    case "recorder_error": return "Recorder error";
    case "upload_failure": return "Upload failed";
    case "transcription_failure": return "Transcription failed";
    default: return kind;
  }
}
