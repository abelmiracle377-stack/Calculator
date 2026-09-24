import { createSuperdevClient } from "npm:@superdevhq/client@0.1.56";

type JsonRecord = Record<string, unknown>;
type VideoState = "queued" | "processing" | "completed" | "failed";
const LUMA_URL = "https://agents.lumalabs.ai/v1";
const MAX_REQUEST_BYTES = 12_000_000;
const MAX_PROMPT = 6_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DATA_URL_CHARS = 11_500_000;
const MAX_RESPONSE_BYTES = 120_000;
const ALLOWED_RATIOS = ["9:16", "3:4", "1:1", "4:3", "16:9", "21:9"] as const;
const ALLOWED_DURATIONS = ["5s", "10s"] as const;
const ALLOWED_RESOLUTIONS = ["540p", "720p", "1080p"] as const;
const ALLOWED_MODES = ["text-to-video", "image-to-video"] as const;
const PUBLIC_ORIGINS = new Set(["https://trancript.art", "https://www.trancript.art", "https://www.buildy.ai"]);
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:superdev\.run|buildy\.show)$/i;

class PublicError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.name = "PublicError"; this.status = status; }
}
function allowedOrigin(origin: string): boolean { return PUBLIC_ORIGINS.has(origin) || PREVIEW_ORIGIN.test(origin); }
function headers(request: Request): HeadersInit {
  const origin = request.headers.get("Origin")?.trim() || "";
  return { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin", ...(allowedOrigin(origin) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" } : {}) };
}
function json(request: Request, payload: unknown, status = 200): Response { return new Response(JSON.stringify(payload), { status, headers: headers(request) }); }
function text(value: unknown, max: number): string { return typeof value === "string" ? value.replace(/\u0000/g, "").replace(/[\u0001-\u001F\u007F]/g, " ").trim().slice(0, max) : ""; }
function requiredText(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || value.length > max) throw new PublicError(`${label} must be between 1 and ${max.toLocaleString()} characters.`);
  const cleaned = text(value, max);
  if (!cleaned) throw new PublicError(`${label} is required.`);
  return cleaned;
}
function choice(value: unknown, values: readonly string[], label: string): string {
  const candidate = text(value, 32);
  if (!values.includes(candidate)) throw new PublicError(`Choose a supported ${label}.`);
  return candidate;
}
function record(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function normalizeState(value: unknown): VideoState { const state = text(value, 24).toLowerCase(); return state === "completed" ? "completed" : state === "failed" ? "failed" : state === "queued" ? "queued" : "processing"; }
function providerMessage(status: number): string {
  if (status === 401) return "The video service credentials are invalid. Ask an administrator to reconnect Luma.";
  if (status === 402) return "Luma cannot start this render because its available balance is insufficient.";
  if (status === 413) return "The starting image is too large for Luma. Choose a smaller image.";
  if (status === 422) return "Luma rejected these video settings. Check the prompt, duration, image, and resolution.";
  if (status === 429) return "Luma is busy with too many requests. Wait a moment and try again.";
  if (status === 404) return "Luma could not find that render. Start a new video.";
  if (status >= 500) return "Luma is temporarily unavailable. Try again shortly.";
  return "Luma could not accept this video request. Check the settings and try again.";
}
function asyncFailure(row: JsonRecord): string {
  const code = `${text(row.failure_code, 80)} ${text(row.failure_reason, 180)}`.toLowerCase();
  if (code.includes("content_moderated")) return "Luma could not render this prompt because it was blocked by content safety checks.";
  if (code.includes("budget_exhausted")) return "Luma could not finish this render because its available balance was exhausted.";
  if (code.includes("image_too_large")) return "The starting image is too large for Luma. Choose a smaller image.";
  if (code.includes("unsupported_format")) return "Luma does not support this starting image format. Choose a JPG, PNG, or WEBP image.";
  if (code.includes("corrupt_input")) return "Luma could not read the starting image. Choose another image and try again.";
  if (code.includes("rate_limited")) return "Luma is busy with too many requests. Wait a moment and try again.";
  if (code.includes("output_not_found")) return "Luma finished without a usable video preview. Start a new render.";
  return "Luma could not complete this video. Try a different prompt or starting image.";
}
function safeOutputUrl(value: unknown): string {
  const candidate = typeof value === "string" ? value : text(record(value).url, 4_000);
  try { const url = new URL(candidate); return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password ? url.toString() : ""; } catch { return ""; }
}
function outputUrl(row: JsonRecord): string {
  const output = Array.isArray(row.output) ? row.output[0] : row.output;
  return safeOutputUrl(output) || safeOutputUrl(row.output_url);
}
function imageFrame(value: unknown): { data: string; media_type: string } {
  if (typeof value !== "string" || value.length > MAX_DATA_URL_CHARS) throw new PublicError("Choose a starting image smaller than 8 MB.", 413);
  const match = value.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match || match[2].length % 4 !== 0) throw new PublicError("The starting image could not be read. Choose a JPG, PNG, or WEBP image.");
  const mediaType = match[1].toLowerCase();
  const base64 = match[2];
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  if (Math.floor((base64.length * 3) / 4) - padding > MAX_IMAGE_BYTES) throw new PublicError("Choose a starting image smaller than 8 MB.", 413);
  let decoded: string;
  try { decoded = atob(base64); } catch { throw new PublicError("The starting image could not be read. Choose another image."); }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw new PublicError("Choose a starting image smaller than 8 MB.", 413);
  const jpeg = mediaType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = mediaType === "image/png" && bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const webp = mediaType === "image/webp" && bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!jpeg && !png && !webp) throw new PublicError("The starting image type does not match its contents. Choose another image.");
  return { data: base64, media_type: mediaType };
}
async function readBody(request: Request): Promise<JsonRecord> {
  const contentType = (request.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType && contentType !== "application/json" && contentType !== "text/plain") throw new PublicError("Send a JSON request body.");
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new PublicError("The video request is too large.", 413);
  if (!request.body) throw new PublicError("A JSON request body is required.");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; if (!value) continue; total += value.byteLength; if (total > MAX_REQUEST_BYTES) { await reader.cancel(); throw new PublicError("The video request is too large.", 413); } chunks.push(value); } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown; try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new PublicError("Send a valid JSON request body."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PublicError("Send a JSON object with video settings.");
  return parsed as JsonRecord;
}
async function authenticate(request: Request): Promise<Response | true> {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(request, { error: "Authentication required." }, 401);
  const client = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") }); client.auth.setToken(token);
  try { const user = record(await client.auth.me()); if (!text(user.email, 320)) return json(request, { error: "Authentication required." }, 401); return true; } catch { return json(request, { error: "Authentication required." }, 401); }
}
async function lumaFetch(request: Request, path: string, init: RequestInit): Promise<JsonRecord> {
  const key = Deno.env.get("LUMA_API_KEY")?.trim();
  if (!key) throw new PublicError("Video generation is not configured yet. Ask an administrator to connect Luma.", 503);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12_000);
  let response: Response;
  try { response = await fetch(`${LUMA_URL}${path}`, { ...init, redirect: "error", signal: controller.signal, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } }); } catch { throw new PublicError("Luma could not be reached. Try again shortly.", 503); } finally { clearTimeout(timer); }
  if (!response.ok) throw new PublicError(providerMessage(response.status), response.status >= 500 ? 503 : response.status === 429 ? 429 : response.status === 413 ? 413 : response.status === 401 ? 502 : response.status === 402 ? 402 : response.status === 422 ? 422 : 502);
  const declared = Number(response.headers.get("Content-Length") || 0); if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new PublicError("Luma returned an unreadable response.", 502);
  let parsed: unknown; try { const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error(); parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new PublicError("Luma returned an unreadable response.", 502); }
  const row = record(parsed); if (!Object.keys(row).length) throw new PublicError("Luma returned an incomplete response.", 502); return row;
}
async function create(request: Request, body: JsonRecord): Promise<Response> {
  const prompt = requiredText(body.prompt, MAX_PROMPT, "The prompt");
  const mode = choice(body.mode, ALLOWED_MODES, "video mode");
  const duration = choice(body.duration, ALLOWED_DURATIONS, "duration");
  const aspectRatio = choice(body.aspect_ratio, ALLOWED_RATIOS, "aspect ratio");
  const resolution = choice(body.resolution, ALLOWED_RESOLUTIONS, "resolution");
  if (mode === "image-to-video" && duration === "10s") throw new PublicError("Image-to-video renders are currently limited to 5 seconds by Luma.", 422);
  const video: JsonRecord = { resolution, duration };
  if (mode === "image-to-video") { if (!body.image_data) throw new PublicError("Choose a starting image for image-to-video."); video.start_frame = imageFrame(body.image_data); }
  const row = await lumaFetch(request, "/generations", { method: "POST", body: JSON.stringify({ model: "ray-3.2", type: "video", prompt, aspect_ratio: aspectRatio, video }) });
  const id = text(row.id, 200); if (!id) throw new PublicError("Luma did not return a render id.", 502);
  return json(request, { id, state: normalizeState(row.state ?? row.status) }, 200);
}
async function status(request: Request, body: JsonRecord): Promise<Response> {
  const id = text(body.generation_id, 200); if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new PublicError("The render id is invalid.");
  const row = await lumaFetch(request, `/generations/${encodeURIComponent(id)}`, { method: "GET" });
  const state = normalizeState(row.state ?? row.status);
  if (state === "failed") return json(request, { id, state, error: asyncFailure(row) });
  if (state === "completed") { const url = outputUrl(row); if (!url) return json(request, { id, state: "failed", error: "Luma finished without a usable video preview. Start a new render." }); return json(request, { id, state, output_url: url }); }
  return json(request, { id, state });
}
function failure(request: Request, error: unknown): Response {
  const publicError = error instanceof PublicError ? error : new PublicError("The video request could not be completed. Please try again.", 500);
  if (!(error instanceof PublicError)) console.error("luma-video failed", "operation");
  return json(request, { error: publicError.message }, publicError.status);
}
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(request) });
  if (request.method !== "POST") return json(request, { error: "Only POST requests are supported." }, 405);
  const authenticated = await authenticate(request); if (authenticated !== true) return authenticated;
  try { const body = await readBody(request); const action = text(body.action, 24); if (action === "create") return await create(request, body); if (action === "status") return await status(request, body); throw new PublicError("Choose a supported video action."); } catch (error) { return failure(request, error); }
});
