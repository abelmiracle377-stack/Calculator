import { createSuperdevClient } from "npm:@superdevhq/client@0.1.56";

type JsonRecord = Record<string, unknown>;
type Client = ReturnType<typeof createSuperdevClient>;
type AdminContext = {
  service: Client;
  caller: Client;
  actorEmail: string;
  actorId: string;
  headers: Record<string, string>;
};
type SourceTarget = "TRANSCRIPT_AND_TRANSLATION" | "ASSISTANT";
type SourceKind = "transcript_correction" | "assistant_answer" | "document_guidance" | "support_resolution" | "repeated_pattern";

const ADMIN_EMAIL = "abelmiracle377@gmail.com";
const MAX_REQUEST_BYTES = 32_000;
const MAX_RULE = 1_200;
const MAX_NOTE = 2_000;
const MAX_SNAPSHOT = 8_000;
const MAX_SOURCE_EXCERPT = 4_000;
const MAX_QUESTION_EXCERPT = 1_800;
const MAX_RESOLUTION_EXCERPT = 2_000;
const MAX_REFERENCE_LABELS = 16;
const MAX_REFERENCE_CHARS = 180;
const MAX_SOURCE_ROWS = 120;
const MAX_PATTERN_ROWS = 240;
const MAX_PATTERN_ITEMS = 12;
const ALLOWED_ORIGINS = new Set(["https://www.buildy.ai", "https://trancript.art", "https://www.trancript.art"]);
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:superdev\.run|buildy\.show)$/i;
const CATEGORIES = new Set([
  "transcription_style", "wording", "terminology", "punctuation", "assistant_guidance", "document_guidance", "support_resolution", "repeated_pattern", "other",
]);
const SOURCE_KINDS = new Set<SourceKind>(["transcript_correction", "assistant_answer", "document_guidance", "support_resolution", "repeated_pattern"]);
const SOURCE_TARGETS = new Set<SourceTarget>(["TRANSCRIPT_AND_TRANSLATION", "ASSISTANT"]);
const decisionLocks = new Set<string>();
const promotionLocks = new Set<string>();

class InputError extends Error { constructor(message: string) { super(message); this.name = "InputError"; } }

function text(value: unknown, max = 320): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim().slice(0, max) : "";
}
function content(value: unknown, max = MAX_SOURCE_EXCERPT): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[link]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[credential redacted]")
    .replace(/\b(?:api[_ -]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "[sensitive value redacted]")
    .trim()
    .slice(0, max);
}
function snapshot(value: unknown): string { return typeof value === "string" ? value.replace(/\u0000/g, "").slice(0, MAX_SNAPSHOT) : ""; }
function email(value: unknown): string { return text(value, 320).toLowerCase(); }
function id(value: unknown): string { return text(value, 200); }
function status(value: unknown): string { return text(value, 24).toUpperCase(); }
function actorId(value: unknown): string { const row = value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; return id(row.id ?? row.user_id ?? row.userId); }
function validEmail(value: unknown): string { const candidate = email(value); return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(candidate) ? candidate : ""; }
function responseHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.has(origin) || PREVIEW_ORIGIN.test(origin);
  return { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin", ...(allowed ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" } : {}) };
}
function json(request: Request, payload: unknown, code = 200): Response { return new Response(JSON.stringify(payload), { status: code, headers: responseHeaders(request) }); }
function serviceClient(): Client {
  const key = Deno.env.get("SUPERDEV_SERVICE_ROLE_KEY");
  if (!key) throw new Error("The protected learning service is not configured.");
  const service = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
  service.auth.setToken(key);
  return service;
}
function integrationHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const authorization = request.headers.get("Authorization");
  const origin = request.headers.get("Origin") || "";
  if (authorization) headers.Authorization = authorization;
  if (origin && (ALLOWED_ORIGINS.has(origin) || PREVIEW_ORIGIN.test(origin))) headers.Origin = origin;
  return headers;
}
function grantStatus(row: JsonRecord): string { return status(row.status); }
function grantRole(row: JsonRecord): string { return text(row.role, 64).toLowerCase(); }
function grantMatches(grants: JsonRecord[], user: JsonRecord): JsonRecord[] {
  const targetId = actorId(user); const targetEmail = email(user.email);
  return grants.filter((grant) => { const grantId = id(grant.user_id ?? grant.userId); return targetId && grantId ? targetId === grantId : Boolean(targetEmail) && email(grant.user_email) === targetEmail; });
}
async function effectiveAdmin(service: Client, user: JsonRecord): Promise<boolean> {
  if (email(user.email) === ADMIN_EMAIL) return true;
  const grants = await service.entities.AdminGrant.list("-updated_at", 2_000) as JsonRecord[];
  return Array.isArray(grants) && grantMatches(grants, user).some((grant) => grantStatus(grant) === "ACTIVE" && grantRole(grant) === "administrator");
}
async function adminContext(request: Request): Promise<AdminContext | Response> {
  const authorization = request.headers.get("Authorization") || "";
  const bearer = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return json(request, { error: "Authentication required." }, 401);
  const caller = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") }); caller.auth.setToken(bearer);
  let user: JsonRecord;
  try { user = await caller.auth.me() as JsonRecord; } catch { return json(request, { error: "Authentication required." }, 401); }
  const actorEmail = validEmail(user.email);
  if (!actorEmail) return json(request, { error: "Authentication required." }, 401);
  try {
    const service = serviceClient();
    if (!(await effectiveAdmin(service, user))) return json(request, { error: "Not found." }, 404);
    return { service, caller, actorEmail, actorId: actorId(user), headers: integrationHeaders(request) };
  } catch {
    console.error("admin-ai-learning authorization failed");
    return json(request, { error: "The protected learning service is unavailable." }, 500);
  }
}
async function readBody(request: Request): Promise<JsonRecord> {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new InputError("The request is too large.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > MAX_REQUEST_BYTES) throw new InputError("A JSON request body is required.");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, "")); } catch { throw new InputError("The request body must contain valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("The request body must be a JSON object.");
  return value as JsonRecord;
}
function requireKeys(body: JsonRecord, allowed: string[], required: string[] = []): void {
  const keys = Object.keys(body);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) throw new InputError("The learning action contains unsupported fields.");
}
function ruleInput(value: unknown, label: string, fallback = ""): string { if (value === undefined) return fallback; if (typeof value !== "string") throw new InputError(`${label} must be text.`); return content(value, MAX_RULE); }
function categoryInput(value: unknown, fallback: string): string { if (value === undefined) return fallback; if (typeof value !== "string" || !CATEGORIES.has(value)) throw new InputError("Choose a supported learning category."); return value; }
function noteInput(value: unknown, fallback = ""): string { if (value === undefined) return fallback; if (typeof value !== "string") throw new InputError("The administrator note must be text."); return text(value, MAX_NOTE); }
function targetSurface(value: unknown): SourceTarget {
  const candidate = text(value, 64).toUpperCase() as SourceTarget;
  return SOURCE_TARGETS.has(candidate) ? candidate : "TRANSCRIPT_AND_TRANSLATION";
}
function sourceKind(value: unknown): SourceKind {
  const candidate = text(value, 64) as SourceKind;
  return SOURCE_KINDS.has(candidate) ? candidate : "transcript_correction";
}
function references(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? content(item, MAX_REFERENCE_CHARS) : "")
    .map((item) => item.replace(/https?:\/\/[^\s]+/gi, "[link]").trim())
    .filter(Boolean)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === item.toLowerCase()) === index)
    .slice(0, MAX_REFERENCE_LABELS);
}
function evidenceIds(value: unknown): string[] { return Array.isArray(value) ? value.map(id).filter(Boolean).filter((item, index, all) => all.indexOf(item) === index).sort().slice(0, MAX_PATTERN_ITEMS) : []; }
function numberValue(value: unknown, fallback = 0): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback; }
function publicItem(row: JsonRecord): JsonRecord {
  return {
    id: id(row.id), source_owner_email: validEmail(row.source_owner_email), scope_key: "PRIVATE_PROJECT", source_kind: sourceKind(row.source_kind), target_surface: targetSurface(row.target_surface),
    source_session_id: id(row.source_session_id), source_segment_id: id(row.source_segment_id), source_line_id: id(row.source_line_id), source_conversation_id: id(row.source_conversation_id), source_message_id: id(row.source_message_id), source_document_id: id(row.source_document_id), source_support_request_id: id(row.source_support_request_id),
    source_document_name: content(row.source_document_name, 160), source_question_excerpt: content(row.source_question_excerpt, MAX_QUESTION_EXCERPT), source_answer_excerpt: content(row.source_answer_excerpt, MAX_SOURCE_EXCERPT), source_resolution_excerpt: content(row.source_resolution_excerpt, MAX_RESOLUTION_EXCERPT), source_reference_labels: references(row.source_reference_labels), evidence_item_ids: evidenceIds(row.evidence_item_ids), pattern_key: text(row.pattern_key, 160), occurrence_count: numberValue(row.occurrence_count, 1), source_content_hash: text(row.source_content_hash, 128),
    original_text_snapshot: snapshot(row.original_text_snapshot), corrected_text_snapshot: snapshot(row.corrected_text_snapshot), proposed_rule: content(row.proposed_rule, MAX_RULE), final_rule: content(row.final_rule, MAX_RULE), category: CATEGORIES.has(text(row.category, 40)) ? text(row.category, 40) : "other", rationale: content(row.rationale, 800), review_mode: text(row.review_mode, 64), session_mode: text(row.session_mode, 64), transcript_style: text(row.transcript_style, 64), source_language: text(row.source_language, 80), target_language: text(row.target_language, 80),
    status: status(row.status), active: row.active === true, version: typeof row.version === "number" ? row.version : 1, submitted_by: validEmail(row.submitted_by), submitted_at: text(row.submitted_at, 80), approved_by: validEmail(row.approved_by), approved_at: text(row.approved_at, 80), rejected_by: validEmail(row.rejected_by), rejected_at: text(row.rejected_at, 80), note: text(row.note, MAX_NOTE),
  };
}
async function items(service: Client): Promise<JsonRecord[]> { const rows = await service.entities.AiLearningItem.list("-updated_at", 2_000) as JsonRecord[]; return Array.isArray(rows) ? rows : []; }
function counts(rows: JsonRecord[]): JsonRecord { return { pending: rows.filter((row) => status(row.status) === "PENDING").length, approved: rows.filter((row) => status(row.status) === "APPROVED").length, rejected: rows.filter((row) => status(row.status) === "REJECTED").length }; }
async function getItem(service: Client, itemId: string): Promise<JsonRecord> { if (!itemId) throw new InputError("A learning item id is required."); const row = await service.entities.AiLearningItem.get(itemId) as JsonRecord; if (!row || !id(row.id)) throw new InputError("Learning item not found."); return row; }
async function digest(value: string): Promise<string> { const bytes = new TextEncoder().encode(value); const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)); return Array.from(hash).map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function ownerMatches(row: JsonRecord, owner: string, ownerId = ""): boolean { const rowEmail = validEmail(row.owner_email); const rowId = id(row.owner_user_id); return Boolean(rowEmail && rowEmail === owner && (!rowId || !ownerId || rowId === ownerId)); }
function rowTime(row: JsonRecord): number { const value = Date.parse(text(row.sent_at ?? row.created_at ?? row.updated_at, 100)); return Number.isFinite(value) ? value : 0; }
function responseObject(value: unknown): JsonRecord {
  if (typeof value === "string") { try { return responseObject(JSON.parse(value)); } catch { return {}; } }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const row = value as JsonRecord;
  return row.result && typeof row.result === "object" && !Array.isArray(row.result) ? responseObject(row.result) : row;
}
function documentLabels(document: JsonRecord): string[] {
  if (!Array.isArray(document.marker_metadata)) return [];
  return document.marker_metadata.map((marker) => {
    if (typeof marker === "string") return content(marker, MAX_REFERENCE_CHARS);
    if (!marker || typeof marker !== "object") return "";
    const row = marker as JsonRecord;
    return content(row.label ?? row.reference ?? row.section, MAX_REFERENCE_CHARS);
  }).filter(Boolean).filter((item, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === item.toLowerCase()) === index).slice(0, MAX_REFERENCE_LABELS);
}
function exactDocumentReferences(message: JsonRecord, document: JsonRecord): string[] {
  const labels = documentLabels(document); const selected = references(message.references);
  return selected.filter((candidate) => labels.some((label) => label.toLowerCase() === candidate.toLowerCase())).slice(0, MAX_REFERENCE_LABELS);
}
function safeDocumentName(document: JsonRecord | undefined): string { return document ? content(document.display_name || document.original_name, 160) : ""; }
async function messageRows(service: Client, conversationId: string, owner: string): Promise<JsonRecord[]> {
  const rows = await service.entities.AssistantMessage.filter({ conversation_id: conversationId, owner_email: owner }, "-created_at", 160) as JsonRecord[];
  return (Array.isArray(rows) ? rows : []).filter((row) => id(row.conversation_id) === conversationId && validEmail(row.owner_email) === owner);
}
function pairedQuestion(rows: JsonRecord[], assistant: JsonRecord): string {
  const ordered = [...rows].sort((a, b) => rowTime(a) - rowTime(b)); const current = ordered.findIndex((row) => id(row.id) === id(assistant.id));
  const prior = ordered.slice(0, current < 0 ? ordered.length : current).reverse().find((row) => text(row.role, 24).toLowerCase() === "user");
  return content(prior?.content, MAX_QUESTION_EXCERPT);
}
async function assistantSource(service: Client, messageId: string, documentMode: boolean): Promise<{ message: JsonRecord; conversation: JsonRecord; document?: JsonRecord; question: string; answer: string; refs: string[]; owner: string }> {
  const message = await service.entities.AssistantMessage.get(messageId) as JsonRecord;
  const conversationId = id(message?.conversation_id);
  const conversation = conversationId ? await service.entities.AssistantConversation.get(conversationId) as JsonRecord : undefined;
  const owner = validEmail(conversation?.owner_email);
  if (!message || !conversation || !id(conversation.id) || !owner || text(message.role, 24).toLowerCase() !== "assistant" || id(message.conversation_id) !== id(conversation.id) || !ownerMatches(message, owner, id(conversation.owner_user_id)) || !ownerMatches(conversation, owner)) throw new InputError("That assistant answer is not an eligible protected source.");
  const rows = await messageRows(service, conversationId, owner); const answer = content(message.content, MAX_SOURCE_EXCERPT); if (!answer) throw new InputError("That assistant answer has no safe content to promote.");
  const selectedDocumentId = id(conversation.selected_document_id); const messageDocumentId = id(message.document_id);
  if (documentMode) {
    if (!selectedDocumentId || !messageDocumentId || selectedDocumentId !== messageDocumentId) throw new InputError("Choose a document-grounded assistant answer for document guidance.");
    const document = await service.entities.AssistantDocument.get(selectedDocumentId) as JsonRecord;
    if (!document || text(document.status, 24).toUpperCase() !== "READY" || !ownerMatches(document, owner, id(conversation.owner_user_id))) throw new InputError("The selected source document is no longer available.");
    return { message, conversation, document, question: pairedQuestion(rows, message), answer, refs: exactDocumentReferences(message, document), owner };
  }
  if (selectedDocumentId || messageDocumentId) throw new InputError("Use document guidance for an answer grounded in an uploaded document.");
  return { message, conversation, question: pairedQuestion(rows, message), answer, refs: [], owner };
}
function sourceOption(fields: JsonRecord): JsonRecord {
  return {
    id: id(fields.id), source_kind: sourceKind(fields.source_kind), source_owner_email: validEmail(fields.source_owner_email), source_conversation_id: id(fields.source_conversation_id), source_message_id: id(fields.source_message_id), source_document_id: id(fields.source_document_id), source_support_request_id: id(fields.source_support_request_id), source_document_name: content(fields.source_document_name, 160), source_question_excerpt: content(fields.source_question_excerpt, MAX_QUESTION_EXCERPT), source_answer_excerpt: content(fields.source_answer_excerpt, MAX_SOURCE_EXCERPT), source_resolution_excerpt: content(fields.source_resolution_excerpt, MAX_RESOLUTION_EXCERPT), source_reference_labels: references(fields.source_reference_labels), target_surface: targetSurface(fields.target_surface), category: CATEGORIES.has(text(fields.category, 40)) ? text(fields.category, 40) : "other", final_rule: content(fields.final_rule, MAX_RULE), rationale: content(fields.rationale, 800), occurrence_count: numberValue(fields.occurrence_count, 1), approved_at: text(fields.approved_at, 80),
  };
}
async function listSources(service: Client): Promise<JsonRecord> {
  const [assistantMessages, conversations, documents, supportRequests, learningRows] = await Promise.all([
    service.entities.AssistantMessage.list("-created_at", 1_000) as Promise<JsonRecord[]>,
    service.entities.AssistantConversation.list("-updated_at", 500) as Promise<JsonRecord[]>,
    service.entities.AssistantDocument.list("-updated_at", 500) as Promise<JsonRecord[]>,
    service.entities.HumanSupportRequest.list("-updated_at", 300) as Promise<JsonRecord[]>,
    service.entities.AiLearningItem.list("-approved_at", 500) as Promise<JsonRecord[]>,
  ]);
  const conversationsById = new Map((Array.isArray(conversations) ? conversations : []).map((row) => [id(row.id), row]));
  const documentsById = new Map((Array.isArray(documents) ? documents : []).map((row) => [id(row.id), row]));
  const allMessages = Array.isArray(assistantMessages) ? assistantMessages : [];
  const assistantAnswers: JsonRecord[] = []; const documentGuidance: JsonRecord[] = [];
  for (const message of allMessages) {
    if (text(message.role, 24).toLowerCase() !== "assistant") continue;
    const conversation = conversationsById.get(id(message.conversation_id)); const owner = validEmail(conversation?.owner_email);
    if (!conversation || !owner || !ownerMatches(message, owner, id(conversation.owner_user_id)) || !ownerMatches(conversation, owner)) continue;
    const answer = content(message.content, MAX_SOURCE_EXCERPT); if (!answer) continue;
    const rows = allMessages.filter((row) => id(row.conversation_id) === id(conversation.id) && validEmail(row.owner_email) === owner); const question = pairedQuestion(rows, message);
    const messageDocumentId = id(message.document_id); const selectedDocumentId = id(conversation.selected_document_id);
    if (messageDocumentId && messageDocumentId === selectedDocumentId) {
      const document = documentsById.get(messageDocumentId);
      if (!document || text(document.status, 24).toUpperCase() !== "READY" || !ownerMatches(document, owner, id(conversation.owner_user_id))) continue;
      documentGuidance.push(sourceOption({ id: message.id, source_kind: "document_guidance", source_owner_email: owner, source_conversation_id: conversation.id, source_message_id: message.id, source_document_id: document.id, source_document_name: safeDocumentName(document), source_question_excerpt: question, source_answer_excerpt: answer, source_reference_labels: exactDocumentReferences(message, document), target_surface: "ASSISTANT", category: "document_guidance", final_rule: answer, rationale: "An administrator can review this document-grounded answer as private assistant guidance." }));
    } else if (!messageDocumentId && !selectedDocumentId) {
      assistantAnswers.push(sourceOption({ id: message.id, source_kind: "assistant_answer", source_owner_email: owner, source_conversation_id: conversation.id, source_message_id: message.id, source_question_excerpt: question, source_answer_excerpt: answer, target_surface: "ASSISTANT", category: "assistant_guidance", final_rule: answer, rationale: "An administrator can review this assistant answer as private project guidance." }));
    }
    if (assistantAnswers.length >= MAX_SOURCE_ROWS && documentGuidance.length >= MAX_SOURCE_ROWS) break;
  }
  const supportResolutions = (Array.isArray(supportRequests) ? supportRequests : []).filter((row) => status(row.status) === "RESOLVED" && validEmail(row.owner_email) && content(row.resolution_summary, MAX_RESOLUTION_EXCERPT)).slice(0, MAX_SOURCE_ROWS).map((row) => sourceOption({ id: row.id, source_kind: "support_resolution", source_owner_email: row.owner_email, source_support_request_id: row.id, source_resolution_excerpt: row.resolution_summary, target_surface: "ASSISTANT", category: "support_resolution", final_rule: row.resolution_summary, rationale: "An administrator-authored resolution summary can be reviewed as private assistant guidance." }));
  const patternItems = (Array.isArray(learningRows) ? learningRows : []).filter((row) => status(row.status) === "APPROVED" && row.active === true && text(row.scope_key, 40) === "PRIVATE_PROJECT" && Boolean(content(row.final_rule, MAX_RULE)) && SOURCE_TARGETS.has(targetSurface(row.target_surface))).slice(0, MAX_PATTERN_ROWS).map((row) => sourceOption({ id: row.id, source_kind: sourceKind(row.source_kind), source_owner_email: row.source_owner_email, source_conversation_id: row.source_conversation_id, source_message_id: row.source_message_id, source_document_id: row.source_document_id, source_support_request_id: row.source_support_request_id, source_document_name: row.source_document_name, source_question_excerpt: row.source_question_excerpt, source_answer_excerpt: row.source_answer_excerpt, source_reference_labels: row.source_reference_labels, target_surface: targetSurface(row.target_surface), category: row.category, final_rule: row.final_rule, rationale: row.rationale, occurrence_count: numberValue(row.occurrence_count, 1), approved_at: row.approved_at }));
  return { ok: true, assistant_answers: assistantAnswers.slice(0, MAX_SOURCE_ROWS), document_guidance: documentGuidance.slice(0, MAX_SOURCE_ROWS), support_resolutions: supportResolutions, pattern_items: patternItems };
}
async function writeAudit(service: Client, item: JsonRecord, action: "CREATED" | "APPROVED" | "REJECTED", actor: string, previousRule: string, currentRule: string, previousStatus: string, currentStatus: string, active: boolean, note: string): Promise<void> {
  const itemId = id(item.id); const version = typeof item.version === "number" ? item.version : 1; const dedupeKey = `AIL:${action}:${itemId}:v${version}`;
  const existing = await service.entities.AiLearningAuditEvent.filter({ dedupe_key: dedupeKey }, "-created_at", 2) as JsonRecord[];
  if (Array.isArray(existing) && existing.length) return;
  await service.entities.AiLearningAuditEvent.create({ learning_item_id: itemId, action, actor_email: validEmail(actor), source_owner_email: validEmail(item.source_owner_email), source_kind: sourceKind(item.source_kind), target_surface: targetSurface(item.target_surface), source_session_id: id(item.source_session_id), source_line_id: id(item.source_line_id), source_conversation_id: id(item.source_conversation_id), source_message_id: id(item.source_message_id), source_document_id: id(item.source_document_id), source_support_request_id: id(item.source_support_request_id), evidence_item_ids: evidenceIds(item.evidence_item_ids), scope_key: "PRIVATE_PROJECT", previous_rule: content(previousRule, MAX_RULE), current_rule: content(currentRule, MAX_RULE), previous_status: status(previousStatus), current_status: status(currentStatus), version, active, server_timestamp: new Date().toISOString(), dedupe_key: dedupeKey, note: text(note, MAX_NOTE) });
}
async function createCandidate(service: Client, candidate: JsonRecord, actor: string): Promise<JsonRecord> {
  const dedupeKey = text(candidate.dedupe_key, 200); if (!dedupeKey) throw new Error("The learning candidate is missing a protected dedupe key.");
  if (promotionLocks.has(dedupeKey)) throw new InputError("This source is already being promoted. Refresh and try again.");
  promotionLocks.add(dedupeKey);
  try {
    const existingRows = await service.entities.AiLearningItem.filter({ dedupe_key: dedupeKey }, "-created_at", 5) as JsonRecord[]; const existing = Array.isArray(existingRows) ? existingRows[0] : undefined;
    if (existing) return { ok: true, action: "CREATED", created: false, duplicate: true, item: publicItem(existing) };
    const saved = await service.entities.AiLearningItem.create({ ...candidate, scope_key: "PRIVATE_PROJECT", status: "PENDING", active: false, version: 1, submitted_by: validEmail(actor), submitted_at: new Date().toISOString() }) as JsonRecord;
    if (!saved || !id(saved.id)) throw new Error("Learning candidate was not saved.");
    try { await writeAudit(service, { ...candidate, ...saved, status: "PENDING", active: false, version: 1 }, "CREATED", actor, "", content(candidate.proposed_rule, MAX_RULE), "", "PENDING", false, "Candidate created by explicit administrator source promotion."); }
    catch (error) { try { await service.entities.AiLearningItem.delete(id(saved.id)); } catch { console.error("admin-ai-learning creation rollback failed"); } throw error; }
    return { ok: true, action: "CREATED", created: true, duplicate: false, item: publicItem({ ...candidate, ...saved, status: "PENDING", active: false, version: 1 }) };
  } finally { promotionLocks.delete(dedupeKey); }
}
function baseCandidate(fields: JsonRecord, actor: string): JsonRecord {
  return { source_owner_email: validEmail(fields.source_owner_email), scope_key: "PRIVATE_PROJECT", source_kind: sourceKind(fields.source_kind), target_surface: targetSurface(fields.target_surface), source_session_id: id(fields.source_session_id), source_segment_id: id(fields.source_segment_id), source_line_id: id(fields.source_line_id), source_conversation_id: id(fields.source_conversation_id), source_message_id: id(fields.source_message_id), source_document_id: id(fields.source_document_id), source_support_request_id: id(fields.source_support_request_id), source_document_name: content(fields.source_document_name, 160), source_question_excerpt: content(fields.source_question_excerpt, MAX_QUESTION_EXCERPT), source_answer_excerpt: content(fields.source_answer_excerpt, MAX_SOURCE_EXCERPT), source_resolution_excerpt: content(fields.source_resolution_excerpt, MAX_RESOLUTION_EXCERPT), source_reference_labels: references(fields.source_reference_labels), evidence_item_ids: evidenceIds(fields.evidence_item_ids), pattern_key: text(fields.pattern_key, 160), occurrence_count: numberValue(fields.occurrence_count, 1), source_content_hash: text(fields.source_content_hash, 128), original_text_snapshot: snapshot(fields.original_text_snapshot), corrected_text_snapshot: snapshot(fields.corrected_text_snapshot), proposed_rule: content(fields.proposed_rule, MAX_RULE), final_rule: "", category: CATEGORIES.has(text(fields.category, 40)) ? text(fields.category, 40) : "other", rationale: content(fields.rationale, 800), review_mode: text(fields.review_mode, 64), session_mode: text(fields.session_mode, 64), transcript_style: text(fields.transcript_style, 64), source_language: text(fields.source_language, 80), target_language: text(fields.target_language, 80), status: "PENDING", active: false, version: 1, submitted_by: validEmail(actor), submitted_at: new Date().toISOString(), approved_by: "", approved_at: "", rejected_by: "", rejected_at: "", dedupe_key: text(fields.dedupe_key, 200), note: "" };
}
async function createFromAssistant(auth: AdminContext, body: JsonRecord, documentMode: boolean): Promise<JsonRecord> {
  requireKeys(body, ["action", "message_id"], ["message_id"]); const messageId = id(body.message_id); const source = await assistantSource(auth.service, messageId, documentMode); const refs = source.refs; const hash = await digest(JSON.stringify({ kind: documentMode ? "document_guidance" : "assistant_answer", owner: source.owner, message: messageId, document: id(source.document?.id), question: source.question, answer: source.answer, refs }));
  return createCandidate(auth.service, baseCandidate({ source_owner_email: source.owner, source_kind: documentMode ? "document_guidance" : "assistant_answer", target_surface: "ASSISTANT", source_conversation_id: source.conversation.id, source_message_id: source.message.id, source_document_id: source.document?.id, source_document_name: safeDocumentName(source.document), source_question_excerpt: source.question, source_answer_excerpt: source.answer, source_reference_labels: refs, source_content_hash: hash, proposed_rule: source.answer, category: documentMode ? "document_guidance" : "assistant_guidance", rationale: documentMode ? "Administrator-selected document-grounded answer awaiting human editing and approval." : "Administrator-selected assistant answer awaiting human editing and approval.", dedupe_key: `AIL:${documentMode ? "document" : "assistant"}:v1:${hash}` }, auth.actorEmail), auth.actorEmail);
}
async function createFromSupport(auth: AdminContext, body: JsonRecord): Promise<JsonRecord> {
  requireKeys(body, ["action", "support_request_id"], ["support_request_id"]); const requestId = id(body.support_request_id); const row = await auth.service.entities.HumanSupportRequest.get(requestId) as JsonRecord;
  if (!row || !id(row.id) || status(row.status) !== "RESOLVED") throw new InputError("Only resolved human support requests can be promoted.");
  const owner = validEmail(row.owner_email); const resolution = content(row.resolution_summary, MAX_RESOLUTION_EXCERPT);
  if (!owner) throw new InputError("Guest support requests cannot be promoted to private learning.");
  if (!resolution) throw new InputError("Add a resolution summary before promoting this support request.");
  const hash = await digest(JSON.stringify({ kind: "support_resolution", owner, request: requestId, resolution }));
  return createCandidate(auth.service, baseCandidate({ source_owner_email: owner, source_kind: "support_resolution", target_surface: "ASSISTANT", source_support_request_id: requestId, source_resolution_excerpt: resolution, source_content_hash: hash, proposed_rule: resolution, category: "support_resolution", rationale: "Administrator-authored resolution summary awaiting human editing and approval.", dedupe_key: `AIL:support:v1:${hash}` }, auth.actorEmail), auth.actorEmail);
}
const CONTEXT_KEYS = ["review_mode", "session_mode", "transcript_style", "source_language", "target_language"] as const;
function contextValue(row: JsonRecord, key: string): string { return text(row[key], 120).toLowerCase().replace(/_/g, "-").replace(/\s+/g, " "); }
function compatiblePattern(rows: JsonRecord[]): { owner: string; target: SourceTarget; category: string; context: JsonRecord } {
  if (rows.length < 2) throw new InputError("Select at least two approved active items for a repeated pattern.");
  const owner = validEmail(rows[0].source_owner_email); const target = targetSurface(rows[0].target_surface); const category = text(rows[0].category, 40) || "other";
  if (!owner || !CATEGORIES.has(category)) throw new InputError("The selected evidence is not a supported private learning source.");
  for (const row of rows) {
    if (status(row.status) !== "APPROVED" || row.active !== true || text(row.scope_key, 40) !== "PRIVATE_PROJECT" || !content(row.final_rule, MAX_RULE)) throw new InputError("Choose only approved active learning items with final rules.");
    if (validEmail(row.source_owner_email) !== owner || targetSurface(row.target_surface) !== target || text(row.category, 40) !== category) throw new InputError("Choose evidence from the same owner, target surface, and compatible category.");
  }
  const context: JsonRecord = {};
  for (const key of CONTEXT_KEYS) {
    const values = Array.from(new Set(rows.map((row) => contextValue(row, key)).filter(Boolean)));
    if (values.length > 1) throw new InputError("Choose evidence with compatible session context.");
    context[key] = values[0] || "";
  }
  return { owner, target, category, context };
}
async function synthesizePattern(auth: AdminContext, rules: string[], category: string, target: SourceTarget): Promise<{ rule: string; rationale: string }> {
  const boundedRules = rules.map((rule, index) => `Approved rule ${index + 1}: ${content(rule, MAX_RULE)}`).join("\n");
  try {
    const response = await auth.caller.integrations.core.invokeLLM({ mode: "standard", prompt: [
      "Synthesize one concise private-project assistant learning rule from the approved rules below.",
      "Use only the approved final rules as evidence. Do not invent facts, owners, scope, permissions, status, activation, or version. Preserve the shared intent and remove one-off details.",
      `Category: ${category}. Target surface: ${target}.`, boundedRules,
      "Return only a reusable rule and a short rationale. The result remains pending for human review.",
    ].join("\n\n"), response_json_schema: { type: "object", properties: { proposed_rule: { type: "string", maxLength: MAX_RULE }, rationale: { type: "string", maxLength: 800 } }, required: ["proposed_rule", "rationale"] } }, { headers: auth.headers });
    const model = responseObject(response); const rule = content(model.proposed_rule, MAX_RULE); const rationale = content(model.rationale, 800);
    if (!rule || !rationale) throw new Error("The synthesis was incomplete.");
    return { rule, rationale };
  } catch { console.error("admin-ai-learning pattern synthesis failed"); throw new InputError("The approved pattern could not be synthesized safely. Nothing was created."); }
}
async function createFromPattern(auth: AdminContext, body: JsonRecord): Promise<JsonRecord> {
  requireKeys(body, ["action", "item_ids"], ["item_ids"]); if (!Array.isArray(body.item_ids) || body.item_ids.length < 2 || body.item_ids.length > MAX_PATTERN_ITEMS) throw new InputError("Select between two and twelve approved items.");
  const ids = evidenceIds(body.item_ids); if (ids.length < 2 || ids.length !== body.item_ids.length) throw new InputError("Select at least two different approved items.");
  const rows = await Promise.all(ids.map((itemId) => getItem(auth.service, itemId))); const compatible = compatiblePattern(rows); const finalRules = rows.map((row) => content(row.final_rule, MAX_RULE));
  const synthesis = await synthesizePattern(auth, finalRules, compatible.category, compatible.target); const patternKey = await digest(JSON.stringify({ owner: compatible.owner, target: compatible.target, category: compatible.category, context: compatible.context, evidence: ids })); const sourceHash = await digest(JSON.stringify({ evidence: ids, rules: finalRules }));
  return createCandidate(auth.service, baseCandidate({ source_owner_email: compatible.owner, source_kind: "repeated_pattern", target_surface: compatible.target, evidence_item_ids: ids, pattern_key: patternKey, occurrence_count: ids.length, source_content_hash: sourceHash, proposed_rule: synthesis.rule, category: "repeated_pattern", rationale: synthesis.rationale, ...compatible.context, dedupe_key: `AIL:pattern:v1:${patternKey}` }, auth.actorEmail), auth.actorEmail);
}
async function editPending(service: Client, body: JsonRecord): Promise<JsonRecord> {
  requireKeys(body, ["action", "item_id", "proposed_rule", "final_rule", "category", "note"], ["item_id"]); const row = await getItem(service, id(body.item_id)); if (status(row.status) !== "PENDING") throw new InputError("Only pending learning items can be edited.");
  const proposed = ruleInput(body.proposed_rule, "The proposed rule", content(row.proposed_rule, MAX_RULE)); const finalRule = ruleInput(body.final_rule, "The final rule", content(row.final_rule, MAX_RULE)); const category = categoryInput(body.category, text(row.category, 40) || "other"); const note = noteInput(body.note, text(row.note, MAX_NOTE));
  const saved = await service.entities.AiLearningItem.update(id(row.id), { proposed_rule: proposed, final_rule: finalRule, category, note, scope_key: "PRIVATE_PROJECT", status: "PENDING", active: false, version: 1 }) as JsonRecord;
  return { ok: true, action: "EDITED", item: publicItem(saved && id(saved.id) ? saved : { ...row, proposed_rule: proposed, final_rule: finalRule, category, note, status: "PENDING", active: false, version: 1 }) };
}
async function decide(service: Client, body: JsonRecord, action: "approve" | "reject", actor: string): Promise<JsonRecord> {
  requireKeys(body, action === "reject" ? ["action", "item_id", "note"] : ["action", "item_id"], ["item_id"]); const itemId = id(body.item_id); if (decisionLocks.has(itemId)) throw new InputError("This learning item is already being reviewed. Refresh and try again."); decisionLocks.add(itemId);
  try {
    const row = await getItem(service, itemId); const currentStatus = status(row.status); if (action === "approve" && currentStatus === "APPROVED") return { ok: true, action: "APPROVED", idempotent: true, item: publicItem(row) }; if (action === "reject" && currentStatus === "REJECTED") return { ok: true, action: "REJECTED", idempotent: true, item: publicItem(row) }; if (currentStatus !== "PENDING") throw new InputError(`This learning item is already ${currentStatus.toLowerCase() || "closed"}.`);
    const previousRule = content(row.final_rule, MAX_RULE) || content(row.proposed_rule, MAX_RULE); const now = new Date().toISOString(); const note = noteInput(body.note, text(row.note, MAX_NOTE)); const approve = action === "approve"; const finalRule = content(row.final_rule, MAX_RULE) || content(row.proposed_rule, MAX_RULE); if (approve && !finalRule) throw new InputError("Add a final rule before approving this item.");
    const patch: JsonRecord = approve ? { final_rule: finalRule, scope_key: "PRIVATE_PROJECT", status: "APPROVED", active: true, version: 1, approved_by: actor, approved_at: now, rejected_by: "", rejected_at: "", note } : { scope_key: "PRIVATE_PROJECT", status: "REJECTED", active: false, version: 1, approved_by: "", approved_at: "", rejected_by: actor, rejected_at: now, note };
    let saved: JsonRecord | undefined;
    try { saved = await service.entities.AiLearningItem.update(itemId, patch) as JsonRecord; await writeAudit(service, row, approve ? "APPROVED" : "REJECTED", actor, previousRule, approve ? finalRule : previousRule, "PENDING", approve ? "APPROVED" : "REJECTED", approve, note); }
    catch (error) { try { await service.entities.AiLearningItem.update(itemId, { scope_key: "PRIVATE_PROJECT", status: "PENDING", active: false, version: 1, approved_by: "", approved_at: "", rejected_by: "", rejected_at: "" }); } catch { console.error("admin-ai-learning decision rollback failed"); } throw error; }
    return { ok: true, action: approve ? "APPROVED" : "REJECTED", idempotent: false, item: publicItem(saved && id(saved.id) ? saved : { ...row, ...patch }) };
  } finally { decisionLocks.delete(itemId); }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return json(request, {}, 204);
  if (request.method !== "POST") return json(request, { error: "Use POST for learning review actions." }, 405);
  const auth = await adminContext(request); if (auth instanceof Response) return auth;
  let body: JsonRecord;
  try { body = await readBody(request); } catch (error) { return json(request, { error: error instanceof Error ? error.message : "The request body is invalid." }, 400); }
  const action = text(body.action, 40);
  try {
    if (action === "list_pending") { requireKeys(body, ["action"]); const rows = await items(auth.service); return json(request, { ok: true, items: rows.filter((row) => status(row.status) === "PENDING").slice(0, 200).map(publicItem), counts: counts(rows) }); }
    if (action === "list_sources") { requireKeys(body, ["action"]); return json(request, await listSources(auth.service)); }
    if (action === "edit_pending") return json(request, await editPending(auth.service, body));
    if (action === "approve" || action === "reject") return json(request, await decide(auth.service, body, action, auth.actorEmail));
    if (action === "create_from_assistant") return json(request, await createFromAssistant(auth, body, false));
    if (action === "create_from_document_guidance") return json(request, await createFromAssistant(auth, body, true));
    if (action === "create_from_support_resolution") return json(request, await createFromSupport(auth, body));
    if (action === "create_from_pattern") return json(request, await createFromPattern(auth, body));
    throw new InputError("Unknown learning review action.");
  } catch (error) { const input = error instanceof InputError; console.error("admin-ai-learning failed", action || "unknown", input ? error.message : "unexpected review error"); return json(request, { error: input ? error.message : "The learning review could not be completed." }, input ? 400 : 500); }
});
