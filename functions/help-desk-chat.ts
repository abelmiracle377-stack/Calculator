import { createSuperdevClient } from "npm:@superdevhq/client@0.1.56";

type JsonRecord = Record<string, unknown>;
type ChatMode = "init" | "message";
type Client = ReturnType<typeof createSuperdevClient>;
type Identity = { userId: string; email: string; name: string };

type ChatResult = { providerConversationId: string; response: string };

const HELP_DESK_AGENT_ID = "1e86b9f6-275b-4d01-bf54-99bb98b93cdd";
const MAX_REQUEST_BYTES = 8_000;
const MAX_MESSAGE_LENGTH = 1_200;
const MAX_CONVERSATION_ID_LENGTH = 256;
const MAX_RESPONSE_LENGTH = 4_000;
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MAX_REASON_LENGTH = 1_000;
const MAX_SUMMARY_LENGTH = 2_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PUBLIC_ORIGINS = new Set([
  "https://trancript.art",
  "https://www.trancript.art",
  "https://www.buildy.ai",
]);
const PREVIEW_ORIGIN_PATTERN = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:superdev\.run|buildy\.show)$/i;

class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

function isAllowedOrigin(origin: string): boolean {
  return PUBLIC_ORIGINS.has(origin) || PREVIEW_ORIGIN_PATTERN.test(origin);
}

function json(request: Request, payload: unknown, status = 200): Response {
  const origin = request.headers.get("Origin") || "";
  const allowed = isAllowedOrigin(origin);
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Origin",
      ...(allowed ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      } : {}),
    },
  });
}

function acceptsJsonContentType(value: string): boolean {
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return !mediaType || mediaType === "application/json" || mediaType === "text/json" || mediaType === "text/plain" || mediaType.endsWith("+json");
}

async function readBody(request: Request): Promise<JsonRecord> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) throw new InputError("The request is too large.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BYTES) throw new InputError("The request is too large.");
  if (!bytes.byteLength) throw new InputError("The request body is required.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, ""));
  } catch {
    throw new InputError("The request body must contain valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("The request body must be a JSON object.");
  return value as JsonRecord;
}

function cleanText(value: unknown, max: number, required = false): string {
  if (typeof value !== "string") {
    if (!required && value === undefined) return "";
    throw new InputError("The submitted value is invalid.");
  }
  if (value.length > max) throw new InputError("The submitted value is too long.");
  const cleaned = value.replace(/\u0000/g, "").replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim();
  if (required && !cleaned) throw new InputError("The submitted value is required.");
  return cleaned.slice(0, max);
}

function messageValue(value: unknown): string {
  if (typeof value !== "string") throw new InputError("Message is required.");
  if (value.length > MAX_MESSAGE_LENGTH) throw new InputError("Message is too long.");
  const cleaned = value.replace(/\u0000/g, "").replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim();
  if (!cleaned) throw new InputError("Message is required.");
  return cleaned;
}

function conversationValue(value: unknown): string {
  if (typeof value !== "string") throw new InputError("Conversation id is required.");
  if (value.length > MAX_CONVERSATION_ID_LENGTH) throw new InputError("Conversation id is too long.");
  const cleaned = value.replace(/[\u0000-\u001F]/g, " ").trim();
  if (!cleaned) throw new InputError("Conversation id is required.");
  return cleaned;
}

function providerText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) return "";
  return value.replace(/\u0000/g, "").replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim();
}

function emailValue(value: unknown, required = false): string {
  const result = cleanText(value, MAX_EMAIL_LENGTH, required).toLowerCase();
  if (result && !EMAIL_PATTERN.test(result)) throw new InputError("Enter a valid email address.");
  return result;
}

function authToken(request: Request): string {
  return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

function identityId(value: unknown): string {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
  const explicit = providerText(row.user_id ?? row.userId, 160);
  return explicit || providerText(row.id, 160);
}

function identityEmail(value: unknown): string {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
  const result = providerText(row.email, MAX_EMAIL_LENGTH).toLowerCase();
  return result && EMAIL_PATTERN.test(result) ? result : "";
}

async function requestIdentity(request: Request): Promise<Identity> {
  const token = authToken(request);
  if (!token) return { userId: "", email: "", name: "" };
  try {
    const caller = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
    caller.auth.setToken(token);
    const user = await caller.auth.me() as JsonRecord;
    return {
      userId: identityId(user),
      email: identityEmail(user),
      name: cleanText(user.full_name ?? user.name, MAX_NAME_LENGTH),
    };
  } catch {
    return { userId: "", email: "", name: "" };
  }
}

function serviceClient(): Client {
  const key = Deno.env.get("SUPERDEV_SERVICE_ROLE_KEY");
  if (!key) throw new Error("The support service is not configured.");
  const client = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
  client.auth.setToken(key);
  return client;
}

function integrationHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const authorization = request.headers.get("Authorization");
  const origin = request.headers.get("Origin");
  if (authorization) headers.Authorization = authorization;
  if (origin && isAllowedOrigin(origin)) headers.Origin = origin;
  return headers;
}

async function findConversation(client: Client, token: string): Promise<JsonRecord | undefined> {
  const rows = await client.entities.SupportConversation.filter({ conversation_token: token }, "-updated_at", 5) as JsonRecord[];
  return Array.isArray(rows) ? rows.find((row) => providerText(row.conversation_token, MAX_CONVERSATION_ID_LENGTH) === token) : undefined;
}

function ownsConversation(row: JsonRecord | undefined, identity: Identity): boolean {
  if (!row) return false;
  const ownerEmail = providerText(row.owner_email, MAX_EMAIL_LENGTH).toLowerCase();
  const ownerId = providerText(row.owner_user_id, 160);
  if (identity.email) {
    if (ownerEmail && ownerEmail !== identity.email) return false;
    if (ownerId && identity.userId && ownerId !== identity.userId) return false;
    return true;
  }
  return !ownerEmail && !ownerId;
}

function messageCount(row: JsonRecord): number {
  const value = typeof row.message_count === "number" ? row.message_count : Number(row.message_count);
  return Number.isFinite(value) && value >= 0 ? Math.min(100_000, Math.floor(value)) : 0;
}

async function storeMessage(client: Client, conversation: JsonRecord, role: "user" | "assistant" | "system", text: string, source: string): Promise<void> {
  const token = providerText(conversation.conversation_token, MAX_CONVERSATION_ID_LENGTH);
  if (!token || !text) return;
  const now = new Date().toISOString();
  await client.entities.SupportMessage.create({
    conversation_token: token,
    owner_user_id: providerText(conversation.owner_user_id, 160),
    owner_email: providerText(conversation.owner_email, MAX_EMAIL_LENGTH).toLowerCase(),
    role,
    message_text: text.slice(0, MAX_RESPONSE_LENGTH),
    source: providerText(source, 64) || "help_desk",
    sent_at: now,
  });
  await client.entities.SupportConversation.update(providerText(conversation.id, 160), {
    message_count: messageCount(conversation) + 1,
    last_message_at: now,
    last_message_preview: text.slice(0, 320),
  });
  conversation.message_count = messageCount(conversation) + 1;
  conversation.last_message_at = now;
  conversation.last_message_preview = text.slice(0, 320);
}

async function callProvider(request: Request, payload: JsonRecord, key: string): Promise<ChatResult> {
  const origin = request.headers.get("Origin") || "";
  const headers = { "X-Public-Chat-Key": key, Origin: origin, ...integrationHeaders(request) };
  try {
    const client = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
    const result = await client.integrations.core.textAgentChat(payload, { headers }) as unknown;
    const record = result && typeof result === "object" && !Array.isArray(result) ? result as JsonRecord : {};
    const providerConversationId = providerText(record.conversation_id, MAX_CONVERSATION_ID_LENGTH);
    const response = providerText(record.response, MAX_RESPONSE_LENGTH);
    if (!providerConversationId && payload.mode === "init") throw new Error("Missing provider conversation id");
    return { providerConversationId, response };
  } catch {
    console.error("help-desk-chat provider failure", payload.mode);
    throw new Error("The AI Help Desk could not be reached right now.");
  }
}

function humanHelpIntent(value: string): boolean {
  return /\b(?:human|person|expert|agent|staff|representative)\b/i.test(value) && /\b(?:help|support|speak|talk|contact|connect|reach|answer)\b/i.test(value);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}

async function notificationSettings(client: Client): Promise<{ recipientEmail: string; enabled: boolean }> {
  const rows = await client.entities.AdminNotificationSettings.filter({ settings_key: "default" }, "-updated_at", 20) as JsonRecord[];
  const selected = Array.isArray(rows) ? rows.find((row) => providerText(row.id, 120)) : undefined;
  const recipientEmail = providerText(selected?.recipient_email, MAX_EMAIL_LENGTH).toLowerCase();
  if (!selected) return { recipientEmail: "transcriptxpert@trancript.art", enabled: true };
  if (!recipientEmail || !EMAIL_PATTERN.test(recipientEmail) || typeof selected.enabled !== "boolean") throw new Error("The access alert setting is invalid.");
  return { recipientEmail, enabled: selected.enabled };
}

async function sendHandoffEmail(client: Client, request: Request, name: string, email: string, reason: string, conversationToken: string): Promise<void> {
  const settings = await notificationSettings(client);
  if (!settings.enabled) return;
  const integration = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
  await integration.integrations.core.sendEmail({
    to: settings.recipientEmail,
    subject: "Human support requested in Verbatim Desk",
    from_name: "Verbatim Desk",
    body_html: `<div style="margin:0;padding:28px;background:#f4f1eb;color:#17202b;font-family:Arial,sans-serif;line-height:1.55"><div style="max-width:560px;margin:0 auto;padding:28px;background:#ffffff;border:1px solid #ded8cf;border-radius:14px"><p style="margin:0 0 8px;color:#168b72;font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase">Verbatim Desk</p><h1 style="margin:0 0 24px;font-size:24px;line-height:1.2">Human support requested</h1><p style="margin:0 0 16px"><strong>Name</strong><br />${escapeHtml(name)}</p><p style="margin:0 0 16px"><strong>Email</strong><br />${escapeHtml(email)}</p><p style="margin:0"><strong>Reason</strong><br />${escapeHtml(reason) || "No reason provided."}</p><p style="margin:20px 0 0;color:#6b7280;font-size:12px">Open the protected Admin Panel to review the linked support conversation. Reference: ${escapeHtml(conversationToken.slice(0, 12))}</p></div></div>`,
  }, { headers: integrationHeaders(request) });
}

async function createHumanHandoff(request: Request, body: JsonRecord, key: string): Promise<Response> {
  const token = conversationValue(body.conversation_id);
  const client = serviceClient();
  const identity = await requestIdentity(request);
  const conversation = await findConversation(client, token);
  if (!ownsConversation(conversation, identity)) return json(request, { error: "That support conversation is not available." }, 404);

  const visitorName = providerText(conversation?.visitor_name, MAX_NAME_LENGTH) || identity.name || cleanText(body.name, MAX_NAME_LENGTH);
  const visitorEmail = providerText(conversation?.visitor_email, MAX_EMAIL_LENGTH).toLowerCase() || identity.email || emailValue(body.email);
  if (!visitorName || !visitorEmail) return json(request, { error: "Tell us your name and email so a human expert can follow up.", code: "IDENTITY_REQUIRED" }, 400);
  if (!EMAIL_PATTERN.test(visitorEmail)) throw new InputError("Enter a valid email address.");
  const reason = cleanText(body.reason, MAX_REASON_LENGTH) || "Visitor requested human support through the AI Help Desk.";
  const now = new Date().toISOString();
  const rows = await client.entities.HumanSupportRequest.filter({ conversation_token: token }, "-requested_at", 5) as JsonRecord[];
  const existing = Array.isArray(rows) ? rows.find((row) => providerText(row.id, 160)) : undefined;
  let support: JsonRecord;
  if (existing?.id) {
    support = await client.entities.HumanSupportRequest.update(providerText(existing.id, 160), {
      requester_name: visitorName,
      requester_email: visitorEmail,
      reason,
      summary: reason.slice(0, MAX_SUMMARY_LENGTH),
      status: providerText(existing.status, 24).toUpperCase() === "RESOLVED" ? "NEW" : providerText(existing.status, 24).toUpperCase() || "NEW",
      resolved_at: "",
    }) as JsonRecord;
  } else {
    support = await client.entities.HumanSupportRequest.create({
      conversation_token: token,
      owner_user_id: identity.userId,
      owner_email: identity.email,
      requester_name: visitorName,
      requester_email: visitorEmail,
      reason,
      summary: reason.slice(0, MAX_SUMMARY_LENGTH),
      status: "NEW",
      requested_at: now,
      assigned_admin: "",
      private_note: "",
      resolved_at: "",
    }) as JsonRecord;
  }
  const supportId = providerText(support?.id ?? existing?.id, 160);
  if (!supportId) throw new Error("The support request was not assigned an id.");
  await client.entities.SupportConversation.update(providerText(conversation?.id, 160), {
    visitor_name: visitorName,
    visitor_email: visitorEmail,
    human_requested: true,
    human_requested_at: providerText(conversation?.human_requested_at, 80) || now,
    human_support_request_id: supportId,
    status: "HUMAN_REQUESTED",
  });

  const dedupeKey = `HUMAN_SUPPORT:${token}`;
  const notificationRows = await client.entities.AdminNotification.filter({ dedupe_key: dedupeKey }, "-created_at", 5) as JsonRecord[];
  const notification = Array.isArray(notificationRows) ? notificationRows.find((row) => providerText(row.id, 160)) : undefined;
  if (!notification) {
    await client.entities.AdminNotification.create({
      event_type: "HUMAN_SUPPORT",
      title: "Human support requested",
      message: `${visitorName} requested human support through the AI Help Desk.`,
      related_access_request_id: "",
      conversation_token: token,
      human_support_request_id: supportId,
      read_by: [],
      dedupe_key: dedupeKey,
    });
    try {
      await sendHandoffEmail(client, request, visitorName, visitorEmail, reason, token);
    } catch {
      console.error("help-desk-chat handoff email failed");
    }
  }
  return json(request, { ok: true, conversation_id: token, human_support_request_id: supportId, status: "NEW" });
}

async function handleChat(request: Request, body: JsonRecord, key: string): Promise<Response> {
  const mode = body.mode;
  const identity = await requestIdentity(request);
  const client = serviceClient();
  if (mode === "init") {
    const result = await callProvider(request, { agent_id: HELP_DESK_AGENT_ID, mode: "init" }, key);
    const token = crypto.randomUUID();
    const now = new Date().toISOString();
    const conversation = await client.entities.SupportConversation.create({
      conversation_token: token,
      provider_conversation_id: result.providerConversationId,
      owner_user_id: identity.userId,
      owner_email: identity.email,
      visitor_name: identity.name,
      visitor_email: identity.email,
      source: identity.email ? "authenticated" : "guest",
      status: "OPEN",
      human_requested: false,
      human_requested_at: "",
      human_support_request_id: "",
      started_at: now,
      last_message_at: result.response ? now : "",
      message_count: 0,
      last_message_preview: result.response.slice(0, 320),
    }) as JsonRecord;
    if (!providerText(conversation?.id, 160)) throw new Error("The support conversation could not be stored.");
    if (result.response) await storeMessage(client, conversation, "assistant", result.response, "assistant_greeting");
    return json(request, { conversation_id: token, response: result.response, human_help_suggested: false });
  }

  const token = conversationValue(body.conversation_id);
  const message = messageValue(body.message);
  const conversation = await findConversation(client, token);
  if (!ownsConversation(conversation, identity)) return json(request, { error: "That support conversation is not available." }, 404);
  const providerConversationId = providerText(conversation?.provider_conversation_id, MAX_CONVERSATION_ID_LENGTH);
  if (!providerConversationId) throw new Error("The support conversation is incomplete.");
  const result = await callProvider(request, { agent_id: HELP_DESK_AGENT_ID, mode: "message", message, conversation_id: providerConversationId }, key);
  try {
    await storeMessage(client, conversation!, "user", message, "visitor");
    if (result.response) await storeMessage(client, conversation!, "assistant", result.response, "assistant");
  } catch {
    console.error("help-desk-chat message storage failed");
  }
  return json(request, { conversation_id: token, response: result.response, human_help_suggested: humanHelpIntent(message) });
}

function validateBody(body: JsonRecord): "init" | "message" | "human_handoff" {
  const mode = body.mode;
  if (mode !== "init" && mode !== "message" && mode !== "human_handoff") throw new InputError("Mode must be init, message, or human_handoff.");
  const accepted = mode === "init" ? ["mode"] : mode === "message" ? ["mode", "message", "conversation_id"] : ["mode", "conversation_id", "name", "email", "reason"];
  if (Object.keys(body).some((key) => !accepted.includes(key))) throw new InputError("The support request contains an unsupported field.");
  if (mode === "init" && Object.keys(body).length !== 1) throw new InputError("Init requests accept only mode.");
  if (mode === "message") {
    messageValue(body.message);
    conversationValue(body.conversation_id);
  }
  if (mode === "human_handoff") conversationValue(body.conversation_id);
  return mode;
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin)) return json(request, { error: "Request origin is not allowed." }, 403);
  if (request.method === "OPTIONS") return json(request, {}, 204);
  if (request.method !== "POST") return json(request, { error: "Use POST for AI Help Desk messages." }, 405);
  if (!acceptsJsonContentType(request.headers.get("Content-Type") || "")) return json(request, { error: "This endpoint accepts JSON requests only." }, 415);

  try {
    const body = await readBody(request);
    const mode = validateBody(body);
    const key = Deno.env.get("NEXT_PUBLIC_PUBLIC_CHAT_KEY")?.trim() || "";
    if (mode !== "human_handoff" && !key) return json(request, { error: "The AI Help Desk is not available right now." }, 503);
    if (mode === "human_handoff") return await createHumanHandoff(request, body, key);
    return await handleChat(request, body, key);
  } catch (error) {
    const input = error instanceof InputError;
    console.error("help-desk-chat failed", input ? "invalid input" : "unexpected support error");
    return json(request, { error: input ? error.message : error instanceof Error && error.message.includes("could not be reached") ? error.message : "The AI Help Desk could not complete that request." }, input ? 400 : 502);
  }
});
