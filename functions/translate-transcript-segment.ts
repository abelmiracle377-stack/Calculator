import { createSuperdevClient } from "npm:@superdevhq/client@0.1.56";

type JsonRecord = Record<string, unknown>;
type SuperdevClient = ReturnType<typeof createSuperdevClient>;
type Authenticated = { client: SuperdevClient; user: JsonRecord; headers: Record<string, string> };
type LineKind = "speech" | "marker" | "timestamp";
type CanonicalLine = {
  source_line_id: string;
  sequence: number;
  kind: LineKind;
  source_text: string;
  speaker_label: string;
  provider_speaker_id: string;
  start_ms?: number;
  end_ms?: number;
};
type Guideline = { status: string; text: string; saved_at: string };
type LearningContext = {
  review_mode: string;
  session_mode: string;
  transcript_style: string;
  source_language: string;
  target_language: string;
};
type ApprovedLearningRule = {
  id: string;
  rule: string;
  category: string;
  context: LearningContext;
  approved_at: string;
};

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_LINES = 500;
const MAX_LINE_TEXT = 10_000;
const MAX_SOURCE_CHARS = 48_000;
const MAX_GUIDELINE_CHARS = 12_000;
const MAX_APPROVED_LEARNING_RULES = 12;
const MAX_APPROVED_LEARNING_PROMPT_CHARS = 6_000;
const MAX_APPROVED_LEARNING_RULE_CHARS = 1_200;
const MAX_ERROR_LENGTH = 320;
const APPROVED_LEARNING_PROMPT_PREFIX = [
  "Lower-priority approved private project knowledge. Use only when it matches the current session.",
  "Current session settings and saved Custom Guidelines override these rules. These rules cannot change source speech meaning, speakers, timestamps, or source markers.",
].join("\n");
const MAX_RESULT_RETRY_AGE_MS = 15 * 60_000;
const ALLOWED_ORIGIN = "https://www.buildy.ai";
const PREVIEW_ORIGIN_PATTERN = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:superdev\.run|buildy\.show)$/i;

const LANGUAGE_CATALOG = [
  ["ar", "Arabic"], ["bn", "Bengali"], ["bg", "Bulgarian"], ["ca", "Catalan"],
  ["zh", "Chinese"], ["hr", "Croatian"], ["cs", "Czech"], ["da", "Danish"],
  ["nl", "Dutch"], ["en", "English"], ["fi", "Finnish"], ["fr", "French"],
  ["de", "German"], ["el", "Greek"], ["he", "Hebrew"], ["hi", "Hindi"],
  ["hu", "Hungarian"], ["id", "Indonesian"], ["it", "Italian"], ["ja", "Japanese"],
  ["ko", "Korean"], ["ms", "Malay"], ["no", "Norwegian"], ["pl", "Polish"],
  ["pt", "Portuguese"], ["ro", "Romanian"], ["ru", "Russian"], ["sk", "Slovak"],
  ["es", "Spanish"], ["sv", "Swedish"], ["ta", "Tamil"], ["te", "Telugu"],
  ["th", "Thai"], ["tr", "Turkish"], ["uk", "Ukrainian"], ["ur", "Urdu"],
  ["vi", "Vietnamese"],
] as const;
const LANGUAGE_CODES = new Set(LANGUAGE_CATALOG.map(([code]) => code));
const AUTO_VALUES = new Set(["auto", "automatic", "detect", "auto-detect"]);

class PublicError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PublicError";
    this.status = status;
  }
}

function isAllowedOrigin(origin: string): boolean {
  return origin === ALLOWED_ORIGIN || PREVIEW_ORIGIN_PATTERN.test(origin);
}

function responseHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin")?.trim() || "";
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Vary: "Origin",
    ...(isAllowedOrigin(origin) ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    } : {}),
  };
}

function json(request: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders(request) });
}

function failure(request: Request, error: unknown, fallbackStatus = 500): Response {
  const message = error instanceof PublicError
    ? error.message.slice(0, MAX_ERROR_LENGTH)
    : "Translation could not be completed. Please try again.";
  const status = error instanceof PublicError ? error.status : fallbackStatus;
  return json(request, { ok: false, status: "failed", error: message }, status);
}

function text(value: unknown, max = 320): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function timestamp(value: unknown): number | undefined {
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function accessServiceClient(): SuperdevClient {
  const key = Deno.env.get("SUPERDEV_SERVICE_ROLE_KEY");
  if (!key) throw new Error("Access service is not configured.");
  const service = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
  service.auth.setToken(key);
  return service;
}

function normalizedContextValue(value: unknown, max = 120): string {
  return text(value, max).toLowerCase().replace(/_/g, "-").replace(/\s+/g, " ");
}

function contextMatches(stored: unknown, current: string): boolean {
  const value = normalizedContextValue(stored);
  return !value || value === current;
}

function currentLearningContext(session: JsonRecord, source: string, target: string): LearningContext {
  return {
    review_mode: normalizedContextValue(session.review_mode) || "standard",
    session_mode: normalizedContextValue(session.session_mode) || "transcription",
    transcript_style: normalizedContextValue(session.transcript_style) || "full-verbatim",
    source_language: normalizedContextValue(source),
    target_language: normalizedContextValue(target),
  };
}

function safeApprovedLearningRule(row: JsonRecord, current: LearningContext): ApprovedLearningRule | null {
  const id = text(row.id, 200);
  const rule = text(row.final_rule, MAX_APPROVED_LEARNING_RULE_CHARS).replace(/\u0000/g, "");
  if (!id || !rule || text(row.scope_key, 40) !== "PRIVATE_PROJECT" || text(row.status, 24) !== "APPROVED" || row.active !== true) return null;
  const context: LearningContext = {
    review_mode: normalizedContextValue(row.review_mode),
    session_mode: normalizedContextValue(row.session_mode),
    transcript_style: normalizedContextValue(row.transcript_style),
    source_language: normalizedContextValue(row.source_language),
    target_language: normalizedContextValue(row.target_language),
  };
  if (!(contextMatches(context.review_mode, current.review_mode) &&
        contextMatches(context.session_mode, current.session_mode) &&
        contextMatches(context.transcript_style, current.transcript_style) &&
        contextMatches(context.source_language, current.source_language) &&
        contextMatches(context.target_language, current.target_language))) return null;
  return {
    id,
    rule,
    category: text(row.category, 40) || "other",
    context,
    approved_at: text(row.approved_at, 80),
  };
}

function approvedLearningEntry(rule: ApprovedLearningRule): string {
  return `- ${rule.category}: ${rule.rule}`;
}

function boundApprovedLearningRules(rules: ApprovedLearningRule[]): ApprovedLearningRule[] {
  const bounded: ApprovedLearningRule[] = [];
  let chars = APPROVED_LEARNING_PROMPT_PREFIX.length;
  for (const rule of rules) {
    if (bounded.length >= MAX_APPROVED_LEARNING_RULES) break;
    const entry = approvedLearningEntry(rule);
    if (chars + entry.length + 1 > MAX_APPROVED_LEARNING_PROMPT_CHARS) break;
    bounded.push(rule);
    chars += entry.length + 1;
  }
  return bounded;
}

function approvedLearningPrompt(rules: ApprovedLearningRule[]): string {
  const bounded = boundApprovedLearningRules(rules);
  return bounded.length
    ? `${APPROVED_LEARNING_PROMPT_PREFIX}\n${bounded.map(approvedLearningEntry).join("\n")}`
    : "";
}

async function retrieveApprovedPrivateLearningRules(user: JsonRecord, session: JsonRecord, source: string, target: string): Promise<ApprovedLearningRule[]> {
  const owner = text(user.email, 320).toLowerCase();
  if (!owner) return [];
  try {
    const service = accessServiceClient();
    const rows = await service.entities.AiLearningItem.filter(
      { source_owner_email: owner, scope_key: "PRIVATE_PROJECT", status: "APPROVED", active: true },
      "-approved_at",
      100,
    ) as JsonRecord[];
    const current = currentLearningContext(session, source, target);
    const rules: ApprovedLearningRule[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row !== "object" || row.source_owner_email !== owner) continue;
      const rule = safeApprovedLearningRule(row, current);
      if (rule) rules.push(rule);
      if (rules.length >= MAX_APPROVED_LEARNING_RULES) break;
    }
    return boundApprovedLearningRules(rules);
  } catch {
    console.error("translate approved learning retrieval failed");
    return [];
  }
}

async function enforceTranscriptionAccess(request: Request, user: JsonRecord): Promise<Response | null> {
  const ownerEmail = text(user.email).toLowerCase();
  if (!ownerEmail) return failure(request, new PublicError("Authentication required.", 401));
  const service = accessServiceClient();
  const profiles = await service.entities.UserAccessProfile.filter({ owner_email: ownerEmail }, "-updated_at", 5) as JsonRecord[];
  const profile = Array.isArray(profiles) ? profiles[0] : undefined;
  if (!profile) return failure(request, new PublicError("Transcription access is currently unavailable.", 403));
  const subscriptions = await service.entities.ManualSubscription.filter({ owner_email: ownerEmail }, "-updated_at", 5) as JsonRecord[];
  const subscription = Array.isArray(subscriptions) ? subscriptions[0] : undefined;
  const profilePremiumEnd = timestamp(profile.premium_end);
  const subscriptionPremiumEnd = timestamp(subscription?.premium_end);
  const premiumEnd = Math.max(profilePremiumEnd ?? 0, subscriptionPremiumEnd ?? 0);
  const trialEnd = timestamp(profile.trial_end) ?? 0;
  const now = Date.now();
  const premiumActive = premiumEnd > now && text(subscription?.status, 24).toUpperCase() !== "NONE";
  const trialActive = trialEnd > now;
  const pendingRows = await service.entities.ManualPaymentSubmission.filter({ owner_email: ownerEmail }, "-created_at", 50) as JsonRecord[];
  const pending = Array.isArray(pendingRows) && pendingRows.some((row) => text(row.status, 24).toUpperCase() === "PENDING");
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
  const profileId = text(profile.id, 160);
  if (profileId && text(profile.lifecycle_status, 40) !== status) {
    try {
      await service.entities.UserAccessProfile.update(profileId, { lifecycle_status: status });
    } catch {
      console.error("translate access state sync failed");
    }
  }
  if (status === "TRIALING" || status === "PREMIUM_ACTIVE") return null;
  return failure(request, new PublicError("Transcription access is currently unavailable.", 403));
}

async function authenticate(request: Request): Promise<Authenticated | Response> {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return failure(request, new PublicError("Authentication required.", 401));
  const client = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
  client.auth.setToken(token);
  let user: JsonRecord;
  try {
    user = await client.auth.me() as JsonRecord;
  } catch {
    return failure(request, new PublicError("Authentication required.", 401));
  }
  if (!text(user.email)) return failure(request, new PublicError("Authentication required.", 401));
  const headers: Record<string, string> = { Authorization: authorization };
  const origin = request.headers.get("Origin");
  if (origin) headers.Origin = origin;
  return { client, user, headers };
}

async function readRequestBody(request: Request): Promise<JsonRecord> {
  const contentType = (request.headers.get("Content-Type") || "").trim();
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new PublicError("The request is too large.", 413);
  if (!request.body) throw new PublicError("A JSON request body is required.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) throw new PublicError("The request is too large.", 413);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new PublicError("Send a valid JSON request body.", 400); }
  if (mediaType && mediaType !== "application/json" && mediaType !== "text/plain") {
    throw new PublicError("Send a JSON request body.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PublicError("Send a JSON object with session_id and segment_id.", 400);
  const body = parsed as JsonRecord;
  const keys = Object.keys(body);
  if (keys.length !== 2 || keys.some((key) => key !== "session_id" && key !== "segment_id")) {
    throw new PublicError("Only session_id and segment_id are accepted.", 400);
  }
  const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
  const segmentId = typeof body.segment_id === "string" ? body.segment_id.trim() : "";
  if (!sessionId || !segmentId || sessionId.length > 200 || segmentId.length > 200) {
    throw new PublicError("session_id and segment_id are required.", 400);
  }
  return { session_id: sessionId, segment_id: segmentId };
}

function normalizeLanguage(value: unknown): string {
  if (typeof value !== "string") return "";
  const raw = value.trim().toLowerCase().replace(/_/g, "-").replace(/\s+/g, " ");
  if (AUTO_VALUES.has(raw)) return "auto";
  const option = LANGUAGE_CATALOG.find(([code, label]) => code === raw || label.toLowerCase() === raw);
  return option?.[0] || "";
}

function languageLabel(code: string): string {
  return LANGUAGE_CATALOG.find(([candidate]) => candidate === code)?.[1] || code;
}

function validateLanguages(session: JsonRecord): { source: string; target: string } {
  const sourceValue = session.translation_source_language == null ||
    (typeof session.translation_source_language === "string" && !session.translation_source_language.trim())
    ? "auto"
    : session.translation_source_language;
  const source = normalizeLanguage(sourceValue);
  const target = normalizeLanguage(session.translation_target_language);
  if (!source) throw new PublicError("The saved source language is not supported.", 409);
  if (!target || target === "auto") throw new PublicError("The saved target language is not supported.", 409);
  if (source !== "auto" && source === target) throw new PublicError("Source and target languages must be different.", 409);
  return { source, target };
}

const GUIDELINE_NEGATION = /\b(?:do not|don't|never|must not|mustn't|avoid|without|cannot|can't|no)\b/i;
function hasPositiveGuidelineInstruction(value: string, pattern: RegExp): boolean {
  return value.toLowerCase().split(/[\n.!?;]+/).some((clause) => pattern.test(clause) && !GUIDELINE_NEGATION.test(clause.slice(0, 120)));
}

function savedTranslationGuideline(session: JsonRecord): Guideline {
  if (session.review_mode !== "custom_guidelines") return { status: "not_applied", text: "", saved_at: "" };
  const status = text(session.custom_guideline_status, 40).toLowerCase();
  if (status !== "ready") throw new PublicError("Custom Guidelines must be ready before translation.", 409);
  const raw = typeof session.custom_guideline_text === "string"
    ? session.custom_guideline_text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim()
    : "";
  if (!raw) throw new PublicError("Custom Guidelines are missing.", 409);
  if (raw.length > MAX_GUIDELINE_CHARS) throw new PublicError("Custom Guidelines exceed the 12,000 character limit.", 409);
  if (hasPositiveGuidelineInstruction(raw, /\b(?:invent|fabricate|make up|guess|reconstruct|hallucinate|fill in)\b/)) {
    throw new PublicError("Custom Guidelines cannot ask translation to invent or guess speech.", 409);
  }
  if (hasPositiveGuidelineInstruction(raw, /\b(?:summari[sz]e|paraphrase)\b/) ||
      hasPositiveGuidelineInstruction(raw, /\brewrite\b.{0,60}\b(?:meaning|speech|what was said)\b/)) {
    throw new PublicError("Custom Guidelines cannot ask translation to summarize or change spoken meaning.", 409);
  }
  if (hasPositiveGuidelineInstruction(raw, /\b(?:identify|infer|deduce|determine|recognize|rename|change)\b.{0,80}\b(?:speaker|person|identity|role|speaker labels?)\b/)) {
    throw new PublicError("Custom Guidelines cannot identify speakers or change speaker labels.", 409);
  }
  if (hasPositiveGuidelineInstruction(raw, /\b(?:add|remove|rename|change|move|relocate|reset|restart|retime|generate|invent)\b.{0,80}\b(?:timestamps?|speaker labels?|sound[- ]events?|event markers?|markers?)\b/)) {
    throw new PublicError("Custom Guidelines cannot change source timestamps or markers.", 409);
  }
  return {
    status: "ready",
    text: raw,
    saved_at: text(session.custom_guideline_saved_at, 80),
  };
}

function optionalLineValue(value: unknown, max: number): string {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || value.length > max) throw new PublicError("A source transcript line contains invalid metadata.", 422);
  return value;
}

function canonicalLines(rows: unknown[], sessionId: string, segmentId: string): CanonicalLine[] {
  if (rows.length > MAX_LINES) throw new PublicError("This segment has too many transcript lines to translate safely.", 413);
  const ids = new Set<string>();
  const lines = rows.map((value) => {
    if (!value || typeof value !== "object") throw new PublicError("The source transcript is invalid.", 422);
    const row = value as JsonRecord;
    if (row.session_id !== sessionId || row.source_segment_id !== segmentId) throw new PublicError("The source transcript does not belong to this segment.", 422);
    const id = typeof row.id === "string" ? row.id : "";
    const sequence = finiteNumber(row.sequence);
    const kind = row.kind;
    if (!id || id.length > 200 || ids.has(id) || sequence == null) throw new PublicError("The source transcript is invalid.", 422);
    if (kind !== "speech" && kind !== "marker" && kind !== "timestamp") throw new PublicError("The source transcript contains an unsupported line kind.", 422);
    ids.add(id);
    const sourceText = typeof row.text === "string" ? row.text : "";
    if (sourceText.length > MAX_LINE_TEXT || /\u0000/.test(sourceText)) throw new PublicError("A source transcript line is too large.", 413);
    if (kind === "speech" && !sourceText.trim()) throw new PublicError("The source transcript contains an empty speech line.", 422);
    const line: CanonicalLine = {
      source_line_id: id,
      sequence,
      kind,
      source_text: sourceText,
      speaker_label: optionalLineValue(row.speaker_label, 160),
      provider_speaker_id: optionalLineValue(row.provider_speaker_id, 200),
    };
    for (const field of ["start_ms", "end_ms"] as const) {
      const raw = row[field];
      if (raw === undefined || raw === null || raw === "") continue;
      const numeric = finiteNumber(raw);
      if (numeric == null) throw new PublicError("The source transcript contains invalid timing.", 422);
      line[field] = numeric;
    }
    return line;
  });
  lines.sort((left, right) => left.sequence - right.sequence || left.source_line_id.localeCompare(right.source_line_id));
  const sourceChars = lines.reduce((total, line) => total + line.source_line_id.length + line.source_text.length, 0);
  if (sourceChars > MAX_SOURCE_CHARS) throw new PublicError("This segment is too large to translate safely.", 413);
  return lines;
}

function snapshot(line: CanonicalLine, translatedText: string): JsonRecord {
  const output: JsonRecord = {
    source_line_id: line.source_line_id,
    sequence: line.sequence,
    kind: line.kind,
    source_text: line.source_text,
    translated_text: translatedText,
    speaker_label: line.speaker_label,
    provider_speaker_id: line.provider_speaker_id,
  };
  if (line.start_ms !== undefined) output.start_ms = line.start_ms;
  if (line.end_ms !== undefined) output.end_ms = line.end_ms;
  return output;
}

function integrationResponseObject(value: unknown): JsonRecord {
  if (typeof value === "string") {
    try { return integrationResponseObject(JSON.parse(value)); } catch { return {}; }
  }
  if (!value || typeof value !== "object") return {};
  const record = value as JsonRecord;
  return record.result === undefined ? record : integrationResponseObject(record.result);
}

function bracketedTags(value: string): string[] {
  return value.match(/\[[^\]]+\]/g) ?? [];
}

function sameBracketedTags(left: string, right: string): boolean {
  const sourceTags = bracketedTags(left);
  const translatedTags = bracketedTags(right);
  return sourceTags.length === translatedTags.length && sourceTags.every((tag, index) => tag === translatedTags[index]);
}

function providerDetectedLanguage(segment: JsonRecord): string {
  const candidates: unknown[] = [segment.detected_language, ...(Array.isArray(segment.detected_languages) ? segment.detected_languages : [])];
  for (const candidate of candidates) {
    const normalized = normalizeLanguage(candidate);
    if (normalized && normalized !== "auto") return normalized;
  }
  return "";
}

async function digest(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function translateSpeech(
  client: SuperdevClient,
  speech: CanonicalLine[],
  source: string,
  target: string,
  guideline: Guideline,
  approvedRules: ApprovedLearningRule[],
  headers: Record<string, string>,
): Promise<{ translations: Map<string, string>; detected: string }> {
  const input = speech.map((line) => ({ source_line_id: line.source_line_id, source_text: line.source_text }));
  const prompt = [
    "Translate the canonical transcript speech lines below.",
    `Target language: ${target} (${languageLabel(target)}). The selected target is authoritative.`,
    source === "auto" ? "Source language: Auto Detect. Return a supported detected source code only when it is known." : `Source language: ${source} (${languageLabel(source)}).`,
    "Return exactly one translation for every supplied source_line_id, with no missing, repeated, added, or reordered lines.",
    "Translate for contextual meaning. Preserve names, numbers, terminology, intent, punctuation, uncertainty markers, and speaker meaning. Do not summarize, paraphrase, invent, guess, identify speakers, create events, create timestamps, or alter source markers.",
    guideline.text ? `User translation guideline:\n${guideline.text}` : "No custom translation guideline applies.",
    ...(approvedLearningPrompt(approvedRules) ? [approvedLearningPrompt(approvedRules)] : []),
    `Canonical speech lines:\n${JSON.stringify(input)}`,
  ].join("\n\n");
  const response = await client.integrations.core.invokeLLM({
    mode: "standard",
    prompt,
    response_json_schema: {
      type: "object",
      properties: {
        detected_source_language: { type: "string", maxLength: 40 },
        translations: {
          type: "array",
          maxItems: speech.length,
          items: {
            type: "object",
            properties: {
              source_line_id: { type: "string", maxLength: 200 },
              translated_text: { type: "string", minLength: 1, maxLength: MAX_LINE_TEXT },
            },
            required: ["source_line_id", "translated_text"],
          },
        },
      },
      required: ["detected_source_language", "translations"],
    },
  }, { headers });
  const parsed = integrationResponseObject(response);
  const entries = Array.isArray(parsed.translations) ? parsed.translations : [];
  if (entries.length !== speech.length) throw new PublicError("The translation service returned an incomplete line set.", 502);
  const expected = new Set(speech.map((line) => line.source_line_id));
  const translations = new Map<string, string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") throw new PublicError("The translation service returned an invalid line set.", 502);
    const item = entry as JsonRecord;
    const id = typeof item.source_line_id === "string" ? item.source_line_id : "";
    const translated = typeof item.translated_text === "string" ? item.translated_text.trim() : "";
    const sourceLine = speech.find((line) => line.source_line_id === id);
    if (!expected.has(id) || translations.has(id) || !translated || translated.length > MAX_LINE_TEXT || /[\r\n\u0000]/.test(translated) || !sourceLine || !sameBracketedTags(sourceLine.source_text, translated)) {
      throw new PublicError("The translation service returned an invalid line set.", 502);
    }
    translations.set(id, translated);
  }
  if (translations.size !== speech.length) throw new PublicError("The translation service returned an incomplete line set.", 502);
  const modelDetected = typeof parsed.detected_source_language === "string" ? normalizeLanguage(parsed.detected_source_language) : "";
  return { translations, detected: modelDetected && modelDetected !== "auto" ? modelDetected : "" };
}

async function latestResult(client: SuperdevClient, sessionId: string, segmentId: string): Promise<JsonRecord | undefined> {
  const rows = await client.entities.TranslationResult.filter({ session_id: sessionId, source_segment_id: segmentId }, "-updated_at", 20) as JsonRecord[];
  if (!Array.isArray(rows)) return undefined;
  return rows.find((row) => row && typeof row.id === "string");
}

function resultId(value: JsonRecord): string {
  return typeof value.id === "string" ? value.id : "";
}

async function saveResult(client: SuperdevClient, existing: JsonRecord | undefined, data: JsonRecord): Promise<JsonRecord> {
  const saved = existing && resultId(existing)
    ? await client.entities.TranslationResult.update(resultId(existing), data)
    : await client.entities.TranslationResult.create(data);
  if (!saved || typeof saved !== "object") throw new Error("Translation result was not saved.");
  const record = saved as JsonRecord;
  if (!resultId(record)) throw new Error("Translation result was not saved.");
  return record;
}

async function markFailed(client: SuperdevClient, result: JsonRecord, error: string): Promise<void> {
  const id = resultId(result);
  if (!id) return;
  try {
    await client.entities.TranslationResult.update(id, {
      status: "failed",
      error: error.slice(0, MAX_ERROR_LENGTH),
      failed_at: new Date().toISOString(),
      translated_at: "",
    });
  } catch {
    console.error("translate result failure state could not be saved");
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(request) });
  if (request.method !== "POST") {
    const response = failure(request, new PublicError("Only POST requests are supported.", 405));
    response.headers.set("Allow", "POST, OPTIONS");
    return response;
  }

  const authenticated = await authenticate(request);
  if (authenticated instanceof Response) return authenticated;

  let activeResult: JsonRecord | undefined;
  try {
    const accessResponse = await enforceTranscriptionAccess(request, authenticated.user);
    if (accessResponse) return accessResponse;
    const body = await readRequestBody(request);
    const sessionId = String(body.session_id);
    const segmentId = String(body.segment_id);
    const session = await authenticated.client.entities.TranscriptionSession.get(sessionId) as JsonRecord;
    if (!session) throw new PublicError("Session not found.", 404);
    if (session.session_mode !== "translation") throw new PublicError("This session is not configured for translation.", 409);
    const segment = await authenticated.client.entities.AudioSegment.get(segmentId) as JsonRecord;
    if (!segment || segment.session_id !== sessionId) throw new PublicError("Segment not found in this session.", 404);
    if (segment.transcription_status !== "completed") throw new PublicError("Transcribe this segment before translating it.", 409);
    const sequence = finiteNumber(segment.sequence);
    if (sequence == null) throw new PublicError("The source segment is invalid.", 422);

    const language = validateLanguages(session);
    const guideline = savedTranslationGuideline(session);
    const rows = await authenticated.client.entities.TranscriptLine.filter(
      { session_id: sessionId, source_segment_id: segmentId },
      "sequence",
      MAX_LINES + 1,
    ) as JsonRecord[];
    const lines = canonicalLines(Array.isArray(rows) ? rows : [], sessionId, segmentId);
    const speech = lines.filter((line) => line.kind === "speech");
    const hashLines = lines.map((line) => ({ ...line }));
    const sourceHash = await digest({ lines: hashLines });
    const approvedRules = await retrieveApprovedPrivateLearningRules(authenticated.user, session, language.source, language.target);
    const settingsHash = await digest({
      source_hash: sourceHash,
      source_language: language.source,
      target_language: language.target,
      review_mode: session.review_mode === "custom_guidelines" ? "custom_guidelines" : "standard",
      guideline: { status: guideline.status, text: guideline.text, saved_at: guideline.saved_at },
      approved_private_project_knowledge: approvedRules.map((rule) => ({
        id: rule.id,
        rule: rule.rule,
        category: rule.category,
        context: rule.context,
        approved_at: rule.approved_at,
      })),
    });
    const existing = await latestResult(authenticated.client, sessionId, segmentId);
    if (existing?.status === "completed" && existing.source_hash === sourceHash && existing.settings_hash === settingsHash) {
      return json(request, { ok: true, status: "completed", result: existing });
    }
    if (existing?.status === "translating" && existing.source_hash === sourceHash && existing.settings_hash === settingsHash) {
      const started = timestamp(existing.translation_started_at);
      if (started != null && Date.now() - started < MAX_RESULT_RETRY_AGE_MS) {
        return json(request, { ok: true, status: "in_progress", result: existing });
      }
    }

    const previousRetry = finiteNumber(existing?.retry);
    const retry = existing ? Math.max(0, Math.floor(previousRetry ?? 0)) + 1 : 0;
    const startedAt = new Date().toISOString();
    const providerDetected = providerDetectedLanguage(segment);
    const detectedBeforeModel = language.source === "auto" ? providerDetected : language.source;
    const pendingLines = lines.map((line) => snapshot(line, line.kind === "speech" ? "" : line.source_text));
    activeResult = await saveResult(authenticated.client, existing, {
      session_id: sessionId,
      source_segment_id: segmentId,
      source_sequence: sequence,
      status: "translating",
      requested_source_language: language.source,
      detected_source_language: detectedBeforeModel,
      target_language: language.target,
      source_hash: sourceHash,
      settings_hash: settingsHash,
      lines: pendingLines,
      error: "",
      retry,
      translation_started_at: startedAt,
      translated_at: "",
      failed_at: "",
    });

    try {
      let translated = new Map<string, string>();
      let detected = detectedBeforeModel;
      if (speech.length) {
        const model = await translateSpeech(authenticated.client, speech, language.source, language.target, guideline, approvedRules, authenticated.headers);
        translated = model.translations;
        if (language.source === "auto" && !detected && model.detected) detected = model.detected;
      }
      const completedLines = lines.map((line) => snapshot(
        line,
        line.kind === "speech" ? (translated.get(line.source_line_id) || "") : line.source_text,
      ));
      if (speech.some((line) => !translated.has(line.source_line_id))) throw new PublicError("The translation service returned an incomplete line set.", 502);
      const completionPatch: JsonRecord = {
        status: "completed",
        detected_source_language: detected,
        lines: completedLines,
        error: "",
        translated_at: new Date().toISOString(),
        failed_at: "",
      };
      const saved = await authenticated.client.entities.TranslationResult.update(resultId(activeResult), completionPatch) as JsonRecord;
      const result = { ...activeResult, ...(saved && typeof saved === "object" ? saved : {}), ...completionPatch };
      return json(request, { ok: true, status: "completed", result });
    } catch (error) {
      const publicFailure = error instanceof PublicError ? error.message : "Translation could not be completed. Please try again.";
      await markFailed(authenticated.client, activeResult, publicFailure);
      return failure(request, error, 502);
    }
  } catch (error) {
    console.error("translate-transcript-segment failed", error instanceof PublicError ? "request" : "operation");
    return failure(request, error);
  }
});
