import { createSuperdevClient } from "npm:@superdevhq/client@0.1.56";

type JsonRecord = Record<string, unknown>;
type SuperdevClient = ReturnType<typeof createSuperdevClient>;
type Authenticated = { client: SuperdevClient; user: JsonRecord; headers: Record<string, string> };
type VoiceCandidate = { voice_id: string; category: string; verified_languages: string[] };
type AudioOutcome = { audio_status: "synthesizing" | "completed" | "failed"; result: JsonRecord; error?: string };

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_TTS_CHARS = 4_500;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_ERROR_LENGTH = 320;
const STALE_SYNTHESIS_MS = 10 * 60_000;
const ALLOWED_ORIGIN = "https://www.buildy.ai";
const PREVIEW_ORIGIN_PATTERN = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:superdev\.run|buildy\.show)$/i;
const SUPPORTED_AUDIO_TYPES = new Set([
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm", "audio/mp4", "application/octet-stream",
]);

let voicesPromise: Promise<VoiceCandidate[]> | null = null;
const selectedVoices = new Map<string, VoiceCandidate>();
const inFlightSynthesis = new Map<string, Promise<AudioOutcome>>();

class PublicError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PublicError";
    this.status = status;
  }
}

function text(value: unknown, max = 320): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
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
    : "Translated audio could not be generated. Please try again.";
  const status = error instanceof PublicError ? error.status : fallbackStatus;
  return json(request, { ok: false, audio_status: "failed", error: message }, status);
}

function timestamp(value: unknown): number | undefined {
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

function ownerMatches(row: JsonRecord, email: string): boolean {
  return text(row.created_by, 320).toLowerCase() === email;
}

function accessServiceClient(): SuperdevClient {
  const key = Deno.env.get("SUPERDEV_SERVICE_ROLE_KEY");
  if (!key) throw new Error("Access service is not configured.");
  const service = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
  service.auth.setToken(key);
  return service;
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
    try { await service.entities.UserAccessProfile.update(profileId, { lifecycle_status: status }); } catch { console.error("audio access state sync failed"); }
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
  try { user = await client.auth.me() as JsonRecord; } catch { return failure(request, new PublicError("Authentication required.", 401)); }
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
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new PublicError("Send a valid JSON request body.", 400); }
  if (mediaType && mediaType !== "application/json" && mediaType !== "text/plain") {
    throw new PublicError("Send a JSON request body.", 400);
  }
  const body = record(parsed);
  if (!body) throw new PublicError("Send a JSON object with session_id and translation_result_id.", 400);
  const keys = Object.keys(body);
  if (keys.length !== 2 || keys.some((key) => key !== "session_id" && key !== "translation_result_id")) throw new PublicError("Only session_id and translation_result_id are accepted.", 400);
  const sessionId = text(body.session_id, 200);
  const resultId = text(body.translation_result_id, 200);
  if (!sessionId || !resultId) throw new PublicError("session_id and translation_result_id are required.", 400);
  return { session_id: sessionId, translation_result_id: resultId };
}

function languageBase(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-").split("-")[0] || "";
}

function voiceLanguageValues(row: JsonRecord): string[] {
  const values: string[] = [];
  const verified = row.verified_languages;
  if (!Array.isArray(verified)) return values;
  verified.forEach((entry) => {
    if (typeof entry === "string") values.push(entry);
    else {
      const item = record(entry);
      if (item) { values.push(text(item.language, 40), text(item.locale, 40)); }
    }
  });
  return values.filter(Boolean);
}

function parseVoices(payload: unknown): VoiceCandidate[] {
  const root = record(payload);
  const rawVoices = root && Array.isArray(root.voices) ? root.voices : [];
  return rawVoices.map((value) => {
    const row = record(value);
    if (!row) return null;
    const voiceId = text(row.voice_id, 200);
    return voiceId ? { voice_id: voiceId, category: text(row.category, 80).toLowerCase(), verified_languages: voiceLanguageValues(row) } : null;
  }).filter((voice): voice is VoiceCandidate => Boolean(voice));
}

async function discoverVoices(apiKey: string): Promise<VoiceCandidate[]> {
  if (voicesPromise) return voicesPromise;
  const pending = (async () => {
    const response = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": apiKey, Accept: "application/json" } });
    if (!response.ok) throw new PublicError("The voice service is temporarily unavailable. Please try again.", 503);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new PublicError("The voice service returned an invalid response. Please try again.", 502); }
    const voices = parseVoices(payload);
    if (!voices.length) throw new PublicError("No voice is available for translated audio. Please try again later.", 503);
    return voices;
  })();
  const cached = pending.catch((error) => { voicesPromise = null; throw error; });
  voicesPromise = cached;
  return cached;
}

async function selectVoice(targetLanguage: string, apiKey: string): Promise<VoiceCandidate> {
  const target = languageBase(targetLanguage);
  const cached = selectedVoices.get(target);
  if (cached) return cached;
  const voices = await discoverVoices(apiKey);
  const ranked = voices.map((voice) => ({
    voice,
    rank: voice.verified_languages.some((language) => languageBase(language) === target) ? 0 : voice.category === "premade" ? 1 : 2,
  })).sort((left, right) => left.rank - right.rank || left.voice.voice_id.localeCompare(right.voice.voice_id));
  const selected = ranked[0]?.voice;
  if (!selected) throw new PublicError("No usable voice is available for translated audio. Please try again later.", 503);
  selectedVoices.set(target, selected);
  return selected;
}

function normalizedMime(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  return Array.from(value).every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

function looksLikeAudio(bytes: Uint8Array, mime: string): boolean {
  if (bytes.byteLength < 64) return false;
  if (mime === "audio/mpeg" || mime === "audio/mp3" || mime === "application/octet-stream") {
    if (asciiAt(bytes, 0, "ID3")) return true;
    return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  }
  if (mime === "audio/wav" || mime === "audio/x-wav") return asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE");
  if (mime === "audio/ogg") return asciiAt(bytes, 0, "OggS");
  if (mime === "audio/webm") return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  if (mime === "audio/mp4") return asciiAt(bytes, 4, "ftyp");
  return false;
}

async function readAudioBytes(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new PublicError("The voice service returned an empty audio file. Please retry.", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_AUDIO_BYTES) throw new PublicError("This translated audio clip is too large to save safely.", 413);
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function requestAudio(apiKey: string, voiceId: string, speech: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text: speech, model_id: "eleven_multilingual_v2" }),
  });
  if (!response.ok) throw new PublicError(response.status === 429 ? "The voice service is busy. Please retry in a moment." : "The voice service could not create this clip. Please try again.", 502);
  const mime = normalizedMime(response.headers.get("content-type") || "");
  if (!SUPPORTED_AUDIO_TYPES.has(mime)) throw new PublicError("The voice service returned an unsupported audio file. Please retry.", 502);
  const bytes = await readAudioBytes(response);
  if (!looksLikeAudio(bytes, mime)) throw new PublicError("The voice service returned invalid audio. Please retry.", 502);
  return { bytes, mime: "audio/mpeg" };
}

function safeAudioUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch { return ""; }
}

function uploadedFileUrl(value: unknown): string {
  const row = record(value);
  if (!row) return "";
  const direct = safeAudioUrl(row.file_url);
  if (direct) return direct;
  return safeAudioUrl(record(row.result)?.file_url);
}

async function uploadAudio(client: SuperdevClient, bytes: Uint8Array, headers: Record<string, string>): Promise<string> {
  const integrations = client.integrations.core as unknown as { uploadFile: (input: unknown, options?: unknown) => Promise<unknown> };
  const uploaded = await integrations.uploadFile({ file: new File([bytes], "translation-audio.mp3", { type: "audio/mpeg" }) }, { headers });
  const url = uploadedFileUrl(uploaded);
  if (!url) throw new PublicError("The generated audio could not be saved. Please try again.", 502);
  return url;
}

function speechText(result: JsonRecord): string {
  const rawLines = Array.isArray(result.lines) ? result.lines : [];
  const pieces: { sequence: number; text: string }[] = [];
  let speechLineCount = 0;
  rawLines.forEach((value) => {
    const line = record(value);
    if (!line || line.kind !== "speech") return;
    speechLineCount += 1;
    const translated = typeof line.translated_text === "string"
      ? line.translated_text.replace(/\[[^\]\r\n]{0,240}\]/g, " ").replace(/[\u0000\r\n]+/g, " ").replace(/\s+/g, " ").trim()
      : "";
    if (translated) pieces.push({ sequence: typeof line.sequence === "number" && Number.isFinite(line.sequence) ? line.sequence : pieces.length, text: translated });
  });
  if (!speechLineCount || pieces.length !== speechLineCount) throw new PublicError("Translated speech is empty. Retry the translation before creating audio.", 409);
  pieces.sort((left, right) => left.sequence - right.sequence);
  const combined = Array.from(pieces.map((piece) => piece.text).join("\n")).slice(0, MAX_TTS_CHARS).join("").trim();
  if (!combined) throw new PublicError("Translated speech is empty. Retry the translation before creating audio.", 409);
  return combined;
}

function resultId(row: JsonRecord): string {
  return text(row.id, 200);
}

function audioIsComplete(row: JsonRecord): boolean {
  const audioGeneratedAt = timestamp(row.audio_generated_at);
  const translatedAt = timestamp(row.translated_at);
  return text(row.audio_status, 40) === "completed"
    && Boolean(safeAudioUrl(row.audio_url))
    && audioGeneratedAt != null
    && (translatedAt == null || audioGeneratedAt >= translatedAt);
}

function mergeSaved(base: JsonRecord, saved: unknown, patch: JsonRecord): JsonRecord {
  const savedRow = record(saved);
  return { ...base, ...(savedRow || {}), ...patch };
}

async function updateAudio(client: SuperdevClient, base: JsonRecord, patch: JsonRecord): Promise<JsonRecord> {
  const id = resultId(base);
  if (!id) throw new Error("Translation result is missing an id.");
  const saved = await client.entities.TranslationResult.update(id, patch) as unknown;
  if (!record(saved)) throw new Error("Translation audio state was not saved.");
  return mergeSaved(base, saved, patch);
}

function safeAudioError(error: unknown): string {
  if (error instanceof PublicError) return error.message.slice(0, MAX_ERROR_LENGTH);
  return "Translated audio could not be generated. Please try again.";
}

async function markAudioFailed(client: SuperdevClient, base: JsonRecord, error: unknown): Promise<AudioOutcome> {
  const message = safeAudioError(error);
  const patch: JsonRecord = {
    audio_status: "failed",
    audio_url: "",
    audio_mime_type: "",
    audio_voice_id: "",
    audio_error: message,
    audio_generated_at: "",
  };
  try {
    const result = await updateAudio(client, base, patch);
    return { audio_status: "failed", result, error: message };
  } catch {
    console.error("translation audio failure state could not be saved");
    return { audio_status: "failed", result: { ...base, ...patch }, error: message };
  }
}

async function performSynthesis(authenticated: Authenticated, base: JsonRecord, speech: string, targetLanguage: string): Promise<AudioOutcome> {
  let working = base;
  try {
    working = await updateAudio(authenticated.client, base, {
      audio_status: "synthesizing", audio_url: "", audio_mime_type: "", audio_voice_id: "", audio_error: "", audio_generated_at: "",
    });
    const apiKey = text(Deno.env.get("ELEVENLABS_API_KEY"), 400);
    if (!apiKey) throw new PublicError("Translated audio is not available right now. Please try again later.", 503);
    const voice = await selectVoice(targetLanguage, apiKey);
    const generated = await requestAudio(apiKey, voice.voice_id, speech);
    const url = await uploadAudio(authenticated.client, generated.bytes, authenticated.headers);
    const patch: JsonRecord = {
      audio_status: "completed",
      audio_url: url,
      audio_mime_type: generated.mime,
      audio_voice_id: voice.voice_id,
      audio_error: "",
      audio_generated_at: new Date().toISOString(),
    };
    const result = await updateAudio(authenticated.client, working, patch);
    return { audio_status: "completed", result };
  } catch (error) {
    return markAudioFailed(authenticated.client, working, error);
  }
}

async function synthesizeForResult(authenticated: Authenticated, sessionId: string, translationResultId: string): Promise<AudioOutcome> {
  const ownerEmail = text(authenticated.user.email, 320).toLowerCase();
  const session = record(await authenticated.client.entities.TranscriptionSession.get(sessionId));
  if (!session || !ownerMatches(session, ownerEmail)) throw new PublicError("Session not found.", 404);
  if (session.session_mode !== "translation") throw new PublicError("This session is not configured for translation.", 409);
  const result = record(await authenticated.client.entities.TranslationResult.get(translationResultId));
  if (!result || !ownerMatches(result, ownerEmail) || result.session_id !== sessionId) throw new PublicError("Translation result not found in this session.", 404);
  if (result.status !== "completed") throw new PublicError("Complete the translated text before creating audio.", 409);
  const targetLanguage = text(result.target_language, 40).toLowerCase();
  if (!targetLanguage || targetLanguage === "auto") throw new PublicError("The translated target language is unavailable.", 409);
  let speech: string;
  try { speech = speechText(result); } catch (error) { return markAudioFailed(authenticated.client, result, error); }
  if (audioIsComplete(result)) return { audio_status: "completed", result };
  const active = inFlightSynthesis.get(translationResultId);
  if (active) return active;
  const updatedAt = timestamp(result.updated_at);
  if (text(result.audio_status, 40) === "synthesizing" && updatedAt != null && Date.now() - updatedAt < STALE_SYNTHESIS_MS) {
    return { audio_status: "synthesizing", result };
  }
  const work = performSynthesis(authenticated, result, speech, targetLanguage);
  inFlightSynthesis.set(translationResultId, work);
  try { return await work; } finally { if (inFlightSynthesis.get(translationResultId) === work) inFlightSynthesis.delete(translationResultId); }
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
  try {
    const accessResponse = await enforceTranscriptionAccess(request, authenticated.user);
    if (accessResponse) return accessResponse;
    const body = await readRequestBody(request);
    const outcome = await synthesizeForResult(authenticated, String(body.session_id), String(body.translation_result_id));
    if (outcome.audio_status === "failed") return json(request, { ok: false, audio_status: "failed", error: outcome.error, result: outcome.result });
    return json(request, { ok: true, audio_status: outcome.audio_status, result: outcome.result });
  } catch (error) {
    console.error("synthesize-translation-audio failed", error instanceof PublicError ? "request" : "operation");
    return failure(request, error);
  }
});
