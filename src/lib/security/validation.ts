import {
  CYBER_ASSET_TYPES,
  CYBER_TESTING_METHODS,
  type CyberAssetType,
  type CyberTestingMethod,
} from "@/lib/security/types";

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4_PART = /^(?:0|[1-9]\d{0,2})$/;
const PORT_RANGE = /^([1-9]\d{0,4})(?:-([1-9]\d{0,4}))?$/;

export function text(value: unknown, max = 320): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "";
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

export function normalizeHost(value: string): string {
  const candidate = value.trim().replace(/\.$/, "").toLowerCase();
  if (validIpv4(candidate) || validIpv6(candidate)) return candidate;
  const labels = candidate.split(".");
  if (labels.length < 2 || candidate.length > 253 || !labels.every((label) => HOST_LABEL.test(label))) {
    throw new Error("Enter a valid domain or IP address.");
  }
  return candidate;
}

export function normalizeCyberTarget(type: CyberAssetType, value: unknown): string {
  const raw = text(value, 320);
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
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Use an HTTP or HTTPS URL without credentials, query strings, or fragments.");
    }
    const host = normalizeHost(parsed.hostname.replace(/^\[|\]$/g, ""));
    const renderedHost = host.includes(":") ? `[${host}]` : host;
    const path = parsed.pathname || "/";
    if (path.length > 180) throw new Error("The URL path is too long.");
    return `${parsed.protocol}//${renderedHost}${parsed.port ? `:${parsed.port}` : ""}${path}`;
  }
  const service = raw.match(/^\[([^\]]+)\]:(\d{1,5})$/) || raw.match(/^([^:]+):(\d{1,5})$/);
  if (!service) throw new Error("Use a hostname or IP address followed by one port, such as example.com:443.");
  const host = normalizeHost(service[1]);
  const port = Number(service[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The network service port must be between 1 and 65535.");
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

export function listInput(value: string, maxItems = 32): string[] {
  return [...new Set(value.split(",").map((item) => text(item, 160)).filter(Boolean))].slice(0, maxItems);
}

export function validatePortList(values: string[]): string[] {
  return [...new Set(values.map((value) => {
    const match = value.match(PORT_RANGE);
    if (!match) throw new Error("Ports must use numbers or ranges such as 443 or 8000-8010.");
    const start = Number(match[1]); const end = match[2] ? Number(match[2]) : start;
    if (start > 65535 || end > 65535 || end < start) throw new Error("Each port or range must stay between 1 and 65535.");
    return end === start ? String(start) : `${start}-${end}`;
  }))];
}

export function dateInputValue(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : "";
}

export function dateInputToIso(value: string, label: string): string {
  if (!value) throw new Error(`${label} is required.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be a valid date.`);
  return parsed.toISOString();
}

export function allowedMethod(value: string): value is CyberTestingMethod {
  return (CYBER_TESTING_METHODS as readonly string[]).includes(value);
}

export function assetType(value: string): CyberAssetType {
  const match = CYBER_ASSET_TYPES.find((item) => item === value);
  if (!match) throw new Error("Choose a supported asset type.");
  return match;
}
