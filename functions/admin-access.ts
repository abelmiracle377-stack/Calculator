import { createSuperdevClient } from "npm:@superdevhq/client@0.1.56";

type JsonRecord = Record<string, unknown>;
type Client = ReturnType<typeof createSuperdevClient>;

class InputError extends Error {
  constructor(message: string) { super(message); this.name = "InputError"; }
}

const ADMIN_EMAIL = "abelmiracle377@gmail.com";
const MAX_REQUEST_BYTES = 600_000;
const MAX_TEXT = 2_000;
const PUBLIC_ORIGINS = new Set(["https://www.buildy.ai", "https://trancript.art", "https://www.trancript.art"]);
const PREVIEW_ORIGIN_PATTERN = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:superdev\.run|buildy\.show)$/i;
function isAllowedOrigin(origin: string): boolean { return PUBLIC_ORIGINS.has(origin) || PREVIEW_ORIGIN_PATTERN.test(origin); }
const DEFAULT_APP_SETTINGS: JsonRecord = { settings_key: "default", workspace_name: "Verbatim Desk", short_label: "Internal staff tool", description: "Private audio transcription workspace for accurate review.", support_slack_url: "", support_email: "", support_slack_enabled: false, support_email_enabled: false, support_ai_help_desk_enabled: true };
const DEFAULT_NOTIFICATION_SETTINGS: JsonRecord = { settings_key: "default", recipient_email: "transcriptxpert@trancript.art", enabled: true, updated_by: "system" };
const APP_SETTINGS_LIMITS = { workspace_name: 80, short_label: 80, description: 360 };
const SUPPORT_SLACK_URL_MAX = 500;
const NOTIFICATION_EMAIL_MAX = 254;
const NOTIFICATION_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ACCESS_REQUEST_STATUSES = new Set(["NEW", "REVIEWED", "APPROVED"]);
const SUPPORT_CONVERSATION_STATUSES = new Set(["OPEN", "HUMAN_REQUESTED", "RESOLVED"]);
const HUMAN_SUPPORT_STATUSES = new Set(["NEW", "IN_PROGRESS", "RESOLVED"]);
const SUPPORT_LIST_LIMIT = 200;
const SUPPORT_MESSAGE_LIMIT = 250;
const SUPPORT_SEARCH_MAX = 120;
const MESSAGE_SUBJECT_MAX = 120;
const MESSAGE_BODY_MAX = 2_000;
type MessageTemplates = {
  signup_subject: string;
  signup_body: string;
  payment_submitted_subject: string;
  payment_submitted_body: string;
  payment_approved_subject: string;
  payment_approved_body: string;
};
const MESSAGE_FIELDS: Array<keyof MessageTemplates> = ["signup_subject", "signup_body", "payment_submitted_subject", "payment_submitted_body", "payment_approved_subject", "payment_approved_body"];
const DEFAULT_MESSAGE_TEMPLATES: MessageTemplates = {
  signup_subject: "Welcome to Verbatim Desk",
  signup_body: "Welcome to Verbatim Desk, {{first_name}}.\n\nYour account is ready. Sign in to open your private transcription workspace and start your first review.\n\nYour 7-day trial begins with your account access. If you need help, reply to this email.\n\nAccount: {{email}}",
  payment_submitted_subject: "Payment received, verification is pending",
  payment_submitted_body: "Hi {{first_name}},\n\nWe received your manual payment submission for Verbatim Desk. Your evidence is saved and is now waiting for administrator verification.\n\nPayment ID: {{payment_id}}\nPayment method: {{payment_method}}\nAmount: {{amount}} {{currency}}\n\nPremium access starts after the payment is approved. We will email you when a decision is recorded.",
  payment_approved_subject: "Your Verbatim Desk Premium access is active",
  payment_approved_body: "Hi {{first_name}},\n\nYour payment has been approved and one calendar month of Premium access is now active.\n\nPayment ID: {{payment_id}}\nPayment method: {{payment_method}}\nPremium: {{premium_start}} to {{premium_end}}\n\nSign in to continue your transcription work.",
};

function text(value: unknown, max = MAX_TEXT): string { return typeof value === "string" ? value.replace(/[\u0000-\u001F]/g, " ").trim().slice(0, max) : ""; }
function messagePlainText(value: unknown, max = MESSAGE_BODY_MAX): string {
  const source = typeof value === "string" ? value : "";
  return source.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ").slice(0, max).trim();
}
function messageSubject(value: unknown, fallback: string): string {
  const source = typeof value === "string" ? value : "";
  return source.replace(/[\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim().slice(0, MESSAGE_SUBJECT_MAX) || fallback;
}
function messageBody(value: unknown, fallback: string): string { return messagePlainText(value) || fallback; }
function safeMessageTemplates(row?: JsonRecord): MessageTemplates {
  return {
    signup_subject: messageSubject(row?.signup_subject, DEFAULT_MESSAGE_TEMPLATES.signup_subject),
    signup_body: messageBody(row?.signup_body, DEFAULT_MESSAGE_TEMPLATES.signup_body),
    payment_submitted_subject: messageSubject(row?.payment_submitted_subject, DEFAULT_MESSAGE_TEMPLATES.payment_submitted_subject),
    payment_submitted_body: messageBody(row?.payment_submitted_body, DEFAULT_MESSAGE_TEMPLATES.payment_submitted_body),
    payment_approved_subject: messageSubject(row?.payment_approved_subject, DEFAULT_MESSAGE_TEMPLATES.payment_approved_subject),
    payment_approved_body: messageBody(row?.payment_approved_body, DEFAULT_MESSAGE_TEMPLATES.payment_approved_body),
  };
}
function email(value: unknown): string { return text(value, 320).toLowerCase(); }
function numberValue(value: unknown): number | null { const result = typeof value === "number" ? value : Number(value); return Number.isFinite(result) ? result : null; }
function time(value: unknown): number | undefined { const result = Date.parse(text(value, 100)); return Number.isFinite(result) ? result : undefined; }
function iso(value: number): string { return new Date(value).toISOString(); }
function timestamp(value: unknown): string { const parsed = time(value); return parsed == null ? "" : iso(parsed); }
function userId(value: unknown): string {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
  const explicitId = text(row.user_id ?? row.userId, 160);
  return explicitId || text(row.id, 160);
}
function json(request: Request, payload: unknown, status = 200): Response {
  const origin = request.headers.get("Origin") || ""; const allowed = isAllowedOrigin(origin);
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin", ...(allowed ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" } : {}) } });
}
function authToken(request: Request): string { return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim(); }
function integrationHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const authorization = request.headers.get("Authorization");
  const origin = request.headers.get("Origin");
  if (authorization) headers.Authorization = authorization;
  if (origin && isAllowedOrigin(origin)) headers.Origin = origin;
  return headers;
}
function serviceClient(): Client {
  const key = Deno.env.get("SUPERDEV_SERVICE_ROLE_KEY"); if (!key) throw new Error("The protected administrator service is not configured.");
  const client = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") }); client.auth.setToken(key); return client;
}
function grantStatus(row: JsonRecord): string { return text(row.status, 24).toUpperCase(); }
function grantRole(row: JsonRecord): string { return text(row.role, 48).toLowerCase(); }
function grantMatches(grants: JsonRecord[], account: JsonRecord): JsonRecord[] {
  const targetId = userId(account); const targetEmail = email(account.email);
  return grants.filter((grant) => {
    const grantId = text(grant.user_id ?? grant.userId, 160);
    if (targetId && grantId) return grantId === targetId;
    return Boolean(targetEmail) && email(grant.user_email) === targetEmail;
  });
}
function newestGrant(rows: JsonRecord[]): JsonRecord | undefined { return [...rows].sort((a, b) => (time(b.updated_at ?? b.granted_at ?? b.revoked_at) || 0) - (time(a.updated_at ?? a.granted_at ?? a.revoked_at) || 0))[0]; }
function activeGrant(grants: JsonRecord[], account: JsonRecord): JsonRecord | undefined { return newestGrant(grantMatches(grants, account).filter((row) => grantStatus(row) === "ACTIVE" && grantRole(row) === "administrator")); }
async function listAdminGrants(client: Client): Promise<JsonRecord[]> { const rows = await client.entities.AdminGrant.list("-updated_at", 2_000) as JsonRecord[]; return Array.isArray(rows) ? rows : []; }
async function effectiveAdmin(client: Client, user: JsonRecord): Promise<boolean> {
  if (email(user.email) === ADMIN_EMAIL) return true;
  return Boolean(activeGrant(await listAdminGrants(client), user));
}

type AdminContext = { service: Client; actorId: string; actorEmail: string };
async function adminContext(request: Request): Promise<AdminContext | Response> {
  const token = authToken(request); if (!token) return json(request, { error: "Authentication required." }, 401);
  const caller = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") }); caller.auth.setToken(token);
  let user: JsonRecord; try { user = await caller.auth.me() as JsonRecord; } catch { return json(request, { error: "Authentication required." }, 401); }
  const actorEmail = email(user.email); if (!actorEmail) return json(request, { error: "Authentication required." }, 401);
  try {
    const service = serviceClient();
    if (!(await effectiveAdmin(service, user))) return json(request, { error: "Not found." }, 404);
    return { service, actorId: userId(user), actorEmail };
  } catch (error) { console.error("admin-access authorization failed", error instanceof Error ? error.message : "unknown error"); return json(request, { error: "The protected administrator service is unavailable." }, 500); }
}
async function readBody(request: Request): Promise<JsonRecord> {
  const declared = Number(request.headers.get("content-length") || 0); if (declared > MAX_REQUEST_BYTES) throw new InputError("The request is too large.");
  const bytes = new Uint8Array(await request.arrayBuffer()); if (bytes.byteLength > MAX_REQUEST_BYTES) throw new InputError("The request is too large."); if (!bytes.byteLength) return {};
  let value: unknown; try { value = JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, "")); } catch { throw new InputError("The request body must contain valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("The request body must be a JSON object."); return value as JsonRecord;
}
async function listProfiles(client: Client): Promise<JsonRecord[]> { const rows = await client.entities.UserAccessProfile.list("-updated_at", 1_000) as JsonRecord[]; return Array.isArray(rows) ? rows : []; }
async function listSubscriptions(client: Client): Promise<JsonRecord[]> { const rows = await client.entities.ManualSubscription.list("-updated_at", 1_000) as JsonRecord[]; return Array.isArray(rows) ? rows : []; }
async function listPayments(client: Client): Promise<JsonRecord[]> { const rows = await client.entities.ManualPaymentSubmission.list("-created_at", 1_000) as JsonRecord[]; return Array.isArray(rows) ? rows : []; }
async function listAccessAudits(client: Client): Promise<JsonRecord[]> { const rows = await client.entities.UserAccessAuditEvent.list("-created_at", 500) as JsonRecord[]; return Array.isArray(rows) ? rows : []; }
async function listBillingAudits(client: Client): Promise<JsonRecord[]> { const rows = await client.entities.ManualPaymentAuditEvent.list("-created_at", 500) as JsonRecord[]; return Array.isArray(rows) ? rows : []; }
async function platformUsers(client: Client): Promise<{ rows: JsonRecord[]; available: boolean }> {
  const auth = client.auth as unknown as { list?: () => Promise<unknown> }; if (typeof auth.list !== "function") return { rows: [], available: false };
  try {
    const value = await auth.list(); const record = value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
    const rows = Array.isArray(value) ? value : Array.isArray(record.users) ? record.users : Array.isArray(record.results) ? record.results : [];
    return { rows: rows.filter((row): row is JsonRecord => Boolean(row && typeof row === "object" && !Array.isArray(row))).filter((row) => Boolean(email(row.email))), available: true };
  } catch (error) { console.error("admin-access platform user list unavailable", error instanceof Error ? error.message : "unknown error"); return { rows: [], available: false }; }
}
function latest(rows: JsonRecord[]): JsonRecord | undefined { return [...rows].sort((a, b) => (time(b.updated_at ?? b.created_at) || 0) - (time(a.updated_at ?? a.created_at) || 0))[0]; }
function groupByOwner(rows: JsonRecord[]): Map<string, JsonRecord[]> {
  const grouped = new Map<string, JsonRecord[]>(); rows.forEach((row) => { const owner = email(row.owner_email); if (!owner || owner === ADMIN_EMAIL) return; grouped.set(owner, [...(grouped.get(owner) || []), row]); });
  grouped.forEach((items, owner) => grouped.set(owner, items.sort((a, b) => (time(b.created_at ?? b.updated_at) || 0) - (time(a.created_at ?? a.updated_at) || 0)))); return grouped;
}
function profileMap(rows: JsonRecord[]): Map<string, JsonRecord> {
  const result = new Map<string, JsonRecord>(); rows.forEach((row) => { const owner = email(row.owner_email); if (!owner || owner === ADMIN_EMAIL) return; const current = result.get(owner); if (!current || (time(row.updated_at ?? row.created_at) || 0) > (time(current.updated_at ?? current.created_at) || 0)) result.set(owner, row); }); return result;
}
function timing(user: JsonRecord | undefined, profile: JsonRecord | undefined): { value: string; label: string; source: "account_created_at" | "first_authenticated_at" | "unavailable" } {
  const platformCreated = time(user?.created_at ?? user?.createdAt ?? user?.created_date ?? user?.createdDate); if (platformCreated != null) return { value: iso(platformCreated), label: "Account created", source: "account_created_at" };
  const trialStart = time(profile?.trial_start); if (trialStart != null && text(profile?.trial_start_source, 64) === "account_created_at") return { value: iso(trialStart), label: "Account created", source: "account_created_at" };
  const firstActivity = time(profile?.first_activity_at) ?? (text(profile?.trial_start_source, 64) === "first_authenticated_at" ? trialStart : undefined); if (firstActivity != null) return { value: iso(firstActivity), label: "First authenticated", source: "first_authenticated_at" };
  return { value: "", label: "Account timing unavailable", source: "unavailable" };
}
function deriveStatus(profile: JsonRecord | undefined, subscription: JsonRecord | undefined, payments: JsonRecord[], now = Date.now()): string {
  if (!profile) return "NOT_INITIALIZED"; if (profile.manual_restricted === true) return "ADMIN_RESTRICTED";
  const premiumEnd = time(subscription?.premium_end) ?? time(profile.premium_end); const trialEnd = time(profile.trial_end);
  if (premiumEnd != null && premiumEnd > now) return "PREMIUM_ACTIVE"; if (trialEnd != null && trialEnd > now) return "TRIALING"; if (payments.some((row) => text(row.status, 24).toUpperCase() === "PENDING")) return "PAYMENT_PENDING";
  if (premiumEnd != null || text(subscription?.status, 24).toUpperCase() === "EXPIRED") return "PREMIUM_EXPIRED"; return "TRIAL_EXPIRED";
}
function paymentSummary(row: JsonRecord | undefined): JsonRecord | null { if (!row) return null; return { id: text(row.id, 120), status: text(row.status, 24).toUpperCase(), payment_method: text(row.payment_method, 64), country: text(row.country, 24), claimed_amount: numberValue(row.claimed_amount) || 0, claimed_currency: text(row.claimed_currency, 16), submitted_at: timestamp(row.created_at ?? row.submitted_at), verification_at: timestamp(row.verification_at), transaction_reference: text(row.transaction_reference, 160), premium_start: timestamp(row.premium_start), premium_end: timestamp(row.premium_end) }; }
function userRow(owner: string, user: JsonRecord | undefined, profile: JsonRecord | undefined, subscription: JsonRecord | undefined, payments: JsonRecord[], grants: JsonRecord[], actorId: string, actorEmail: string): JsonRecord {
  const latestPayment = paymentSummary(payments[0]); const premiumStart = timestamp(subscription?.premium_start) || timestamp(profile?.premium_start); const premiumEnd = timestamp(subscription?.premium_end) || timestamp(profile?.premium_end); const pending = payments.find((row) => text(row.status, 24).toUpperCase() === "PENDING"); const account = timing(user, profile);
  const root = owner === ADMIN_EMAIL; const accountRef = { user_id: userId(user), email: owner }; const matching = grantMatches(grants, accountRef); const active = activeGrant(grants, accountRef); const recentGrant = newestGrant(matching); const current = Boolean((actorId && actorId === userId(user)) || (actorEmail && actorEmail === owner));
  return { id: text(profile?.id, 120) || `account:${userId(user) || owner}`, user_id: userId(user), profile_id: text(profile?.id, 120), email: owner, name: text(user?.full_name ?? user?.name, 240), profile_available: Boolean(profile), lifecycle_status: deriveStatus(profile, subscription, payments), effective_role: root || Boolean(active) ? "administrator" : "user", is_root_admin: root, is_granted_admin: !root && Boolean(active), is_current_admin: current, is_protected_admin: root || current, admin_grant_status: root ? "root" : active ? "active" : grantStatus(recentGrant || {}) === "REVOKED" ? "revoked" : "none", admin_granted_at: timestamp(active?.granted_at ?? recentGrant?.granted_at), admin_granted_by: email(active?.granted_by ?? recentGrant?.granted_by), admin_revoked_at: timestamp(recentGrant?.revoked_at), admin_revoked_by: email(recentGrant?.revoked_by), account_timestamp: account.value, account_timestamp_label: account.label, account_timestamp_source: account.source, profile_updated_at: timestamp(profile?.updated_at), trial_start: timestamp(profile?.trial_start), trial_end: timestamp(profile?.trial_end), premium_start: premiumStart, premium_end: premiumEnd, pending_payment_id: text(pending?.id, 120) || text(profile?.pending_payment_id, 120), pending_payment_submitted_at: timestamp(pending?.created_at) || timestamp(profile?.pending_payment_submitted_at), payment_status: text(latestPayment?.status, 24) || "NONE", latest_payment: latestPayment, manual_restricted: profile?.manual_restricted === true, restriction_reason: text(profile?.manual_restriction_reason, MAX_TEXT), manual_restricted_at: timestamp(profile?.manual_restricted_at), first_activity_at: timestamp(profile?.first_activity_at), last_activity_at: timestamp(profile?.last_activity_at), first_ip: text(profile?.first_ip, 64), first_ip_at: timestamp(profile?.first_ip_at), last_ip: text(profile?.last_ip, 64), last_ip_at: timestamp(profile?.last_ip_at), internal_note: text(profile?.internal_note, MAX_TEXT) };
}
function scope(platform: { rows: JsonRecord[]; available: boolean }, profileCount: number): JsonRecord { return { user_list_available: platform.available, user_list_source: platform.available ? "platform_accounts" : "access_profiles_only", total_users: platform.available ? platform.rows.length : null, total_profiles: profileCount, account_timing_note: platform.available ? "Account-created timestamps use platform account metadata when available. Older access profiles may use first authenticated activity." : "The platform account list is unavailable. Directory rows come from access profiles, with recorded account or first-authenticated timing only." }; }
async function directory(client: Client, actorId = "", actorEmail = ""): Promise<{ users: JsonRecord[]; scope: JsonRecord }> {
  const [profiles, subscriptions, payments, platform, grants] = await Promise.all([listProfiles(client), listSubscriptions(client), listPayments(client), platformUsers(client), listAdminGrants(client)]);
  const profilesByOwner = profileMap(profiles); const subscriptionsByOwner = groupByOwner(subscriptions); const paymentsByOwner = groupByOwner(payments); const usersByOwner = new Map<string, JsonRecord>(); platform.rows.forEach((row) => { const owner = email(row.email); if (owner) usersByOwner.set(owner, row); });
  const owners = new Set<string>([...profilesByOwner.keys(), ...usersByOwner.keys(), ADMIN_EMAIL]);
  const users = [...owners].map((owner) => userRow(owner, usersByOwner.get(owner), profilesByOwner.get(owner), latest(subscriptionsByOwner.get(owner) || []), paymentsByOwner.get(owner) || [], grants, actorId, actorEmail)).sort((a, b) => (time(b.last_activity_at ?? b.account_timestamp) || 0) - (time(a.last_activity_at ?? a.account_timestamp) || 0) || String(a.email).localeCompare(String(b.email)));
  return { users, scope: scope(platform, profilesByOwner.size) };
}
function counts(users: JsonRecord[], dataScope: JsonRecord): JsonRecord {
  const result: JsonRecord = { total_users: dataScope.total_users as number | null, total_profiles: dataScope.total_profiles, trialing: 0, trial_expired: 0, payment_pending: 0, premium_active: 0, premium_expired: 0, manually_restricted: 0, not_initialized: 0 };
  users.forEach((user) => { if (user.is_root_admin === true) return; const status = text(user.lifecycle_status, 40); if (status === "TRIALING") result.trialing = (result.trialing as number) + 1; if (status === "TRIAL_EXPIRED") result.trial_expired = (result.trial_expired as number) + 1; if (status === "PAYMENT_PENDING") result.payment_pending = (result.payment_pending as number) + 1; if (status === "PREMIUM_ACTIVE") result.premium_active = (result.premium_active as number) + 1; if (status === "PREMIUM_EXPIRED") result.premium_expired = (result.premium_expired as number) + 1; if (status === "ADMIN_RESTRICTED") result.manually_restricted = (result.manually_restricted as number) + 1; if (status === "NOT_INITIALIZED") result.not_initialized = (result.not_initialized as number) + 1; }); return result;
}
async function target(client: Client, body: JsonRecord, requireProfile = true, blockAdmin = false): Promise<{ row: JsonRecord; profile?: JsonRecord }> {
  const data = await directory(client); const targetId = text(body.user_id, 160); const targetEmail = email(body.owner_email ?? body.user_email); const row = targetId ? data.users.find((item) => item.user_id === targetId) : data.users.find((item) => targetEmail && item.email === targetEmail);
  if (!row) throw new InputError("The selected account was not found."); if (blockAdmin && row.effective_role === "administrator") throw new InputError("Administrator accounts cannot be restricted through access controls.");
  if (!requireProfile) return { row }; if (row.profile_available !== true) throw new InputError("The selected user access profile was not found.");
  const profile = await client.entities.UserAccessProfile.get(text(row.profile_id, 120)) as JsonRecord; if (!profile || email(profile.owner_email) !== row.email) throw new InputError("The selected user access profile was not found."); return { row, profile };
}
async function roleTarget(client: Client, body: JsonRecord): Promise<{ row: JsonRecord; grants: JsonRecord[] }> {
  const targetId = text(body.user_id, 160); if (!targetId) throw new InputError("A stable platform account id is required for role changes."); const data = await directory(client); if (!data.scope.user_list_available) throw new InputError("The platform account directory is temporarily unavailable.");
  const row = data.users.find((item) => item.user_id === targetId); if (!row) throw new InputError("The selected platform account was not found."); return { row, grants: await listAdminGrants(client) };
}
async function accessAudit(client: Client, owner: string, userIdValue: string, actor: string, action: string, note: string, paymentId = "", subscriptionId = "") { await client.entities.UserAccessAuditEvent.create({ target_user_email: owner, target_user_id: userIdValue, actor_email: email(actor), action: text(action, 64), occurred_at: new Date().toISOString(), related_payment_id: text(paymentId, 120), related_subscription_id: text(subscriptionId, 120), dedupe_key: `ADMIN:${text(action, 64)}:${owner}:${crypto.randomUUID()}`, note: text(note, MAX_TEXT) }); }
async function updatedUser(client: Client, owner: string, actorId: string, actorEmail: string): Promise<JsonRecord> { const data = await directory(client, actorId, actorEmail); const row = data.users.find((item) => item.email === owner); if (!row) throw new Error("Updated user was not returned."); return row; }
async function changeAccess(client: Client, body: JsonRecord, action: "restrict" | "restore" | "note", actorId: string, actorEmail: string): Promise<JsonRecord> {
  const selected = await target(client, body, true, true); const owner = email(selected.row.email); const now = new Date().toISOString(); const profile = selected.profile!;
  if (action === "restrict") { const note = text(body.note ?? body.reason, MAX_TEXT); if (!note) throw new InputError("A restriction note is required."); await client.entities.UserAccessProfile.update(text(profile.id, 120), { manual_restricted: true, manual_restriction_reason: note, manual_restricted_at: now, manual_restricted_by: actorEmail, lifecycle_status: "ADMIN_RESTRICTED" }); await accessAudit(client, owner, text(selected.row.user_id, 160), actorEmail, "ACCESS_RESTRICTED", note); }
  else if (action === "restore") { const premiumEnd = time(selected.row.premium_end); const trialEnd = time(selected.row.trial_end); const hasPending = Boolean(text(selected.row.pending_payment_id, 120)); const hasPremiumHistory = premiumEnd != null || Boolean(text(selected.row.premium_start, 80)); const status = premiumEnd != null && premiumEnd > Date.now() ? "PREMIUM_ACTIVE" : trialEnd != null && trialEnd > Date.now() ? "TRIALING" : hasPending ? "PAYMENT_PENDING" : hasPremiumHistory ? "PREMIUM_EXPIRED" : "TRIAL_EXPIRED"; await client.entities.UserAccessProfile.update(text(profile.id, 120), { manual_restricted: false, manual_restriction_reason: "", manual_restricted_at: "", manual_restricted_by: "", lifecycle_status: status }); await accessAudit(client, owner, text(selected.row.user_id, 160), actorEmail, "ACCESS_RESTORED", text(body.note, MAX_TEXT) || `Access restored. Current lifecycle status: ${status}.`); }
  else { const note = text(body.internal_note); await client.entities.UserAccessProfile.update(text(profile.id, 120), { internal_note: note }); await accessAudit(client, owner, text(selected.row.user_id, 160), actorEmail, "INTERNAL_NOTE_UPDATED", note ? "Internal note updated." : "Internal note cleared."); }
  const resultAction = action === "restrict" ? "ACCESS_RESTRICTED" : action === "restore" ? "ACCESS_RESTORED" : "INTERNAL_NOTE_UPDATED"; return { ok: true, action: resultAction, user: await updatedUser(client, owner, actorId, actorEmail), audit: { action: resultAction, occurred_at: now } };
}
async function changeRole(client: Client, body: JsonRecord, action: "grant_admin" | "revoke_admin", actorId: string, actorEmail: string): Promise<JsonRecord> {
  const selected = await roleTarget(client, body); const row = selected.row; if (row.is_root_admin === true) throw new InputError("The primary administrator is protected and cannot be changed."); const matches = grantMatches(selected.grants, { user_id: row.user_id, email: row.email }); const active = matches.filter((grant) => grantStatus(grant) === "ACTIVE");
  if (action === "revoke_admin") {
    if (row.is_current_admin || (actorId && row.user_id === actorId) || (actorEmail && row.email === actorEmail)) throw new InputError("You cannot remove your own administrator access.");
    if (!active.length) return { ok: true, action: "ADMIN_ALREADY_REVOKED", user: await updatedUser(client, row.email, actorId, actorEmail), audit: { action: "ADMIN_ALREADY_REVOKED", occurred_at: new Date().toISOString() } };
    const now = new Date().toISOString(); const note = text(body.note ?? body.reason, MAX_TEXT) || "Administrator access revoked."; await Promise.all(active.map((grant) => client.entities.AdminGrant.update(text(grant.id, 160), { status: "REVOKED", revoked_at: now, revoked_by: actorEmail, note }))); await accessAudit(client, row.email, row.user_id, actorEmail, "ADMIN_REVOKED", note); return { ok: true, action: "ADMIN_REVOKED", user: await updatedUser(client, row.email, actorId, actorEmail), audit: { action: "ADMIN_REVOKED", occurred_at: now } };
  }
  if (active.length) return { ok: true, action: "ADMIN_ALREADY_GRANTED", user: await updatedUser(client, row.email, actorId, actorEmail), audit: { action: "ADMIN_ALREADY_GRANTED", occurred_at: new Date().toISOString() } };
  const existing = newestGrant(matches); const now = new Date().toISOString(); const note = text(body.note ?? body.reason, MAX_TEXT) || "Administrator access granted."; const data = { user_id: row.user_id, user_email: row.email, role: "administrator", status: "ACTIVE", granted_at: now, granted_by: actorEmail, revoked_at: "", revoked_by: "", note };
  if (existing?.id) await client.entities.AdminGrant.update(text(existing.id, 160), data); else await client.entities.AdminGrant.create(data); await accessAudit(client, row.email, row.user_id, actorEmail, "ADMIN_GRANTED", note); return { ok: true, action: "ADMIN_GRANTED", user: await updatedUser(client, row.email, actorId, actorEmail), audit: { action: "ADMIN_GRANTED", occurred_at: now } };
}
function actorLabel(value: unknown, targetEmail: string): string { const actor = email(value); if (actor === "system") return "System"; if (actor === ADMIN_EMAIL) return "Administrator"; if (actor && actor === targetEmail) return "User account"; return actor ? "Authorized staff" : "System"; }
function accessHistoryRow(row: JsonRecord): JsonRecord | null { const targetEmail = email(row.target_user_email); if (!targetEmail || targetEmail === ADMIN_EMAIL) return null; return { id: text(row.id, 120), kind: "access", action: text(row.action, 64), target_user_email: targetEmail, actor_label: actorLabel(row.actor_email, targetEmail), occurred_at: timestamp(row.occurred_at ?? row.created_at), note: text(row.note, MAX_TEXT), related_payment_id: text(row.related_payment_id, 120), related_subscription_id: text(row.related_subscription_id, 120), summary: text(row.note, MAX_TEXT), metadata_text: "" }; }
function billingHistoryRow(row: JsonRecord): JsonRecord | null { const targetEmail = email(row.subject_email); if (targetEmail === ADMIN_EMAIL) return null; return { id: text(row.id, 120), kind: "billing", action: text(row.action, 64), target_user_email: targetEmail, actor_label: actorLabel(row.actor_email, targetEmail), occurred_at: timestamp(row.created_at), note: text(row.summary, 500), related_payment_id: text(row.related_payment_id, 120), related_subscription_id: text(row.related_subscription_id, 120), summary: text(row.summary, 500), metadata_text: text(row.metadata_text, 500) }; }
async function history(client: Client, body: JsonRecord): Promise<JsonRecord> { const kind = text(body.kind, 20).toLowerCase(); const [access, billing] = await Promise.all([kind === "billing" ? Promise.resolve([]) : listAccessAudits(client), kind === "access" ? Promise.resolve([]) : listBillingAudits(client)]); return { access_events: access.map(accessHistoryRow).filter(Boolean).slice(0, 200), billing_events: billing.map(billingHistoryRow).filter(Boolean).slice(0, 200) }; }
function settingField(value: unknown, key: keyof typeof APP_SETTINGS_LIMITS): string { if (typeof value !== "string") throw new InputError(`A ${key.replace("_", " ")} is required.`); if (value.length > APP_SETTINGS_LIMITS[key]) throw new InputError(`The ${key.replace("_", " ")} is too long.`); const result = text(value, APP_SETTINGS_LIMITS[key]); if (!result) throw new InputError(`A ${key.replace("_", " ")} is required.`); return result; }
function sanitizedSupportSlackUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > SUPPORT_SLACK_URL_MAX) return "";
  const candidate = value.trim();
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) return "";
    return parsed.toString();
  } catch { return ""; }
}
function supportSlackUrl(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > SUPPORT_SLACK_URL_MAX) throw new InputError("Enter an HTTPS Slack support URL under 500 characters, or leave it blank.");
  const result = sanitizedSupportSlackUrl(value);
  if (value.trim() && !result) throw new InputError("Enter a valid HTTPS Slack support URL, or leave it blank.");
  return result;
}
function sanitizedSupportEmail(value: unknown): string {
  if (typeof value !== "string" || value.length > NOTIFICATION_EMAIL_MAX) return "";
  const candidate = value.trim().toLowerCase();
  return candidate && NOTIFICATION_EMAIL_PATTERN.test(candidate) ? candidate : "";
}
function supportEmail(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > NOTIFICATION_EMAIL_MAX) throw new InputError("Enter a valid support email address under 254 characters, or leave it blank.");
  const result = sanitizedSupportEmail(value);
  if (value.trim() && !result) throw new InputError("Enter a valid support email address, or leave it blank.");
  return result;
}
function supportToggle(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new InputError(`${label} enabled state must be true or false.`);
  return value;
}
function safeAppSettings(row?: JsonRecord): JsonRecord { return { id: text(row?.id, 120), settings_key: "default", workspace_name: text(row?.workspace_name, APP_SETTINGS_LIMITS.workspace_name) || String(DEFAULT_APP_SETTINGS.workspace_name), short_label: text(row?.short_label, APP_SETTINGS_LIMITS.short_label) || String(DEFAULT_APP_SETTINGS.short_label), description: text(row?.description, APP_SETTINGS_LIMITS.description) || String(DEFAULT_APP_SETTINGS.description), support_slack_url: sanitizedSupportSlackUrl(row?.support_slack_url), support_email: sanitizedSupportEmail(row?.support_email), support_slack_enabled: typeof row?.support_slack_enabled === "boolean" ? row.support_slack_enabled : Boolean(DEFAULT_APP_SETTINGS.support_slack_enabled), support_email_enabled: typeof row?.support_email_enabled === "boolean" ? row.support_email_enabled : Boolean(DEFAULT_APP_SETTINGS.support_email_enabled), support_ai_help_desk_enabled: typeof row?.support_ai_help_desk_enabled === "boolean" ? row.support_ai_help_desk_enabled : Boolean(DEFAULT_APP_SETTINGS.support_ai_help_desk_enabled) }; }
async function appSettings(client: Client): Promise<JsonRecord> { const rows = await client.entities.AppSettings.filter({ settings_key: "default" }, "-updated_at", 20) as JsonRecord[]; const selected = Array.isArray(rows) ? rows.find((row) => Boolean(text(row.id, 120))) : undefined; return { settings: safeAppSettings(selected), source: selected ? "saved" : "default" }; }
function notificationEmailField(value: unknown): string { if (typeof value !== "string") throw new InputError("Enter an alert email address."); if (value.length > NOTIFICATION_EMAIL_MAX) throw new InputError("Enter an alert email address under 254 characters."); const result = value.trim().toLowerCase(); if (!result || result.length > NOTIFICATION_EMAIL_MAX) throw new InputError("Enter an alert email address under 254 characters."); if (!NOTIFICATION_EMAIL_PATTERN.test(result)) throw new InputError("Enter a valid alert email address."); return result; }
function notificationToggle(value: unknown): boolean { if (typeof value !== "boolean") throw new InputError("Choose whether access request alerts are enabled."); return value; }
function safeNotificationSettings(row?: JsonRecord): JsonRecord { const candidate = typeof row?.recipient_email === "string" ? row.recipient_email.trim().toLowerCase() : ""; const recipient = candidate && candidate.length <= NOTIFICATION_EMAIL_MAX && NOTIFICATION_EMAIL_PATTERN.test(candidate) ? candidate : String(DEFAULT_NOTIFICATION_SETTINGS.recipient_email); const enabled = typeof row?.enabled === "boolean" ? row.enabled : Boolean(DEFAULT_NOTIFICATION_SETTINGS.enabled); return { id: text(row?.id, 120), settings_key: "default", recipient_email: recipient, enabled, updated_by: email(row?.updated_by) || "System" }; }
async function notificationSettings(client: Client): Promise<JsonRecord> { const rows = await client.entities.AdminNotificationSettings.filter({ settings_key: "default" }, "-updated_at", 20) as JsonRecord[]; const selected = Array.isArray(rows) ? rows.find((row) => Boolean(text(row.id, 120))) : undefined; return { settings: safeNotificationSettings(selected), source: selected ? "saved" : "default" }; }
async function messageTemplates(client: Client): Promise<JsonRecord> {
  const rows = await client.entities.AdminMessageTemplates.filter({ settings_key: "default" }, "-updated_at", 20) as JsonRecord[];
  const selected = Array.isArray(rows) ? rows.find((row) => Boolean(text(row.id, 120))) : undefined;
  return { templates: safeMessageTemplates(selected), source: selected ? "saved" : "default" };
}
function savedMessageSubject(value: unknown, label: string): string {
  if (typeof value !== "string") throw new InputError(`${label} must be plain text.`);
  if (value.length > MESSAGE_SUBJECT_MAX) throw new InputError(`${label} must be ${MESSAGE_SUBJECT_MAX} characters or fewer.`);
  const result = messageSubject(value, "");
  if (!result) throw new InputError(`${label} is required.`);
  return result;
}
function savedMessageBody(value: unknown, label: string): string {
  if (typeof value !== "string") throw new InputError(`${label} must be plain text.`);
  if (value.length > MESSAGE_BODY_MAX) throw new InputError(`${label} must be ${MESSAGE_BODY_MAX} characters or fewer.`);
  const result = messagePlainText(value);
  if (!result) throw new InputError(`${label} is required.`);
  return result;
}
async function saveMessageTemplates(client: Client, body: JsonRecord, actorEmail: string): Promise<JsonRecord> {
  if (Object.keys(body).some((key) => !["action", "templates"].includes(key))) throw new InputError("Only the three user email messages can be changed.");
  const input = body.templates && typeof body.templates === "object" && !Array.isArray(body.templates) ? body.templates as JsonRecord : undefined;
  if (!input) throw new InputError("The user email messages are required.");
  if (Object.keys(input).some((key) => !MESSAGE_FIELDS.includes(key as keyof MessageTemplates))) throw new InputError("Only the six message subject and body fields can be changed.");
  const data: JsonRecord = { settings_key: "default", updated_by: email(actorEmail) };
  data.signup_subject = savedMessageSubject(input.signup_subject, "The signup subject");
  data.signup_body = savedMessageBody(input.signup_body, "The signup message");
  data.payment_submitted_subject = savedMessageSubject(input.payment_submitted_subject, "The payment submitted subject");
  data.payment_submitted_body = savedMessageBody(input.payment_submitted_body, "The payment submitted message");
  data.payment_approved_subject = savedMessageSubject(input.payment_approved_subject, "The payment approved subject");
  data.payment_approved_body = savedMessageBody(input.payment_approved_body, "The payment approved message");
  const rows = await client.entities.AdminMessageTemplates.filter({ settings_key: "default" }, "-updated_at", 20) as JsonRecord[];
  const existing = Array.isArray(rows) ? rows.find((row) => Boolean(text(row.id, 120))) : undefined;
  const saved = existing?.id
    ? await client.entities.AdminMessageTemplates.update(text(existing.id, 120), data) as JsonRecord
    : await client.entities.AdminMessageTemplates.create(data) as JsonRecord;
  if (Array.isArray(rows) && rows.length > 1) await Promise.all(rows.slice(1).map(async (row) => {
    const id = text(row.id, 120);
    if (id) { try { await client.entities.AdminMessageTemplates.delete(id); } catch { /* retain the active record if duplicate cleanup is unavailable */ } }
  }));
  return { templates: safeMessageTemplates({ ...(existing || {}), ...data, ...(saved || {}) }), source: "saved" };
}
async function saveNotificationSettings(client: Client, body: JsonRecord, actorEmail: string): Promise<JsonRecord> { if (Object.keys(body).some((key) => !["action", "recipient_email", "enabled"].includes(key))) throw new InputError("Only the alert email and enabled state can be changed."); const data = { settings_key: "default", recipient_email: notificationEmailField(body.recipient_email), enabled: notificationToggle(body.enabled), updated_by: email(actorEmail) }; const rows = await client.entities.AdminNotificationSettings.filter({ settings_key: "default" }, "-updated_at", 20) as JsonRecord[]; const existing = Array.isArray(rows) ? rows.find((row) => Boolean(text(row.id, 120))) : undefined; const saved = existing?.id ? await client.entities.AdminNotificationSettings.update(text(existing.id, 120), data) as JsonRecord : await client.entities.AdminNotificationSettings.create(data) as JsonRecord; if (Array.isArray(rows) && rows.length > 1) await Promise.all(rows.slice(1).map(async (row) => { const id = text(row.id, 120); if (id) { try { await client.entities.AdminNotificationSettings.delete(id); } catch { /* retain the active record if duplicate cleanup is unavailable */ } } })); return { settings: safeNotificationSettings({ ...(existing || {}), ...data, ...(saved || {}) }), source: "saved" }; }
async function saveAppSettings(client: Client, body: JsonRecord): Promise<JsonRecord> { const data = { settings_key: "default", workspace_name: settingField(body.workspace_name, "workspace_name"), short_label: settingField(body.short_label, "short_label"), description: settingField(body.description, "description") }; const rows = await client.entities.AppSettings.filter({ settings_key: "default" }, "-updated_at", 20) as JsonRecord[]; const existing = Array.isArray(rows) ? rows.find((row) => Boolean(text(row.id, 120))) : undefined; const saved = existing?.id ? await client.entities.AppSettings.update(text(existing.id, 120), data) as JsonRecord : await client.entities.AppSettings.create(data) as JsonRecord; if (Array.isArray(rows) && rows.length > 1) await Promise.all(rows.slice(1).map(async (row) => { const id = text(row.id, 120); if (id) { try { await client.entities.AppSettings.delete(id); } catch { /* retain the active record if duplicate cleanup is unavailable */ } } })); return { settings: safeAppSettings({ ...(existing || {}), ...data, ...(saved || {}) }), source: "saved" }; }
async function saveSupportSettings(client: Client, body: JsonRecord): Promise<JsonRecord> {
  const allowedFields = ["action", "support_slack_url", "support_email", "support_slack_enabled", "support_email_enabled", "support_ai_help_desk_enabled"];
  if (Object.keys(body).some((key) => !allowedFields.includes(key))) throw new InputError("Only the contact destinations and enabled states can be changed here.");
  const rows = await client.entities.AppSettings.filter({ settings_key: "default" }, "-updated_at", 20) as JsonRecord[];
  const existing = Array.isArray(rows) ? rows.find((row) => Boolean(text(row.id, 120))) : undefined;
  const current = safeAppSettings(existing);
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const support_slack_url = has("support_slack_url") ? supportSlackUrl(body.support_slack_url) : String(current.support_slack_url || "");
  const support_email = has("support_email") ? supportEmail(body.support_email) : String(current.support_email || "");
  const support_slack_enabled = has("support_slack_enabled") ? supportToggle(body.support_slack_enabled, "Slack contact option") : current.support_slack_enabled === true;
  const support_email_enabled = has("support_email_enabled") ? supportToggle(body.support_email_enabled, "Email contact option") : current.support_email_enabled === true;
  const support_ai_help_desk_enabled = has("support_ai_help_desk_enabled") ? supportToggle(body.support_ai_help_desk_enabled, "AI Help Desk contact option") : current.support_ai_help_desk_enabled !== false;
  if (support_slack_enabled && !support_slack_url) throw new InputError("Add a valid HTTPS Slack support URL before enabling the Slack contact option.");
  if (support_email_enabled && !support_email) throw new InputError("Add a valid support email address before enabling the email contact option.");
  const data = { support_slack_url, support_email, support_slack_enabled, support_email_enabled, support_ai_help_desk_enabled };
  const saved = existing?.id
    ? await client.entities.AppSettings.update(text(existing.id, 120), data) as JsonRecord
    : await client.entities.AppSettings.create({ ...DEFAULT_APP_SETTINGS, ...data }) as JsonRecord;
  if (Array.isArray(rows) && rows.length > 1) await Promise.all(rows.slice(1).map(async (row) => {
    const id = text(row.id, 120);
    if (id) { try { await client.entities.AppSettings.delete(id); } catch { /* retain the active record if duplicate cleanup is unavailable */ } }
  }));
  return { settings: safeAppSettings({ ...(existing || {}), ...data, ...(saved || {}) }), source: "saved" };
}
function requestMessage(value: unknown): string { return typeof value === "string" ? value.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").slice(0, 500) : ""; }
function requestStatus(value: unknown): "NEW" | "REVIEWED" | "APPROVED" { const status = text(value, 20).toUpperCase(); return ACCESS_REQUEST_STATUSES.has(status) ? status as "NEW" | "REVIEWED" | "APPROVED" : "NEW"; }
function safeAccessRequest(row: JsonRecord): JsonRecord { return { id: text(row.id, 120), name: text(row.name, 120), contact_email: email(row.contact_email), message: requestMessage(row.message), submitted_at: timestamp(row.submitted_at ?? row.created_at), status: requestStatus(row.status), private_note: text(row.private_note, MAX_TEXT), reviewed_by: email(row.reviewed_by), reviewed_at: timestamp(row.reviewed_at), approved_by: email(row.approved_by), approved_at: timestamp(row.approved_at) }; }
function searchValue(value: unknown): string { return text(value, SUPPORT_SEARCH_MAX).toLowerCase(); }
function selectedStatus(value: unknown, allowed: Set<string>, label: string): string {
  const candidate = text(value, 32).toUpperCase();
  if (!candidate || candidate === "ALL") return "";
  if (!allowed.has(candidate)) throw new InputError(`Choose a valid ${label} status.`);
  return candidate;
}
function containsSearch(values: unknown[], search: string): boolean {
  if (!search) return true;
  return values.some((value) => typeof value === "string" && value.toLowerCase().includes(search));
}
function accessRequests(client: Client, body: JsonRecord = {}): Promise<JsonRecord> {
  return client.entities.AccessRequest.list("-submitted_at", SUPPORT_LIST_LIMIT).then((rows) => {
    const search = searchValue(body.search);
    const status = selectedStatus(body.status, ACCESS_REQUEST_STATUSES, "access request");
    const requests = (Array.isArray(rows) ? rows : []).map(safeAccessRequest).filter((row) => {
      if (!row.id || (status && row.status !== status)) return false;
      return containsSearch([row.name, row.contact_email, row.message, row.private_note, row.status], search);
    });
    const counts = { total: requests.length, new: 0, reviewed: 0, approved: 0 };
    requests.forEach((row) => { const current = row.status as string; if (current === "NEW") counts.new += 1; else if (current === "REVIEWED") counts.reviewed += 1; else counts.approved += 1; });
    return { requests, counts };
  });
}
async function updateAccessRequest(client: Client, body: JsonRecord, actorEmail: string): Promise<JsonRecord> { const id = text(body.request_id, 120); if (!id) throw new InputError("A request id is required."); const statusValue = text(body.status, 20).toUpperCase(); if (!ACCESS_REQUEST_STATUSES.has(statusValue)) throw new InputError("Choose New, Reviewed, or Approved."); if (body.private_note !== undefined && typeof body.private_note !== "string") throw new InputError("The private note must be text."); const current = await client.entities.AccessRequest.get(id) as JsonRecord; if (!current || !text(current.id, 120)) throw new InputError("The access request was not found."); const prior = requestStatus(current.status); const patch: JsonRecord = { status: statusValue, private_note: text(body.private_note, MAX_TEXT) }; if (statusValue !== prior) { const now = new Date().toISOString(); if (statusValue === "NEW") Object.assign(patch, { reviewed_by: "", reviewed_at: "", approved_by: "", approved_at: "" }); if (statusValue === "REVIEWED") Object.assign(patch, { reviewed_by: actorEmail, reviewed_at: now, approved_by: "", approved_at: "" }); if (statusValue === "APPROVED") Object.assign(patch, { reviewed_by: email(current.reviewed_by) || actorEmail, reviewed_at: timestamp(current.reviewed_at) || now, approved_by: actorEmail, approved_at: now }); } const saved = await client.entities.AccessRequest.update(id, patch) as JsonRecord; return { ok: true, request: safeAccessRequest({ ...current, ...patch, ...(saved || {}) }) }; }

async function accessRequestDetail(client: Client, body: JsonRecord): Promise<JsonRecord> {
  const id = text(body.access_request_id, 120);
  if (!id) throw new InputError("An access request id is required.");
  const request = await client.entities.AccessRequest.get(id) as JsonRecord;
  if (!request || !text(request.id, 120)) throw new InputError("The access request was not found.");
  const rows = await client.entities.SupportMessage.filter({ access_request_id: id }, "sent_at", SUPPORT_MESSAGE_LIMIT) as JsonRecord[];
  const replies = (Array.isArray(rows) ? rows : []).map(safeSupportMessage).filter((row) => row.role === "admin" && Boolean(row.id && row.message_text));
  return { request: safeAccessRequest(request), replies };
}

type AdminReplyTargetKind = "access_request" | "support_conversation" | "human_support";
type AdminReplyTarget = { kind: AdminReplyTargetKind; row: JsonRecord; recipientEmail: string; accessRequestId: string; conversationToken: string; ownerUserId: string; ownerEmail: string };

function replyIdentifier(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new InputError(`${label} is invalid.`);
  const result = value.replace(/[\u0000-\u001F]/g, " ").trim();
  if (!result) throw new InputError(`${label} is required.`);
  return result;
}
function replyRecipient(value: unknown): string {
  const result = email(value);
  if (!result || result.length > NOTIFICATION_EMAIL_MAX || !NOTIFICATION_EMAIL_PATTERN.test(result)) throw new InputError("This thread has no valid requester email.");
  return result;
}
function replySubject(value: unknown): string {
  if (typeof value !== "string" || value.length > MESSAGE_SUBJECT_MAX) throw new InputError(`The subject must be ${MESSAGE_SUBJECT_MAX} characters or fewer.`);
  const result = messageSubject(value, "");
  if (!result) throw new InputError("A subject is required.");
  return result;
}
function replyBody(value: unknown): string {
  if (typeof value !== "string" || value.length > MESSAGE_BODY_MAX) throw new InputError(`The message must be ${MESSAGE_BODY_MAX} characters or fewer.`);
  const result = messagePlainText(value);
  if (!result) throw new InputError("A message is required.");
  return result;
}
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}
function replyHtml(value: string): string { return escapeHtml(value).replace(/\n/g, "<br />"); }
function deliveryMetadata(value: unknown): { message_id: string; delivery_status: string } {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
  const messageId = text(row.message_id ?? row.id ?? row.request_id, 160);
  const deliveryStatus = text(row.delivery_status ?? row.status, 48).toLowerCase() || "sent";
  return { message_id: messageId, delivery_status: deliveryStatus };
}
async function resolveAdminReplyTarget(client: Client, body: JsonRecord): Promise<AdminReplyTarget> {
  const kind = text(body.target_kind, 40).toLowerCase() as AdminReplyTargetKind;
  const accessRequestId = typeof body.access_request_id === "string" ? body.access_request_id.trim() : "";
  const conversationToken = typeof body.conversation_token === "string" ? body.conversation_token.trim() : "";
  const supportRequestId = typeof body.support_request_id === "string" ? body.support_request_id.trim() : "";
  if (!["access_request", "support_conversation", "human_support"].includes(kind)) throw new InputError("Choose a valid protected reply target.");
  const selectedCount = [accessRequestId, conversationToken, supportRequestId].filter(Boolean).length;
  if (selectedCount !== 1) throw new InputError("Provide exactly one protected reply target.");
  if (kind === "access_request") {
    const id = replyIdentifier(accessRequestId, "The access request id", 120);
    const row = await client.entities.AccessRequest.get(id) as JsonRecord;
    if (!row || !text(row.id, 120)) throw new InputError("The access request was not found.");
    return { kind, row, recipientEmail: replyRecipient(row.contact_email), accessRequestId: id, conversationToken: "", ownerUserId: "", ownerEmail: "" };
  }
  if (kind === "support_conversation") {
    const token = replyIdentifier(conversationToken, "The conversation token", 256);
    const rows = await client.entities.SupportConversation.filter({ conversation_token: token }, "-updated_at", 5) as JsonRecord[];
    const row = Array.isArray(rows) ? rows.find((item) => text(item.conversation_token, 256) === token) : undefined;
    if (!row || !text(row.id, 120)) throw new InputError("The support conversation was not found.");
    return { kind, row, recipientEmail: replyRecipient(row.visitor_email || row.owner_email), accessRequestId: "", conversationToken: token, ownerUserId: text(row.owner_user_id, 160), ownerEmail: email(row.owner_email) };
  }
  const id = replyIdentifier(supportRequestId, "The human support request id", 120);
  const row = await client.entities.HumanSupportRequest.get(id) as JsonRecord;
  if (!row || !text(row.id, 120)) throw new InputError("The human support request was not found.");
  return { kind, row, recipientEmail: replyRecipient(row.requester_email || row.owner_email), accessRequestId: "", conversationToken: text(row.conversation_token, 256), ownerUserId: text(row.owner_user_id, 160), ownerEmail: email(row.owner_email) };
}
async function sendAdminReply(client: Client, request: Request, body: JsonRecord, actorEmail: string): Promise<JsonRecord> {
  const allowedFields = ["action", "target_kind", "access_request_id", "conversation_token", "support_request_id", "subject", "body"];
  if (Object.keys(body).some((key) => !allowedFields.includes(key))) throw new InputError("Only a protected target, subject, and message can be sent.");
  const subject = replySubject(body.subject);
  const message = replyBody(body.body);
  const target = await resolveAdminReplyTarget(client, body);
  const integration = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
  let delivery: { message_id: string; delivery_status: string };
  try {
    const result = await integration.integrations.core.sendEmail({
      to: target.recipientEmail,
      subject,
      from_name: "Verbatim Desk Support",
      reply_to: ADMIN_EMAIL,
      body_html: `<div style="margin:0;padding:28px;background:#f4f1eb;color:#17202b;font-family:Arial,sans-serif;line-height:1.55"><div style="max-width:600px;margin:0 auto;padding:28px;background:#ffffff;border:1px solid #ded8cf;border-radius:14px"><p style="margin:0 0 8px;color:#168b72;font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase">Verbatim Desk Support</p><h1 style="margin:0 0 22px;font-size:24px;line-height:1.2">A message from the Verbatim Desk team</h1><p style="margin:0 0 22px">${replyHtml(message)}</p><p style="margin:22px 0 0;color:#6b7280;font-size:12px">Please reply to this email if you need more help.</p></div></div>`,
    }, { headers: integrationHeaders(request) }) as unknown;
    delivery = deliveryMetadata(result);
  } catch {
    console.error("admin-access administrator reply email failed", target.kind);
    throw new Error("The administrator email could not be sent.");
  }
  const now = new Date().toISOString();
  let saved: JsonRecord;
  try {
    saved = await client.entities.SupportMessage.create({
      conversation_token: target.conversationToken,
      access_request_id: target.accessRequestId,
      owner_user_id: target.ownerUserId,
      owner_email: target.ownerEmail,
      role: "admin",
      message_text: message,
      source: "administrator_email",
      recipient_email: target.recipientEmail,
      subject,
      delivery_status: delivery.delivery_status,
      sent_at: now,
    }) as JsonRecord;
    if (target.kind === "access_request") {
      const currentStatus = requestStatus(target.row.status);
      if (currentStatus !== "APPROVED") await client.entities.AccessRequest.update(target.accessRequestId, { status: "REVIEWED", reviewed_by: actorEmail, reviewed_at: now });
    }
    if (target.kind === "human_support") {
      const currentStatus = humanStatus(target.row.status);
      const patch: JsonRecord = { last_updated_at: now, last_updated_by: actorEmail };
      if (currentStatus === "NEW") Object.assign(patch, { status: "IN_PROGRESS", assigned_admin: email(target.row.assigned_admin) || actorEmail, status_updated_at: now, status_updated_by: actorEmail, resolved_at: "" });
      await client.entities.HumanSupportRequest.update(text(target.row.id, 120), patch);
      if (currentStatus !== "RESOLVED" && target.conversationToken) {
        const rows = await client.entities.SupportConversation.filter({ conversation_token: target.conversationToken }, "-updated_at", 5) as JsonRecord[];
        const conversation = Array.isArray(rows) ? rows.find((item) => text(item.id, 120)) : undefined;
        if (conversation?.id) await client.entities.SupportConversation.update(text(conversation.id, 120), { status: "HUMAN_REQUESTED" });
      }
    }
  } catch {
    console.error("admin-access administrator reply history failed", target.kind);
    throw new Error("The email could not be recorded in the protected thread.");
  }
  return { ok: true, message_id: delivery.message_id || text(saved?.id, 120), delivery_status: delivery.delivery_status, sent_at: now };
}

function conversationStatus(value: unknown): string {
  const candidate = text(value, 32).toUpperCase();
  return SUPPORT_CONVERSATION_STATUSES.has(candidate) ? candidate : "OPEN";
}
function humanStatus(value: unknown): string {
  const candidate = text(value, 32).toUpperCase();
  return HUMAN_SUPPORT_STATUSES.has(candidate) ? candidate : "NEW";
}
function supportMessageCount(value: unknown): number {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate >= 0 ? Math.min(100_000, Math.floor(candidate)) : 0;
}
function safeConversation(row: JsonRecord): JsonRecord {
  return {
    id: text(row.id, 120),
    conversation_token: text(row.conversation_token, 256),
    visitor_name: text(row.visitor_name, 120),
    visitor_email: email(row.visitor_email) || email(row.owner_email),
    source: text(row.source, 24) || "guest",
    status: conversationStatus(row.status),
    human_requested: row.human_requested === true,
    human_requested_at: timestamp(row.human_requested_at),
    human_support_request_id: text(row.human_support_request_id, 120),
    started_at: timestamp(row.started_at ?? row.created_at),
    last_message_at: timestamp(row.last_message_at ?? row.updated_at ?? row.created_at),
    message_count: supportMessageCount(row.message_count),
    last_message_preview: messagePlainText(row.last_message_preview, 320),
  };
}
function safeSupportMessage(row: JsonRecord): JsonRecord {
  const candidate = text(row.role, 24).toLowerCase();
  const role = candidate === "user" || candidate === "assistant" || candidate === "system" || candidate === "admin" ? candidate : "system";
  return {
    id: text(row.id, 120),
    role,
    message_text: messagePlainText(row.message_text, MAX_TEXT),
    source: text(row.source, 64),
    access_request_id: text(row.access_request_id, 120),
    recipient_email: email(row.recipient_email),
    subject: messageSubject(row.subject, ""),
    delivery_status: text(row.delivery_status, 48).toLowerCase(),
    sent_at: timestamp(row.sent_at ?? row.created_at),
  };
}
function notificationReadBy(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => email(item)).filter(Boolean))];
}
function safeNotification(row: JsonRecord, actorEmail: string): JsonRecord {
  const candidate = text(row.event_type, 32).toUpperCase();
  const eventType = candidate === "ACCESS_REQUEST" || candidate === "HUMAN_SUPPORT" || candidate === "SUPPORT_EVENT" ? candidate : "SUPPORT_EVENT";
  return {
    id: text(row.id, 120),
    event_type: eventType,
    title: text(row.title, 160),
    message: messagePlainText(row.message, 500),
    related_access_request_id: text(row.related_access_request_id, 120),
    conversation_token: text(row.conversation_token, 256),
    human_support_request_id: text(row.human_support_request_id, 120),
    created_at: timestamp(row.created_at),
    is_read: notificationReadBy(row.read_by).includes(actorEmail),
  };
}
function safeHumanSupport(row: JsonRecord): JsonRecord {
  return {
    id: text(row.id, 120),
    conversation_token: text(row.conversation_token, 256),
    requester_name: text(row.requester_name, 120),
    requester_email: email(row.requester_email),
    owner_email: email(row.owner_email),
    reason: messagePlainText(row.reason, MAX_TEXT),
    summary: messagePlainText(row.summary, MAX_TEXT),
    resolution_summary: messagePlainText(row.resolution_summary, MAX_TEXT),
    status: humanStatus(row.status),
    requested_at: timestamp(row.requested_at ?? row.created_at),
    assigned_admin: email(row.assigned_admin),
    private_note: messagePlainText(row.private_note, MAX_TEXT),
    resolved_at: timestamp(row.resolved_at),
    last_updated_at: timestamp(row.last_updated_at ?? row.updated_at),
    last_updated_by: email(row.last_updated_by),
    status_updated_at: timestamp(row.status_updated_at),
    status_updated_by: email(row.status_updated_by),
  };
}
async function listNotifications(client: Client): Promise<JsonRecord[]> {
  const rows = await client.entities.AdminNotification.list("-created_at", SUPPORT_LIST_LIMIT) as JsonRecord[];
  return Array.isArray(rows) ? rows : [];
}
async function notifications(client: Client, body: JsonRecord, actorEmail: string): Promise<JsonRecord> {
  const search = searchValue(body.search);
  const rows = await listNotifications(client);
  const safe = rows.map((row) => safeNotification(row, actorEmail)).filter((row) => containsSearch([row.event_type, row.title, row.message], search));
  return { notifications: safe, unread_count: safe.filter((row) => row.is_read !== true).length, count: safe.length };
}
async function markNotificationRead(client: Client, body: JsonRecord, actorEmail: string): Promise<JsonRecord> {
  const id = text(body.notification_id, 120);
  if (!id) throw new InputError("A notification id is required.");
  const current = await client.entities.AdminNotification.get(id) as JsonRecord;
  if (!current || !text(current.id, 120)) throw new InputError("The notification was not found.");
  const readBy = notificationReadBy(current.read_by);
  if (!readBy.includes(actorEmail)) {
    readBy.push(actorEmail);
    await client.entities.AdminNotification.update(id, { read_by: readBy });
  }
  const next = { ...current, read_by: readBy };
  const remaining = (await listNotifications(client)).map((row) => safeNotification(row, actorEmail)).filter((row) => row.is_read !== true).length;
  return { ok: true, notification: safeNotification(next, actorEmail), unread_count: remaining };
}
async function supportConversations(client: Client, body: JsonRecord): Promise<JsonRecord> {
  const search = searchValue(body.search);
  const status = selectedStatus(body.status, SUPPORT_CONVERSATION_STATUSES, "conversation");
  const humanFilter = text(body.human_help, 24).toLowerCase();
  if (humanFilter && !["all", "requested", "yes", "true", "not_requested", "no", "false"].includes(humanFilter)) throw new InputError("Choose a valid human-help filter.");
  const rows = await client.entities.SupportConversation.list("-last_message_at", SUPPORT_LIST_LIMIT) as JsonRecord[];
  const conversations = (Array.isArray(rows) ? rows : []).map(safeConversation).filter((row) => {
    if (!row.id || (status && row.status !== status)) return false;
    if (["requested", "yes", "true"].includes(humanFilter) && row.human_requested !== true) return false;
    if (["not_requested", "no", "false"].includes(humanFilter) && row.human_requested === true) return false;
    return containsSearch([row.visitor_name, row.visitor_email, row.status, row.last_message_preview], search);
  });
  return { conversations, count: conversations.length };
}
async function conversationDetail(client: Client, body: JsonRecord): Promise<JsonRecord> {
  const token = text(body.conversation_token ?? body.conversation_id, 256);
  if (!token) throw new InputError("A conversation id is required.");
  const rows = await client.entities.SupportConversation.filter({ conversation_token: token }, "-updated_at", 5) as JsonRecord[];
  const conversation = Array.isArray(rows) ? rows.find((row) => text(row.conversation_token, 256) === token) : undefined;
  if (!conversation || !text(conversation.id, 120)) throw new InputError("The support conversation was not found.");
  const messageRows = await client.entities.SupportMessage.filter({ conversation_token: token }, "sent_at", SUPPORT_MESSAGE_LIMIT) as JsonRecord[];
  const messages = (Array.isArray(messageRows) ? messageRows : []).map(safeSupportMessage).filter((row) => Boolean(row.id && row.message_text));
  return { conversation: safeConversation(conversation), messages };
}
async function humanSupportRequests(client: Client, body: JsonRecord): Promise<JsonRecord> {
  const search = searchValue(body.search);
  const status = selectedStatus(body.status, HUMAN_SUPPORT_STATUSES, "human support");
  const rows = await client.entities.HumanSupportRequest.list("-requested_at", SUPPORT_LIST_LIMIT) as JsonRecord[];
  const requests = (Array.isArray(rows) ? rows : []).map(safeHumanSupport).filter((row) => {
    if (!row.id || (status && row.status !== status)) return false;
    return containsSearch([row.requester_name, row.requester_email, row.owner_email, row.reason, row.summary, row.resolution_summary, row.private_note, row.status], search);
  });
  return { requests, count: requests.length };
}
async function humanSupportDetail(client: Client, body: JsonRecord): Promise<JsonRecord> {
  const id = text(body.support_request_id, 120);
  if (!id) throw new InputError("A human support request id is required.");
  const row = await client.entities.HumanSupportRequest.get(id) as JsonRecord;
  if (!row || !text(row.id, 120)) throw new InputError("The human support request was not found.");
  const token = text(row.conversation_token, 256);
  let conversation: JsonRecord | null = null;
  let messages: JsonRecord[] = [];
  if (token) {
    try {
      const detail = await conversationDetail(client, { conversation_token: token });
      conversation = detail.conversation as JsonRecord;
      messages = detail.messages as JsonRecord[];
    } catch {
      console.error("admin-access linked support conversation unavailable");
    }
  }
  return { request: safeHumanSupport(row), conversation, messages };
}
async function updateHumanSupport(client: Client, body: JsonRecord, actorEmail: string): Promise<JsonRecord> {
  if (Object.keys(body).some((key) => !["action", "support_request_id", "status", "private_note", "resolution_summary", "assigned_admin"].includes(key))) throw new InputError("Only support status, assignment, private notes, and resolution summaries can be changed.");
  const id = text(body.support_request_id, 120);
  if (!id) throw new InputError("A human support request id is required.");
  const current = await client.entities.HumanSupportRequest.get(id) as JsonRecord;
  if (!current || !text(current.id, 120)) throw new InputError("The human support request was not found.");
  const previousStatus = humanStatus(current.status);
  const nextStatus = body.status === undefined ? previousStatus : selectedStatus(body.status, HUMAN_SUPPORT_STATUSES, "human support");
  const patch: JsonRecord = {};
  if (body.private_note !== undefined) {
    if (typeof body.private_note !== "string" || body.private_note.length > MAX_TEXT) throw new InputError("The private note is too long.");
    patch.private_note = messagePlainText(body.private_note, MAX_TEXT);
  }
  if (body.resolution_summary !== undefined) {
    if (typeof body.resolution_summary !== "string" || body.resolution_summary.length > MAX_TEXT) throw new InputError("The resolution summary is too long.");
    patch.resolution_summary = messagePlainText(body.resolution_summary, MAX_TEXT);
  }
  if (body.assigned_admin !== undefined) {
    if (typeof body.assigned_admin !== "string" || body.assigned_admin.length > NOTIFICATION_EMAIL_MAX) throw new InputError("The assigned administrator email is invalid.");
    const candidate = body.assigned_admin.trim().toLowerCase();
    if (candidate && !NOTIFICATION_EMAIL_PATTERN.test(candidate)) throw new InputError("The assigned administrator email is invalid.");
    patch.assigned_admin = candidate;
  } else if (nextStatus === "IN_PROGRESS" && !email(current.assigned_admin)) {
    patch.assigned_admin = actorEmail;
  }
  if (body.status !== undefined) patch.status = nextStatus;
  const now = new Date().toISOString();
  patch.last_updated_at = now;
  patch.last_updated_by = actorEmail;
  if (nextStatus !== previousStatus) {
    patch.status_updated_at = now;
    patch.status_updated_by = actorEmail;
    patch.resolved_at = nextStatus === "RESOLVED" ? now : "";
  }
  const saved = await client.entities.HumanSupportRequest.update(id, patch) as JsonRecord;
  const merged = { ...current, ...patch, ...(saved || {}) };
  const token = text(current.conversation_token, 256);
  if (token) {
    try {
      const rows = await client.entities.SupportConversation.filter({ conversation_token: token }, "-updated_at", 5) as JsonRecord[];
      const conversation = Array.isArray(rows) ? rows.find((row) => text(row.id, 120)) : undefined;
      if (conversation?.id) await client.entities.SupportConversation.update(text(conversation.id, 120), { status: nextStatus === "RESOLVED" ? "RESOLVED" : "HUMAN_REQUESTED" });
    } catch { console.error("admin-access support conversation status sync failed"); }
  }
  return { ok: true, request: safeHumanSupport(merged), updated_at: now, updated_by: actorEmail };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return json(request, {}, 204); if (request.method !== "POST") return json(request, { error: "Use POST for administrator actions." }, 405);
  const auth = await adminContext(request); if (auth instanceof Response) return auth; let body: JsonRecord; try { body = await readBody(request); } catch (error) { return json(request, { error: error instanceof Error ? error.message : "The request body is invalid." }, 400); }
  const action = text(body.action, 40);
  try {
    if (action === "overview") { const data = await directory(auth.service, auth.actorId, auth.actorEmail); return json(request, { counts: counts(data.users, data.scope), scope: data.scope }); }
    if (action === "users") return json(request, await directory(auth.service, auth.actorId, auth.actorEmail));
    if (action === "user_detail" || action === "detail") { const selected = await target(auth.service, body, true, false); const rows = await listAccessAudits(auth.service); return json(request, { user: selected.row, history: rows.map(accessHistoryRow).filter((row) => row && row.target_user_email === selected.row.email).slice(0, 100) }); }
    if (action === "restrict" || action === "restore" || action === "note") return json(request, await changeAccess(auth.service, body, action, auth.actorId, auth.actorEmail));
    if (action === "grant_admin" || action === "revoke_admin") return json(request, await changeRole(auth.service, body, action, auth.actorId, auth.actorEmail));
    if (action === "history") return json(request, await history(auth.service, body));
    if (action === "app_settings") return json(request, await appSettings(auth.service));
    if (action === "save_app_settings") return json(request, await saveAppSettings(auth.service, body));
    if (action === "save_support_settings") return json(request, await saveSupportSettings(auth.service, body));
    if (action === "notification_settings") return json(request, await notificationSettings(auth.service));
    if (action === "message_templates") return json(request, await messageTemplates(auth.service));
    if (action === "save_message_templates") return json(request, await saveMessageTemplates(auth.service, body, auth.actorEmail));
    if (action === "save_notification_settings") return json(request, await saveNotificationSettings(auth.service, body, auth.actorEmail));
    if (action === "access_requests") return json(request, await accessRequests(auth.service, body));
    if (action === "access_request_detail") return json(request, await accessRequestDetail(auth.service, body));
    if (action === "update_access_request") return json(request, await updateAccessRequest(auth.service, body, auth.actorEmail));
    if (action === "send_admin_reply") return json(request, await sendAdminReply(auth.service, request, body, auth.actorEmail));
    if (action === "notifications") return json(request, await notifications(auth.service, body, auth.actorEmail));
    if (action === "mark_notification_read") return json(request, await markNotificationRead(auth.service, body, auth.actorEmail));
    if (action === "support_conversations") return json(request, await supportConversations(auth.service, body));
    if (action === "support_conversation_detail") return json(request, await conversationDetail(auth.service, body));
    if (action === "human_support_requests") return json(request, await humanSupportRequests(auth.service, body));
    if (action === "human_support_detail") return json(request, await humanSupportDetail(auth.service, body));
    if (action === "update_human_support") return json(request, await updateHumanSupport(auth.service, body, auth.actorEmail));
    throw new InputError("Unknown administrator action.");
  } catch (error) { const input = error instanceof InputError; console.error("admin-access failed", action, input ? error.message : "unexpected administrator error"); return json(request, { error: input ? error.message : "The administrator request could not be completed." }, input ? 400 : 500); }
});
