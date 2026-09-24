import { createSuperdevClient } from "npm:@superdevhq/client@0.1.56";

type JsonRecord = Record<string, unknown>;
type Client = ReturnType<typeof createSuperdevClient>;
type Account = { email: string; user?: JsonRecord; profile?: JsonRecord; subscription?: JsonRecord };

class InputError extends Error {
  constructor(message: string) { super(message); this.name = "InputError"; }
}

const ADMIN_EMAIL = "abelmiracle377@gmail.com";
const CAMPAIGN_KEY = "reengagement-30-day-v1";
const AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BATCH = 100;
const MAX_REQUEST_BYTES = 100_000;
const SUBJECT_MAX = 120;
const BODY_MAX = 2_000;
const ERROR_MAX = 500;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PLACEHOLDERS = new Set(["first_name", "email", "trial_end"]);
const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;
const DEFAULT_SETTINGS = {
  settings_key: "default",
  enabled: false,
  subject: "Revisit your Verbatim Desk workspace",
  body: "Hi {{first_name}},\n\nYour Verbatim Desk workspace is ready when you are. Sign in to check whether trial access is available for your account, then revisit transcription, translation, review, and export in one workspace.\n\nTrial end: {{trial_end}}\n\nIf your trial has ended, you can review the available Premium option from the workspace. We do not automatically renew or extend access.\n\nAccount: {{email}}",
  updated_by: "system",
  last_run_at: "",
  last_run_count: 0,
  last_run_error: "",
};
let runInFlight = false;

function text(value: unknown, max = 2_000): string { return typeof value === "string" ? value.replace(/[\u0000-\u001F]/g, " ").trim().slice(0, max) : ""; }
function plain(value: unknown, max = BODY_MAX): string { const source = typeof value === "string" ? value : ""; return source.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ").slice(0, max).trim(); }
function subject(value: unknown, fallback = ""): string { const source = typeof value === "string" ? value : ""; return source.replace(/[\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim().slice(0, SUBJECT_MAX) || fallback; }
function email(value: unknown): string { return text(value, 320).toLowerCase(); }
function validEmail(value: unknown): string { const candidate = email(value); return EMAIL_PATTERN.test(candidate) ? candidate : ""; }
function at(value: unknown): number | undefined { const result = Date.parse(text(value, 100)); return Number.isFinite(result) ? result : undefined; }
function numberValue(value: unknown): number { const result = typeof value === "number" ? value : Number(value); return Number.isFinite(result) ? result : 0; }
function userId(value: unknown): string { const row = value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; return text(row.user_id ?? row.userId ?? row.id, 160); }
function grantRole(row: JsonRecord): string { return text(row.role, 48).toLowerCase(); }
function authToken(request: Request): string { return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim(); }
function allowedOrigin(origin: string): boolean { return origin === "https://www.buildy.ai" || origin === "https://trancript.art" || origin === "https://www.trancript.art" || /^https:\/\/[^/]+\.(?:superdev\.run|buildy\.show)$/i.test(origin); }
function json(request: Request, payload: unknown, status = 200): Response { const origin = request.headers.get("Origin") || ""; return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin", ...(allowedOrigin(origin) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" } : {}) } }); }
function serviceClient(): Client { const key = Deno.env.get("SUPERDEV_SERVICE_ROLE_KEY"); if (!key) throw new Error("Protected reminder service is not configured."); const client = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") }); client.auth.setToken(key); return client; }
function acceptsJson(value: string): boolean { const mediaType = value.split(";", 1)[0].trim().toLowerCase(); return !mediaType || mediaType === "application/json" || mediaType === "text/plain" || mediaType === "text/json" || mediaType.endsWith("+json"); }
async function readBody(request: Request): Promise<JsonRecord> { const declared = Number(request.headers.get("content-length") || 0); if (declared > MAX_REQUEST_BYTES) throw new InputError("The request is too large."); const bytes = new Uint8Array(await request.arrayBuffer()); if (bytes.byteLength > MAX_REQUEST_BYTES) throw new InputError("The request is too large."); if (!bytes.byteLength) return {}; let value: unknown; try { value = JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, "")); } catch { throw new InputError("The request body must contain valid JSON."); } if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("The request body must be a JSON object."); return value as JsonRecord; }

async function adminContext(request: Request): Promise<{ service: Client; actorEmail: string } | Response> {
  const token = authToken(request); if (!token) return json(request, { error: "Authentication required." }, 401);
  const caller = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") }); caller.auth.setToken(token);
  let user: JsonRecord;
  try { user = await caller.auth.me() as JsonRecord; } catch { return json(request, { error: "Authentication required." }, 401); }
  const actorEmail = validEmail(user.email); if (!actorEmail) return json(request, { error: "Authentication required." }, 401);
  try {
    const service = serviceClient();
    if (actorEmail !== ADMIN_EMAIL) {
      const grants = await service.entities.AdminGrant.list("-updated_at", 2_000) as JsonRecord[];
      const currentId = userId(user);
      const active = (Array.isArray(grants) ? grants : []).some((grant) => {
        if (text(grant.status, 24).toUpperCase() !== "ACTIVE" || grantRole(grant) !== "administrator") return false;
        const grantId = text(grant.user_id ?? grant.userId, 160);
        return Boolean(currentId && grantId) ? currentId === grantId : actorEmail === email(grant.user_email);
      });
      if (!active) return json(request, { error: "Not found." }, 404);
    }
    return { service, actorEmail };
  } catch (error) { console.error("reengagement-reminder authorization failed", error instanceof Error ? "service error" : "unknown error"); return json(request, { error: "The protected administrator service is unavailable." }, 500); }
}

function safeSettings(row?: JsonRecord): JsonRecord {
  return {
    id: text(row?.id, 120), settings_key: "default", enabled: row?.enabled === true,
    subject: subject(row?.subject, DEFAULT_SETTINGS.subject), body: plain(row?.body) || DEFAULT_SETTINGS.body,
    updated_by: email(row?.updated_by) || "system", last_run_at: text(row?.last_run_at, 80),
    last_run_count: Math.max(0, Math.min(10_000, Math.round(numberValue(row?.last_run_count)))), last_run_error: plain(row?.last_run_error, ERROR_MAX),
  };
}
async function settingRows(client: Client): Promise<JsonRecord[]> { const rows = await client.entities.ReengagementSettings.filter({ settings_key: "default" }, "-updated_at", 20) as JsonRecord[]; return Array.isArray(rows) ? rows : []; }
async function readSettings(client: Client): Promise<{ row?: JsonRecord; settings: JsonRecord }> { const rows = await settingRows(client); const row = rows.find((item) => Boolean(text(item.id, 120))); return { row, settings: row ? safeSettings(row) : { ...DEFAULT_SETTINGS } }; }
function saveSubject(value: unknown): string { if (typeof value !== "string") throw new InputError("The reminder subject must be plain text."); if (value.length > SUBJECT_MAX) throw new InputError(`The reminder subject must be ${SUBJECT_MAX} characters or fewer.`); const result = subject(value); if (!result) throw new InputError("A reminder subject is required."); return result; }
function saveBody(value: unknown): string { if (typeof value !== "string") throw new InputError("The reminder message must be plain text."); if (value.length > BODY_MAX) throw new InputError(`The reminder message must be ${BODY_MAX.toLocaleString()} characters or fewer.`); const result = plain(value); if (!result) throw new InputError("A reminder message is required."); return result; }
async function saveSettings(client: Client, body: JsonRecord, actorEmail: string): Promise<JsonRecord> {
  if (Object.keys(body).some((key) => !["action", "enabled", "subject", "body"].includes(key))) throw new InputError("Only reminder enabled state, subject, and message can be changed.");
  if (typeof body.enabled !== "boolean") throw new InputError("Choose whether the reminder is enabled.");
  const current = await readSettings(client); const data = { settings_key: "default", enabled: body.enabled, subject: saveSubject(body.subject), body: saveBody(body.body), updated_by: actorEmail, last_run_at: text(current.settings.last_run_at, 80), last_run_count: numberValue(current.settings.last_run_count), last_run_error: plain(current.settings.last_run_error, ERROR_MAX) };
  const saved = current.row?.id ? await client.entities.ReengagementSettings.update(text(current.row.id, 120), data) as JsonRecord : await client.entities.ReengagementSettings.create(data) as JsonRecord;
  const rows = await settingRows(client); if (rows.length > 1) await Promise.all(rows.slice(1).map(async (row) => { const id = text(row.id, 120); if (id) { try { await client.entities.ReengagementSettings.delete(id); } catch { /* keep the active record when duplicate cleanup is unavailable */ } } }));
  return { settings: safeSettings({ ...current.row, ...data, ...(saved || {}) }), source: "saved" };
}

async function platformUsers(client: Client): Promise<JsonRecord[]> {
  const auth = client.auth as unknown as { list?: () => Promise<unknown> }; if (typeof auth.list !== "function") return [];
  try { const value = await auth.list(); const record = value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; const rows = Array.isArray(value) ? value : Array.isArray(record.users) ? record.users : Array.isArray(record.results) ? record.results : []; return rows.filter((row): row is JsonRecord => Boolean(row && typeof row === "object" && !Array.isArray(row))).filter((row) => Boolean(validEmail(row.email))); } catch { console.error("reengagement-reminder platform account list unavailable"); return []; }
}
async function listProfiles(client: Client): Promise<JsonRecord[]> { const rows = await client.entities.UserAccessProfile.list("-updated_at", 5_000) as JsonRecord[]; return Array.isArray(rows) ? rows : []; }
async function listSubscriptions(client: Client): Promise<JsonRecord[]> { const rows = await client.entities.ManualSubscription.list("-updated_at", 5_000) as JsonRecord[]; return Array.isArray(rows) ? rows : []; }
async function listDeliveries(client: Client): Promise<JsonRecord[]> { const rows = await client.entities.ReengagementDelivery.filter({ campaign_key: CAMPAIGN_KEY }, "-attempted_at", 10_000) as JsonRecord[]; return Array.isArray(rows) ? rows : []; }
function newer(a: JsonRecord | undefined, b: JsonRecord): JsonRecord { return !a || (at(b.updated_at ?? b.created_at) || 0) > (at(a.updated_at ?? a.created_at) || 0) ? b : a; }
function accounts(users: JsonRecord[], profiles: JsonRecord[], subscriptions: JsonRecord[]): Map<string, Account> {
  const result = new Map<string, Account>();
  users.forEach((user) => { const owner = validEmail(user.email); if (owner && owner !== ADMIN_EMAIL) result.set(owner, { email: owner, user }); });
  profiles.forEach((profile) => { const owner = validEmail(profile.owner_email); if (!owner || owner === ADMIN_EMAIL) return; const current = result.get(owner) || { email: owner }; result.set(owner, { ...current, profile: newer(current.profile, profile) }); });
  subscriptions.forEach((subscription) => { const owner = validEmail(subscription.owner_email); if (!owner || owner === ADMIN_EMAIL) return; const current = result.get(owner) || { email: owner }; result.set(owner, { ...current, subscription: newer(current.subscription, subscription) }); });
  return result;
}
function accountAge(account: Account): number | undefined { return at(account.user?.created_at ?? account.user?.createdAt ?? account.user?.created_date ?? account.user?.createdDate) ?? at(account.profile?.trial_start) ?? at(account.profile?.created_at); }
function premiumEnd(account: Account): number | undefined { const values = [at(account.subscription?.premium_end), at(account.profile?.premium_end)].filter((value): value is number => value != null); return values.length ? Math.max(...values) : undefined; }
function firstName(account: Account): string { const name = text(account.user?.full_name ?? account.user?.first_name ?? account.user?.name, 160); return name.split(/\s+/)[0] || account.email.split("@", 1)[0].replace(/[._-]+/g, " ").split(/\s+/)[0] || "there"; }
function eligible(account: Account, now: number): boolean {
  const age = accountAge(account); if (age == null || age > now - AGE_MS) return false;
  const profile = account.profile; const trialEnd = at(profile?.trial_end); const activePremium = (premiumEnd(account) || 0) > now; const currentTrial = trialEnd != null && trialEnd > now; const restricted = profile?.manual_restricted === true || text(profile?.lifecycle_status, 40).toUpperCase() === "ADMIN_RESTRICTED"; if (activePremium || currentTrial || restricted) return false;
  const hasActivity = at(profile?.first_activity_at) != null || at(profile?.last_activity_at) != null; return (trialEnd != null && trialEnd <= now) || !hasActivity;
}
function emailDate(value: number | undefined): string { return value == null ? "Not recorded" : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value)); }
function escapeHtml(value: unknown): string { const source = typeof value === "string" ? value : value == null ? "" : String(value); return source.replace(/\u0000/g, "").replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;"); }
function context(account: Account): Record<string, string> { return { first_name: firstName(account), email: account.email, trial_end: emailDate(at(account.profile?.trial_end)) }; }
function renderSubject(template: string, values: Record<string, string>): string { const rendered = subject(template).replace(PLACEHOLDER_PATTERN, (_token, key: string) => PLACEHOLDERS.has(key.trim().toLowerCase()) ? subject(values[key.trim().toLowerCase()]) : ""); return subject(rendered, DEFAULT_SETTINGS.subject); }
function renderBody(template: string, values: Record<string, string>): string { const source = plain(template); let cursor = 0; let rendered = ""; source.replace(PLACEHOLDER_PATTERN, (token: string, key: string, offset: number) => { rendered += escapeHtml(source.slice(cursor, offset)); rendered += PLACEHOLDERS.has(key.trim().toLowerCase()) ? escapeHtml(values[key.trim().toLowerCase()] || "") : ""; cursor = offset + token.length; return token; }); rendered += escapeHtml(source.slice(cursor)); return rendered.replace(/\n/g, "<br />"); }
function wrapped(body: string): string { return `<div style="font-family:Arial,sans-serif;color:#1f2933;line-height:1.65;max-width:640px"><div>${body}</div><p style="margin:24px 0 0;color:#667085;font-size:12px">Verbatim Desk</p></div>`; }
async function markAttempt(client: Client, owner: string, attemptedAt: string): Promise<JsonRecord | undefined> { try { const row = await client.entities.ReengagementDelivery.create({ campaign_key: CAMPAIGN_KEY, owner_email: owner, status: "ATTEMPTED", attempted_at: attemptedAt, sent_at: "", error: "" }) as JsonRecord; return text(row.id, 120) ? row : undefined; } catch { console.error("reengagement-reminder delivery marker failed"); return undefined; } }
async function updateDelivery(client: Client, row: JsonRecord, patch: JsonRecord): Promise<void> { try { await client.entities.ReengagementDelivery.update(text(row.id, 120), patch); } catch { console.error("reengagement-reminder delivery status update failed"); } }
async function updateRun(client: Client, id: string, count: number, errorMessage: string): Promise<void> { try { await client.entities.ReengagementSettings.update(id, { last_run_at: new Date().toISOString(), last_run_count: Math.max(0, Math.min(10_000, count)), last_run_error: plain(errorMessage, ERROR_MAX) }); } catch { console.error("reengagement-reminder run status update failed"); } }
async function sendReminder(client: Client, account: Account, settings: JsonRecord): Promise<void> { const values = context(account); await client.integrations.core.sendEmail({ to: account.email, subject: renderSubject(String(settings.subject), values), body_html: wrapped(renderBody(String(settings.body), values)), from_name: "Verbatim Desk", reply_to: ADMIN_EMAIL }); }

async function runReminder(): Promise<void> {
  if (runInFlight) return; runInFlight = true; let client: Client | undefined; let settingsId = "";
  try {
    client = serviceClient(); const loaded = await readSettings(client); settingsId = text(loaded.row?.id, 120); if (!loaded.row || loaded.settings.enabled !== true) return;
    const [users, profiles, subscriptions, deliveries] = await Promise.all([platformUsers(client), listProfiles(client), listSubscriptions(client), listDeliveries(client)]);
    const attempted = new Set((deliveries || []).filter((row) => text(row.campaign_key, 100) === CAMPAIGN_KEY).map((row) => validEmail(row.owner_email)).filter(Boolean));
    const now = Date.now(); const candidates = [...accounts(users, profiles, subscriptions).values()].filter((account) => !attempted.has(account.email) && eligible(account, now)).sort((a, b) => (accountAge(a) || 0) - (accountAge(b) || 0)).slice(0, MAX_BATCH);
    let sent = 0; let failed = 0;
    for (const account of candidates) {
      attempted.add(account.email); const attemptedAt = new Date().toISOString(); const marker = await markAttempt(client, account.email, attemptedAt); if (!marker) { failed += 1; continue; }
      try { await sendReminder(client, account, loaded.settings); await updateDelivery(client, marker, { status: "SENT", sent_at: new Date().toISOString(), error: "" }); sent += 1; }
      catch { failed += 1; await updateDelivery(client, marker, { status: "FAILED", sent_at: "", error: "Email delivery could not be completed." }); }
    }
    await updateRun(client, settingsId, sent, failed ? `${failed} reminder attempt${failed === 1 ? "" : "s"} could not be sent.` : "");
  } catch (error) {
    console.error("reengagement-reminder run failed", error instanceof Error ? "scheduled check error" : "unknown error"); if (client && settingsId) await updateRun(client, settingsId, 0, "The daily reminder check could not be completed.");
  } finally { runInFlight = false; }
}

Deno.cron("reengagement-reminder-daily", "30 3 * * *", async () => { try { await runReminder(); } catch { console.error("reengagement-reminder scheduled job failed"); } });

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return json(request, {}, 204);
  if (request.method !== "POST") return json(request, { error: "Use POST for reminder settings." }, 405);
  if (!acceptsJson(request.headers.get("Content-Type") || "")) return json(request, { error: "This endpoint accepts JSON requests only." }, 415);
  const auth = await adminContext(request); if (auth instanceof Response) return auth;
  let body: JsonRecord; try { body = await readBody(request); } catch (error) { return json(request, { error: error instanceof Error ? error.message : "The request body is invalid." }, 400); }
  const action = text(body.action, 40);
  try {
    if (action === "settings") return json(request, await (async () => { const loaded = await readSettings(auth.service); return { settings: loaded.settings, source: loaded.row ? "saved" : "default" }; })());
    if (action === "save_settings") return json(request, await saveSettings(auth.service, body, auth.actorEmail));
    throw new InputError("Unknown reminder settings action.");
  } catch (error) { const input = error instanceof InputError; console.error("reengagement-reminder request failed", action, input ? "input error" : "server error"); return json(request, { error: input ? error.message : "The reminder settings could not be saved." }, input ? 400 : 500); }
});
