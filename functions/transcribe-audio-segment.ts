import { createSuperdevClient } from "npm:@superdevhq/client@0.1.56";

type JsonRecord = Record<string, unknown>;
type SafeSegment = JsonRecord & { id: string; session_id: string };

type SuperdevClient = ReturnType<typeof createSuperdevClient>;

type Token = {
  text: string;
  type: "word" | "event";
  startMs?: number;
  endMs?: number;
  timingPresent: boolean;
  speakerId: string;
  confidence?: number;
};

type GroupedLine = {
  kind: "speech" | "marker";
  text: string;
  raw_text?: string;
  start_ms?: number;
  end_ms?: number;
  provider_start_ms?: number;
  provider_end_ms?: number;
  speaker_label?: string;
  provider_speaker_id?: string;
  confidence?: number;
  audio_event_tags: string[];
  word_count: number;
  automatic_marker?: boolean;
  audio_event_source?: "provider";
  audio_event_type?: string;
  audio_event_confidence?: number;
};

const MAX_AUDIO_SIZE_MB = 100;
const MAX_AUDIO_BYTES = MAX_AUDIO_SIZE_MB * 1024 * 1024;
const AUDIO_SIZE_LIMIT_MESSAGE = `This audio segment is larger than ${MAX_AUDIO_SIZE_MB} MB.`;
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDER_TEXT = 12_000;
const MAX_CUSTOM_GUIDELINE_CHARS = 12_000;
const MAX_CUSTOM_INPUT_CHARS = 60_000;
const MAX_ERROR_LENGTH = 320;
const AUDIO_SOURCE_TIMEOUT_MS = 60_000;
const TRANSCRIPTION_PROVIDER_TIMEOUT_MS = 120_000;

const AUDIO_MIME_ALIASES: Record<string, string> = {
  "audio/mp3": "audio/mpeg",
  "audio/mpga": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-mp3": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/x-mpeg-3": "audio/mpeg",
  "audio/wave": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/m4a": "audio/mp4",
  "audio/m4b": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "audio/x-mp4": "audio/mp4",
  "video/mp4": "audio/mp4",
  "audio/x-aac": "audio/aac",
  "audio/x-flac": "audio/flac",
  "application/ogg": "audio/ogg",
  "audio/x-ogg": "audio/ogg",
  "audio/x-opus+ogg": "audio/opus",
  "audio/x-webm": "audio/webm",
  "video/webm": "audio/webm",
  "video/3gpp": "audio/3gpp",
  "audio/x-amr": "audio/amr",
  "audio/amr-wb": "audio/amr",
  "audio/x-aiff": "audio/aiff",
  "audio/x-aifc": "audio/aiff",
  "audio/caf": "audio/x-caf",
  "audio/matroska": "audio/x-matroska",
  "video/x-matroska": "audio/x-matroska",
  "audio/wma": "audio/x-ms-wma",
  "video/x-ms-wma": "audio/x-ms-wma",
};

const CLEARLY_NON_AUDIO_MIME_TYPES = new Set([
  "application/json",
  "application/problem+json",
  "text/json",
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
]);

class ProviderResponseError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(providerErrorMessage(status));
    this.name = "ProviderResponseError";
    this.status = status;
  }
}

function cleanMimeType(value: unknown): string {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
}

function isClearlyNonAudioMime(value: unknown): boolean {
  const mime = cleanMimeType(value);
  return CLEARLY_NON_AUDIO_MIME_TYPES.has(mime) || mime.endsWith("+json") || mime.endsWith("+xml");
}

function isAudioLikeMime(value: unknown): boolean {
  const mime = cleanMimeType(value);
  const generic = mime === "audio/octet-stream" || mime === "audio/*";
  return (!generic && mime.startsWith("audio/")) || Object.prototype.hasOwnProperty.call(AUDIO_MIME_ALIASES, mime);
}

function normalizeAudioMimeType(value: unknown, fallback = "audio/webm"): string {
  const mime = cleanMimeType(value);
  const generic = mime === "audio/octet-stream" || mime === "audio/*";
  return AUDIO_MIME_ALIASES[mime] || (!generic && mime.startsWith("audio/") ? mime : fallback);
}

function providerErrorMessage(status: number): string {
  if (status === 401 || status === 403) return "The transcription provider rejected its credentials. Refresh ELEVENLABS_API_KEY through the secure project secret control, then retry transcription.";
  if (status === 400 || status === 415 || status === 422) return "The transcription provider could not read this audio. Try again with a supported audio recording.";
  if (status === 413) return "The transcription provider rejected this audio because it exceeds the provider's current size limit. The app accepts up to 100 MB, but this service may allow less. Choose a smaller file and retry.";
  if (status === 429) return "The transcription provider is rate-limiting requests. Wait a moment, then retry transcription.";
  if (status >= 500) return "The transcription provider is temporarily unavailable. Wait a moment, then retry transcription.";
  return `The transcription provider rejected this request (${status}). Try again with a supported audio recording.`;
}

async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function accessTimestamp(value: unknown): number | undefined {
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(parsed) ? parsed : undefined;
}
function accessText(value: unknown, max = 160): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function accessServiceClient(): SuperdevClient {
  const key = Deno.env.get("SUPERDEV_SERVICE_ROLE_KEY");
  if (!key) throw new Error("Access service is not configured.");
  const service = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
  service.auth.setToken(key);
  return service;
}
async function enforceTranscriptionAccess(user: JsonRecord): Promise<Response | null> {
  const ownerEmail = accessText(user.email, 320).toLowerCase();
  if (!ownerEmail) return json({ error: "Authentication required." }, 401);
  const service = accessServiceClient();
  const profiles = await service.entities.UserAccessProfile.filter({ owner_email: ownerEmail }, "-updated_at", 5) as JsonRecord[];
  const profile = Array.isArray(profiles) ? profiles[0] : undefined;
  if (!profile) return json({ error: "Transcription access is currently unavailable.", code: "ACCESS_RESTRICTED", status: "ACCESS_RESTRICTED" }, 403);
  const subscriptions = await service.entities.ManualSubscription.filter({ owner_email: ownerEmail }, "-updated_at", 5) as JsonRecord[];
  const subscription = Array.isArray(subscriptions) ? subscriptions[0] : undefined;
  const now = Date.now();
  const profilePremiumEnd = accessTimestamp(profile.premium_end);
  const subscriptionPremiumEnd = accessTimestamp(subscription?.premium_end);
  const premiumEnd = Math.max(profilePremiumEnd ?? 0, subscriptionPremiumEnd ?? 0);
  const trialEnd = accessTimestamp(profile.trial_end) ?? 0;
  const premiumActive = premiumEnd > now && accessText(subscription?.status, 24).toUpperCase() !== "NONE";
  const trialActive = trialEnd > now;
  const pendingRows = await service.entities.ManualPaymentSubmission.filter({ owner_email: ownerEmail }, "-created_at", 50) as JsonRecord[];
  const pending = Array.isArray(pendingRows) && pendingRows.some((row) => accessText(row.status, 24).toUpperCase() === "PENDING");
  const status = profile.manual_restricted === true
    ? "ADMIN_RESTRICTED"
    : premiumActive
      ? "PREMIUM_ACTIVE"
      : trialActive
        ? "TRIALING"
        : pending
          ? "PAYMENT_PENDING"
          : premiumEnd > 0
            ? "PREMIUM_EXPIRED"
            : "TRIAL_EXPIRED";
  const id = accessText(profile.id, 160);
  if (id && accessText(profile.lifecycle_status, 40) !== status) {
    try { await service.entities.UserAccessProfile.update(id, { lifecycle_status: status }); } catch (error) { console.error("transcription access state sync failed", error instanceof Error ? error.message : "unknown error"); }
  }
  if (status === "TRIALING" || status === "PREMIUM_ACTIVE") return null;
  return json({ error: "Transcription access is currently unavailable.", code: "ACCESS_RESTRICTED", status: "ACCESS_RESTRICTED" }, 403);
}

async function readCappedBody(response: Response, maxBytes: number, message: string): Promise<Uint8Array> {
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > maxBytes) throw new Error(message);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(message);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore cancellation errors */ }
        throw new Error(message);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function safeError(error: unknown): string {
  const text = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "Transcription could not be completed.";
  return text
    .replace(/xi-api-key[^\s]*/gi, "provider credential")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_LENGTH);
}

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

function isAutomaticLanguageValue(value: unknown): boolean {
  return typeof value !== "string" || AUTO_LANGUAGE_VALUES.has(value.trim().toLowerCase());
}

function parseLanguagePreferences(value: unknown): string[] {
  const source: unknown[] = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return Array.from(new Set(source
    .flatMap((item) => typeof item === "string" ? item.split(",") : [])
    .map((item) => item.trim().replace(/\s+/g, " ").slice(0, 80))
    .filter((item) => item && !isAutomaticLanguageValue(item))))
    .slice(0, 8);
}

function normalizeLanguageCode(value: unknown): string {
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

function sessionLanguagePreferences(session: JsonRecord): string[] {
  const saved = Array.isArray(session.language_preferences)
    ? parseLanguagePreferences(session.language_preferences)
    : [];
  return saved.length ? saved : parseLanguagePreferences(session.language);
}

function languageHintForSession(session: JsonRecord): string {
  const preferences = sessionLanguagePreferences(session);
  const mode = session.language_mode === "manual" || (!session.language_mode && preferences.length) ? "manual" : "auto";
  if (mode !== "manual") return "";
  const validCodes = Array.from(new Set(preferences.map(normalizeLanguageCode).filter(Boolean)));
  return preferences.length === 1 && validCodes.length === 1 ? validCodes[0] : "";
}

function normalizeDetectedLanguages(values: unknown[]): string[] {
  const output: string[] = [];
  const add = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(add); return; }
    if (value && typeof value === "object") {
      const record = value as JsonRecord;
      ["language_code", "language", "code", "lang"].forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(record, key)) add(record[key]);
      });
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

function providerLanguageValues(payload: JsonRecord, items: JsonRecord[], primary: string): unknown[] {
  const values: unknown[] = primary ? [primary] : [];
  ["detected_languages", "language_codes", "languages", "language_list"].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(payload, key)) values.push(payload[key]);
  });
  items.forEach((item) => {
    ["language_code", "language", "lang"].forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(item, key)) values.push(item[key]);
    });
  });
  return values;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function providerMs(value: unknown): number | undefined {
  if (value == null || (typeof value === "string" && !value.trim())) return undefined;
  const seconds = numberValue(value);
  return seconds == null ? undefined : Math.max(0, Math.round(seconds * 1000));
}

function confidenceValue(item: JsonRecord): number | undefined {
  const direct = numberValue(item.confidence);
  if (direct != null && direct >= 0 && direct <= 1) return direct;
  const logprob = numberValue(item.logprob);
  if (logprob != null) return Math.max(0, Math.min(1, Math.exp(logprob)));
  return undefined;
}

function eventTag(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const inner = trimmed
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\b(?:\d{1,2}:){2}\d{2}(?:\.\d+)?\b/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds|s|sec|seconds)\b/gi, " ")
    .replace(/[^A-Za-z0-9' -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!inner || inner.length > 80 || /^(?:inaudible|unintelligible)\b/.test(inner)) return null;
  const aliases: Record<string, string> = {
    laugh: "laughs",
    laughing: "laughs",
    cough: "coughs",
    coughing: "coughs",
    sigh: "sighs",
    sighing: "sighs",
    sniff: "sniffs",
    sniffing: "sniffs",
    cry: "crying",
  };
  const normalized = aliases[inner] || inner;
  if (normalized.split(" ").filter(Boolean).length > 2) return null;
  return `[${normalized}]`;
}

function providerItems(payload: JsonRecord): JsonRecord[] {
  const words = Array.isArray(payload.words) ? payload.words : [];
  return words.filter((item): item is JsonRecord => !!item && typeof item === "object");
}

function itemSpeaker(item: JsonRecord): string {
  const value = item.speaker_id ?? item.speakerId ?? item.speaker;
  return typeof value === "string" ? value : "";
}

function itemText(item: JsonRecord): string {
  const value = item.text ?? item.word ?? item.token ?? "";
  return typeof value === "string" ? value : String(value ?? "");
}

function normalizeTokens(items: JsonRecord[], _segmentStartMs: number): { tokens: Token[]; wordCount: number; speakerIds: string[] } {
  const tokens: Token[] = [];
  let wordCount = 0;
  const speakerIds: string[] = [];
  for (const item of items) {
    const rawText = itemText(item);
    const rawType = String(item.type ?? "word").toLowerCase();
    if (rawType === "spacing" || !rawText.trim()) continue;
    const event = rawType.includes("event") || rawType.includes("audio") || /^\s*\[[^\]]+\]\s*$/.test(rawText);
    const text = event ? eventTag(rawText) : rawText;
    if (!text) continue;
    const speakerId = itemSpeaker(item);
    const startMs = providerMs(item.start ?? item.start_time);
    const rawEndMs = providerMs(item.end ?? item.end_time);
    const endMs = rawEndMs == null ? undefined : Math.max(startMs ?? rawEndMs, rawEndMs);
    if (!event && speakerId && !speakerIds.includes(speakerId)) speakerIds.push(speakerId);
    tokens.push({
      text,
      type: event ? "event" : "word",
      startMs,
      endMs,
      timingPresent: startMs != null || endMs != null,
      speakerId,
      confidence: confidenceValue(item),
    });
    if (!event) wordCount += 1;
  }
  return { tokens, wordCount, speakerIds };
}

function markerLine(token: Token, segmentStartMs: number): GroupedLine {
  const timed = token.timingPresent && token.startMs != null && token.endMs != null;
  return {
    kind: "marker",
    text: token.text,
    audio_event_tags: [token.text],
    word_count: 0,
    automatic_marker: true,
    audio_event_source: "provider",
    audio_event_type: token.text.slice(1, -1).trim().toLowerCase(),
    ...(timed ? {
      start_ms: segmentStartMs + token.startMs!,
      end_ms: segmentStartMs + token.endMs!,
      provider_start_ms: token.startMs,
      provider_end_ms: token.endMs,
    } : {}),
    ...(token.confidence == null ? {} : {
      confidence: token.confidence,
      audio_event_confidence: token.confidence,
    }),
  };
}

function groupTokens(tokens: Token[], segmentStartMs: number): GroupedLine[] {
  const labels = new Map<string, string>();
  const labelFor = (speakerId: string) => {
    if (!speakerId) return "Speaker 1";
    const existing = labels.get(speakerId);
    if (existing) return existing;
    const label = `Speaker ${labels.size + 1}`;
    labels.set(speakerId, label);
    return label;
  };
  const output: GroupedLine[] = [];
  const pendingUntimedEvents: Token[] = [];
  let current: GroupedLine | null = null;
  let confidenceTotal = 0;
  let confidenceCount = 0;

  const appendText = (line: GroupedLine, text: string) => {
    const needsSpace = line.text.length > 0 && !/\s$/.test(line.text) && !/^[,.;!?%)\]}]/.test(text) && !/^['’]/.test(text);
    if (needsSpace) line.text += " ";
    line.text += text;
  };

  const flushPendingUntimedEvents = () => {
    pendingUntimedEvents.splice(0).forEach((event) => output.push(markerLine(event, segmentStartMs)));
  };

  const flush = () => {
    if (!current || !current.text.trim()) {
      current = null;
      confidenceTotal = 0;
      confidenceCount = 0;
      return;
    }
    current.text = current.text.replace(/\s+/g, " ").trim();
    if (confidenceCount) current.confidence = confidenceTotal / confidenceCount;
    current.audio_event_tags = Array.from(new Set(current.text.match(/\[[^\]]+\]/g) ?? []));
    output.push(current);
    current = null;
    confidenceTotal = 0;
    confidenceCount = 0;
  };

  const startSpeech = (token: Token) => {
    current = {
      kind: "speech",
      text: "",
      ...(token.startMs == null ? {} : {
        start_ms: segmentStartMs + token.startMs,
        provider_start_ms: token.startMs,
      }),
      ...(token.endMs == null ? {} : {
        end_ms: segmentStartMs + token.endMs,
        provider_end_ms: token.endMs,
      }),
      speaker_label: labelFor(token.speakerId),
      provider_speaker_id: token.speakerId,
      audio_event_tags: [],
      word_count: 0,
    };
    pendingUntimedEvents.splice(0).forEach((event) => appendText(current!, event.text));
  };

  for (const token of tokens) {
    if (token.type === "event") {
      const timed = token.timingPresent && token.startMs != null && token.endMs != null;
      if (timed) {
        flush();
        flushPendingUntimedEvents();
        output.push(markerLine(token, segmentStartMs));
      } else if (current) {
        appendText(current, token.text);
      } else {
        pendingUntimedEvents.push(token);
      }
      continue;
    }

    if (current && token.speakerId && current.provider_speaker_id && token.speakerId !== current.provider_speaker_id) flush();
    if (!current) startSpeech(token);
    if (!current) continue;
    appendText(current, token.text);
    if (token.startMs != null && current.start_ms == null) {
      current.start_ms = segmentStartMs + token.startMs;
      current.provider_start_ms = token.startMs;
    }
    if (token.endMs != null) {
      current.end_ms = segmentStartMs + token.endMs;
      current.provider_end_ms = token.endMs;
    }
    current.word_count += 1;
    if (token.confidence != null) {
      confidenceTotal += token.confidence;
      confidenceCount += 1;
    }
    const punctuation = /[.!?]["'”’)\]]*$/.test(token.text);
    if (current.word_count >= 40 || (punctuation && (current.text.length > 70 || current.word_count >= 10))) flush();
  }
  flush();
  flushPendingUntimedEvents();
  return output;
}

const GUIDELINE_NEGATION = /\b(?:do not|don't|never|must not|mustn't|avoid|without|cannot|can't|no)\b/;

function guidelineClauses(value: string): string[] {
  return value.toLowerCase().split(/[\n.!?;]+/).map((part) => part.trim()).filter(Boolean);
}

function hasPositiveGuidelineInstruction(value: string, pattern: RegExp): boolean {
  return guidelineClauses(value).some((clause) => pattern.test(clause) && !GUIDELINE_NEGATION.test(clause.slice(0, 110)));
}

function validateCustomGuideline(session: JsonRecord): string {
  const status = typeof session.custom_guideline_status === "string" ? session.custom_guideline_status.trim().toLowerCase() : "";
  if (status !== "ready") throw new Error("Custom Guidelines is not ready. Save a valid guideline before transcribing.");
  const text = typeof session.custom_guideline_text === "string"
    ? session.custom_guideline_text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim()
    : "";
  if (!text) throw new Error("Custom Guidelines is missing. Save a guideline before transcribing.");
  if (text.length > MAX_CUSTOM_GUIDELINE_CHARS) throw new Error("Custom Guidelines exceed the 12,000 character limit. Shorten and save them again.");

  const fullVerbatim = hasPositiveGuidelineInstruction(text, /\b(?:full|strict|exact)\s+verbatim\b/);
  const cleanVerbatim = hasPositiveGuidelineInstruction(text, /\bclean\s+verbatim\b/);
  if (fullVerbatim && cleanVerbatim) throw new Error("Custom guideline conflict: Full verbatim and Clean verbatim are both required.");

  const preserveFillers = hasPositiveGuidelineInstruction(text, /\b(?:preserve|keep|retain|include)\b.{0,70}\bfillers?\b/);
  const removeFillers = hasPositiveGuidelineInstruction(text, /\b(?:remove|omit|delete|strip)\b.{0,70}\bfillers?\b/);
  if (preserveFillers && removeFillers) throw new Error("Custom guideline conflict: it gives opposite directions about keeping and removing fillers.");

  if (hasPositiveGuidelineInstruction(text, /\b(?:invent|fabricate|make up|guess|reconstruct|hallucinate|fill in)\b/)) {
    throw new Error("Custom guideline is unsupported because it asks the transcript to invent or guess speech.");
  }
  if (hasPositiveGuidelineInstruction(text, /\b(?:identify|infer|deduce|determine|recognize)\b.{0,70}\b(?:speaker|person|identity|role)\b/) ||
      hasPositiveGuidelineInstruction(text, /\b(?:rename|change|relocate)\b.{0,70}\bspeaker\s+labels?\b/)) {
    throw new Error("Custom guideline is unsupported because it asks the system to identify speakers or change source labels.");
  }
  if (hasPositiveGuidelineInstruction(text, /\b(?:add|remove|rename|change|move|relocate|reset|restart|retime|generate|invent)\b.{0,80}\b(?:timestamps?|speaker\s+labels?|sound[- ]event|event\s+markers?)\b/)) {
    throw new Error("Custom guideline is unsupported because it asks the system to change source timestamps, speakers, or sound markers.");
  }
  if (hasPositiveGuidelineInstruction(text, /\b(?:translate|transliterate|summarize|paraphrase)\b/) ||
      hasPositiveGuidelineInstruction(text, /\brewrite\b.{0,50}\b(?:meaning|speech|what\s+was\s+said)\b/)) {
    throw new Error("Custom guideline is unsupported because it asks the system to translate, summarize, or change spoken meaning.");
  }
  if (hasPositiveGuidelineInstruction(text, /\[sic\]/) ||
      hasPositiveGuidelineInstruction(text, /\b(?:use|put|format|write)\b.{0,80}\([^)]*(?:audio|laugh|cough|noise|inaudible)\b/)) {
    throw new Error("Custom guideline is unsupported because it requests a marking format that conflicts with source markers.");
  }
  return text;
}

function bracketedTextTags(value: string): string[] {
  return value.match(/\[[^\]]+\]/g) ?? [];
}

function sameTextTags(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function integrationResponseObject(value: unknown): JsonRecord {
  if (typeof value === "string") {
    try { return integrationResponseObject(JSON.parse(value)); } catch { return {}; }
  }
  if (!value || typeof value !== "object") return {};
  const record = value as JsonRecord;
  if (record.result !== undefined) return integrationResponseObject(record.result);
  return record;
}

async function customizeGroupedLines(
  client: SuperdevClient,
  session: JsonRecord,
  grouped: GroupedLine[],
  headers: Record<string, string>,
): Promise<GroupedLine[]> {
  const guideline = validateCustomGuideline(session);
  if (!grouped.length) return [];
  const inputLines = grouped.map((line, index) => ({
    index,
    kind: line.kind,
    text: line.text,
    audio_event_tags: line.audio_event_tags,
  }));
  const inputSize = inputLines.reduce((total, line) => total + line.text.length, 0);
  if (inputSize > MAX_CUSTOM_INPUT_CHARS) throw new Error("Custom guideline input is too large to process safely. Retry this segment.");
  const prompt = [
    "Apply the user's transcription guideline to the normalized provider lines below.",
    "Return exactly one transformed text value for every supplied line index, in a JSON object.",
    "Only display text may change. Preserve the supplied spoken words and meaning, changing punctuation, capitalization, number presentation, or compatible formatting only when the guideline explicitly supports it.",
    "Never translate, summarize, paraphrase, invent, guess, identify a speaker, or change timing, speaker labels, or source markers.",
    "Marker lines must be returned byte-for-byte unchanged. Every existing bracketed tag on a speech line must remain byte-for-byte unchanged and in the same order.",
    `User guideline:\n${guideline}`,
    `Normalized lines:\n${JSON.stringify(inputLines)}`,
  ].join("\n\n");
  const response = await client.integrations.core.invokeLLM({
    mode: "standard",
    prompt,
    response_json_schema: {
      type: "object",
      properties: {
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "integer" },
              text: { type: "string" },
            },
            required: ["index", "text"],
          },
        },
      },
      required: ["lines"],
    },
  }, { headers });
  const parsed = integrationResponseObject(response);
  const entries = Array.isArray(parsed.lines) ? parsed.lines : [];
  if (entries.length !== grouped.length) throw new Error("Custom guideline processing returned an incomplete line set.");
  const byIndex = new Map<number, JsonRecord>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") throw new Error("Custom guideline processing returned an invalid line.");
    const item = entry as JsonRecord;
    const index = numberValue(item.index);
    if (index == null || !Number.isInteger(index) || index < 0 || index >= grouped.length || byIndex.has(index)) {
      throw new Error("Custom guideline processing returned invalid line indexes.");
    }
    byIndex.set(index, item);
  }
  const output: GroupedLine[] = [];
  for (let index = 0; index < grouped.length; index += 1) {
    const original = grouped[index];
    const entry = byIndex.get(index);
    const text = entry && typeof entry.text === "string" ? entry.text : "";
    if (!text.trim() || text.length > MAX_PROVIDER_TEXT || /[\r\n]/.test(text)) {
      throw new Error("Custom guideline processing returned invalid line text.");
    }
    if (original.kind === "marker" && text !== original.text) {
      throw new Error("Custom guideline processing changed a source marker.");
    }
    if (original.kind === "speech" && !sameTextTags(bracketedTextTags(original.text), bracketedTextTags(text))) {
      throw new Error("Custom guideline processing changed a source sound marker.");
    }
    output.push({ ...original, raw_text: original.text, text });
  }
  return output;
}

const TIMING_FIELDS = ["start_ms", "end_ms", "provider_start_ms", "provider_end_ms"] as const;
type TimingField = typeof TIMING_FIELDS[number];

function hasStoredValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function hasTimingValue(value: JsonRecord | GroupedLine, field: TimingField): boolean {
  return hasStoredValue((value as JsonRecord)[field]);
}

function sameTimingShape(existing: JsonRecord, incoming: GroupedLine): boolean {
  return TIMING_FIELDS.every((field) => hasTimingValue(existing, field) === hasTimingValue(incoming, field));
}

function canReuseGeneratedLine(existing: JsonRecord, incoming: GroupedLine): boolean {
  return existing.kind === incoming.kind &&
    sameTimingShape(existing, incoming) &&
    hasStoredValue(existing.confidence) === hasStoredValue(incoming.confidence) &&
    hasStoredValue(existing.audio_event_confidence) === hasStoredValue(incoming.audio_event_confidence);
}

function groupedLineData(sessionId: string, segmentId: string, line: GroupedLine, sequence: number): JsonRecord {
  const data: JsonRecord = {
    session_id: sessionId,
    sequence,
    kind: line.kind,
    speaker_label: line.kind === "speech" ? line.speaker_label ?? "" : "",
    text: line.text,
    raw_text: line.raw_text ?? line.text,
    source_segment_id: segmentId,
    origin: "generated",
    provider_speaker_id: line.kind === "speech" ? line.provider_speaker_id ?? "" : "",
    edit_state: "provider",
    edited_at: "",
    cleanup_text: "",
    cleanup_applied: false,
    audio_event_tags: line.audio_event_tags,
    automatic_marker: line.kind === "marker",
    audio_event_source: line.kind === "marker" ? "provider" : "",
    audio_event_type: line.kind === "marker" ? line.audio_event_type ?? "" : "",
  };
  if (line.kind === "marker" && hasStoredValue(line.audio_event_confidence)) {
    data.audio_event_confidence = line.audio_event_confidence;
  }
  for (const field of TIMING_FIELDS) {
    const value = (line as JsonRecord)[field];
    if (hasStoredValue(value)) data[field] = value;
  }
  if (hasStoredValue(line.confidence)) data.confidence = line.confidence;
  return data;
}

function extensionForMime(mime: string): string {
  const normalized = (mime || "").split(";", 1)[0].trim().toLowerCase();
  switch (normalized) {
    case "audio/aac":
    case "audio/x-aac":
      return "aac";
    case "audio/flac":
    case "audio/x-flac":
      return "flac";
    case "audio/mp4":
    case "audio/m4a":
    case "audio/m4b":
    case "audio/x-m4a":
    case "audio/x-mp4":
    case "video/mp4":
      return "m4a";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
    case "audio/vnd.wave":
      return "wav";
    case "audio/aiff":
    case "audio/x-aiff":
    case "audio/x-aifc":
      return "aiff";
    case "audio/amr":
    case "audio/x-amr":
    case "audio/amr-wb":
      return "amr";
    case "audio/3gpp":
    case "video/3gpp":
      return "3gp";
    case "audio/x-caf":
    case "audio/caf":
      return "caf";
    case "audio/x-matroska":
    case "audio/matroska":
    case "video/x-matroska":
      return "mka";
    case "audio/x-ms-wma":
    case "audio/wma":
    case "video/x-ms-wma":
      return "wma";
    case "audio/mp3":
    case "audio/mpga":
    case "audio/mpeg":
    case "audio/mpeg3":
    case "audio/x-mp3":
    case "audio/x-mpeg":
    case "audio/x-mpeg-3":
      return "mp3";
    case "audio/opus":
    case "audio/x-opus+ogg":
      return "opus";
    case "application/ogg":
    case "audio/ogg":
    case "audio/x-ogg":
      return "ogg";
    case "audio/webm":
    case "video/webm":
      return "webm";
    default:
      return "webm";
  }
}

function transcriptionState(rows: JsonRecord[]) {
  const uploaded = rows.filter((row) => row.upload_status === "uploaded");
  const counts = { total: uploaded.length, pending: 0, active: 0, completed: 0, failed: 0 };
  for (const row of uploaded) {
    const status = String(row.transcription_status || "pending");
    if (status === "transcribing") counts.active += 1;
    else if (status === "completed") counts.completed += 1;
    else if (status === "failed") counts.failed += 1;
    else counts.pending += 1;
  }
  const status = counts.active || counts.pending ? "processing" : counts.failed && !counts.completed ? "failed" : counts.failed ? "partial" : counts.total ? "completed" : "idle";
  return { ...counts, status };
}

async function updateSessionProgress(client: SuperdevClient, sessionId: string, patch: JsonRecord = {}) {
  const rows = (await client.entities.AudioSegment.filter({ session_id: sessionId }, "sequence", 500)) as JsonRecord[];
  const counts = transcriptionState(rows);
  const hasLanguageData = rows.some((row) =>
    Object.prototype.hasOwnProperty.call(row, "detected_language") ||
    Object.prototype.hasOwnProperty.call(row, "detected_languages")
  );
  const detectedLanguages = normalizeDetectedLanguages(rows.flatMap((row) => [
    ...(Array.isArray(row.detected_languages) ? row.detected_languages : []),
    row.detected_language,
  ]));
  const sessionPatch = {
    transcription_status: counts.status,
    transcription_total_count: counts.total,
    transcription_pending_count: counts.pending,
    transcription_active_count: counts.active,
    transcription_completed_count: counts.completed,
    transcription_failed_count: counts.failed,
    ...(hasLanguageData ? { detected_languages: detectedLanguages } : {}),
    ...patch,
  };
  const updated = await client.entities.TranscriptionSession.update(sessionId, sessionPatch);
  return { updated, counts };
}

async function markFailed(client: SuperdevClient, segment: SafeSegment, sessionId: string, message: string) {
  const errorMessage = safeError(message);
  const updated = await client.entities.AudioSegment.update(segment.id, {
    transcription_status: "failed",
    transcription_error: errorMessage,
    transcribed_at: "",
  });
  let issue: JsonRecord | null = null;
  try {
    issue = (await client.entities.AudioIssue.create({
      session_id: sessionId,
      kind: "transcription_failure",
      severity: "error",
      timestamp_ms: Number(segment.end_ms ?? segment.start_ms ?? 0),
      source: "provider",
      notes: `Transcription failed for segment ${Number(segment.sequence ?? 0) + 1}: ${errorMessage}`,
    })) as JsonRecord;
  } catch (issueError) {
    console.error("Could not save transcription issue", safeError(issueError));
  }
  const progress = await updateSessionProgress(client, sessionId, { transcription_error_summary: errorMessage });
  return { updated, issue, session: progress.updated, counts: progress.counts };
}

async function transcribe(
  client: SuperdevClient,
  segment: SafeSegment,
  session: JsonRecord,
  integrationHeaders: Record<string, string>,
) {
  const apiKey = Deno.env.get("ELEVENLABS_API_KEY")?.trim();
  if (!apiKey) throw new Error("Automatic transcription is not configured yet.");
  const sourceUrl = typeof segment.audio_url === "string" ? segment.audio_url : "";
  if (!sourceUrl) throw new Error("This segment has no saved audio file.");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    throw new Error("The saved audio URL is invalid.");
  }
  if (parsedUrl.protocol !== "https:") throw new Error("The saved audio URL is not secure.");

  let sourceResponse: Response;
  try {
    sourceResponse = await fetchWithTimeout(
      parsedUrl,
      {},
      AUDIO_SOURCE_TIMEOUT_MS,
      "The saved audio file could not be reached in time. Upload it again.",
    );
  } catch (error) {
    if (error instanceof Error && error.message === "The saved audio file could not be reached in time. Upload it again.") throw error;
    throw new Error("The saved audio file could not be downloaded. Upload it again.");
  }
  if (!sourceResponse.ok) {
    try { await sourceResponse.body?.cancel(); } catch { /* ignore cleanup errors */ }
    if (sourceResponse.status === 404 || sourceResponse.status === 410) throw new Error("The saved audio file is no longer available. Upload it again.");
    throw new Error("The saved audio file could not be downloaded. Upload it again.");
  }
  const sourceMime = cleanMimeType(sourceResponse.headers.get("content-type"));
  if (isClearlyNonAudioMime(sourceMime)) throw new Error("The saved audio file response was not an audio file. Upload it again.");
  let audioBytes: Uint8Array;
  try {
    audioBytes = await readCappedBody(
      sourceResponse,
      MAX_AUDIO_BYTES,
      AUDIO_SIZE_LIMIT_MESSAGE
    );
  } catch (error) {
    if (error instanceof Error && error.message === AUDIO_SIZE_LIMIT_MESSAGE) throw error;
    throw new Error("The saved audio file could not be downloaded. Upload it again.");
  }
  if (!audioBytes.byteLength) throw new Error("This audio segment is empty.");

  const segmentMime = cleanMimeType(segment.mime_type);
  const mimeSource = isAudioLikeMime(segmentMime)
    ? segmentMime
    : isAudioLikeMime(sourceMime)
      ? sourceMime
      : segmentMime || sourceMime;
  const mime = normalizeAudioMimeType(mimeSource);
  const form = new FormData();
  form.append("file", new File([audioBytes], `segment-${segment.sequence}.${extensionForMime(mime)}`, { type: mime }));
  form.append("model_id", "scribe_v2");
  form.append("timestamps_granularity", "word");
  form.append("diarize", "true");
  form.append("tag_audio_events", "true");
  form.append("no_verbatim", "false");
  const languageHint = languageHintForSession(session);
  if (languageHint) form.append("language_code", languageHint);

  let response: Response;
  try {
    response = await fetchWithTimeout(
      "https://api.elevenlabs.io/v1/speech-to-text",
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, Accept: "application/json" },
        body: form,
      },
      TRANSCRIPTION_PROVIDER_TIMEOUT_MS,
      "The transcription provider timed out. Wait a moment, then retry transcription.",
    );
  } catch (error) {
    if (error instanceof Error && error.message === "The transcription provider timed out. Wait a moment, then retry transcription.") throw error;
    throw new Error("The transcription provider could not be reached. Wait a moment, then retry transcription.");
  }
  if (!response.ok) {
    console.error("ElevenLabs transcription failed", response.status);
    try { await response.body?.cancel(); } catch { /* ignore cleanup errors */ }
    throw new ProviderResponseError(response.status);
  }
  let providerBytes: Uint8Array;
  try {
    providerBytes = await readCappedBody(
      response,
      MAX_PROVIDER_RESPONSE_BYTES,
      "The transcription provider response was too large."
    );
  } catch (error) {
    if (error instanceof Error && error.message === "The transcription provider response was too large.") throw error;
    throw new Error("The transcription provider returned an unreadable response.");
  }
  let payload: JsonRecord;
  try {
    payload = JSON.parse(new TextDecoder().decode(providerBytes)) as JsonRecord;
  } catch {
    throw new Error("The transcription provider returned an unreadable response.");
  }
  const items = providerItems(payload);
  const normalized = normalizeTokens(items, Number(segment.start_ms ?? 0));
  const providerText = typeof payload.text === "string" ? payload.text.slice(0, MAX_PROVIDER_TEXT) : normalized.tokens.map((token) => token.text).join(" ").slice(0, MAX_PROVIDER_TEXT);
  const grouped = normalized.tokens.length
    ? groupTokens(normalized.tokens, Number(segment.start_ms ?? 0))
    : providerText
      ? [{
          kind: "speech",
          text: providerText,
          start_ms: Number(segment.start_ms ?? 0),
          end_ms: Number(segment.end_ms ?? segment.start_ms ?? 0),
          provider_start_ms: 0,
          provider_end_ms: Math.max(0, Number(segment.end_ms ?? 0) - Number(segment.start_ms ?? 0)),
          speaker_label: "Speaker 1",
          provider_speaker_id: "",
          audio_event_tags: [],
          word_count: providerText.trim().split(/\s+/).filter(Boolean).length,
        }]
      : [];
  const effectiveGrouped = session.review_mode === "custom_guidelines"
    ? await customizeGroupedLines(client, session, grouped, integrationHeaders)
    : grouped;
  const speakerIds = normalized.speakerIds;
  const labels = speakerIds.map((_, index) => `Speaker ${index + 1}`);
  const detectedLanguage = typeof payload.language_code === "string" ? payload.language_code : "";
  const detectedLanguages = normalizeDetectedLanguages(providerLanguageValues(payload, items, detectedLanguage));
  const languageProbability = numberValue(payload.language_probability) ?? 0;
  return { grouped: effectiveGrouped, providerText, wordCount: normalized.wordCount, speakerIds, labels, detectedLanguage, detectedLanguages, languageProbability };
}

Deno.serve(async (request) => {
  const authorization = request.headers.get("Authorization");
  if (!authorization) return json({ error: "Authentication required." }, 401);
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Authentication required." }, 401);
  const integrationHeaders: Record<string, string> = { Authorization: authorization };
  const origin = request.headers.get("Origin");
  if (origin) integrationHeaders.Origin = origin;
  try {
    const client = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
    client.auth.setToken(token);
    let user: JsonRecord;
    try {
      user = await client.auth.me() as JsonRecord;
    } catch {
      return json({ error: "Authentication required." }, 401);
    }
    const accessResponse = await enforceTranscriptionAccess(user);
    if (accessResponse) return accessResponse;
    const body = (await request.json()) as JsonRecord;
    const segmentId = typeof body.segment_id === "string" ? body.segment_id : "";
    const suppliedSessionId = typeof body.session_id === "string" ? body.session_id : "";
    if (!segmentId || !suppliedSessionId) return json({ error: "segment_id and session_id are required." }, 400);
    const segment = (await client.entities.AudioSegment.get(segmentId)) as SafeSegment;
    if (!segment || segment.session_id !== suppliedSessionId) return json({ error: "Segment not found in this session." }, 404);
    const session = (await client.entities.TranscriptionSession.get(segment.session_id)) as JsonRecord;
    if (!session) return json({ error: "Session not found." }, 404);
    if (segment.upload_status !== "uploaded") return json({ error: "Upload this segment before transcribing." }, 409);
    if (segment.transcription_status === "completed") return json({ ok: true, status: "completed", skipped: true, segment });
    if (segment.transcription_status === "transcribing") {
      const started = Date.parse(String(segment.transcription_started_at || ""));
      if (Number.isFinite(started) && Date.now() - started < 15 * 60_000) return json({ ok: true, status: "in_progress", segment });
    }

    const startedAt = new Date().toISOString();
    const marked = (await client.entities.AudioSegment.update(segment.id, {
      transcription_status: "transcribing",
      transcription_error: "",
      transcription_started_at: startedAt,
    })) as SafeSegment;
    await updateSessionProgress(client, segment.session_id, { transcription_status: "processing", transcription_error_summary: "" });

    try {
      const result = await transcribe(client, marked, session, integrationHeaders);
      const existing = (await client.entities.TranscriptLine.filter({ session_id: segment.session_id }, "sequence", 500)) as JsonRecord[];
      const previous = existing
        .filter((line) => line.source_segment_id === segment.id && line.origin === "generated" && line.edit_state !== "edited")
        .sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
      const maxSequence = existing.reduce((max, line) => {
        const sequence = Number(line.sequence);
        return Number.isFinite(sequence) ? Math.max(max, sequence) : max;
      }, -1);
      const reusableByIndex = new Map<number, JsonRecord>();
      const reusedIds = new Set<string>();
      let candidateCursor = 0;
      for (let index = 0; index < result.grouped.length; index += 1) {
        let matchIndex = -1;
        for (let candidateIndex = candidateCursor; candidateIndex < previous.length; candidateIndex += 1) {
          if (canReuseGeneratedLine(previous[candidateIndex], result.grouped[index])) {
            matchIndex = candidateIndex;
            break;
          }
        }
        if (matchIndex < 0) continue;
        const match = previous[matchIndex];
        reusableByIndex.set(index, match);
        reusedIds.add(String(match.id));
        candidateCursor = matchIndex + 1;
      }

      const sequenceByIndex = new Map<number, number>();
      reusableByIndex.forEach((match, index) => {
        const sequence = Number(match.sequence);
        if (Number.isFinite(sequence)) sequenceByIndex.set(index, sequence);
      });
      let insertionIndex = 0;
      while (insertionIndex < result.grouped.length) {
        if (reusableByIndex.has(insertionIndex)) {
          insertionIndex += 1;
          continue;
        }
        const runStart = insertionIndex;
        while (insertionIndex < result.grouped.length && !reusableByIndex.has(insertionIndex)) insertionIndex += 1;
        const runEnd = insertionIndex;
        let beforeSequence: number | undefined;
        for (let index = runStart - 1; index >= 0; index -= 1) {
          const sequence = sequenceByIndex.get(index);
          if (sequence != null) {
            beforeSequence = sequence;
            break;
          }
        }
        let afterSequence: number | undefined;
        for (let index = runEnd; index < result.grouped.length; index += 1) {
          const sequence = sequenceByIndex.get(index);
          if (sequence != null) {
            afterSequence = sequence;
            break;
          }
        }
        const count = runEnd - runStart;
        for (let offset = 0; offset < count; offset += 1) {
          let sequence: number;
          if (beforeSequence != null && afterSequence != null && afterSequence > beforeSequence) {
            sequence = beforeSequence + ((afterSequence - beforeSequence) * (offset + 1)) / (count + 1);
          } else if (beforeSequence != null) {
            sequence = beforeSequence + (offset + 1) / (count + 1);
          } else if (afterSequence != null) {
            sequence = afterSequence - (count - offset) / (count + 1);
          } else {
            sequence = maxSequence + runStart + offset + 1;
          }
          sequenceByIndex.set(runStart + offset, sequence);
        }
      }

      const savedLines: JsonRecord[] = [];
      for (let index = 0; index < result.grouped.length; index += 1) {
        const line = result.grouped[index];
        const match = reusableByIndex.get(index);
        const sequence = sequenceByIndex.get(index) ?? maxSequence + index + 1;
        const lineData = groupedLineData(segment.session_id, segment.id, line, sequence);
        const saved = match
          ? await client.entities.TranscriptLine.update(String(match.id), lineData)
          : await client.entities.TranscriptLine.create(lineData);
        savedLines.push(saved as JsonRecord);
      }
      for (const stale of previous) {
        if (!reusedIds.has(String(stale.id))) await client.entities.TranscriptLine.delete(String(stale.id));
      }

      const completed = (await client.entities.AudioSegment.update(segment.id, {
        transcription_status: "completed",
        transcription_error: "",
        transcribed_at: new Date().toISOString(),
        detected_language: result.detectedLanguage,
        detected_languages: result.detectedLanguages,
        language_probability: result.languageProbability,
        speaker_count: result.speakerIds.length,
        detected_speakers: result.labels,
        provider_speaker_ids: result.speakerIds,
        word_count: result.wordCount,
        provider_text: result.providerText,
      })) as SafeSegment;
      const progress = await updateSessionProgress(client, segment.session_id, {
        transcription_error_summary: "",
        last_transcription_at: new Date().toISOString(),
      });
      return json({ ok: true, status: "completed", segment: completed, session: progress.updated, lines: savedLines, counts: progress.counts });
    } catch (error) {
      const failed = await markFailed(client, marked, segment.session_id, safeError(error));
      return json({ ok: false, status: "failed", error: safeError(error), segment: failed.updated, session: failed.session, issue: failed.issue, counts: failed.counts });
    }
  } catch (error) {
    console.error("transcribe-audio-segment failed", safeError(error));
    return json({ error: safeError(error) }, 500);
  }
});
