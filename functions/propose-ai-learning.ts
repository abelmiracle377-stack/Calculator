import { createSuperdevClient } from "npm:@superdevhq/client@0.1.56";

type JsonRecord = Record<string, unknown>;
type Client = ReturnType<typeof createSuperdevClient>;
type Authenticated = { caller: Client; user: JsonRecord; headers: Record<string, string> };

const MAX_REQUEST_BYTES = 12_000;
const MAX_SNAPSHOT = 8_000;
const MAX_RULE = 1_200;
const MAX_RATIONALE = 800;
const ALLOWED_ORIGINS = new Set(["https://www.buildy.ai", "https://trancript.art", "https://www.trancript.art"]);
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:superdev\.run|buildy\.show)$/i;
const CATEGORIES = new Set(["transcription_style", "wording", "terminology", "punctuation", "other"]);
const proposalLocks = new Set<string>();

class InputError extends Error { constructor(message: string) { super(message); this.name = "InputError"; } }
function text(value: unknown, max = 320): string { return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim().slice(0, max) : ""; }
function safeContent(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\u0000/g, "").replace(/https?:\/\/[^\s"'<>]+/gi, "[link]").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function snapshot(value: unknown): string { return typeof value === "string" ? value.replace(/\u0000/g, "").slice(0, MAX_SNAPSHOT) : ""; }
function email(value: unknown): string { return text(value, 320).toLowerCase(); }
function status(value: unknown): string { return text(value, 24).toUpperCase(); }
function id(value: unknown): string { return text(value, 200); }
function normalized(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function allowedOrigin(origin: string): boolean { return ALLOWED_ORIGINS.has(origin) || PREVIEW_ORIGIN.test(origin); }
function headers(request: Request): HeadersInit { const origin = request.headers.get("Origin") || ""; return { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin", ...(allowedOrigin(origin) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" } : {}) }; }
function json(request: Request, payload: unknown, code = 200): Response { return new Response(JSON.stringify(payload), { status: code, headers: headers(request) }); }
function token(request: Request): string { return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim(); }
function serviceClient(): Client { const key = Deno.env.get("SUPERDEV_SERVICE_ROLE_KEY"); if (!key) throw new Error("Learning service is not configured."); const service = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") }); service.auth.setToken(key); return service; }
function responseObject(value: unknown): JsonRecord { if (typeof value === "string") { try { return responseObject(JSON.parse(value)); } catch { return {}; } } if (!value || typeof value !== "object" || Array.isArray(value)) return {}; const row = value as JsonRecord; return row.result && typeof row.result === "object" ? responseObject(row.result) : row; }
async function authenticate(request: Request): Promise<Authenticated | Response> {
  const authorization = request.headers.get("Authorization") || ""; const bearer = token(request); if (!bearer) return json(request, { error: "Authentication required." }, 401);
  const caller = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") }); caller.auth.setToken(bearer);
  let user: JsonRecord; try { user = await caller.auth.me() as JsonRecord; } catch { return json(request, { error: "Authentication required." }, 401); }
  if (!email(user.email)) return json(request, { error: "Authentication required." }, 401);
  const requestHeaders: Record<string, string> = { Authorization: authorization }; const origin = request.headers.get("Origin"); if (origin && allowedOrigin(origin)) requestHeaders.Origin = origin;
  return { caller, user, headers: requestHeaders };
}
async function readBody(request: Request): Promise<{ session_id: string; line_id: string }> {
  const declared = Number(request.headers.get("Content-Length") || 0); if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new InputError("The request is too large.");
  const bytes = new Uint8Array(await request.arrayBuffer()); if (!bytes.byteLength || bytes.byteLength > MAX_REQUEST_BYTES) throw new InputError("A JSON request body is required.");
  let parsed: unknown; try { parsed = JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, "")); } catch { throw new InputError("The request body must contain valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InputError("The request body must be a JSON object.");
  const row = parsed as JsonRecord; const keys = Object.keys(row); if (keys.length !== 2 || keys.some((key) => key !== "session_id" && key !== "line_id")) throw new InputError("Only session_id and line_id are accepted.");
  const sessionId = id(row.session_id); const lineId = id(row.line_id); if (!sessionId || !lineId) throw new InputError("session_id and line_id are required."); return { session_id: sessionId, line_id: lineId };
}
function context(session: JsonRecord): JsonRecord {
  return { review_mode: text(session.review_mode, 64) || "standard", session_mode: text(session.session_mode, 64) || "transcription", transcript_style: text(session.transcript_style, 64) || "full_verbatim", source_language: text(session.translation_source_language ?? session.language, 80), target_language: text(session.translation_target_language, 80) };
}
function candidateSummary(row: JsonRecord): JsonRecord { return { id: id(row.id), status: "PENDING", active: false, scope_key: "PRIVATE_PROJECT", category: CATEGORIES.has(text(row.category, 40)) ? text(row.category, 40) : "other", submitted_at: text(row.submitted_at, 80) }; }
async function digest(value: string): Promise<string> { const bytes = new TextEncoder().encode(value); const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return Array.from(hash).map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function writeCreatedAudit(service: Client, item: JsonRecord, actor: string, rule: string): Promise<void> {
  const itemId = id(item.id); const dedupeKey = `AIL:CREATED:${itemId}:v1`; const existing = await service.entities.AiLearningAuditEvent.filter({ dedupe_key: dedupeKey }, "-created_at", 2) as JsonRecord[]; if (Array.isArray(existing) && existing.length) return;
  await service.entities.AiLearningAuditEvent.create({ learning_item_id: itemId, action: "CREATED", actor_email: email(actor), source_owner_email: email(item.source_owner_email), source_kind: "transcript_correction", target_surface: "TRANSCRIPT_AND_TRANSLATION", source_session_id: id(item.source_session_id), source_line_id: id(item.source_line_id), source_conversation_id: "", source_message_id: "", source_document_id: "", source_support_request_id: "", evidence_item_ids: [], scope_key: "PRIVATE_PROJECT", previous_rule: "", current_rule: safeContent(rule, MAX_RULE), previous_status: "", current_status: "PENDING", version: 1, active: false, server_timestamp: new Date().toISOString(), dedupe_key: dedupeKey, note: "Candidate created from an explicit transcript correction." });
}

async function propose(auth: Authenticated, sessionId: string, lineId: string): Promise<JsonRecord> {
  const owner = email(auth.user.email); const session = await auth.caller.entities.TranscriptionSession.get(sessionId) as JsonRecord; const line = await auth.caller.entities.TranscriptLine.get(lineId) as JsonRecord;
  if (!session || !line || (session.created_by && email(session.created_by) !== owner) || (line.created_by && email(line.created_by) !== owner) || id(line.session_id) !== sessionId) throw new InputError("The transcript correction could not be found.");
  if (text(line.origin, 24).toLowerCase() !== "generated" || text(line.kind, 24).toLowerCase() !== "speech" || text(line.edit_state, 24).toLowerCase() !== "edited") return { ok: true, created: false, reason: "not_meaningful" };
  const original = snapshot(line.raw_text); const corrected = snapshot(line.text); if (!original.trim() || !corrected.trim() || normalized(original) === normalized(corrected)) return { ok: true, created: false, reason: "not_meaningful" };
  const dedupeKey = `AIL:v1:${await digest(JSON.stringify({ owner, session: sessionId, line: lineId, correction: normalized(corrected) }))}`;
  if (proposalLocks.has(dedupeKey)) return { ok: true, created: false, reason: "already_pending" };
  proposalLocks.add(dedupeKey);
  try {
    const service = serviceClient(); const existingRows = await service.entities.AiLearningItem.filter({ dedupe_key: dedupeKey }, "-created_at", 5) as JsonRecord[]; const existing = Array.isArray(existingRows) ? existingRows[0] : undefined;
    if (existing) return { ok: true, created: false, reason: status(existing.status) === "PENDING" ? "already_pending" : "already_reviewed", candidate: candidateSummary(existing) };
    const sessionContext = context(session); let model: JsonRecord = {};
    try {
      const response = await auth.caller.integrations.core.invokeLLM({ mode: "standard", prompt: [
        "Analyze this provider transcript versus a human correction.",
        "Suggest one safe, reusable private-project learning rule only when the difference expresses a repeatable transcription preference. Ignore one-off content changes, names, facts, uncertain words, speaker identity, timestamps, and structural edits.",
        "Return only the requested category, short rule, and short rationale. Never choose approval, status, active state, scope, owner, or version.",
        `Transcript style: ${sessionContext.transcript_style}. Review mode: ${sessionContext.review_mode}. Session mode: ${sessionContext.session_mode}. Source language: ${sessionContext.source_language || "unspecified"}. Target language: ${sessionContext.target_language || "unspecified"}.`,
        `Provider text:\n${original}\n\nHuman-corrected text:\n${corrected}`,
      ].join("\n\n"), response_json_schema: { type: "object", properties: { category: { type: "string", enum: [...CATEGORIES] }, proposed_rule: { type: "string", maxLength: MAX_RULE }, rationale: { type: "string", maxLength: MAX_RATIONALE } }, required: ["category", "proposed_rule", "rationale"] } }, { headers: auth.headers });
      model = responseObject(response);
    } catch { console.error("propose-ai-learning model request failed"); return { ok: true, created: false, reason: "no_safe_rule" }; }
    const category = CATEGORIES.has(text(model.category, 40)) ? text(model.category, 40) : "other"; const proposedRule = safeContent(model.proposed_rule, MAX_RULE); const rationale = safeContent(model.rationale, MAX_RATIONALE);
    if (!proposedRule || !rationale) return { ok: true, created: false, reason: "no_safe_rule" };
    const now = new Date().toISOString(); const sourceContentHash = await digest(JSON.stringify({ original, corrected, session: sessionId, line: lineId }));
    const saved = await service.entities.AiLearningItem.create({ source_owner_email: owner, scope_key: "PRIVATE_PROJECT", source_kind: "transcript_correction", target_surface: "TRANSCRIPT_AND_TRANSLATION", source_session_id: sessionId, source_segment_id: id(line.source_segment_id), source_line_id: lineId, source_conversation_id: "", source_message_id: "", source_document_id: "", source_support_request_id: "", source_document_name: "", source_question_excerpt: "", source_answer_excerpt: "", source_resolution_excerpt: "", source_reference_labels: [], evidence_item_ids: [], pattern_key: "", occurrence_count: 1, source_content_hash: sourceContentHash, original_text_snapshot: original, corrected_text_snapshot: corrected, proposed_rule: proposedRule, final_rule: "", category, rationale, ...sessionContext, status: "PENDING", active: false, version: 1, submitted_by: owner, submitted_at: now, approved_by: "", approved_at: "", rejected_by: "", rejected_at: "", dedupe_key: dedupeKey, note: "" }) as JsonRecord;
    if (!saved || !id(saved.id)) throw new Error("Learning candidate was not saved.");
    try { await writeCreatedAudit(service, { ...saved, submitted_at: now }, owner, proposedRule); }
    catch (error) { try { await service.entities.AiLearningItem.delete(id(saved.id)); } catch { console.error("propose-ai-learning creation rollback failed"); } throw error; }
    return { ok: true, created: true, candidate: candidateSummary({ ...saved, submitted_at: now }) };
  } finally { proposalLocks.delete(dedupeKey); }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return json(request, {}, 204);
  if (request.method !== "POST") return json(request, { error: "Use POST for learning proposals." }, 405);
  const auth = await authenticate(request); if (auth instanceof Response) return auth;
  try { const body = await readBody(request); return json(request, await propose(auth, body.session_id, body.line_id)); }
  catch (error) { const input = error instanceof InputError; console.error("propose-ai-learning failed", input ? "request" : "operation"); return json(request, { error: input ? error.message : "The learning proposal could not be completed." }, input ? 400 : 500); }
});
