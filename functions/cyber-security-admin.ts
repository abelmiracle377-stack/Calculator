import { createSuperdevClient } from "npm:@superdevhq/client@0.1.56";

type JsonRecord = Record<string, unknown>;
type Client = ReturnType<typeof createSuperdevClient>;
type CyberAssetType = "Domain" | "Subdomain" | "IPv4" | "IPv6" | "Website" | "API endpoint" | "Network service";
type AuditOutcome = "SUCCESS" | "DENIED" | "VALIDATION_FAILED" | "ERROR";

class InputError extends Error {
  constructor(message: string) { super(message); this.name = "InputError"; }
}

const ADMIN_EMAIL = "abelmiracle377@gmail.com";
const MAX_REQUEST_BYTES = 120_000;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 600;
const MAX_SCOPE_TARGET = 500;
const MAX_EVIDENCE_REFERENCE = 500;
const MAX_NOTE = 600;
const MAX_LIST_ITEMS = 32;
const MAX_PATHS = 48;
const MAX_AUDIT_EVENTS = 120;
const CYBER_ASSET_TYPES = new Set<CyberAssetType>(["Domain", "Subdomain", "IPv4", "IPv6", "Website", "API endpoint", "Network service"]);
const CYBER_METHODS = new Set(["PORT_DISCOVERY", "SERVICE_IDENTIFICATION", "HTTP_SECURITY_REVIEW", "TLS_CONFIGURATION_REVIEW", "DNS_CONFIGURATION_REVIEW", "VULNERABILITY_ASSESSMENT"]);
const PUBLIC_ORIGINS = new Set(["https://www.buildy.ai", "https://trancript.art", "https://www.trancript.art"]);
const PREVIEW_ORIGIN_PATTERN = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:superdev\.run|buildy\.show)$/i;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4_PART = /^(?:0|[1-9]\d{0,2})$/;
const PORT_RANGE = /^([1-9]\d{0,4})(?:-([1-9]\d{0,4}))?$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isAllowedOrigin(origin: string): boolean { return PUBLIC_ORIGINS.has(origin) || PREVIEW_ORIGIN_PATTERN.test(origin); }
function text(value: unknown, max = 320): string { return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : ""; }
function email(value: unknown): string { return text(value, 254).toLowerCase(); }
function userId(value: unknown): string { const row = value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; return text(row.id ?? row.user_id ?? row.userId, 160); }
function parsedTime(value: unknown): number | undefined { const candidate = text(value, 100); if (!candidate) return undefined; const parsed = Date.parse(candidate); return Number.isFinite(parsed) ? parsed : undefined; }
function iso(value: unknown): string { const parsed = parsedTime(value); return parsed == null ? "" : new Date(parsed).toISOString(); }
function json(request: Request, payload: unknown, status = 200): Response {
  const origin = request.headers.get("Origin") || "";
  const cors = isAllowedOrigin(origin) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" } : {};
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin", ...cors } });
}
function authToken(request: Request): string { return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim(); }
function serviceClient(): Client {
  const key = Deno.env.get("SUPERDEV_SERVICE_ROLE_KEY");
  if (!key) throw new Error("The protected security service is not configured.");
  const client = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
  client.auth.setToken(key);
  return client;
}
function workspaceKey(): string { return `cyberai:${text(Deno.env.get("SUPERDEV_APP_ID"), 120) || "current"}`; }
function grantStatus(row: JsonRecord): string { return text(row.status, 24).toUpperCase(); }
function grantRole(row: JsonRecord): string { return text(row.role, 48).toLowerCase(); }
function grantMatches(grants: JsonRecord[], account: JsonRecord): JsonRecord[] {
  const targetId = userId(account);
  const targetEmail = email(account.email);
  return grants.filter((grant) => {
    const grantId = text(grant.user_id ?? grant.userId, 160);
    if (targetId && grantId) return grantId === targetId;
    return Boolean(targetEmail) && email(grant.user_email) === targetEmail;
  });
}
async function effectiveAdmin(client: Client, account: JsonRecord): Promise<boolean> {
  if (email(account.email) === ADMIN_EMAIL) return true;
  const grants = await client.entities.AdminGrant.list("-updated_at", 2_000) as JsonRecord[];
  return Array.isArray(grants) && grantMatches(grants, account).some((row) => grantStatus(row) === "ACTIVE" && grantRole(row) === "administrator");
}
async function writeAudit(client: Client, actorEmail: string, actorId: string, action: string, outcome: AuditOutcome, message: string, assetId = "", authorizationId = "", targetSnapshot = ""): Promise<void> {
  try {
    await client.entities.CyberAuditEvent.create({
      action: text(action, 64) || "unknown",
      outcome,
      actor_email: email(actorEmail) || "unknown",
      actor_user_id: text(actorId, 160),
      asset_id: text(assetId, 160),
      authorization_id: text(authorizationId, 160),
      target_snapshot: text(targetSnapshot, 500),
      message: text(message, 600),
      occurred_at: new Date().toISOString(),
      request_id: crypto.randomUUID(),
      workspace_key: workspaceKey(),
    });
  } catch (error) {
    console.error("cyber-security-admin audit write failed", error instanceof Error ? error.message : "unknown error");
  }
}

type AdminContext = { service: Client; actorId: string; actorEmail: string };
async function adminContext(request: Request, action: string): Promise<AdminContext | Response> {
  const token = authToken(request);
  if (!token) return json(request, { error: "Authentication required." }, 401);
  const caller = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
  caller.auth.setToken(token);
  let account: JsonRecord;
  try { account = await caller.auth.me() as JsonRecord; } catch { return json(request, { error: "Authentication required." }, 401); }
  const actorEmail = email(account.email);
  const actorId = userId(account);
  if (!actorEmail || !EMAIL_PATTERN.test(actorEmail)) return json(request, { error: "Authentication required." }, 401);
  try {
    const service = serviceClient();
    if (!(await effectiveAdmin(service, account))) {
      await writeAudit(service, actorEmail, actorId, action, "DENIED", "The authenticated account is outside the administrator security boundary.");
      return json(request, { error: "Not found." }, 404);
    }
    return { service, actorId, actorEmail };
  } catch (error) {
    console.error("cyber-security-admin authorization failed", error instanceof Error ? error.message : "unknown error");
    return json(request, { error: "The protected security service is unavailable." }, 500);
  }
}
async function readBody(request: Request): Promise<JsonRecord> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_REQUEST_BYTES) throw new InputError("The request is too large.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BYTES) throw new InputError("The request is too large.");
  if (!bytes.byteLength) return {};
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, "")); } catch { throw new InputError("The request body must contain valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("The request body must be a JSON object.");
  return value as JsonRecord;
}
function assertFields(body: JsonRecord, allowed: string[]): void { if (Object.keys(body).some((key) => !allowed.includes(key))) throw new InputError("This action contains an unsupported field."); }
function requiredText(value: unknown, label: string, max: number): string { if (typeof value !== "string" || value.length > max) throw new InputError(`${label} must be ${max} characters or fewer.`); const result = text(value, max); if (!result) throw new InputError(`${label} is required.`); return result; }
function optionalText(value: unknown, label: string, max: number): string { if (value === undefined || value === null) return ""; if (typeof value !== "string" || value.length > max) throw new InputError(`${label} must be ${max} characters or fewer.`); return text(value, max); }
function validIpv4(value: string): boolean { const parts = value.split("."); return parts.length === 4 && parts.every((part) => IPV4_PART.test(part) && Number(part) <= 255); }
function validIpv6(value: string): boolean {
  const candidate = value.replace(/^\[|\]$/g, "");
  if (!candidate.includes(":") || !/^[0-9a-f:]+$/i.test(candidate)) return false;
  const sections = candidate.split("::");
  if (sections.length > 2) return false;
  const count = (section: string) => section ? section.split(":").filter(Boolean).length : 0;
  const groups = count(sections[0]) + (sections.length === 2 ? count(sections[1]) : 0);
  return sections.length === 2 ? groups < 8 : groups === 8;
}
function normalizeHost(value: string): string {
  const candidate = value.trim().replace(/\.$/, "").toLowerCase();
  if (validIpv4(candidate) || validIpv6(candidate)) return candidate;
  const labels = candidate.split(".");
  if (labels.length < 2 || candidate.length > 253 || !labels.every((label) => HOST_LABEL.test(label))) throw new InputError("Enter a valid domain or IP address.");
  return candidate;
}
function normalizeTarget(assetType: CyberAssetType, value: unknown): string {
  const raw = requiredText(value, "The target", 320);
  if (assetType === "Domain" || assetType === "Subdomain") return normalizeHost(raw);
  if (assetType === "IPv4") { if (!validIpv4(raw)) throw new InputError("Enter a valid IPv4 address."); return raw; }
  if (assetType === "IPv6") { if (!validIpv6(raw)) throw new InputError("Enter a valid IPv6 address."); return raw.replace(/^\[|\]$/g, "").toLowerCase(); }
  if (assetType === "Website" || assetType === "API endpoint") {
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new InputError("Use a complete HTTP or HTTPS target URL."); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new InputError("Use an HTTP or HTTPS URL without credentials, query strings, or fragments.");
    const host = normalizeHost(parsed.hostname.replace(/^\[|\]$/g, ""));
    const path = parsed.pathname || "/";
    if (path.length > 180 || path.includes("..")) throw new InputError("The URL path is too long or contains an unsafe segment.");
    return `${parsed.protocol}//${host.includes(":") ? `[${host}]` : host}${parsed.port ? `:${parsed.port}` : ""}${path}`;
  }
  const match = raw.match(/^\[([^\]]+)\]:(\d{1,5})$/) || raw.match(/^([^:]+):(\d{1,5})$/);
  if (!match) throw new InputError("Use a hostname or IP address followed by one port, such as example.com:443.");
  const host = normalizeHost(match[1]);
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InputError("The network service port must be between 1 and 65535.");
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}
function assetType(value: unknown): CyberAssetType {
  const candidate = text(value, 40) as CyberAssetType;
  if (!CYBER_ASSET_TYPES.has(candidate)) throw new InputError("Choose a supported asset type.");
  return candidate;
}
function listInput(value: unknown, label: string, maxItems = MAX_LIST_ITEMS, maxItemLength = 160): string[] {
  if (value === undefined || value === null || value === "") return [];
  const source = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!source || source.length > maxItems) throw new InputError(`${label} contains too many entries.`);
  const result = source.map((item) => { if (typeof item !== "string" || item.length > maxItemLength) throw new InputError(`${label} contains an invalid entry.`); return text(item, maxItemLength); }).filter(Boolean);
  return [...new Set(result)];
}
function validatePorts(value: unknown): string[] {
  return [...new Set(listInput(value, "Ports", MAX_LIST_ITEMS, 20).map((entry) => {
    const match = entry.match(PORT_RANGE);
    if (!match) throw new InputError("Ports must use numbers or ranges such as 443 or 8000-8010.");
    const start = Number(match[1]); const end = match[2] ? Number(match[2]) : start;
    if (start > 65535 || end > 65535 || end < start || end - start > 1024) throw new InputError("Each port or range must stay between 1 and 65535 and span at most 1024 ports.");
    return start === end ? String(start) : `${start}-${end}`;
  }))];
}
function validatePaths(value: unknown): string[] {
  return [...new Set(listInput(value, "Web paths", MAX_PATHS, 180).map((entry) => {
    if (!entry.startsWith("/") || entry.includes("..") || entry.includes("\\") || entry.includes("?") || entry.includes("#")) throw new InputError("Web paths must begin with / and cannot contain traversal, queries, or fragments.");
    return entry;
  }))];
}
function validateMethods(value: unknown): string[] {
  const methods = listInput(value, "Testing methods", CYBER_METHODS.size, 64);
  if (!methods.length) throw new InputError("Select at least one allowed testing method.");
  if (methods.some((method) => !CYBER_METHODS.has(method))) throw new InputError("Choose only the listed defensive testing methods.");
  return methods;
}
function dateValue(value: unknown, label: string): string {
  const candidate = requiredText(value, label, 100);
  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) throw new InputError(`${label} must be a valid date.`);
  return new Date(parsed).toISOString();
}
function authorizationWindow(fromValue: unknown, untilValue: unknown): { from: string; until: string; fromMs: number; untilMs: number } {
  const from = dateValue(fromValue, "Valid from");
  const until = dateValue(untilValue, "Valid until");
  const fromMs = Date.parse(from); const untilMs = Date.parse(until);
  if (untilMs <= fromMs) throw new InputError("Valid until must be later than valid from.");
  if (untilMs - fromMs > 366 * 24 * 60 * 60 * 1000) throw new InputError("An authorization window cannot exceed one year.");
  return { from, until, fromMs, untilMs };
}
function currentStatus(row: JsonRecord, now = Date.now()): string {
  const raw = text(row.status, 24).toUpperCase();
  if ((raw === "ACTIVE" || raw === "PENDING") && (parsedTime(row.valid_until) || 0) <= now) return "EXPIRED";
  if (["PENDING", "ACTIVE", "REVOKED", "EXPIRED"].includes(raw)) return raw;
  return "PENDING";
}
function isActiveNow(row: JsonRecord, now = Date.now()): boolean { return currentStatus(row, now) === "ACTIVE" && (parsedTime(row.valid_from) || 0) <= now && (parsedTime(row.valid_until) || 0) > now; }
function safeAsset(row: JsonRecord): JsonRecord {
  return { id: text(row.id, 160), name: text(row.name, MAX_NAME), asset_type: assetTypeForResponse(row.asset_type), target: text(row.target, 320), description: text(row.description, MAX_DESCRIPTION), status: text(row.status, 20).toUpperCase() === "ARCHIVED" ? "ARCHIVED" : "ACTIVE", owner_email: email(row.owner_email), owner_user_id: text(row.owner_user_id, 160), created_at: iso(row.created_at), updated_at: iso(row.updated_at), archived_at: iso(row.archived_at), archived_by: email(row.archived_by), last_updated_by: email(row.last_updated_by) };
}
function assetTypeForResponse(value: unknown): string { return CYBER_ASSET_TYPES.has(text(value, 40) as CyberAssetType) ? text(value, 40) : "Unknown"; }
function safeAuthorization(row: JsonRecord): JsonRecord {
  return { id: text(row.id, 160), asset_id: text(row.asset_id, 160), asset_target: text(row.asset_target, 320), asset_type: assetTypeForResponse(row.asset_type), scope_target: text(row.scope_target, MAX_SCOPE_TARGET), scope_ports: validateResponseList(row.scope_ports, 32, 20), scope_web_paths: validateResponseList(row.scope_web_paths, MAX_PATHS, 180), allowed_testing_methods: validateResponseList(row.allowed_testing_methods, CYBER_METHODS.size, 64), evidence_reference: text(row.evidence_reference, MAX_EVIDENCE_REFERENCE), valid_from: iso(row.valid_from), valid_until: iso(row.valid_until), status: currentStatus(row), owner_email: email(row.owner_email), owner_user_id: text(row.owner_user_id, 160), requested_by: email(row.requested_by), requested_by_user_id: text(row.requested_by_user_id, 160), approved_by: email(row.approved_by), approved_at: iso(row.approved_at), approval_note: text(row.approval_note, MAX_NOTE), renewed_by: email(row.renewed_by), renewed_at: iso(row.renewed_at), renewal_note: text(row.renewal_note, MAX_NOTE), revoked_by: email(row.revoked_by), revoked_at: iso(row.revoked_at), revocation_note: text(row.revocation_note, MAX_NOTE) };
}
function validateResponseList(value: unknown, maxItems: number, maxLength: number): string[] { return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => text(item, maxLength)).filter(Boolean))].slice(0, maxItems) : []; }
function safeAudit(row: JsonRecord): JsonRecord {
  const candidate = text(row.outcome, 32).toUpperCase();
  const outcome: AuditOutcome = candidate === "DENIED" || candidate === "VALIDATION_FAILED" || candidate === "ERROR" ? candidate : "SUCCESS";
  return { id: text(row.id, 160), action: text(row.action, 64), outcome, actor_email: email(row.actor_email), actor_user_id: text(row.actor_user_id, 160), asset_id: text(row.asset_id, 160), authorization_id: text(row.authorization_id, 160), target_snapshot: text(row.target_snapshot, 500), message: text(row.message, 600), occurred_at: iso(row.occurred_at ?? row.created_at) };
}
async function listAssets(client: Client): Promise<JsonRecord[]> { const rows = await client.entities.CyberAsset.filter({ workspace_key: workspaceKey() }, "-updated_at", 500) as JsonRecord[]; return Array.isArray(rows) ? rows.filter((row) => text(row.id, 160)) : []; }
async function listAuthorizations(client: Client): Promise<JsonRecord[]> { const rows = await client.entities.CyberAuthorizationRecord.filter({ workspace_key: workspaceKey() }, "-updated_at", 800) as JsonRecord[]; return Array.isArray(rows) ? rows.filter((row) => text(row.id, 160)) : []; }
async function listAudits(client: Client): Promise<JsonRecord[]> { const rows = await client.entities.CyberAuditEvent.filter({ workspace_key: workspaceKey() }, "-occurred_at", MAX_AUDIT_EVENTS) as JsonRecord[]; return Array.isArray(rows) ? rows.filter((row) => text(row.id, 160)) : []; }
async function findAsset(client: Client, idValue: unknown): Promise<JsonRecord> { const id = requiredText(idValue, "The asset id", 160); const row = await client.entities.CyberAsset.get(id) as JsonRecord; if (!row || text(row.workspace_key, 160) !== workspaceKey()) throw new InputError("The authorized asset was not found."); return row; }
async function findAuthorization(client: Client, idValue: unknown): Promise<JsonRecord> { const id = requiredText(idValue, "The authorization id", 160); const row = await client.entities.CyberAuthorizationRecord.get(id) as JsonRecord; if (!row || text(row.workspace_key, 160) !== workspaceKey()) throw new InputError("The authorization record was not found."); return row; }
function metrics(assets: JsonRecord[], authorizations: JsonRecord[]): JsonRecord {
  const activeAssets = assets.filter((row) => text(row.status, 20).toUpperCase() !== "ARCHIVED");
  const now = Date.now();
  const active = authorizations.filter((row) => isActiveNow(row, now));
  const expiring = active.filter((row) => { const until = parsedTime(row.valid_until) || 0; return until > now && until <= now + 30 * 24 * 60 * 60 * 1000; });
  return { total_assets: assets.length, active_assets: activeAssets.length, active_authorizations: active.length, authorizations_expiring_30_days: expiring.length };
}
async function overview(client: Client): Promise<JsonRecord> {
  const [assets, authorizations, audits] = await Promise.all([listAssets(client), listAuthorizations(client), listAudits(client)]);
  return { assets: assets.map(safeAsset), authorization_records: authorizations.map(safeAuthorization), audit_events: audits.map(safeAudit), metrics: metrics(assets, authorizations), scope: { assessment_enabled: false, external_targets_contacted: false, future_role_expansion: "The current boundary is limited to the existing administrator role and active administrator grants." } };
}
async function createAsset(client: Client, body: JsonRecord, actorEmail: string, actorId: string): Promise<JsonRecord> {
  assertFields(body, ["action", "name", "asset_type", "target", "description"]);
  const type = assetType(body.asset_type);
  const name = requiredText(body.name, "The asset name", MAX_NAME);
  const target = normalizeTarget(type, body.target);
  const description = optionalText(body.description, "The asset description", MAX_DESCRIPTION);
  const saved = await client.entities.CyberAsset.create({ name, asset_type: type, target, description, status: "ACTIVE", owner_email: actorEmail, owner_user_id: actorId, workspace_key: workspaceKey(), last_updated_by: actorEmail, archived_at: "", archived_by: "" }) as JsonRecord;
  const asset = safeAsset({ ...saved, name, asset_type: type, target, description, status: "ACTIVE", owner_email: actorEmail, owner_user_id: actorId, last_updated_by: actorEmail });
  await writeAudit(client, actorEmail, actorId, "CREATE_ASSET", "SUCCESS", "Authorized asset record created.", text(asset.id, 160), "", target);
  return { ok: true, asset };
}
async function updateAsset(client: Client, body: JsonRecord, actorEmail: string, actorId: string): Promise<JsonRecord> {
  assertFields(body, ["action", "asset_id", "name", "description"]);
  const current = await findAsset(client, body.asset_id);
  const patch: JsonRecord = { last_updated_by: actorEmail };
  if (body.name !== undefined) patch.name = requiredText(body.name, "The asset name", MAX_NAME);
  if (body.description !== undefined) patch.description = optionalText(body.description, "The asset description", MAX_DESCRIPTION);
  if (Object.keys(patch).length === 1) throw new InputError("Provide an asset name or description to update.");
  const saved = await client.entities.CyberAsset.update(text(current.id, 160), patch) as JsonRecord;
  const asset = safeAsset({ ...current, ...patch, ...(saved || {}) });
  await writeAudit(client, actorEmail, actorId, "UPDATE_ASSET", "SUCCESS", "Authorized asset metadata updated.", text(asset.id, 160), "", text(asset.target, 320));
  return { ok: true, asset };
}
async function archiveAsset(client: Client, body: JsonRecord, actorEmail: string, actorId: string): Promise<JsonRecord> {
  assertFields(body, ["action", "asset_id"]);
  const current = await findAsset(client, body.asset_id);
  if (text(current.status, 20).toUpperCase() === "ARCHIVED") throw new InputError("This asset is already archived.");
  const authorizations = (await listAuthorizations(client)).filter((row) => text(row.asset_id, 160) === text(current.id, 160));
  if (authorizations.some((row) => isActiveNow(row))) throw new InputError("Revoke every active authorization before archiving this asset.");
  if (authorizations.some((row) => currentStatus(row) === "PENDING")) throw new InputError("Resolve every pending authorization before archiving this asset.");
  const now = new Date().toISOString();
  const saved = await client.entities.CyberAsset.update(text(current.id, 160), { status: "ARCHIVED", archived_at: now, archived_by: actorEmail, last_updated_by: actorEmail }) as JsonRecord;
  const asset = safeAsset({ ...current, ...(saved || {}), status: "ARCHIVED", archived_at: now, archived_by: actorEmail, last_updated_by: actorEmail });
  await writeAudit(client, actorEmail, actorId, "ARCHIVE_ASSET", "SUCCESS", "Authorized asset archived. No assessment was performed.", text(asset.id, 160), "", text(asset.target, 320));
  return { ok: true, asset };
}
async function createAuthorization(client: Client, body: JsonRecord, actorEmail: string, actorId: string): Promise<JsonRecord> {
  assertFields(body, ["action", "asset_id", "scope_target", "scope_ports", "scope_web_paths", "allowed_testing_methods", "evidence_reference", "valid_from", "valid_until"]);
  const asset = await findAsset(client, body.asset_id);
  if (text(asset.status, 20).toUpperCase() === "ARCHIVED") throw new InputError("Archived assets cannot receive new authorization records.");
  const scopeTarget = requiredText(body.scope_target, "The authorization scope", MAX_SCOPE_TARGET);
  const ports = validatePorts(body.scope_ports);
  const paths = validatePaths(body.scope_web_paths);
  const methods = validateMethods(body.allowed_testing_methods);
  const evidence = requiredText(body.evidence_reference, "The authorization evidence reference", MAX_EVIDENCE_REFERENCE);
  const window = authorizationWindow(body.valid_from, body.valid_until);
  const saved = await client.entities.CyberAuthorizationRecord.create({ asset_id: text(asset.id, 160), asset_target: text(asset.target, 320), asset_type: text(asset.asset_type, 40), scope_target: scopeTarget, scope_ports: ports, scope_web_paths: paths, allowed_testing_methods: methods, evidence_reference: evidence, valid_from: window.from, valid_until: window.until, status: "PENDING", owner_email: actorEmail, owner_user_id: actorId, requested_by: actorEmail, requested_by_user_id: actorId, approved_by: "", approved_at: "", approval_note: "", renewed_by: "", renewed_at: "", renewal_note: "", revoked_by: "", revoked_at: "", revocation_note: "", workspace_key: workspaceKey() }) as JsonRecord;
  const authorization = safeAuthorization({ ...saved, asset_id: asset.id, asset_target: asset.target, asset_type: asset.asset_type, scope_target: scopeTarget, scope_ports: ports, scope_web_paths: paths, allowed_testing_methods: methods, evidence_reference: evidence, valid_from: window.from, valid_until: window.until, status: "PENDING", owner_email: actorEmail, owner_user_id: actorId, requested_by: actorEmail, requested_by_user_id: actorId });
  await writeAudit(client, actorEmail, actorId, "CREATE_AUTHORIZATION", "SUCCESS", "Authorization record created in PENDING state.", text(asset.id, 160), text(authorization.id, 160), text(asset.target, 320));
  return { ok: true, authorization };
}
async function approveAuthorization(client: Client, body: JsonRecord, actorEmail: string, actorId: string): Promise<JsonRecord> {
  assertFields(body, ["action", "authorization_id", "approval_note"]);
  const current = await findAuthorization(client, body.authorization_id);
  const asset = await findAsset(client, current.asset_id);
  const now = Date.now();
  if (text(asset.status, 20).toUpperCase() === "ARCHIVED") throw new InputError("Archived assets cannot have active authorizations.");
  if (text(current.status, 24).toUpperCase() !== "PENDING") throw new InputError("Only pending authorization records can be approved.");
  if ((parsedTime(current.valid_until) || 0) <= now) throw new InputError("An expired authorization cannot be approved.");
  const note = optionalText(body.approval_note, "The approval note", MAX_NOTE);
  const approvedAt = new Date().toISOString();
  const saved = await client.entities.CyberAuthorizationRecord.update(text(current.id, 160), { status: "ACTIVE", approved_by: actorEmail, approved_at: approvedAt, approval_note: note }) as JsonRecord;
  const authorization = safeAuthorization({ ...current, ...(saved || {}), status: "ACTIVE", approved_by: actorEmail, approved_at: approvedAt, approval_note: note });
  await writeAudit(client, actorEmail, actorId, "APPROVE_AUTHORIZATION", "SUCCESS", "Authorization explicitly approved. Assessment remains disabled in Phase 1.", text(asset.id, 160), text(current.id, 160), text(asset.target, 320));
  return { ok: true, authorization };
}
async function renewAuthorization(client: Client, body: JsonRecord, actorEmail: string, actorId: string): Promise<JsonRecord> {
  assertFields(body, ["action", "authorization_id", "valid_until", "renewal_note"]);
  const current = await findAuthorization(client, body.authorization_id);
  const asset = await findAsset(client, current.asset_id);
  if (text(asset.status, 20).toUpperCase() === "ARCHIVED") throw new InputError("Archived assets cannot have renewed authorizations.");
  if (text(current.status, 24).toUpperCase() !== "ACTIVE" || !isActiveNow(current)) throw new InputError("Only an active, currently valid authorization can be renewed.");
  const nextUntil = dateValue(body.valid_until, "New valid until");
  const nextUntilMs = Date.parse(nextUntil); const currentUntil = parsedTime(current.valid_until) || 0; const from = parsedTime(current.valid_from) || Date.now();
  if (nextUntilMs <= currentUntil || nextUntilMs <= Date.now()) throw new InputError("The renewed end date must extend the current authorization window.");
  if (nextUntilMs - from > 366 * 24 * 60 * 60 * 1000) throw new InputError("The renewed authorization window cannot exceed one year.");
  const note = optionalText(body.renewal_note, "The renewal note", MAX_NOTE);
  const renewedAt = new Date().toISOString();
  const saved = await client.entities.CyberAuthorizationRecord.update(text(current.id, 160), { valid_until: nextUntil, status: "ACTIVE", renewed_by: actorEmail, renewed_at: renewedAt, renewal_note: note }) as JsonRecord;
  const authorization = safeAuthorization({ ...current, ...(saved || {}), valid_until: nextUntil, status: "ACTIVE", renewed_by: actorEmail, renewed_at: renewedAt, renewal_note: note });
  await writeAudit(client, actorEmail, actorId, "RENEW_AUTHORIZATION", "SUCCESS", "Authorization validity window renewed.", text(asset.id, 160), text(current.id, 160), text(asset.target, 320));
  return { ok: true, authorization };
}
async function revokeAuthorization(client: Client, body: JsonRecord, actorEmail: string, actorId: string): Promise<JsonRecord> {
  assertFields(body, ["action", "authorization_id", "revocation_note"]);
  const current = await findAuthorization(client, body.authorization_id);
  const asset = await findAsset(client, current.asset_id);
  if (text(current.status, 24).toUpperCase() === "REVOKED") throw new InputError("This authorization is already revoked.");
  const note = optionalText(body.revocation_note, "The revocation note", MAX_NOTE);
  const revokedAt = new Date().toISOString();
  const saved = await client.entities.CyberAuthorizationRecord.update(text(current.id, 160), { status: "REVOKED", revoked_by: actorEmail, revoked_at: revokedAt, revocation_note: note }) as JsonRecord;
  const authorization = safeAuthorization({ ...current, ...(saved || {}), status: "REVOKED", revoked_by: actorEmail, revoked_at: revokedAt, revocation_note: note });
  await writeAudit(client, actorEmail, actorId, "REVOKE_AUTHORIZATION", "SUCCESS", "Authorization revoked. No assessment was performed.", text(asset.id, 160), text(current.id, 160), text(asset.target, 320));
  return { ok: true, authorization };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return json(request, {}, 204);
  if (request.method !== "POST") return json(request, { error: "Use POST for protected security actions." }, 405);
  let body: JsonRecord;
  try { body = await readBody(request); } catch (error) { return json(request, { error: error instanceof Error ? error.message : "The request body is invalid." }, 400); }
  const action = text(body.action, 64) || "unknown";
  const auth = await adminContext(request, action);
  if (auth instanceof Response) return auth;
  const auditAssetId = text(body.asset_id, 160);
  const auditAuthorizationId = text(body.authorization_id, 160);
  try {
    if (action === "overview" || action === "list") { assertFields(body, ["action"]); return json(request, await overview(auth.service)); }
    if (action === "audit_events") { assertFields(body, ["action"]); return json(request, { audit_events: (await listAudits(auth.service)).map(safeAudit) }); }
    if (action === "create_asset") return json(request, await createAsset(auth.service, body, auth.actorEmail, auth.actorId));
    if (action === "update_asset") return json(request, await updateAsset(auth.service, body, auth.actorEmail, auth.actorId));
    if (action === "archive_asset") return json(request, await archiveAsset(auth.service, body, auth.actorEmail, auth.actorId));
    if (action === "create_authorization") return json(request, await createAuthorization(auth.service, body, auth.actorEmail, auth.actorId));
    if (action === "approve_authorization") return json(request, await approveAuthorization(auth.service, body, auth.actorEmail, auth.actorId));
    if (action === "renew_authorization") return json(request, await renewAuthorization(auth.service, body, auth.actorEmail, auth.actorId));
    if (action === "revoke_authorization") return json(request, await revokeAuthorization(auth.service, body, auth.actorEmail, auth.actorId));
    throw new InputError("Unknown protected security action.");
  } catch (error) {
    const input = error instanceof InputError;
    const message = input ? error.message : "The protected security action could not be completed.";
    console.error("cyber-security-admin failed", action, input ? error.message : "unexpected protected security error");
    await writeAudit(auth.service, auth.actorEmail, auth.actorId, action, input ? "VALIDATION_FAILED" : "ERROR", message, auditAssetId, auditAuthorizationId, text(body.target ?? body.scope_target, 500));
    return json(request, { error: message }, input ? 400 : 500);
  }
});
