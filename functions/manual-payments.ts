import { createSuperdevClient } from "npm:@superdevhq/client@0.1.56";

type JsonRecord = Record<string, unknown>;
type Client = ReturnType<typeof createSuperdevClient>;
type NotificationStatus = "NOT_ATTEMPTED" | "SENT" | "FAILED" | "SKIPPED";

class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

const ADMIN_EMAIL = "abelmiracle377@gmail.com";
const BASE_PRICE_USD = 20;
const USA_PRICE_USD = 10;
const MAX_REQUEST_BYTES = 7 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_RECEIPT_DATA_CHARS = 3_200_000;
const MAX_TEXT = 2_000;
const ACCEPTED_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const MESSAGE_SUBJECT_MAX = 120;
const MESSAGE_BODY_MAX = 2_000;
const MESSAGE_PLACEHOLDERS = new Set(["first_name", "email", "payment_id", "payment_method", "amount", "currency", "premium_start", "premium_end"]);
const MESSAGE_PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;
type MessageTemplates = {
  signup_subject: string;
  signup_body: string;
  payment_submitted_subject: string;
  payment_submitted_body: string;
  payment_approved_subject: string;
  payment_approved_body: string;
};
const DEFAULT_MESSAGE_TEMPLATES: MessageTemplates = {
  signup_subject: "Welcome to Verbatim Desk",
  signup_body: "Welcome to Verbatim Desk, {{first_name}}.\n\nYour account is ready. Sign in to open your private transcription workspace and start your first review.\n\nYour 7-day trial begins with your account access. If you need help, reply to this email.\n\nAccount: {{email}}",
  payment_submitted_subject: "Payment received, verification is pending",
  payment_submitted_body: "Hi {{first_name}},\n\nWe received your manual payment submission for Verbatim Desk. Your evidence is saved and is now waiting for administrator verification.\n\nPayment ID: {{payment_id}}\nPayment method: {{payment_method}}\nAmount: {{amount}} {{currency}}\n\nPremium access starts after the payment is approved. We will email you when a decision is recorded.",
  payment_approved_subject: "Your Verbatim Desk Premium access is active",
  payment_approved_body: "Hi {{first_name}},\n\nYour payment has been approved and one calendar month of Premium access is now active.\n\nPayment ID: {{payment_id}}\nPayment method: {{payment_method}}\nPremium: {{premium_start}} to {{premium_end}}\n\nSign in to continue your transcription work.",
};
const DEFAULT_SETTINGS: JsonRecord = {
  settings_key: "default", premium_price_usd: BASE_PRICE_USD, usa_price_usd: USA_PRICE_USD,
  nigeria_enabled: false, nigeria_bank_name: "", nigeria_account_name: "", nigeria_account_number: "", nigeria_instructions: "", nigeria_ngn_rate: 0, nigeria_rate_timestamp: "",
  uk_enabled: false, uk_account_holder_name: "", uk_bank_name: "", uk_account_number: "", uk_sort_code: "", uk_iban: "", uk_bic_swift: "", uk_bank_address: "", uk_account_holder_address: "", uk_instructions: "", uk_gbp_rate: 0, uk_rate_timestamp: "",
  usa_enabled: false, usa_account_holder_name: "", usa_bank_name: "", usa_account_number: "", usa_routing_number: "", usa_bank_address: "", usa_account_holder_address: "", usa_instructions: "",
};

const ALLOWED_ORIGIN = "https://www.buildy.ai";
const PREVIEW_ORIGIN_PATTERN = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:superdev\.run|buildy\.show)$/i;

function isAllowedOrigin(origin: string): boolean {
  return origin === ALLOWED_ORIGIN || PREVIEW_ORIGIN_PATTERN.test(origin);
}

function json(request: Request, payload: unknown, status = 200) {
  const origin = request.headers.get("Origin") || "";
  const allowed = isAllowedOrigin(origin);
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin", ...(allowed ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" } : {}) } });
}
function text(value: unknown, max = MAX_TEXT): string { return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").trim().slice(0, max) : ""; }
function numberValue(value: unknown): number | null { const result = typeof value === "number" ? value : Number(value); return Number.isFinite(result) ? result : null; }
function normalizeEmail(value: unknown): string { return text(value, 320).toLowerCase(); }
function notificationStatus(value: unknown): NotificationStatus { const valueText = text(value, 24).toUpperCase(); return ["SENT", "FAILED", "SKIPPED", "NOT_ATTEMPTED"].includes(valueText) ? valueText as NotificationStatus : "NOT_ATTEMPTED"; }
function authHeaders(request: Request): Record<string, string> { const headers: Record<string, string> = {}; const authorization = request.headers.get("Authorization"); const origin = request.headers.get("Origin"); if (authorization) headers.Authorization = authorization; if (origin) headers.Origin = origin; return headers; }
function acceptsJsonContentType(value: string): boolean { const mediaType = value.split(";", 1)[0].trim().toLowerCase(); return !mediaType || mediaType === "application/json" || mediaType === "text/plain" || mediaType === "text/json" || mediaType.endsWith("+json"); }

function clientForRequest(request: Request): { client: Client } | Response {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(request, { error: "Authentication required." }, 401);
  const client = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
  client.auth.setToken(token);
  return { client };
}
async function authenticate(request: Request): Promise<{ client: Client; user: JsonRecord } | Response> {
  const context = clientForRequest(request);
  if (context instanceof Response) return context;
  try {
    const user = await context.client.auth.me();
    const record = user && typeof user === "object" ? user as JsonRecord : {};
    if (!normalizeEmail(record.email)) return json(request, { error: "Authentication required." }, 401);
    return { client: context.client, user: record };
  } catch { return json(request, { error: "Authentication required." }, 401); }
}
function serviceClient(): Client {
  const key = Deno.env.get("SUPERDEV_SERVICE_ROLE_KEY");
  if (!key) throw new Error("The protected billing service is not configured.");
  const client = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
  client.auth.setToken(key);
  return client;
}
async function readBody(request: Request): Promise<JsonRecord> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_REQUEST_BYTES) throw new InputError("The request is too large.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BYTES) throw new InputError("The request is too large.");
  if (!bytes.byteLength) return {};
  const raw = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new InputError("The request body must contain valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("The request body must be a JSON object.");
  return value as JsonRecord;
}
async function settings(client: Client): Promise<JsonRecord> { const rows = await client.entities.ManualPaymentSettings.list("-updated_at", 2) as JsonRecord[]; return { ...DEFAULT_SETTINGS, ...(Array.isArray(rows) ? rows[0] || {} : {}) }; }
async function cryptoOptions(client: Client): Promise<JsonRecord[]> { const rows = await client.entities.ManualCryptoOption.list("display_order", 100) as JsonRecord[]; return Array.isArray(rows) ? rows : []; }
function configured(value: unknown, max = 2_000): string { return text(value, max); }
function roundNgn(value: number): number { return Math.max(100, Math.round(value / 100) * 100); }
function buildOptions(config: JsonRecord, cryptoRows: JsonRecord[]) {
  const methods: JsonRecord[] = [];
  const unavailable: JsonRecord[] = [];
  const unavailableMethod = (id: string, label: string, reason: string) => unavailable.push({ id, label, reason });
  if (config.nigeria_enabled === true) {
    const rate = numberValue(config.nigeria_ngn_rate) || 0;
    const bank = { bank_name: configured(config.nigeria_bank_name), account_name: configured(config.nigeria_account_name), account_number: configured(config.nigeria_account_number), instructions: configured(config.nigeria_instructions) };
    if (rate <= 0) unavailableMethod("NIGERIA_BANK_TRANSFER", "Nigeria Bank Transfer", "This payment destination is temporarily unavailable because its rate is not ready.");
    else if (!bank.bank_name || !bank.account_name || !bank.account_number) unavailableMethod("NIGERIA_BANK_TRANSFER", "Nigeria Bank Transfer", "This payment destination is temporarily unavailable.");
    else methods.push({ id: "NIGERIA_BANK_TRANSFER", label: "Nigeria Bank Transfer", country: "NG", expected_amount: roundNgn(BASE_PRICE_USD * rate), expected_currency: "NGN", exchange_rate: rate, exchange_rate_mode: "MANUAL", exchange_rate_timestamp: configured(config.nigeria_rate_timestamp), bank });
  }
  if (config.uk_enabled === true) {
    const rate = numberValue(config.uk_gbp_rate) || 0;
    const bank = { account_holder_name: configured(config.uk_account_holder_name), bank_name: configured(config.uk_bank_name), account_number: configured(config.uk_account_number), sort_code: configured(config.uk_sort_code), iban: configured(config.uk_iban), bic_swift: configured(config.uk_bic_swift), bank_address: configured(config.uk_bank_address), account_holder_address: configured(config.uk_account_holder_address), instructions: configured(config.uk_instructions) };
    if (rate <= 0) unavailableMethod("UK_BANK_TRANSFER", "UK Bank Transfer", "This payment destination is temporarily unavailable because its rate is not ready.");
    else if (!bank.account_holder_name || !bank.bank_name || (!bank.account_number && !bank.iban)) unavailableMethod("UK_BANK_TRANSFER", "UK Bank Transfer", "This payment destination is temporarily unavailable.");
    else methods.push({ id: "UK_BANK_TRANSFER", label: "UK Bank Transfer", country: "UK", expected_amount: Number((BASE_PRICE_USD * rate).toFixed(2)), expected_currency: "GBP", exchange_rate: rate, exchange_rate_mode: "MANUAL", exchange_rate_timestamp: configured(config.uk_rate_timestamp), bank });
  }
  if (config.usa_enabled === true) {
    const bank = { account_holder_name: configured(config.usa_account_holder_name), bank_name: configured(config.usa_bank_name), account_number: configured(config.usa_account_number), routing_number: configured(config.usa_routing_number), bank_address: configured(config.usa_bank_address), account_holder_address: configured(config.usa_account_holder_address), instructions: configured(config.usa_instructions) };
    if (!bank.account_holder_name || !bank.bank_name || !bank.account_number || !bank.routing_number) unavailableMethod("USA_BANK_TRANSFER", "USA Bank Transfer", "The administrator has not finished the receiving account details.");
    else methods.push({ id: "USA_BANK_TRANSFER", label: "USA Bank Transfer", country: "US", expected_amount: USA_PRICE_USD, expected_currency: "USD", exchange_rate: 0, exchange_rate_mode: "NONE", exchange_rate_timestamp: "", bank });
  }
  const enabledCrypto = cryptoRows.filter((row) => row.enabled === true && configured(row.name) && configured(row.network) && configured(row.wallet_address)).map((row) => ({ id: text(row.id, 120), name: configured(row.name), network: configured(row.network), wallet_address: configured(row.wallet_address, 512), instructions: configured(row.instructions, 2_000) }));
  if (enabledCrypto.length) methods.push({ id: "CRYPTO", label: "Cryptocurrency", country: "CRYPTO", expected_amount: BASE_PRICE_USD, expected_currency: "USD", exchange_rate: 0, exchange_rate_mode: "NONE", exchange_rate_timestamp: "", crypto_options: enabledCrypto });
  else if (cryptoRows.some((row) => row.enabled === true)) unavailableMethod("CRYPTO", "Cryptocurrency", "This payment destination is temporarily unavailable.");
  return { base_amount_usd: BASE_PRICE_USD, methods, unavailable_methods: unavailable };
}
function escapeHtml(value: unknown): string { return text(value, 2_000).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function methodLabel(method: string): string { return ({ NIGERIA_BANK_TRANSFER: "Nigeria Bank Transfer", UK_BANK_TRANSFER: "UK Bank Transfer", USA_BANK_TRANSFER: "USA Bank Transfer", CRYPTO: "Cryptocurrency" } as Record<string, string>)[method] || "Manual payment"; }
function emailDate(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(date) : "Not recorded"; }
function messagePlainText(value: unknown, max = MESSAGE_BODY_MAX): string { const source = typeof value === "string" ? value : ""; return source.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ").slice(0, max).trim(); }
function messageSubject(value: unknown, fallback: string): string { const source = typeof value === "string" ? value : ""; return source.replace(/[\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim().slice(0, MESSAGE_SUBJECT_MAX) || fallback; }
function safeMessageTemplates(row?: JsonRecord): MessageTemplates { return { signup_subject: messageSubject(row?.signup_subject, DEFAULT_MESSAGE_TEMPLATES.signup_subject), signup_body: messagePlainText(row?.signup_body) || DEFAULT_MESSAGE_TEMPLATES.signup_body, payment_submitted_subject: messageSubject(row?.payment_submitted_subject, DEFAULT_MESSAGE_TEMPLATES.payment_submitted_subject), payment_submitted_body: messagePlainText(row?.payment_submitted_body) || DEFAULT_MESSAGE_TEMPLATES.payment_submitted_body, payment_approved_subject: messageSubject(row?.payment_approved_subject, DEFAULT_MESSAGE_TEMPLATES.payment_approved_subject), payment_approved_body: messagePlainText(row?.payment_approved_body) || DEFAULT_MESSAGE_TEMPLATES.payment_approved_body }; }
async function getMessageTemplates(client: Client): Promise<MessageTemplates> { try { const rows = await client.entities.AdminMessageTemplates.filter({ settings_key: "default" }, "-updated_at", 20) as JsonRecord[]; const selected = Array.isArray(rows) ? rows.find((row) => Boolean(row && text(row.id, 160))) : undefined; return safeMessageTemplates(selected); } catch { console.error("manual-payments message template lookup failed"); return safeMessageTemplates(); } }
function escapeMessageHtml(value: unknown): string { const source = typeof value === "string" ? value : value == null ? "" : String(value); return source.replace(/\u0000/g, "").replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;"); }
function renderMessageSubject(template: string, context: Record<string, string>): string { const rendered = messageSubject(template, "").replace(MESSAGE_PLACEHOLDER_PATTERN, (_token, key: string) => { const normalizedKey = key.trim().toLowerCase(); return MESSAGE_PLACEHOLDERS.has(normalizedKey) ? messageSubject(context[normalizedKey] || "", "") : ""; }); return messageSubject(rendered, ""); }
function renderMessageBody(template: string, context: Record<string, string>): string { const source = messagePlainText(template); let cursor = 0; let rendered = ""; source.replace(MESSAGE_PLACEHOLDER_PATTERN, (token: string, key: string, offset: number) => { rendered += escapeMessageHtml(source.slice(cursor, offset)); const normalizedKey = key.trim().toLowerCase(); rendered += MESSAGE_PLACEHOLDERS.has(normalizedKey) ? escapeMessageHtml(context[normalizedKey] || "") : ""; cursor = offset + token.length; return token; }); rendered += escapeMessageHtml(source.slice(cursor)); return rendered.replace(/\n/g, "<br />"); }
function wrappedMessageHtml(body: string): string { return `<div style="font-family:Arial,sans-serif;color:#1f2933;line-height:1.65;max-width:640px"><div>${body}</div><p style="margin:24px 0 0;color:#667085;font-size:12px">Verbatim Desk</p></div>`; }
function accountFirstName(user: JsonRecord, ownerEmail: string): string { const name = text(user.full_name ?? user.name, 160); return name.split(/\s+/)[0] || ownerEmail.split("@", 1)[0] || "there"; }

async function writeAudit(client: Client, event: JsonRecord) {
  try {
    await client.entities.ManualPaymentAuditEvent.create({ action: text(event.action, 64), actor_email: normalizeEmail(event.actor_email) || "system", subject_email: normalizeEmail(event.subject_email), related_payment_id: text(event.related_payment_id, 120), related_subscription_id: text(event.related_subscription_id, 120), summary: text(event.summary, 500), metadata_text: text(event.metadata_text, 500) });
  } catch { console.error("manual-payments audit write failed", text(event.action, 64)); }
}
async function syncPendingAccess(client: Client, ownerEmail: string, paymentId: string, submittedAt: string) {
  try {
    const rows = await client.entities.UserAccessProfile.filter({ owner_email: ownerEmail }, "-updated_at", 5) as JsonRecord[];
    const profile = Array.isArray(rows) ? rows[0] : undefined;
    if (!profile) return;
    const now = Date.now();
    const premiumEnd = Date.parse(text(profile.premium_end, 80));
    const trialEnd = Date.parse(text(profile.trial_end, 80));
    const activePremium = Number.isFinite(premiumEnd) && premiumEnd > now;
    const activeTrial = Number.isFinite(trialEnd) && trialEnd > now;
    const lifecycleStatus = profile.manual_restricted === true ? "ADMIN_RESTRICTED" : activePremium ? "PREMIUM_ACTIVE" : activeTrial ? "TRIALING" : "PAYMENT_PENDING";
    await client.entities.UserAccessProfile.update(text(profile.id, 160), { pending_payment_id: paymentId, pending_payment_submitted_at: submittedAt, lifecycle_status: lifecycleStatus });
  } catch (error) { console.error("manual-payments access state sync failed", error instanceof Error ? error.message : "unknown error"); }
}
async function writeAccessAudit(client: Client, ownerEmail: string, userId: string, paymentId: string, nowIso: string) {
  const dedupeKey = `PAYMENT_SUBMITTED:${paymentId}`;
  try {
    const existing = await client.entities.UserAccessAuditEvent.filter({ dedupe_key: dedupeKey }, "-created_at", 1) as JsonRecord[];
    if (Array.isArray(existing) && existing.length) return;
    await client.entities.UserAccessAuditEvent.create({ target_user_email: ownerEmail, target_user_id: userId, actor_email: ownerEmail, action: "PAYMENT_SUBMITTED", occurred_at: nowIso, related_payment_id: paymentId, related_subscription_id: "", dedupe_key: dedupeKey, note: "Payment proof submitted for verification." });
  } catch (error) { console.error("manual-payments access audit failed", error instanceof Error ? error.message : "unknown error"); }
}
async function sendNotice(client: Client, request: Request, to: string, subject: string, bodyHtml: string): Promise<{ status: NotificationStatus; message: string }> {
  const headers = authHeaders(request);
  if (!headers.Authorization || !headers.Origin) return { status: "SKIPPED", message: "Email notice was not attempted for this request." };
  try {
    await client.integrations.core.sendEmail({ to, subject, body_html: bodyHtml, from_name: "Verbatim Desk", reply_to: ADMIN_EMAIL }, { headers });
    return { status: "SENT", message: "Email notice sent." };
  } catch { console.error("manual-payments notification failed"); return { status: "FAILED", message: "Email notice could not be sent." }; }
}
function notificationPatch(audience: "admin" | "payer", outcome: { status: NotificationStatus; message: string }) {
  const prefix = audience === "admin" ? "admin_notification" : "payer_notification";
  return { [`${prefix}_status`]: outcome.status, [`${prefix}_at`]: new Date().toISOString(), [`${prefix}_error`]: outcome.status === "FAILED" ? "Email notice could not be sent." : "" };
}
async function processNotice(storage: Client, integration: Client, request: Request, paymentId: string, subjectEmail: string, actorEmail: string, audience: "admin" | "payer", subject: string, bodyHtml: string) {
  const outcome = await sendNotice(integration, request, subjectEmail, subject, bodyHtml);
  const patch = notificationPatch(audience, outcome);
  try { await storage.entities.ManualPaymentSubmission.update(paymentId, patch); } catch { console.error("manual-payments notification status update failed"); }
  await writeAudit(storage, { action: "NOTIFICATION_ATTEMPTED", actor_email: actorEmail, subject_email: subjectEmail, related_payment_id: paymentId, summary: `${audience === "admin" ? "Administrator" : "Payer"} email notification ${outcome.status.toLowerCase()}.`, metadata_text: `channel=email; audience=${audience}; status=${outcome.status}` });
  return { outcome, patch };
}
function safeSubmission(row: JsonRecord): JsonRecord {
  const payerStatus = notificationStatus(row.payer_notification_status);
  return { id: text(row.id, 120), payment_method: text(row.payment_method, 60), country: text(row.country, 30), claimed_amount: numberValue(row.claimed_amount) || 0, claimed_currency: text(row.claimed_currency, 16), expected_amount: numberValue(row.expected_amount) || 0, expected_currency: text(row.expected_currency, 16), exchange_rate: numberValue(row.exchange_rate) || 0, exchange_rate_mode: text(row.exchange_rate_mode, 20), exchange_rate_timestamp: text(row.exchange_rate_timestamp, 80), transaction_reference: text(row.transaction_reference, 160), payment_date: text(row.payment_date, 80), submitted_at: text(row.created_at, 80), status: text(row.status, 20), premium_start: text(row.premium_start, 80), premium_end: text(row.premium_end, 80), crypto_name: text(row.crypto_name, 80), crypto_network: text(row.crypto_network, 120), notification_status: payerStatus, notification_attempted_at: text(row.payer_notification_at, 80), notification_message: payerStatus === "SENT" ? "A decision notice was sent to your sign-in email." : payerStatus === "FAILED" ? "The decision was saved, but email delivery was unavailable." : payerStatus === "SKIPPED" ? "The decision was saved. No email notice was sent." : "" };
}
function safeSubscription(row: JsonRecord | undefined, now: number): JsonRecord {
  if (!row) return { status: "NONE", premium_start: "", premium_end: "", latest_payment_id: "", payment_method: "", amount: 0, currency: "" };
  const end = Date.parse(text(row.premium_end, 80));
  const stored = text(row.status, 20).toUpperCase();
  const status = Number.isFinite(end) && end > now ? "ACTIVE" : stored === "NONE" ? "NONE" : "EXPIRED";
  return { status, premium_start: text(row.premium_start, 80), premium_end: text(row.premium_end, 80), latest_payment_id: text(row.latest_payment_id, 120), payment_method: text(row.payment_method, 60), amount: numberValue(row.amount) || 0, currency: text(row.currency, 16) };
}
async function ownStatus(client: Client, ownerEmail: string): Promise<JsonRecord> {
  const [subscriptions, submissions] = await Promise.all([client.entities.ManualSubscription.filter({ owner_email: ownerEmail }, "-updated_at", 5) as Promise<JsonRecord[]>, client.entities.ManualPaymentSubmission.filter({ owner_email: ownerEmail }, "-created_at", 25) as Promise<JsonRecord[]>]);
  const subscription = safeSubscription(Array.isArray(subscriptions) ? subscriptions[0] : undefined, Date.now());
  const summaries = (Array.isArray(submissions) ? submissions : []).map(safeSubmission);
  if (subscription.status !== "ACTIVE" && summaries.some((item) => item.status === "PENDING")) subscription.status = "PENDING";
  return { subscription, submissions: summaries };
}
function canonicalMime(value: unknown): string { const mime = text(value, 80).toLowerCase(); return mime === "image/jpg" ? "image/jpeg" : mime; }
function hasImageSignature(bytes: Uint8Array, mime: string): boolean { if (mime === "image/jpeg") return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff; if (mime === "image/png") return bytes.length > 8 && bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]); if (mime === "image/webp") return bytes.length > 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"; return false; }
function receiptPayload(value: unknown): { data: string; mime: string; size: number; filename: string } {
  if (!value || typeof value !== "object") throw new InputError("A payment receipt image is required.");
  const receipt = value as JsonRecord; const mime = canonicalMime(receipt.mime_type ?? receipt.mimeType); if (!ACCEPTED_MIME.has(mime)) throw new InputError("Use a JPG, JPEG, PNG, or WEBP receipt image.");
  const source = text(receipt.data, MAX_RECEIPT_DATA_CHARS + 100); const prefix = `data:${mime};base64,`; if (!source.startsWith(prefix)) throw new InputError("The receipt image format is invalid.");
  const encoded = source.slice(prefix.length).replace(/\s/g, ""); if (!encoded || encoded.length > MAX_RECEIPT_DATA_CHARS || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new InputError("The receipt image is invalid or too large.");
  let binary = ""; try { binary = atob(encoded); } catch { throw new InputError("The receipt image is invalid."); }
  if (!binary.length || binary.length > MAX_RECEIPT_BYTES) throw new InputError("Receipt images must be smaller than 2 MB after preparation.");
  const bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (!hasImageSignature(bytes, mime)) throw new InputError("The receipt image content does not match its file type.");
  return { data: `${prefix}${encoded}`, mime, size: bytes.byteLength, filename: text(receipt.original_filename ?? receipt.filename, 120) || "payment-receipt.jpg" };
}
function validPaymentDate(value: unknown): string { const date = new Date(text(value, 80)); const time = date.getTime(); if (!Number.isFinite(time) || time > Date.now() + 5 * 60_000 || time < Date.now() - 366 * 24 * 60 * 60_000) throw new InputError("Enter a valid payment date within the last year."); return date.toISOString(); }

async function submit(storage: Client, integration: Client, request: Request, user: JsonRecord, body: JsonRecord) {
  const owner = normalizeEmail(user.email); const config = await settings(storage); const cryptoRows = await cryptoOptions(storage); const available = buildOptions(config, cryptoRows); const method = text(body.method, 60); const selected = available.methods.find((item) => item.id === method) as JsonRecord | undefined;
  if (!selected) throw new InputError("That payment method is not currently available.");
  const cryptoId = method === "CRYPTO" ? text(body.crypto_option_id, 120) : ""; const selectedCrypto = method === "CRYPTO" ? (selected.crypto_options as JsonRecord[]).find((item) => item.id === cryptoId) : undefined; if (method === "CRYPTO" && !selectedCrypto) throw new InputError("Choose one of the enabled cryptocurrency destinations.");
  const claimedAmount = numberValue(body.claimed_amount ?? body.amount_paid); if (claimedAmount == null || claimedAmount <= 0 || claimedAmount > 1_000_000_000) throw new InputError("Enter a valid amount paid.");
  const expectedCurrency = text(selected.expected_currency, 16); const claimedCurrency = text(body.claimed_currency ?? body.currency, 16).toUpperCase(); if (!claimedCurrency || !/^[A-Z0-9]{2,12}$/.test(claimedCurrency)) throw new InputError("Enter the currency or crypto ticker used for payment."); if (method !== "CRYPTO" && claimedCurrency !== expectedCurrency) throw new InputError(`This method requires a ${expectedCurrency} payment.`);
  const paymentDate = validPaymentDate(body.payment_date); const receipt = receiptPayload(body.receipt); const reference = text(body.transaction_reference ?? body.reference, 160); const note = text(body.note, 2_000);
  const receiptRow = await storage.entities.ManualPaymentReceipt.create({ payment_id: "", owner_email: owner, original_filename: receipt.filename, mime_type: receipt.mime, payload_data: receipt.data, byte_size: receipt.size }) as JsonRecord; const receiptId = text(receiptRow.id, 120); if (!receiptId) throw new Error("The receipt could not be saved securely.");
  let paymentId = "";
  try {
    const created = await storage.entities.ManualPaymentSubmission.create({ owner_email: owner, country: text(selected.country, 30), payment_method: method, crypto_option_id: cryptoId, crypto_name: selectedCrypto ? text(selectedCrypto.name, 80) : "", crypto_network: selectedCrypto ? text(selectedCrypto.network, 120) : "", base_amount_usd: BASE_PRICE_USD, claimed_amount: claimedAmount, claimed_currency: claimedCurrency, expected_amount: numberValue(selected.expected_amount) || BASE_PRICE_USD, expected_currency: expectedCurrency, exchange_rate: numberValue(selected.exchange_rate) || 0, exchange_rate_mode: text(selected.exchange_rate_mode, 20), exchange_rate_timestamp: text(selected.exchange_rate_timestamp, 80), transaction_reference: reference, payment_date: paymentDate, note, receipt_id: receiptId, status: "PENDING", admin_decision: "", admin_reason: "", verification_at: "", premium_start: "", premium_end: "", admin_notification_status: "NOT_ATTEMPTED", admin_notification_at: "", admin_notification_error: "", payer_notification_status: "NOT_ATTEMPTED", payer_notification_at: "", payer_notification_error: "" }) as JsonRecord;
    paymentId = text(created.id, 120); if (!paymentId) throw new Error("The payment submission could not be saved."); await storage.entities.ManualPaymentReceipt.update(receiptId, { payment_id: paymentId });
    const submittedAt = text(created.created_at, 80) || new Date().toISOString();
    await syncPendingAccess(storage, owner, paymentId, submittedAt);
    await writeAccessAudit(storage, owner, text(user.id, 160), paymentId, submittedAt);
    await writeAudit(storage, { action: "SUBMISSION_CREATED", actor_email: owner, subject_email: owner, related_payment_id: paymentId, summary: "New manual Premium payment submission created.", metadata_text: `method=${method}; country=${text(selected.country, 30)}; currency=${claimedCurrency}` });
    await processNotice(storage, integration, request, paymentId, ADMIN_EMAIL, owner, "admin", "New Premium payment awaiting verification", `<h1>New Premium payment submission</h1><p>A user submitted a manual payment for private review in Verbatim Desk.</p><ul><li>Account: ${escapeHtml(owner)}</li><li>Method: ${escapeHtml(methodLabel(method))}</li><li>Payment ID: ${escapeHtml(paymentId)}</li></ul><p>Open the private Admin Panel to inspect the receipt and verify that funds arrived.</p>`);
    const templates = await getMessageTemplates(storage);
    const context: Record<string, string> = { first_name: accountFirstName(user, owner), email: owner, payment_id: paymentId, payment_method: methodLabel(method), amount: String(claimedAmount), currency: claimedCurrency, premium_start: "", premium_end: "" };
    const payerNotice = await processNotice(storage, integration, request, paymentId, owner, owner, "payer", renderMessageSubject(templates.payment_submitted_subject, context), wrappedMessageHtml(renderMessageBody(templates.payment_submitted_body, context)));
    const userMessage = payerNotice.outcome.status === "SENT"
      ? "Payment submitted. A confirmation was sent to your sign-in email."
      : payerNotice.outcome.status === "FAILED"
      ? "Payment submitted. Email delivery was unavailable, but your evidence is saved."
      : "Payment submitted. Your evidence is saved. No email notice was sent.";
    const own = await ownStatus(storage, owner);
    return { ok: true, status: "PENDING", payment_id: paymentId, notification: { status: payerNotice.outcome.status, message: userMessage }, ...own };
  } catch (error) {
    if (paymentId) { try { await storage.entities.ManualPaymentSubmission.delete(paymentId); } catch { /* preserve original error */ } }
    try { await storage.entities.ManualPaymentReceipt.delete(receiptId); } catch { /* preserve original error */ }
    throw error;
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return json(request, {}, 204);
  if (request.method !== "POST") return json(request, { error: "Use POST for billing actions." }, 405);
  const contentType = request.headers.get("Content-Type") || "";
  if (!acceptsJsonContentType(contentType)) return json(request, { error: "This endpoint accepts JSON requests only." }, 415);
  const auth = await authenticate(request); if (auth instanceof Response) return auth;
  let body: JsonRecord; try { body = await readBody(request); } catch (error) { return json(request, { error: error instanceof Error ? error.message : "The request body is invalid." }, 400); }
  const action = text(body.action, 40);
  try {
    const protectedClient = serviceClient();
    if (action === "options") { const [config, cryptoRows] = await Promise.all([settings(protectedClient), cryptoOptions(protectedClient)]); return json(request, buildOptions(config, cryptoRows)); }
    if (action === "status") return json(request, await ownStatus(protectedClient, normalizeEmail(auth.user.email)));
    if (action === "submit") return json(request, await submit(protectedClient, auth.client, request, auth.user, body), 201);
    return json(request, { error: "Unknown billing action." }, 400);
  } catch (error) {
    const input = error instanceof InputError; console.error("manual-payments failed", action, input ? error.message : "unexpected billing error"); return json(request, { error: input ? error.message : "The billing action could not be completed." }, input ? 400 : 500);
  }
});
