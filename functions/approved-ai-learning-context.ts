import { createSuperdevClient } from "npm:@superdevhq/client@0.1.56";

type JsonRecord = Record<string, unknown>;
type Client = ReturnType<typeof createSuperdevClient>;
const MAX_REQUEST_BYTES = 8_000;
const MAX_RULES = 12;
const MAX_PROMPT_CHARS = 6_000;
const MAX_RULE = 1_200;
const ALLOWED_ORIGIN = "https://www.buildy.ai";
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:superdev\.run|buildy\.show)$/i;
const CATEGORIES = new Set(["transcription_style", "wording", "terminology", "punctuation", "repeated_pattern", "other"]);
class InputError extends Error { constructor(message: string) { super(message); this.name = "InputError"; } }
function text(value: unknown, max = 320): string { return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim().slice(0, max) : ""; }
function email(value: unknown): string { return text(value, 320).toLowerCase(); }
function originAllowed(origin: string): boolean { return origin === ALLOWED_ORIGIN || PREVIEW_ORIGIN.test(origin); }
function json(request: Request, payload: unknown, status = 200): Response { const origin = request.headers.get("Origin") || ""; return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin", ...(originAllowed(origin) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" } : {}) } }); }
function serviceClient(): Client { const key = Deno.env.get("SUPERDEV_SERVICE_ROLE_KEY"); if (!key) throw new Error("Learning service is not configured."); const client = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") }); client.auth.setToken(key); return client; }
function normalize(value: unknown): string { return text(value, 120).toLowerCase().replace(/_/g, "-"); }
function contextMatches(stored: unknown, current: string): boolean { const value = normalize(stored); return !value || value === current; }
async function readBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("Content-Length") || 0); if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new InputError("The request is too large.");
  const bytes = new Uint8Array(await request.arrayBuffer()); if (!bytes.byteLength || bytes.byteLength > MAX_REQUEST_BYTES) throw new InputError("A JSON request body is required."); let parsed: unknown; try { parsed = JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, "")); } catch { throw new InputError("The request body must contain valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InputError("The request body must be a JSON object."); const row = parsed as JsonRecord; const keys = Object.keys(row); if (keys.length !== 1 || keys[0] !== "session_id") throw new InputError("Only session_id is accepted."); const sessionId = text(row.session_id, 200); if (!sessionId) throw new InputError("session_id is required."); return sessionId;
}
function currentContext(session: JsonRecord): Record<string, string> { return { review_mode: normalize(session.review_mode) || "standard", session_mode: normalize(session.session_mode) || "transcription", transcript_style: normalize(session.transcript_style) || "full-verbatim", source_language: normalize(session.translation_source_language ?? session.language), target_language: normalize(session.translation_target_language) }; }
function safeRule(row: JsonRecord, context: Record<string, string>): JsonRecord | null { const rule = text(row.final_rule, MAX_RULE); const category = text(row.category, 40); const target = normalize(row.target_surface); const transcriptTarget = !target || target === "transcript-and-translation"; if (!rule || status(row.status) !== "APPROVED" || row.active !== true || text(row.scope_key, 40) !== "PRIVATE_PROJECT" || !transcriptTarget || !CATEGORIES.has(category)) return null; if (!(contextMatches(row.review_mode, context.review_mode) && contextMatches(row.session_mode, context.session_mode) && contextMatches(row.transcript_style, context.transcript_style) && contextMatches(row.source_language, context.source_language) && contextMatches(row.target_language, context.target_language))) return null; return { id: text(row.id, 160), rule, category, rationale: text(row.rationale, 800), scope_key: "PRIVATE_PROJECT", context: { review_mode: text(row.review_mode, 64), session_mode: text(row.session_mode, 64), transcript_style: text(row.transcript_style, 64), source_language: text(row.source_language, 80), target_language: text(row.target_language, 80) }, approved_at: text(row.approved_at, 80) }; }
function status(value: unknown): string { return text(value, 24).toUpperCase(); }
async function retrieve(owner: string, session: JsonRecord): Promise<JsonRecord[]> {
  try {
    const service = serviceClient(); const rows = await service.entities.AiLearningItem.filter({ source_owner_email: owner, scope_key: "PRIVATE_PROJECT", status: "APPROVED", active: true }, "-approved_at", 100) as JsonRecord[]; const context = currentContext(session); const rules: JsonRecord[] = []; let chars = 0;
    for (const row of Array.isArray(rows) ? rows : []) { if (!row || email(row.source_owner_email) !== owner) continue; const rule = safeRule(row, context); if (!rule) continue; const size = JSON.stringify(rule).length; if (rules.length >= MAX_RULES || chars + size > MAX_PROMPT_CHARS) break; rules.push(rule); chars += size; }
    return rules;
  } catch { console.error("approved-ai-learning-context retrieval failed"); return []; }
}
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return json(request, {}, 204); if (request.method !== "POST") return json(request, { error: "Use POST for learning context." }, 405);
  const authorization = request.headers.get("Authorization") || ""; const bearer = authorization.replace(/^Bearer\s+/i, "").trim(); if (!bearer) return json(request, { error: "Authentication required." }, 401);
  const caller = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") }); caller.auth.setToken(bearer); let user: JsonRecord; try { user = await caller.auth.me() as JsonRecord; } catch { return json(request, { error: "Authentication required." }, 401); }
  const owner = email(user.email); if (!owner) return json(request, { error: "Authentication required." }, 401);
  try { const sessionId = await readBody(request); const session = await caller.entities.TranscriptionSession.get(sessionId) as JsonRecord; if (!session || (session.created_by && email(session.created_by) !== owner)) return json(request, { error: "Session not found." }, 404); return json(request, { ok: true, rules: await retrieve(owner, session) }); }
  catch (error) { const input = error instanceof InputError; console.error("approved-ai-learning-context failed", input ? "request" : "operation"); return json(request, { error: input ? error.message : "The learning context could not be loaded." }, input ? 400 : 500); }
});
