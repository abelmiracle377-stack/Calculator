import {
  CYBER_TESTING_METHODS,
  CYBER_USER_ASSET_TYPES,
  type CyberTestingMethod,
  type CyberUserAssetType,
} from "@/lib/cyberai/types";

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4_PART = /^(?:0|[1-9]\d{0,2})$/;
const PORT_RANGE = /^([1-9]\d{0,4})(?:-([1-9]\d{0,4}))?$/;
export const MAX_CONSOLE_MESSAGE = 1_200;
export const MAX_ASSET_NAME = 120;
export const MAX_ASSET_DESCRIPTION = 600;
export const MAX_SCOPE_TARGET = 500;
export const MAX_EVIDENCE_REFERENCE = 500;

export function cleanText(value: unknown, max = 320): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

export function assetType(value: unknown): CyberUserAssetType {
  const candidate = cleanText(value, 40) as CyberUserAssetType;
  if (!CYBER_USER_ASSET_TYPES.includes(candidate)) throw new Error("Choose a supported asset type.");
  return candidate;
}

function validIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => IPV4_PART.test(part) && Number(part) <= 255);
}

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
  if (labels.length < 2 || candidate.length > 253 || !labels.every((label) => HOST_LABEL.test(label))) {
    throw new Error("Enter a valid domain or IP address.");
  }
  return candidate;
}

export function normalizeCyberTarget(type: CyberUserAssetType, value: unknown): string {
  const raw = cleanText(value, 320);
  if (!raw) throw new Error("A target is required.");
  if (type === "Domain" || type === "Subdomain") return normalizeHost(raw);
  if (type === "IPv4") {
    if (!validIpv4(raw)) throw new Error("Enter a valid IPv4 address.");
    return raw;
  }
  if (type === "IPv6") {
    if (!validIpv6(raw)) throw new Error("Enter a valid IPv6 address.");
    return raw.replace(/^\[|\]$/g, "").toLowerCase();
  }
  if (type === "Website" || type === "API endpoint") {
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new Error("Use a complete HTTP or HTTPS target URL."); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Use an HTTP or HTTPS URL without credentials, query strings, or fragments.");
    }
    const host = normalizeHost(parsed.hostname.replace(/^\[|\]$/g, ""));
    const path = parsed.pathname || "/";
    if (path.length > 180 || path.includes("..")) throw new Error("The URL path is too long or contains an unsafe segment.");
    return `${parsed.protocol}//${host.includes(":") ? `[${host}]` : host}${parsed.port ? `:${parsed.port}` : ""}${path}`;
  }
  const match = raw.match(/^\[([^\]]+)\]:(\d{1,5})$/) || raw.match(/^([^:]+):(\d{1,5})$/);
  if (!match) throw new Error("Use a hostname or IP followed by one port, such as lab.example:443.");
  const host = normalizeHost(match[1]);
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("The service port must be between 1 and 65535.");
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

export function validateAssetName(value: unknown): string {
  const candidate = cleanText(value, MAX_ASSET_NAME);
  if (!candidate) throw new Error("An asset name is required.");
  return candidate;
}

export function validateDescription(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > MAX_ASSET_DESCRIPTION) throw new Error("The description must be 600 characters or fewer.");
  return cleanText(value, MAX_ASSET_DESCRIPTION);
}

function listInput(value: unknown, label: string, maxItems: number, maxItemLength: number): string[] {
  if (value === undefined || value === null || value === "") return [];
  const source = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!source || source.length > maxItems) throw new Error(`${label} contains too many entries.`);
  return [...new Set(source.map((item) => {
    if (typeof item !== "string" || item.length > maxItemLength) throw new Error(`${label} contains an invalid entry.`);
    return cleanText(item, maxItemLength);
  }).filter(Boolean))];
}

export function validatePortList(value: unknown): string[] {
  return listInput(value, "Ports", 32, 20).map((entry) => {
    const match = entry.match(PORT_RANGE);
    if (!match) throw new Error("Ports must use numbers or ranges such as 443 or 8000-8010.");
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (start > 65_535 || end > 65_535 || end < start || end - start > 1_024) {
      throw new Error("Each port or range must stay between 1 and 65535 and span at most 1024 ports.");
    }
    return start === end ? String(start) : `${start}-${end}`;
  });
}

export function validateWebPaths(value: unknown): string[] {
  return listInput(value, "Web paths", 48, 180).map((entry) => {
    if (!entry.startsWith("/") || entry.includes("..") || entry.includes("\\") || entry.includes("?") || entry.includes("#")) {
      throw new Error("Web paths must begin with / and cannot contain traversal, queries, or fragments.");
    }
    return entry;
  });
}

export function validateTestingMethods(value: unknown): CyberTestingMethod[] {
  const methods = listInput(value, "Testing methods", CYBER_TESTING_METHODS.length, 64) as CyberTestingMethod[];
  if (!methods.length) throw new Error("Select at least one allowed testing method.");
  if (methods.some((method) => !CYBER_TESTING_METHODS.includes(method))) throw new Error("Choose only the listed defensive testing methods.");
  return methods;
}

export function dateInputToIso(value: string, label: string): string {
  if (!value) throw new Error(`${label} is required.`);
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid date.`);
  return new Date(parsed).toISOString();
}

export function dateInputValue(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : "";
}

export function validateAuthorizationWindow(from: string, until: string): { valid_from: string; valid_until: string } {
  const valid_from = dateInputToIso(from, "Valid from");
  const valid_until = dateInputToIso(until, "Valid until");
  const start = Date.parse(valid_from);
  const end = Date.parse(valid_until);
  if (end <= start) throw new Error("Valid until must be later than valid from.");
  if (end - start > 366 * 24 * 60 * 60 * 1_000) throw new Error("An authorization window cannot exceed one year.");
  return { valid_from, valid_until };
}

export function validateScope(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_SCOPE_TARGET) throw new Error("The explicit scope must be 500 characters or fewer.");
  const candidate = cleanText(value, MAX_SCOPE_TARGET);
  if (!candidate) throw new Error("An explicit authorization scope is required.");
  return candidate;
}

export function validateEvidenceReference(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_EVIDENCE_REFERENCE) throw new Error("The evidence reference must be 500 characters or fewer.");
  const candidate = cleanText(value, MAX_EVIDENCE_REFERENCE);
  if (!candidate) throw new Error("An authorization evidence reference is required.");
  return candidate;
}

export function validateSessionTitle(value: unknown): string {
  const candidate = cleanText(value, 120);
  if (!candidate) throw new Error("A session title is required.");
  return candidate;
}

export function validateConsoleMessage(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_CONSOLE_MESSAGE) throw new Error(`Keep the console request to ${MAX_CONSOLE_MESSAGE} characters or fewer.`);
  const candidate = value.replace(/\u0000/g, "").replace(/[\u0001-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  if (!candidate) throw new Error("Write a request for the planning assistant first.");
  return candidate;
}

export function todayInput(offsetDays = 0): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}
