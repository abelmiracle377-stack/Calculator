import { createSuperdevClient } from "npm:@superdevhq/client@0.1.56";

type JsonRecord = Record<string, unknown>;
type Client = ReturnType<typeof createSuperdevClient>;
type AuthContext = { client: Client; user: JsonRecord; email: string };
type SafeResult<T> = { ok: true; value: T } | { ok: false; timedOut: boolean };
type BillingSnapshot = {
  subscription?: JsonRecord;
  pending?: JsonRecord;
  subscriptionAvailable: boolean;
  pendingAvailable: boolean;
};
type TransitionResult = "written" | "exists" | "unchanged" | "failed";

const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const ALLOWED_ORIGIN = "https://www.buildy.ai";
const PREVIEW_ORIGIN_PATTERN = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:superdev\.run|buildy\.show)$/i;
const AUTH_TIMEOUT_MS = 5_000;
const PROFILE_TIMEOUT_MS = 4_000;
const SECONDARY_TIMEOUT_MS = 2_500;
const PENDING_LOOKUP_TIMEOUT_MS = 1_000;
const AUDIT_TIMEOUT_MS = 2_000;
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

function messagePlainText(value: unknown, max = MESSAGE_BODY_MAX): string {
  const source = typeof value === "string" ? value : "";
  return source.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ").slice(0, max).trim();
}
function messageSubject(value: unknown, fallback: string): string {
  const source = typeof value === "string" ? value : "";
  return source.replace(/[\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim().slice(0, MESSAGE_SUBJECT_MAX) || fallback;
}
function safeMessageTemplates(row?: JsonRecord): MessageTemplates {
  return {
    signup_subject: messageSubject(row?.signup_subject, DEFAULT_MESSAGE_TEMPLATES.signup_subject),
    signup_body: messagePlainText(row?.signup_body) || DEFAULT_MESSAGE_TEMPLATES.signup_body,
    payment_submitted_subject: messageSubject(row?.payment_submitted_subject, DEFAULT_MESSAGE_TEMPLATES.payment_submitted_subject),
    payment_submitted_body: messagePlainText(row?.payment_submitted_body) || DEFAULT_MESSAGE_TEMPLATES.payment_submitted_body,
    payment_approved_subject: messageSubject(row?.payment_approved_subject, DEFAULT_MESSAGE_TEMPLATES.payment_approved_subject),
    payment_approved_body: messagePlainText(row?.payment_approved_body) || DEFAULT_MESSAGE_TEMPLATES.payment_approved_body,
  };
}
function escapeMessageHtml(value: unknown): string {
  const source = typeof value === "string" ? value : value == null ? "" : String(value);
  return source.replace(/\u0000/g, "").replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}
function renderMessageSubject(template: string, context: Record<string, string>): string {
  const rendered = messageSubject(template, "").replace(MESSAGE_PLACEHOLDER_PATTERN, (_token, key: string) => {
    const normalizedKey = key.trim().toLowerCase();
    return MESSAGE_PLACEHOLDERS.has(normalizedKey) ? messageSubject(context[normalizedKey] || "", "") : "";
  });
  return messageSubject(rendered, "");
}
function renderMessageBody(template: string, context: Record<string, string>): string {
  const source = messagePlainText(template);
  let cursor = 0;
  let rendered = "";
  source.replace(MESSAGE_PLACEHOLDER_PATTERN, (token: string, key: string, offset: number) => {
    rendered += escapeMessageHtml(source.slice(cursor, offset));
    const normalizedKey = key.trim().toLowerCase();
    rendered += MESSAGE_PLACEHOLDERS.has(normalizedKey) ? escapeMessageHtml(context[normalizedKey] || "") : "";
    cursor = offset + token.length;
    return token;
  });
  rendered += escapeMessageHtml(source.slice(cursor));
  return rendered.replace(/\n/g, "<br />");
}
function wrappedMessageHtml(body: string): string {
  return `<div style="font-family:Arial,sans-serif;color:#1f2933;line-height:1.65;max-width:640px"><div>${body}</div><p style="margin:24px 0 0;color:#667085;font-size:12px">Verbatim Desk</p></div>`;
}

function text(value: unknown, max = 512): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001F]/g, " ").trim().slice(0, max)
    : "";
}
function email(value: unknown): string { return text(value, 320).toLowerCase(); }
function timestamp(value: unknown): number | undefined {
  const parsed = Date.parse(text(value, 80));
  return Number.isFinite(parsed) ? parsed : undefined;
}
function iso(value: number): string { return new Date(value).toISOString(); }
function safeIp(value: string): string {
  const candidate = value.trim().replace(/^"|"$/g, "");
  if (!candidate || candidate.length > 45 || /[^0-9a-f:.]/i.test(candidate)) return "";
  if (candidate.includes(".")) {
    const parts = candidate.split(".");
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return "";
  } else if (!candidate.includes(":")) return "";
  return candidate;
}
function trustedIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0] || "";
  for (const value of [request.headers.get("cf-connecting-ip") || "", request.headers.get("x-real-ip") || "", forwarded]) {
    const ip = safeIp(value);
    if (ip) return ip;
  }
  return "";
}
function isAllowedOrigin(origin: string): boolean {
  return origin === ALLOWED_ORIGIN || PREVIEW_ORIGIN_PATTERN.test(origin);
}
function authHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const authorization = request.headers.get("Authorization");
  const origin = request.headers.get("Origin");
  if (authorization) headers.Authorization = authorization;
  if (origin) headers.Origin = origin;
  return headers;
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
function serviceClient(): Client {
  const key = Deno.env.get("SUPERDEV_SERVICE_ROLE_KEY");
  if (!key) throw new Error("Access service is not configured.");
  const client = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
  client.auth.setToken(key);
  return client;
}

function safeCall<T>(label: string, operation: () => Promise<T>, timeoutMs: number): Promise<SafeResult<T>> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveResult: (result: SafeResult<T>) => void = () => undefined;
  const result = new Promise<SafeResult<T>>((resolve) => { resolveResult = resolve; });
  const finish = (value: SafeResult<T>) => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    resolveResult(value);
  };
  const pending = Promise.resolve().then(operation);
  void pending.then(
    (value) => finish({ ok: true, value }),
    () => {
      console.error("access-status operation failed", label);
      finish({ ok: false, timedOut: false });
    },
  );
  timer = setTimeout(() => {
    if (settled) return;
    console.error("access-status operation timed out", label);
    finish({ ok: false, timedOut: true });
  }, timeoutMs);
  return result;
}

async function optionalBillingCall<T>(label: string, operation: () => Promise<T>, timeoutMs: number): Promise<SafeResult<T>> {
  try {
    return await safeCall(label, operation, timeoutMs);
  } catch (error) {
    console.error("access-status optional billing operation failed", label, error instanceof Error ? error.message : "unknown error");
    return { ok: false, timedOut: false };
  }
}

async function authenticate(request: Request): Promise<AuthContext | Response> {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json(request, { error: "Authentication required." }, 401);
  const client = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
  client.auth.setToken(token);
  const authenticated = await safeCall("authentication", () => client.auth.me() as Promise<JsonRecord>, AUTH_TIMEOUT_MS);
  if (!authenticated.ok) return json(request, { error: authenticated.timedOut ? "Authentication could not be verified right now." : "Authentication required." }, authenticated.timedOut ? 503 : 401);
  const user = authenticated.value;
  const ownerEmail = email(user?.email);
  if (!ownerEmail) return json(request, { error: "Authentication required." }, 401);
  return { client, user, email: ownerEmail };
}

async function findProfile(client: Client, ownerEmail: string): Promise<JsonRecord | undefined> {
  const rows = await client.entities.UserAccessProfile.filter({ owner_email: ownerEmail }, undefined, 1) as JsonRecord[];
  return Array.isArray(rows) ? rows.find((row) => Boolean(row && text(row.id, 160))) : undefined;
}
async function getMessageTemplates(client: Client): Promise<MessageTemplates> {
  try {
    const rows = await client.entities.AdminMessageTemplates.filter({ settings_key: "default" }, "-updated_at", 20) as JsonRecord[];
    const selected = Array.isArray(rows) ? rows.find((row) => Boolean(row && text(row.id, 160))) : undefined;
    return safeMessageTemplates(selected);
  } catch {
    console.error("access-status message template lookup failed");
    return safeMessageTemplates();
  }
}
function accountFirstName(user: JsonRecord, ownerEmail: string): string {
  const name = text(user.full_name ?? user.name, 160);
  return name.split(/\s+/)[0] || ownerEmail.split("@", 1)[0] || "there";
}
async function sendSignupNotification(service: Client, integration: Client, request: Request, user: JsonRecord, ownerEmail: string, profile: JsonRecord): Promise<void> {
  const profileId = text(profile.id, 160);
  if (!profileId) return;
  try {
    await safeCall("signup notification marker start", () => service.entities.UserAccessProfile.update(profileId, { signup_notification_status: "SENDING", signup_notification_at: "", signup_notification_error: "" }) as Promise<JsonRecord>, PROFILE_TIMEOUT_MS);
    const templates = await getMessageTemplates(service);
    const context: Record<string, string> = { first_name: accountFirstName(user, ownerEmail), email: ownerEmail, payment_id: "", payment_method: "", amount: "", currency: "", premium_start: "", premium_end: "" };
    const subject = renderMessageSubject(templates.signup_subject, context);
    const bodyHtml = wrappedMessageHtml(renderMessageBody(templates.signup_body, context));
    const headers = authHeaders(request);
    let status: "SENT" | "FAILED" | "SKIPPED" = "FAILED";
    let errorMessage = "";
    if (!headers.Authorization || !headers.Origin) {
      status = "SKIPPED";
      errorMessage = "Email notice was not attempted for this request.";
    } else {
      try {
        await integration.integrations.core.sendEmail({ to: ownerEmail, subject, body_html: bodyHtml, from_name: "Verbatim Desk", reply_to: "abelmiracle377@gmail.com" }, { headers });
        status = "SENT";
      } catch {
        console.error("access-status signup notification failed");
        errorMessage = "Email notice could not be sent.";
      }
    }
    await safeCall("signup notification marker update", () => service.entities.UserAccessProfile.update(profileId, { signup_notification_status: status, signup_notification_at: new Date().toISOString(), signup_notification_error: errorMessage }) as Promise<JsonRecord>, PROFILE_TIMEOUT_MS);
  } catch {
    console.error("access-status signup notification failed");
    await safeCall("signup notification failure marker", () => service.entities.UserAccessProfile.update(profileId, { signup_notification_status: "FAILED", signup_notification_at: new Date().toISOString(), signup_notification_error: "Email notice could not be sent." }) as Promise<JsonRecord>, PROFILE_TIMEOUT_MS);
  }
}
function accountStart(user: JsonRecord, profile?: JsonRecord): { start: number; source: string } {
  const existing = timestamp(profile?.trial_start);
  if (existing != null) return { start: existing, source: text(profile?.trial_start_source, 64) || "account_created_at" };
  const created = timestamp(user.created_at ?? user.createdAt);
  if (created != null && created <= Date.now() + 5 * 60_000) return { start: created, source: "account_created_at" };
  return { start: Date.now(), source: "first_authenticated_at" };
}
async function ensureProfile(client: Client, user: JsonRecord, ownerEmail: string, ip: string, now: number): Promise<{ profile: JsonRecord; created: boolean }> {
  const initial = await safeCall("access profile lookup", () => findProfile(client, ownerEmail), PROFILE_TIMEOUT_MS);
  if (!initial.ok) throw new Error("Authoritative access profile unavailable.");
  if (initial.value) return { profile: initial.value, created: false };
  const start = accountStart(user);
  const data: JsonRecord = {
    owner_email: ownerEmail,
    lifecycle_status: "TRIALING",
    trial_start: iso(start.start),
    trial_end: iso(start.start + TRIAL_DURATION_MS),
    trial_start_source: start.source,
    premium_start: "",
    premium_end: "",
    premium_payment_id: "",
    premium_payment_method: "",
    manual_restricted: false,
    manual_restriction_reason: "",
    manual_restricted_at: "",
    manual_restricted_by: "",
    pending_payment_id: "",
    pending_payment_submitted_at: "",
    first_activity_at: iso(now),
    last_activity_at: iso(now),
    first_ip: ip,
    first_ip_at: ip ? iso(now) : "",
    last_ip: ip,
    last_ip_at: ip ? iso(now) : "",
    last_lifecycle_transition_at: "",
    last_lifecycle_transition_key: "",
    signup_notification_status: "NOT_ATTEMPTED",
    signup_notification_at: "",
    signup_notification_error: "",
  };
  const created = await safeCall("access profile creation", () => client.entities.UserAccessProfile.create(data) as Promise<JsonRecord>, PROFILE_TIMEOUT_MS);
  if (created.ok && created.value && text(created.value.id, 160)) return { profile: created.value, created: true };
  const raced = await safeCall("access profile retry lookup", () => findProfile(client, ownerEmail), PROFILE_TIMEOUT_MS);
  if (raced.ok && raced.value) return { profile: raced.value, created: false };
  throw new Error("Authoritative access profile unavailable.");
}

async function latestBilling(client: Client, ownerEmail: string, profile: JsonRecord, now: number): Promise<BillingSnapshot> {
  const storedStatus = text(profile.lifecycle_status, 40).toUpperCase();
  const profileHasAuthoritativeOutcome = profile.manual_restricted === true
    || storedStatus === "ADMIN_RESTRICTED"
    || (timestamp(profile.premium_end) ?? 0) > now
    || (timestamp(profile.trial_end) ?? 0) > now;
  const pendingResultPromise: Promise<SafeResult<JsonRecord[]>> = profileHasAuthoritativeOutcome
    ? Promise.resolve({ ok: false, timedOut: false })
    : optionalBillingCall("pending payment lookup", () => client.entities.ManualPaymentSubmission.filter({ owner_email: ownerEmail, status: "PENDING" }, "-created_at", 1) as Promise<JsonRecord[]>, PENDING_LOOKUP_TIMEOUT_MS);
  const [subscriptionResult, pendingResult] = await Promise.all([
    optionalBillingCall("subscription lookup", () => client.entities.ManualSubscription.filter({ owner_email: ownerEmail }, "-updated_at", 1) as Promise<JsonRecord[]>, SECONDARY_TIMEOUT_MS),
    pendingResultPromise,
  ]);
  const subscriptions = subscriptionResult.ok && Array.isArray(subscriptionResult.value) ? subscriptionResult.value : [];
  const payments = pendingResult.ok && Array.isArray(pendingResult.value) ? pendingResult.value : [];
  return {
    subscription: subscriptions[0],
    pending: payments[0],
    subscriptionAvailable: subscriptionResult.ok,
    pendingAvailable: pendingResult.ok,
  };
}

async function writeTransition(client: Client, profile: JsonRecord, ownerEmail: string, user: JsonRecord, status: string, key: string, nowIso: string, paymentId: string, subscriptionId: string): Promise<TransitionResult> {
  if (!key || key === text(profile.last_lifecycle_transition_key, 240)) return "unchanged";
  try {
    const existing = await client.entities.UserAccessAuditEvent.filter({ dedupe_key: key }, "-created_at", 1) as JsonRecord[];
    if (Array.isArray(existing) && existing.length) return "exists";
    const labels: Record<string, string> = { TRIALING: "TRIAL_STARTED", TRIAL_EXPIRED: "TRIAL_EXPIRED", PAYMENT_PENDING: "PAYMENT_PENDING", PREMIUM_ACTIVE: "PREMIUM_ACTIVE", PREMIUM_EXPIRED: "PREMIUM_EXPIRED", ADMIN_RESTRICTED: "ADMIN_RESTRICTED" };
    await client.entities.UserAccessAuditEvent.create({
      target_user_email: ownerEmail,
      target_user_id: text(user.id, 160),
      actor_email: "system",
      action: labels[status] || "ACCESS_STATUS_CHANGED",
      occurred_at: nowIso,
      related_payment_id: paymentId,
      related_subscription_id: subscriptionId,
      dedupe_key: key,
      note: `Access lifecycle changed to ${status}.`,
    });
    return "written";
  } catch {
    console.error("access-status transition audit failed");
    return "failed";
  }
}
async function persistTransition(client: Client, profile: JsonRecord, ownerEmail: string, user: JsonRecord, status: string, key: string, nowIso: string, paymentId: string, subscriptionId: string): Promise<void> {
  const audit = await safeCall("lifecycle audit", () => writeTransition(client, profile, ownerEmail, user, status, key, nowIso, paymentId, subscriptionId), AUDIT_TIMEOUT_MS);
  if (!audit.ok || (audit.value !== "written" && audit.value !== "exists")) return;
  const profileId = text(profile.id, 160);
  if (!profileId) return;
  await safeCall("lifecycle marker update", () => client.entities.UserAccessProfile.update(profileId, { last_lifecycle_transition_at: nowIso, last_lifecycle_transition_key: key }) as Promise<JsonRecord>, PROFILE_TIMEOUT_MS);
}

async function reconcile(client: Client, integration: Client, user: JsonRecord, ownerEmail: string, request: Request): Promise<JsonRecord> {
  const now = Date.now();
  const nowIso = iso(now);
  const ip = trustedIp(request);
  const ensured = await ensureProfile(client, user, ownerEmail, ip, now);
  const profile = ensured.profile;
  const billing = await latestBilling(client, ownerEmail, profile, now);
  const subscription = billing.subscription;
  const storedStatus = text(profile.lifecycle_status, 40).toUpperCase();
  const subscriptionEnd = timestamp(subscription?.premium_end);
  const profileEnd = timestamp(profile.premium_end);
  const premiumEnd = subscriptionEnd ?? profileEnd;
  const premiumStart = text(subscription?.premium_start, 80) || text(profile.premium_start, 80);
  const premiumPaymentId = text(subscription?.latest_payment_id, 160) || text(profile.premium_payment_id, 160);
  const premiumPaymentMethod = text(subscription?.payment_method, 80) || text(profile.premium_payment_method, 80);
  const trial = accountStart(user, profile);
  const storedTrialEnd = timestamp(profile.trial_end);
  const trialEnd = Math.max(storedTrialEnd ?? 0, trial.start + TRIAL_DURATION_MS);
  const hasPremium = premiumEnd != null && premiumEnd > now;
  const hasTrial = trialEnd > now;
  const storedPendingId = text(profile.pending_payment_id, 160);
  const storedPendingAt = text(profile.pending_payment_submitted_at, 80);
  const pendingId = billing.pendingAvailable ? text(billing.pending?.id, 160) : storedPendingId;
  const pendingAt = billing.pendingAvailable ? text(billing.pending?.created_at, 80) : storedPendingAt;
  const manualRestricted = profile.manual_restricted === true || storedStatus === "ADMIN_RESTRICTED";
  const storedPending = !billing.pendingAvailable && storedStatus === "PAYMENT_PENDING";
  const priorPremiumState = storedStatus === "PREMIUM_ACTIVE" || storedStatus === "PREMIUM_EXPIRED";
  const subscriptionExpired = billing.subscriptionAvailable && text(subscription?.status, 24).toUpperCase() === "EXPIRED";
  const status = manualRestricted
    ? "ADMIN_RESTRICTED"
    : hasPremium
    ? "PREMIUM_ACTIVE"
    : hasTrial
    ? "TRIALING"
    : pendingId || storedPending
    ? "PAYMENT_PENDING"
    : premiumEnd != null || priorPremiumState || subscriptionExpired
    ? "PREMIUM_EXPIRED"
    : "TRIAL_EXPIRED";
  const transitionBoundary = status === "TRIALING" || status === "TRIAL_EXPIRED"
    ? iso(trialEnd)
    : status === "PREMIUM_ACTIVE" || status === "PREMIUM_EXPIRED"
    ? (premiumEnd == null ? "none" : iso(premiumEnd))
    : status === "PAYMENT_PENDING"
    ? pendingId || storedPendingId || "stored"
    : "manual";
  const transitionKey = `${ownerEmail}:${status}:${transitionBoundary}`;
  const patch: JsonRecord = {
    lifecycle_status: status,
    trial_start: iso(trial.start),
    trial_end: iso(trialEnd),
    trial_start_source: trial.source,
    premium_start: premiumStart,
    premium_end: premiumEnd == null ? text(profile.premium_end, 80) : iso(premiumEnd),
    premium_payment_id: premiumPaymentId,
    premium_payment_method: premiumPaymentMethod,
    pending_payment_id: billing.pendingAvailable ? pendingId : storedPendingId,
    pending_payment_submitted_at: billing.pendingAvailable ? pendingAt : storedPendingAt,
    last_activity_at: nowIso,
  };
  if (!text(profile.first_activity_at, 80)) patch.first_activity_at = nowIso;
  if (ip) {
    patch.last_ip = ip;
    patch.last_ip_at = nowIso;
    if (!text(profile.first_ip, 64)) {
      patch.first_ip = ip;
      patch.first_ip_at = nowIso;
    }
  }

  void persistTransition(client, profile, ownerEmail, user, status, transitionKey, nowIso, pendingId || premiumPaymentId, text(subscription?.id, 160))
    .catch(() => console.error("access-status lifecycle persistence failed"));

  const id = text(profile.id, 160);
  if (!id) throw new Error("Access profile is missing an id.");
  const saved = await safeCall("access profile update", () => client.entities.UserAccessProfile.update(id, patch) as Promise<JsonRecord>, PROFILE_TIMEOUT_MS);
  const responseProfile: JsonRecord = { ...profile, ...patch };
  const effectiveProfile = saved.ok && saved.value && typeof saved.value === "object"
    ? { ...responseProfile, ...saved.value }
    : responseProfile;

  if (ensured.created) await sendSignupNotification(client, integration, request, user, ownerEmail, profile);

  if (subscription && text(subscription.id, 160) && text(subscription.status, 24).toUpperCase() === "ACTIVE" && subscriptionEnd != null && subscriptionEnd <= now) {
    const subscriptionId = text(subscription.id, 160);
    void safeCall("subscription expiry sync", () => client.entities.ManualSubscription.update(subscriptionId, { status: "EXPIRED", expired_at: nowIso }) as Promise<JsonRecord>, SECONDARY_TIMEOUT_MS)
      .catch(() => console.error("access-status subscription expiry sync failed"));
  }
  return {
    ok: true,
    status,
    can_transcribe: status === "TRIALING" || status === "PREMIUM_ACTIVE",
    trial_start: text(effectiveProfile.trial_start, 80),
    trial_end: text(effectiveProfile.trial_end, 80),
    premium_start: text(effectiveProfile.premium_start, 80),
    premium_end: text(effectiveProfile.premium_end, 80),
    has_pending_payment: Boolean(pendingId) || status === "PAYMENT_PENDING",
    pending_payment_submitted_at: pendingAt,
    checked_at: nowIso,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return json(request, {}, 204);
  if (request.method !== "POST") return json(request, { error: "Use POST for access status." }, 405);
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  try {
    const service = serviceClient();
    return json(request, await reconcile(service, auth.client, auth.user, auth.email, request));
  } catch (error) {
    console.error("access-status failed", error instanceof Error ? error.message : "unknown error");
    return json(request, { error: "Your transcription access could not be verified." }, 503);
  }
});
