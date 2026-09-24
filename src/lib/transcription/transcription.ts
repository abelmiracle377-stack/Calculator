import type {
  AudioSegmentRecord,
  CleanupProposal,
  LanguageMode,
  LanguageDetectionSummary,
  TimestampCadence,
  TranscriptLineRecord,
  TranscriptionCounts,
  TranscriptionSessionRecord,
  TranscriptionStatus,
} from "./types";

export type CanonicalTimestampCadence = Exclude<TimestampCadence, "30s" | "60s">;

const AUTO_LANGUAGE_VALUES = new Set(["", "auto", "automatic", "detect", "multilingual"]);
const LANGUAGE_ALIASES: Record<string, string> = {
  english: "en", "english (us)": "en", "us english": "en", "american english": "en", "british english": "en",
  spanish: "es", french: "fr", german: "de", italian: "it", portuguese: "pt", dutch: "nl",
  polish: "pl", russian: "ru", ukrainian: "uk", arabic: "ar", hindi: "hi", japanese: "ja",
  korean: "ko", chinese: "zh", mandarin: "zh", turkish: "tr", indonesian: "id", filipino: "fil",
  malay: "ms", romanian: "ro", greek: "el", czech: "cs", danish: "da", finnish: "fi",
  bulgarian: "bg", croatian: "hr", slovak: "sk", swedish: "sv", tamil: "ta", telugu: "te",
  hungarian: "hu", norwegian: "no", vietnamese: "vi", hebrew: "he", thai: "th", urdu: "ur",
  bengali: "bn", catalan: "ca",
};
const LANGUAGE_CODE_ALIASES: Record<string, string> = {
  afr: "af", amh: "am", ara: "ar", aze: "az", ben: "bn", bul: "bg", cat: "ca", ces: "cs", cze: "cs",
  dan: "da", deu: "de", ger: "de", ell: "el", gre: "el", eng: "en", spa: "es", fin: "fi", fil: "fil",
  fra: "fr", fre: "fr", heb: "he", hin: "hi", hrv: "hr", hun: "hu", ind: "id", ita: "it", jpn: "ja",
  kor: "ko", msa: "ms", may: "ms", nld: "nl", dut: "nl", nor: "no", pol: "pl", por: "pt", ron: "ro",
  rum: "ro", rus: "ru", slk: "sk", slo: "sk", swe: "sv", tam: "ta", tel: "te", tha: "th", tur: "tr",
  ukr: "uk", urd: "ur", vie: "vi", zho: "zh", cmn: "zh",
};
const KNOWN_LANGUAGE_CODES = new Set([
  "ar", "bg", "bn", "ca", "cs", "da", "de", "el", "en", "es", "fi", "fil", "fr", "he", "hi", "hr",
  "hu", "id", "it", "ja", "ko", "ms", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sv", "ta", "te",
  "th", "tr", "uk", "ur", "vi", "zh",
]);
const LANGUAGE_LABELS: Record<string, string> = {
  ar: "Arabic", bg: "Bulgarian", bn: "Bengali", ca: "Catalan", cs: "Czech", da: "Danish", de: "German",
  el: "Greek", en: "English", es: "Spanish", fi: "Finnish", fil: "Filipino", fr: "French", he: "Hebrew",
  hi: "Hindi", hr: "Croatian", hu: "Hungarian", id: "Indonesian", it: "Italian", ja: "Japanese", ko: "Korean",
  ms: "Malay", nl: "Dutch", no: "Norwegian", pl: "Polish", pt: "Portuguese", ro: "Romanian", ru: "Russian",
  sk: "Slovak", sv: "Swedish", ta: "Tamil", te: "Telugu", th: "Thai", tr: "Turkish", uk: "Ukrainian",
  ur: "Urdu", vi: "Vietnamese", zh: "Chinese",
};

export function isAutomaticLanguageValue(value: unknown): boolean {
  return typeof value !== "string" || AUTO_LANGUAGE_VALUES.has(value.trim().toLowerCase());
}

/** Keeps the user's language wording while limiting it to safe, comma-separated preferences. */
export function parseLanguagePreferences(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return Array.from(new Set(source
    .flatMap((item) => typeof item === "string" ? item.split(",") : [])
    .map((item) => item.trim().replace(/\s+/g, " ").slice(0, 80))
    .filter((item) => item && !isAutomaticLanguageValue(item))))
    .slice(0, 8);
}

/** Returns a provider-safe ISO code, never treating an accent or dialect alone as a language. */
export function normalizeLanguageCode(value: unknown): string {
  if (typeof value !== "string") return "";
  const raw = value.trim().toLowerCase().replace(/_/g, "-").replace(/\s+/g, " ");
  if (AUTO_LANGUAGE_VALUES.has(raw)) return "";
  const withoutQualifier = raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (LANGUAGE_CODE_ALIASES[raw]) return LANGUAGE_CODE_ALIASES[raw];
  if (LANGUAGE_ALIASES[raw]) return LANGUAGE_ALIASES[raw];
  if (LANGUAGE_CODE_ALIASES[withoutQualifier]) return LANGUAGE_CODE_ALIASES[withoutQualifier];
  if (LANGUAGE_ALIASES[withoutQualifier]) return LANGUAGE_ALIASES[withoutQualifier];
  const base = raw.split("-")[0];
  return KNOWN_LANGUAGE_CODES.has(base) ? base : "";
}

export function getLanguageMode(mode: unknown, legacyLanguage: unknown): LanguageMode {
  if (mode === "manual") return "manual";
  if (mode === "auto") return "auto";
  return parseLanguagePreferences(legacyLanguage).length ? "manual" : "auto";
}

export function getSessionLanguageMode(session: Pick<TranscriptionSessionRecord, "language_mode" | "language">): LanguageMode {
  return getLanguageMode(session.language_mode, session.language);
}

export function getManualLanguagePreferences(session: Pick<TranscriptionSessionRecord, "language_mode" | "language" | "language_preferences">): string[] {
  const saved = Array.isArray(session.language_preferences) ? parseLanguagePreferences(session.language_preferences) : [];
  return saved.length ? saved : parseLanguagePreferences(session.language);
}

export function normalizeDetectedLanguages(values: unknown[]): string[] {
  const output: string[] = [];
  const add = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(add); return; }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      ["language_code", "language", "code", "lang"].forEach((key) => { if (key in record) add(record[key]); });
      return;
    }
    if (typeof value !== "string") return;
    const raw = value.trim();
    if (!raw || isAutomaticLanguageValue(raw)) return;
    const code = normalizeLanguageCode(raw);
    const normalized = (code || raw.toLowerCase().replace(/[^a-z0-9 _-]/g, " ").replace(/\s+/g, " ").trim()).slice(0, 40);
    if (normalized && !output.some((item) => item.toLowerCase() === normalized.toLowerCase())) output.push(normalized);
  };
  values.forEach(add);
  return output;
}

export function detectedLanguagesForSegment(segment: Pick<AudioSegmentRecord, "detected_language" | "detected_languages"> | undefined): string[] {
  if (!segment) return [];
  return normalizeDetectedLanguages([...(segment.detected_languages || []), segment.detected_language]);
}

export function aggregateDetectedLanguages(segments: AudioSegmentRecord[], fallback: string[] = []): string[] {
  return normalizeDetectedLanguages([
    ...fallback,
    ...segments.flatMap((segment) => detectedLanguagesForSegment(segment)),
  ]);
}

export function averageLanguageConfidence(segments: AudioSegmentRecord[]): number | undefined {
  const values = segments
    .map((segment) => segment.language_probability)
    .filter((value): value is number => Number.isFinite(value) && value >= 0 && value <= 1);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

export function formatConfidenceText(value: number | undefined): string {
  return Number.isFinite(value) && (value as number) >= 0 && (value as number) <= 1
    ? `${Math.round((value as number) * 100)}% confidence`
    : "Confidence unavailable";
}

export function languageLabel(value: string): string {
  const code = normalizeLanguageCode(value);
  return LANGUAGE_LABELS[code] || value.trim() || "Unknown language";
}

export function formatLanguageList(values: string[]): string {
  return values.map(languageLabel).join(", ");
}

export function languageModeLabel(mode: LanguageMode): string {
  return mode === "manual" ? "Manual hints" : "Auto detect";
}

export function getLanguageDetectionSummary(
  segments: AudioSegmentRecord[],
  fallback: string[] = []
): LanguageDetectionSummary {
  return { languages: aggregateDetectedLanguages(segments, fallback), confidence: averageLanguageConfidence(segments) };
}

export function getTranscriptionStatus(segment: AudioSegmentRecord): TranscriptionStatus {
  if (segment.transcription_status) return segment.transcription_status;
  return segment.upload_status === "uploaded" ? "pending" : "pending";
}

export function getTranscriptionCounts(segments: AudioSegmentRecord[]): TranscriptionCounts {
  const counts: TranscriptionCounts = { total: 0, pending: 0, active: 0, completed: 0, failed: 0 };
  segments.forEach((segment) => {
    if (segment.upload_status !== "uploaded") return;
    counts.total += 1;
    const status = getTranscriptionStatus(segment);
    if (status === "transcribing") counts.active += 1;
    else if (status === "completed") counts.completed += 1;
    else if (status === "failed") counts.failed += 1;
    else counts.pending += 1;
  });
  return counts;
}

export function sortTranscriptLines(lines: TranscriptLineRecord[]): TranscriptLineRecord[] {
  return [...lines].sort((a, b) => {
    const sequenceDelta = (a.sequence ?? 0) - (b.sequence ?? 0);
    return sequenceDelta || (a.start_ms ?? 0) - (b.start_ms ?? 0);
  });
}

export function normalizeDisplayLabel(label: string | undefined, index: number): string {
  return label?.trim() || `Speaker ${index + 1}`;
}

export function normalizeTimestampCadence(value: TimestampCadence | string | undefined): CanonicalTimestampCadence {
  switch (value) {
    case "speaker_change":
    case "two_minutes":
    case "both":
    case "manual":
    case "none":
      return value;
    // Older cadence choices are kept in storage but shown as a safe manual choice.
    case "30s":
    case "60s":
    default:
      return "manual";
  }
}

export function timestampCadenceLabel(value: TimestampCadence | string | undefined): string {
  switch (normalizeTimestampCadence(value)) {
    case "speaker_change": return "Every speaker change";
    case "two_minutes": return "Every two minutes";
    case "both": return "Speaker changes and every two minutes";
    case "none": return "No automatic marks";
    default: return "Manual marks only";
  }
}

export function isGeneratedLine(line: TranscriptLineRecord): boolean {
  return line.origin === "generated" || line.edit_state === "provider";
}

export function isManualLine(line: TranscriptLineRecord): boolean {
  return !isGeneratedLine(line);
}

export function providerTimestamp(ms: number | undefined): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.round(ms as number));
}

export function extractBracketedTags(text: string): string[] {
  return text.match(/\[[^\]\r\n]{1,160}\]/g) ?? [];
}

function unclearTagIsExact(tag: string): boolean {
  return /^\[(?:inaudible|unintelligible) \d{2}:\d{2}:\d{2}\]$/.test(tag);
}

function hasParenthesizedTag(text: string): boolean {
  return /\(\s*(?:inaudible|unintelligible|laughs?|laughter|coughs?|sighs?|background noise|crosstalk|silence)\b[^)]*\)/i.test(text);
}

function wordsForComparison(text: string): string[] {
  return text
    .replace(/\[[^\]]+\]/g, " ")
    .toLowerCase()
    .match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];
}

function appearsToParaphrase(original: string, candidate: string): boolean {
  const originalWords = wordsForComparison(original);
  const candidateWords = wordsForComparison(candidate);
  if (originalWords.length < 6) return false;
  const overlap = candidateWords.filter((word) => originalWords.includes(word)).length;
  return overlap < Math.max(2, Math.floor(originalWords.length * 0.25));
}

export function validateCleanupCandidate(
  original: string,
  candidate: string
): { valid: boolean; reason?: string } {
  const proposed = candidate.trim();
  if (!proposed) return { valid: false, reason: "The proposed text is empty." };
  const expectedTags = extractBracketedTags(original);
  const receivedTags = extractBracketedTags(proposed);
  if (expectedTags.length !== receivedTags.length || expectedTags.some((tag, index) => tag !== receivedTags[index])) {
    return { valid: false, reason: "Bracketed event tags must stay unchanged and in order." };
  }
  if (receivedTags.some((tag) => /^(?:\[)(?:inaudible|unintelligible)\b/i.test(tag) && !unclearTagIsExact(tag))) {
    return { valid: false, reason: "Unclear-audio marks must use the exact timestamp format." };
  }
  if (/[!]/.test(proposed)) return { valid: false, reason: "Exclamation marks are not allowed." };
  if (/\[sic\]/i.test(proposed)) return { valid: false, reason: "The [sic] tag is not allowed." };
  if (hasParenthesizedTag(proposed)) return { valid: false, reason: "Audio tags must use square brackets." };
  if (appearsToParaphrase(original, proposed)) return { valid: false, reason: "The suggestion changes too much of the spoken content." };
  return { valid: true };
}

/** Rejects AI output when it removes, changes, or invents bracketed events. */
export function preserveBracketedEventTags(original: string, candidate: string): string {
  const expected = extractBracketedTags(original);
  const received = extractBracketedTags(candidate);
  if (expected.length !== received.length || expected.some((tag, index) => tag !== received[index])) return original;
  return candidate;
}

/** Returns session-relative automatic timestamp marks without resetting at clip boundaries. */
export function getCadenceMarks(
  lines: TranscriptLineRecord[],
  durationMs: number,
  cadence: TimestampCadence | string | undefined
): number[] {
  const rawCadence = cadence || "manual";
  const normalized = normalizeTimestampCadence(rawCadence);
  const sessionDuration = Math.max(durationMs || 0, ...lines.map((line) => line.end_ms || line.start_ms || 0));
  const marks: number[] = [];
  const add = (value: number) => { if (Number.isFinite(value) && value >= 0) marks.push(Math.round(value)); };
  const addSpeakerMarks = normalized === "speaker_change" || normalized === "both";
  if (addSpeakerMarks) {
    let previousSpeaker = "";
    sortTranscriptLines(lines).forEach((line) => {
      if (line.kind !== "speech" || line.start_ms == null) return;
      const speaker = normalizeDisplayLabel(line.speaker_label, 0);
      if (!previousSpeaker || previousSpeaker !== speaker) add(line.start_ms);
      previousSpeaker = speaker;
    });
  }
  const legacyStep = rawCadence === "30s" ? 30_000 : rawCadence === "60s" ? 60_000 : 0;
  const step = legacyStep || (normalized === "two_minutes" || normalized === "both" ? 120_000 : 0);
  if (step > 0) for (let time = step; time < sessionDuration; time += step) add(time);
  return Array.from(new Set(marks)).sort((a, b) => a - b);
}

export function cleanupProposalForLine(line: TranscriptLineRecord, proposedText: string): CleanupProposal | null {
  const original = line.text || "";
  const candidate = proposedText.trim();
  if (!validateCleanupCandidate(original, candidate).valid || !candidate || candidate === original.trim()) return null;
  return {
    line_id: line.id,
    original_text: original,
    proposed_text: candidate,
    speaker_label: normalizeDisplayLabel(line.speaker_label, 0),
    start_ms: line.start_ms,
    end_ms: line.end_ms,
  };
}
