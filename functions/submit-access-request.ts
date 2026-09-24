import { createSuperdevClient } from "npm:@superdevhq/client@0.1.56";

type JsonRecord = Record<string, unknown>;
type Client = ReturnType<typeof createSuperdevClient>;

class InputError extends Error {
  constructor(message: string) { super(message); this.name = "InputError"; }
}

const MAX_REQUEST_BYTES = 16_000;
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MAX_MESSAGE_LENGTH = 500;
const RATE_WINDOW_MS = 10 * 60_000;
const MAX_EMAIL_REQUESTS = 3;
const MAX_NETWORK_REQUESTS = 12;
const DEDUPE_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_NOTIFICATION_EMAIL = "transcriptxpert@trancript.art";
const DEFAULT_NOTIFICATION_ENABLED = true;
const NOTIFICATION_EMAIL_MAX = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PUBLIC_ORIGINS = new Set([
  "https://trancript.art",
  "https://www.trancript.art",
  "https://www.buildy.ai",
]);
const PREVIEW_ORIGIN_PATTERN = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:superdev\.run|buildy\.show)$/i;
const recentBuckets = new Map<string, { startedAt: number; count: number }>();

function isAllowedOrigin(origin: string): boolean { return PUBLIC_ORIGINS.has(origin) || PREVIEW_ORIGIN_PATTERN.test(origin); }
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
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      } : {}),
    },
  });
}
function text(value: unknown, max: number): string { return typeof value === "string" ? value.slice(0, max) : ""; }
function singleLine(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== "string") { if (!required && value === undefined) return ""; throw new InputError(`${label} is required.`); }
  if (value.length > max) throw new InputError(`${label} is too long.`);
  const cleaned = value.replace(/\u0000/g, "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (required && !cleaned) throw new InputError(`${label} is required.`);
  return cleaned.slice(0, max);
}
function messageValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new InputError("Message must be text.");
  if (value.length > MAX_MESSAGE_LENGTH) throw new InputError("Message is too long.");
  return value.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").trim();
}
function trustedIp(request: Request): string {
  const candidates = [request.headers.get("cf-connecting-ip") || "", request.headers.get("x-real-ip") || "", request.headers.get("x-forwarded-for")?.split(",")[0] || ""];
  for (const value of candidates) {
    const candidate = value.trim().replace(/^"|"$/g, "");
    if (candidate && candidate.length <= 45 && /^[0-9a-f:.]+$/i.test(candidate)) return candidate;
  }
  return "";
}
function consume(key: string, limit: number, now: number): boolean {
  if (!key) return true;
  const previous = recentBuckets.get(key);
  const bucket = !previous || now - previous.startedAt >= RATE_WINDOW_MS ? { startedAt: now, count: 0 } : previous;
  if (bucket.count >= limit) { recentBuckets.set(key, bucket); return false; }
  bucket.count += 1;
  recentBuckets.set(key, bucket);
  if (recentBuckets.size > 1_000) for (const [entry, value] of recentBuckets) if (now - value.startedAt >= RATE_WINDOW_MS) recentBuckets.delete(entry);
  return true;
}
async function fingerprint(name: string, email: string, message: string): Promise<string> {
  const source = new TextEncoder().encode(`${name}\u001f${email}\u001f${message}`);
  const digest = await crypto.subtle.digest("SHA-256", source);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
function serviceClient(): Client {
  const key = Deno.env.get("SUPERDEV_SERVICE_ROLE_KEY");
  if (!key) throw new Error("The access request service is not configured.");
  const client = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
  client.auth.setToken(key);
  return client;
}
async function readBody(request: Request): Promise<JsonRecord> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_REQUEST_BYTES) throw new InputError("The request is too large.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BYTES) throw new InputError("The request is too large.");
  if (!bytes.byteLength) throw new InputError("The request body is required.");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, "")); } catch { throw new InputError("The request body must contain valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("The request body must be a JSON object.");
  const body = value as JsonRecord;
  if (Object.keys(body).some((key) => !["name", "email", "message"].includes(key))) throw new InputError("Only name, email, and message are accepted.");
  return body;
}
async function recentDuplicate(client: Client, key: string, now: number): Promise<string> {
  const rows = await client.entities.AccessRequest.filter({ dedupe_key: key }, "-submitted_at", 1) as JsonRecord[];
  const row = Array.isArray(rows) ? rows[0] : undefined;
  const submitted = row ? Date.parse(text(row.submitted_at ?? row.created_at, 80)) : NaN;
  const id = row ? text(row.id, 120) : "";
  return id && Number.isFinite(submitted) && now - submitted >= -5 * 60_000 && now - submitted <= DEDUPE_WINDOW_MS ? id : "";
}
function escapeHtml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;"); }
function integrationHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const authorization = request.headers.get("Authorization");
  const origin = request.headers.get("Origin");
  if (authorization) headers.Authorization = authorization;
  if (origin && isAllowedOrigin(origin)) headers.Origin = origin;
  return headers;
}
async function notificationSettings(client: Client): Promise<{ recipientEmail: string; enabled: boolean }> {
  const rows = await client.entities.AdminNotificationSettings.filter({ settings_key: "default" }, "-updated_at", 20) as JsonRecord[];
  const selected = Array.isArray(rows) ? rows.find((row) => Boolean(text(row.id, 120))) : undefined;
  if (!selected) return { recipientEmail: DEFAULT_NOTIFICATION_EMAIL, enabled: DEFAULT_NOTIFICATION_ENABLED };
  const recipientEmail = typeof selected.recipient_email === "string" ? selected.recipient_email.trim().toLowerCase() : "";
  if (!recipientEmail || recipientEmail.length > NOTIFICATION_EMAIL_MAX || !EMAIL_PATTERN.test(recipientEmail) || typeof selected.enabled !== "boolean") throw new Error("The access alert setting is invalid.");
  return { recipientEmail, enabled: selected.enabled };
}
async function sendAccessRequestNotification(client: Client, request: Request, name: string, email: string, message: string): Promise<void> {
  const settings = await notificationSettings(client);
  if (!settings.enabled) return;
  const safeMessage = escapeHtml(message).replace(/\n/g, "<br />");
  const integration = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
  await integration.integrations.core.sendEmail({
    to: settings.recipientEmail,
    subject: "New Verbatim Desk access request",
    from_name: "Verbatim Desk",
    body_html: `<div style="margin:0;padding:28px;background:#f4f1eb;color:#17202b;font-family:Arial,sans-serif;line-height:1.55"><div style="max-width:560px;margin:0 auto;padding:28px;background:#ffffff;border:1px solid #ded8cf;border-radius:14px"><p style="margin:0 0 8px;color:#168b72;font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase">Verbatim Desk</p><h1 style="margin:0 0 24px;font-size:24px;line-height:1.2">New access request</h1><p style="margin:0 0 16px"><strong>Name</strong><br />${escapeHtml(name)}</p><p style="margin:0 0 16px"><strong>Email</strong><br />${escapeHtml(email)}</p><p style="margin:0"><strong>Message</strong><br />${safeMessage || "<span style=\"color:#6b7280\">No message provided.</span>"}</p></div></div>`,
  }, { headers: integrationHeaders(request) });
}

async function createAccessNotification(client: Client, requestId: string, name: string, email: string, message: string): Promise<void> {
  const dedupeKey = `ACCESS_REQUEST:${requestId}`;
  const rows = await client.entities.AdminNotification.filter({ dedupe_key: dedupeKey }, "-created_at", 5) as JsonRecord[];
  if (Array.isArray(rows) && rows.some((row) => Boolean(text(row.id, 120)))) return;
  await client.entities.AdminNotification.create({
    event_type: "ACCESS_REQUEST",
    title: "New access request",
    message: `${name} (${email}) requested access.${message ? ` ${message}` : ""}`.slice(0, 2_000),
    related_access_request_id: requestId,
    conversation_token: "",
    human_support_request_id: "",
    read_by: [],
    dedupe_key: dedupeKey,
  });
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin") || "";
  if (request.method === "OPTIONS") return isAllowedOrigin(origin) ? json(request, {}, 204) : json(request, { error: "Request origin is not allowed." }, 403);
  if (!isAllowedOrigin(origin)) return json(request, { error: "Request origin is not allowed." }, 403);
  if (request.method !== "POST") return json(request, { error: "Use POST to submit an access request." }, 405);
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType && contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") return json(request, { error: "This endpoint accepts JSON requests only." }, 415);
  try {
    const body = await readBody(request);
    const name = singleLine(body.name, "Name", MAX_NAME_LENGTH);
    const email = singleLine(body.email, "Email", MAX_EMAIL_LENGTH).toLowerCase();
    if (!EMAIL_PATTERN.test(email)) throw new InputError("Enter a valid email address.");
    const message = messageValue(body.message);
    const now = Date.now();
    const ip = trustedIp(request);
    if (!consume(`email:${email}`, MAX_EMAIL_REQUESTS, now) || !consume(`network:${origin}:${ip || "unknown"}`, MAX_NETWORK_REQUESTS, now)) return json(request, { error: "Too many requests. Try again later." }, 429);
    const service = serviceClient();
    const dedupeKey = await fingerprint(name, email, message);
    const duplicateId = await recentDuplicate(service, dedupeKey, now);
    if (duplicateId) return json(request, { ok: true, request_id: duplicateId, coalesced: true });
    const submittedAt = new Date(now).toISOString();
    const created = await service.entities.AccessRequest.create({ contact_email: email, contact_id: "", name, message, submitted_at: submittedAt, status: "NEW", private_note: "", reviewed_by: "", reviewed_at: "", approved_by: "", approved_at: "", dedupe_key: dedupeKey }) as JsonRecord;
    const requestId = text(created?.id, 120);
    if (!requestId) throw new Error("The request was not assigned an id.");
    try {
      await createAccessNotification(service, requestId, name, email, message);
    } catch {
      console.error("submit-access-request in-app notification failed");
    }
    try {
      await sendAccessRequestNotification(service, request, name, email, message);
    } catch {
      console.error("submit-access-request notification failed");
    }
    return json(request, { ok: true, request_id: requestId, coalesced: false }, 201);
  } catch (error) {
    const input = error instanceof InputError;
    console.error("submit-access-request failed", input ? "invalid input" : "unexpected service error");
    return json(request, { error: input ? error.message : "The access request could not be recorded." }, input ? 400 : 503);
  }
});
