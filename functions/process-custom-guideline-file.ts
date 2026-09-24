import { Buffer } from "node:buffer";
import { strFromU8, Unzip, UnzipInflate } from "npm:fflate@0.8.2";
import WordExtractor from "npm:word-extractor@1.0.4";
import { createSuperdevClient } from "npm:@superdevhq/client@0.1.56";

type JsonRecord = Record<string, unknown>;
type SourceCategory = "txt" | "md" | "csv" | "json" | "yaml" | "xml" | "log" | "srt" | "vtt" | "pdf" | "image" | "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "avif" | "doc" | "docx" | "zip";
type SourceResult = { name: string; category: SourceCategory; text: string; status: "ready" | "empty" | "conflict" | "unsupported"; message: string; character_count: number };
type ArchiveEntry = { name: string; compression: number; originalSize?: number; bytes: Uint8Array | null; error: string };

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 30;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_CHARS = 12_000;
const MAX_MESSAGE = 520;
const MAX_ARCHIVE_STREAM_WAIT_MS = 10_000;
const DOC_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const EXTRACTION_SCHEMA = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
const PLAIN: Record<string, SourceCategory> = { txt: "txt", md: "md", markdown: "md", csv: "csv", json: "json", yaml: "yaml", yml: "yaml", xml: "xml", log: "log", srt: "srt", vtt: "vtt" };
const IMAGES: Record<string, SourceCategory> = { png: "png", jpg: "jpg", jpeg: "jpeg", webp: "webp", gif: "gif", bmp: "bmp", avif: "avif" };
const MANAGED_UPLOAD_HOSTS = new Set(["api.superdev.build", "www.buildy.ai", "buildy.ai", "ellprnxjjzatijdxcogk.supabase.co"]);

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function safeName(value: unknown, fallback = "Guideline source"): string {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, 160);
}

function message(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[private link]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[credential redacted]")
    .replace(/\b(?:api[_ -]?key|token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1: [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE);
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/g, "")).join("\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

function extension(name: string): string {
  return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
}

function classifyName(name: string, mime = ""): { source?: SourceCategory; extension: string } {
  const ext = extension(name);
  if (PLAIN[ext]) return { source: PLAIN[ext], extension: ext };
  if (IMAGES[ext]) return { source: IMAGES[ext], extension: ext };
  if (ext === "pdf") return { source: "pdf", extension: ext };
  if (ext === "doc") return { source: "doc", extension: ext };
  if (ext === "docx") return { source: "docx", extension: ext };
  if (ext === "zip") return { source: "zip", extension: ext };
  const normalizedMime = mime.toLowerCase().split(";", 1)[0].trim();
  if (normalizedMime === "application/pdf") return { source: "pdf", extension: ext };
  if (normalizedMime === "application/msword") return { source: "doc", extension: ext };
  if (normalizedMime.includes("wordprocessingml.document")) return { source: "docx", extension: ext };
  if (normalizedMime === "application/zip" || normalizedMime === "application/x-zip-compressed") return { source: "zip", extension: ext };
  if (normalizedMime.startsWith("image/")) {
    const imageExtension = normalizedMime.slice("image/".length);
    if (IMAGES[imageExtension]) return { source: IMAGES[imageExtension], extension: ext };
  }
  if (normalizedMime.startsWith("text/")) return { source: "txt", extension: ext };
  return { extension: ext };
}

function result(name: string, category: SourceCategory, text: string, status: SourceResult["status"] = "ready", sourceMessage = ""): SourceResult {
  const normalized = normalizeText(text);
  return { name: safeName(name), category, text: normalized, status: normalized ? status : status === "ready" ? "empty" : status, message: message(sourceMessage), character_count: normalized.length };
}

function unsupported(name: string, category: SourceCategory, sourceMessage: string): SourceResult {
  return result(name, category, "", "unsupported", sourceMessage);
}

function boundedSourceText(name: string, category: SourceCategory, text: string): SourceResult {
  const normalized = normalizeText(text);
  if (!normalized) return result(name, category, "", "empty", "No readable guideline text was found in this file.");
  if (normalized.length > MAX_SOURCE_CHARS) return unsupported(name, category, `This source contains ${normalized.length.toLocaleString()} characters, above the ${MAX_SOURCE_CHARS.toLocaleString()} character safe limit. No content was truncated.`);
  return result(name, category, normalized, "ready", "");
}

type XmlElement = { name: string; open: string; content: string; raw: string };

function localName(value: string): string {
  return value.split(":").pop() || value;
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match: string, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    try { return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ""; }
    catch { return ""; }
  });
}

function tagEnd(xml: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === "\"" || character === "'") { quote = character; continue; }
    if (character === ">") return index;
  }
  return -1;
}

function topLevelElements(xml: string): XmlElement[] {
  const elements: XmlElement[] = [];
  let cursor = 0;
  let depth = 0;
  let rootStart = -1;
  let contentStart = -1;
  let rootName = "";
  let rootOpen = "";
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) break;
    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start + 4);
      cursor = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      const end = xml.indexOf("]]>", start + 9);
      cursor = end < 0 ? xml.length : end + 3;
      continue;
    }
    const end = tagEnd(xml, start);
    if (end < 0) break;
    const token = xml.slice(start, end + 1);
    if (/^<\?/.test(token) || /^<!/.test(token)) { cursor = end + 1; continue; }
    const match = token.match(/^<\s*(\/?)\s*([A-Za-z_][\w:.-]*)\b/);
    if (!match) { cursor = end + 1; continue; }
    const closing = match[1] === "/";
    const name = match[2];
    const selfClosing = !closing && /\/\s*>$/.test(token);
    if (closing) {
      if (depth > 0) depth -= 1;
      if (depth === 0 && rootStart >= 0) {
        elements.push({ name: rootName, open: rootOpen, content: xml.slice(contentStart, start), raw: xml.slice(rootStart, end + 1) });
        rootStart = -1;
        contentStart = -1;
        rootName = "";
        rootOpen = "";
      }
    } else if (depth === 0) {
      rootStart = start;
      contentStart = end + 1;
      rootName = name;
      rootOpen = token;
      if (selfClosing) {
        elements.push({ name, open: token, content: "", raw: token });
        rootStart = -1;
        contentStart = -1;
        rootName = "";
        rootOpen = "";
      } else depth = 1;
    } else if (!selfClosing) {
      depth += 1;
    }
    cursor = end + 1;
  }
  return elements;
}

function descendants(xml: string, target: string, depth = 0): XmlElement[] {
  if (depth > 64) return [];
  const matches: XmlElement[] = [];
  for (const element of topLevelElements(xml)) {
    if (localName(element.name) === target) matches.push(element);
    if (!(["t", "instrText"].includes(localName(element.name)))) matches.push(...descendants(element.content, target, depth + 1));
  }
  return matches;
}

function attr(element: XmlElement | undefined, name: string): string {
  if (!element) return "";
  const match = element.open.match(new RegExp("(?:^|\\s)(?:[A-Za-z_][\\w:.-]*:)?" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i"));
  return decodeXml(match?.[1] ?? match?.[2] ?? "");
}

function nodeText(xml: string, depth = 0): string {
  if (depth > 64) return "";
  let text = "";
  for (const child of topLevelElements(xml)) {
    const local = localName(child.name);
    if (local === "t" || local === "instrText") text += decodeXml(child.content.replace(/<[^>]*>/g, ""));
    else if (local === "tab") text += "\t";
    else if (local === "br" || local === "cr") text += "\n";
    else text += nodeText(child.content, depth + 1);
  }
  return text;
}

function numberingMaps(xml: string): { formats: Map<string, string>; nums: Map<string, string> } {
  const formats = new Map<string, string>();
  const nums = new Map<string, string>();
  for (const abstract of descendants(xml, "abstractNum")) {
    const abstractId = attr(abstract, "abstractNumId");
    for (const level of descendants(abstract.content, "lvl")) {
      const ilvl = attr(level, "ilvl") || "0";
      const format = descendants(level.content, "numFmt")[0];
      formats.set(abstractId + ":" + ilvl, attr(format, "val") || "decimal");
    }
  }
  for (const num of descendants(xml, "num")) {
    const numId = attr(num, "numId");
    const abstract = descendants(num.content, "abstractNumId")[0];
    if (numId && abstract) nums.set(numId, attr(abstract, "val"));
  }
  return { formats, nums };
}

function paragraphLine(paragraph: XmlElement, counters: Map<string, number>, maps: { formats: Map<string, string>; nums: Map<string, string> }): string {
  const text = nodeText(paragraph.content).replace(/[ \t]+/g, " ").trim();
  if (!text) return "";
  const style = descendants(paragraph.content, "pStyle")[0];
  const styleValue = attr(style, "val");
  const heading = styleValue.match(/heading(\d+)/i);
  if (heading) return `${"#".repeat(Math.min(6, Number(heading[1]) || 1))} ${text}`;
  const numPr = descendants(paragraph.content, "numPr")[0];
  if (!numPr) return text;
  const numIdNode = descendants(numPr.content, "numId")[0];
  const levelNode = descendants(numPr.content, "ilvl")[0];
  const numId = attr(numIdNode, "val");
  const level = levelNode ? attr(levelNode, "val") || "0" : "0";
  const key = `${numId}:${level}`;
  const abstractId = maps.nums.get(numId) || "";
  const format = maps.formats.get(`${abstractId}:${level}`) || "decimal";
  if (format === "bullet" || format === "none") return `${"  ".repeat(Number(level) || 0)}• ${text}`;
  const count = (counters.get(key) || 0) + 1;
  counters.set(key, count);
  return `${"  ".repeat(Number(level) || 0)}${count}. ${text}`;
}

function tableLines(table: XmlElement, counters: Map<string, number>, maps: { formats: Map<string, string>; nums: Map<string, string> }): string[] {
  return topLevelElements(table.content).filter((row) => localName(row.name) === "tr").map((row) => {
    const cells = topLevelElements(row.content).filter((cell) => localName(cell.name) === "tc").map((cell) => topLevelElements(cell.content).filter((paragraph) => localName(paragraph.name) === "p").map((paragraph) => paragraphLine(paragraph, counters, maps)).filter(Boolean).join(" "));
    return cells.filter(Boolean).join(" | ");
  }).filter(Boolean);
}

function joinChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

type UnzipFileLike = {
  name: string;
  compression: number;
  originalSize?: number;
  ondata?: (error: Error | null, data: Uint8Array, final: boolean) => void;
  start: () => void;
};

type ByteBudget = { value: number; stopped: boolean };

function collectUnzipFile(file: UnzipFileLike, maxBytes: number, budget: ByteBudget, totalLimit: number): Promise<{ bytes: Uint8Array | null; error: string }> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (bytes: Uint8Array | null, error = "") => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ bytes, error: message(error) });
    };
    file.ondata = (error, data, final) => {
      if (settled) return;
      if (error) {
        finish(null, error.message || "This archive entry could not be read.");
        return;
      }
      const chunkLength = data?.byteLength || 0;
      const nextLength = length + chunkLength;
      if (nextLength > maxBytes) {
        finish(null, `This archive entry is larger than the ${maxBytes / 1024 / 1024} MB entry limit.`);
        return;
      }
      if (budget.value + chunkLength > totalLimit) {
        budget.stopped = true;
        finish(null, "The archive exceeds the total uncompressed size limit. No remaining content was truncated.");
        return;
      }
      if (chunkLength) {
        budget.value += chunkLength;
        length = nextLength;
        chunks.push(data);
      }
      if (final) finish(joinChunks(chunks, length));
    };
    timer = setTimeout(() => {
      budget.stopped = true;
      finish(null, `This archive entry did not finish within ${MAX_ARCHIVE_STREAM_WAIT_MS / 1000} seconds.`);
    }, MAX_ARCHIVE_STREAM_WAIT_MS);
    try {
      file.start();
    } catch (error) {
      finish(null, error instanceof Error ? error.message : "This archive entry could not be read.");
    }
  });
}

function zipEntryPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

async function streamDocxParts(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  const wanted = new Set(["word/document.xml", "word/numbering.xml"]);
  const encrypted = encryptedEntryNames(bytes);
  const parts: Record<string, Uint8Array> = {};
  const failures: string[] = [];
  const budget: ByteBudget = { value: 0, stopped: false };
  const pending: Promise<void>[] = [];
  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.onfile = (file) => {
    const entryName = zipEntryPath(file.name);
    if (!wanted.has(entryName)) return;
    if (encrypted.has(file.name) || encrypted.has(entryName)) {
      failures.push(`${entryName}: This DOCX entry is encrypted and cannot be read.`);
      return;
    }
    if (file.compression !== 0 && file.compression !== 8) {
      failures.push(`${entryName}: This DOCX entry uses an unsupported compression method.`);
      return;
    }
    const declared = file.originalSize;
    if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_ENTRY_BYTES)) {
      failures.push(`${entryName}: This DOCX entry is larger than the ${MAX_ENTRY_BYTES / 1024 / 1024} MB entry limit.`);
      return;
    }
    if (declared !== undefined && budget.value + declared > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      budget.stopped = true;
      failures.push(`${entryName}: The DOCX archive exceeds the total uncompressed size limit.`);
      return;
    }
    pending.push((async () => {
      const collected = await collectUnzipFile(file, MAX_ENTRY_BYTES, budget, MAX_ARCHIVE_UNCOMPRESSED_BYTES);
      if (collected.error) failures.push(`${entryName}: ${collected.error}`);
      else if (!collected.bytes?.byteLength) failures.push(`${entryName}: This DOCX entry is empty.`);
      else parts[entryName] = collected.bytes;
    })());
  };
  try {
    unzipper.push(bytes, true);
    const settled = await Promise.allSettled(pending);
    if (settled.some((item) => item.status === "rejected")) throw new Error("An archive entry stream failed before it completed.");
  } catch {
    throw new Error("The DOCX archive could not be opened. It may be damaged or use unsupported compression.");
  }
  if (failures.length) throw new Error(message(failures[0]) || "The DOCX archive could not be read.");
  return parts;
}

function extractDocxFromZip(zip: Record<string, Uint8Array>): string {
  const documentBytes = zip["word/document.xml"];
  if (!documentBytes?.byteLength) throw new Error("The DOCX document.xml part is missing or empty.");
  const documentXml = strFromU8(documentBytes);
  const roots = topLevelElements(documentXml);
  if (!roots.length || localName(roots[0].name) !== "document") throw new Error("The DOCX document.xml structure is damaged or unreadable.");
  const numberingBytes = zip["word/numbering.xml"];
  const numbering = numberingBytes
    ? numberingMaps(strFromU8(numberingBytes))
    : { formats: new Map<string, string>(), nums: new Map<string, string>() };
  const body = descendants(documentXml, "body")[0];
  if (!body) throw new Error("The DOCX document body is missing from document.xml.");
  const counters = new Map<string, number>();
  const lines: string[] = [];
  for (const node of topLevelElements(body.content)) {
    const local = localName(node.name);
    if (local === "p") {
      const line = paragraphLine(node, counters, numbering);
      if (line) lines.push(line);
    } else if (local === "tbl") {
      lines.push(...tableLines(node, counters, numbering));
    }
  }
  return normalizeText(lines.join("\n"));
}

async function extractDoc(client: ReturnType<typeof createSuperdevClient>, bytes: Uint8Array, name: string, headers: Record<string, string>): Promise<string> {
  let legacyReason = "";
  try {
    const extractor = new WordExtractor();
    const document = await extractor.extract(Buffer.from(bytes)) as { getBody?: () => string };
    const body = document?.getBody?.();
    const text = normalizeText(body);
    if (text) return text;
    legacyReason = "The legacy Word reader found no readable text.";
  } catch (error) {
    legacyReason = message(error instanceof Error ? error.message : "The legacy Word reader failed.");
  }
  try {
    const fallback = await extractWithBuiltIn(client, bytes, name, "doc", headers);
    if (fallback) return fallback;
  } catch (error) {
    const fallbackReason = message(error instanceof Error ? error.message : "The built-in document reader failed.");
    throw new Error(`This DOC file could not be read by either document reader. ${legacyReason} ${fallbackReason}`.trim());
  }
  throw new Error(`This DOC file could not be read by either document reader. ${legacyReason}`.trim());
}

function extractedText(value: unknown): string {
  const collect = (candidate: unknown, depth: number): string[] => {
    if (depth > 5) return [];
    if (typeof candidate === "string") return [candidate];
    if (Array.isArray(candidate)) return candidate.flatMap((item) => collect(item, depth + 1));
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as JsonRecord;
    for (const key of ["text", "guideline_text", "content", "output", "data", "result"]) {
      if (record[key] !== undefined) {
        const found = collect(record[key], depth + 1);
        if (found.length) return found;
      }
    }
    return Object.entries(record)
      .filter(([key]) => !["status", "success", "error", "details", "message", "reason"].includes(key))
      .flatMap(([, item]) => collect(item, depth + 1));
  };
  return normalizeText(collect(value, 0).join("\n"));
}

function extractionFailure(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as JsonRecord;
  if (record.result && typeof record.result === "object") {
    const nested = extractionFailure(record.result);
    if (nested) return nested;
  }
  const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
  const hasExplicitError = typeof record.error === "string" || typeof record.details === "string" || typeof record.reason === "string";
  if (status === "error" || status === "failed" || record.success === false || hasExplicitError) {
    const detail = record.error ?? record.details ?? record.reason ?? record.message;
    return message(typeof detail === "string" ? detail : "The document reader returned an error.");
  }
  return "";
}

function mimeFor(category: SourceCategory): string {
  if (category === "pdf") return "application/pdf";
  if (category === "doc") return "application/msword";
  if (category === "png") return "image/png";
  if (category === "jpg" || category === "jpeg") return "image/jpeg";
  if (category === "webp") return "image/webp";
  if (category === "gif") return "image/gif";
  if (category === "bmp") return "image/bmp";
  if (category === "avif" || category === "image") return "image/png";
  return "application/octet-stream";
}

function integrationHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const authorization = request.headers.get("Authorization");
  const origin = request.headers.get("Origin");
  if (authorization) headers.Authorization = authorization;
  if (origin) headers.Origin = origin;
  return headers;
}

async function extractWithBuiltIn(client: ReturnType<typeof createSuperdevClient>, bytes: Uint8Array, name: string, category: SourceCategory, headers: Record<string, string>): Promise<string> {
  const integrations = client.integrations.core as unknown as { uploadFile: (input: unknown, options?: unknown) => Promise<{ file_url?: string }>; extractDataFromUploadedFile: (input: unknown, options?: unknown) => Promise<unknown> };
  const uploaded = await integrations.uploadFile({ file: new File([bytes], safeName(name), { type: mimeFor(category) }) }, { headers });
  if (!uploaded?.file_url) throw new Error(`The ${category === "pdf" ? "PDF" : "image"} could not be prepared for reading.`);
  const extracted = await integrations.extractDataFromUploadedFile({ file_url: uploaded.file_url, json_schema: EXTRACTION_SCHEMA }, { headers });
  const failure = extractionFailure(extracted);
  if (failure) throw new Error(`${category === "pdf" ? "PDF" : "Image"} reading failed: ${failure}`);
  const text = extractedText(extracted);
  if (!text) throw new Error(`The ${category === "pdf" ? "PDF" : "image"} reader returned no readable guideline text.`);
  return text;
}

async function extractBytes(client: ReturnType<typeof createSuperdevClient>, bytes: Uint8Array, name: string, category: SourceCategory, headers: Record<string, string>): Promise<string> {
  if (["txt", "md", "csv", "json", "yaml", "xml", "log", "srt", "vtt"].includes(category)) return normalizeText(new TextDecoder().decode(bytes));
  if (category === "doc") return extractDoc(client, bytes, name, headers);
  if (category === "docx") return extractDocxFromZip(await streamDocxParts(bytes));
  if (category === "pdf" || ["image", "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"].includes(category)) return extractWithBuiltIn(client, bytes, name, category, headers);
  throw new Error("This archive entry is not a supported guideline file.");
}

function encryptedEntryNames(bytes: Uint8Array): Set<string> {
  const names = new Set<string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  for (let index = 0; index + 46 <= bytes.byteLength; index += 1) {
    if (view.getUint32(index, true) !== 0x02014b50) continue;
    const flags = view.getUint16(index + 8, true);
    const nameLength = view.getUint16(index + 28, true);
    const extraLength = view.getUint16(index + 30, true);
    const commentLength = view.getUint16(index + 32, true);
    const end = index + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.byteLength) continue;
    const name = decoder.decode(bytes.slice(index + 46, index + 46 + nameLength));
    if (flags & 1) names.add(name);
    index = end - 1;
  }
  return names;
}

async function streamArchiveEntries(bytes: Uint8Array, encrypted: Set<string>): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  let fileIndex = 0;
  const budget: ByteBudget = { value: 0, stopped: false };
  const pending: Promise<void>[] = [];
  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.onfile = (file) => {
    const name = zipEntryPath(file.name);
    const entry: ArchiveEntry = { name, compression: file.compression, originalSize: file.originalSize, bytes: null, error: "" };
    entries.push(entry);
    if (name.endsWith("/")) return;
    const index = fileIndex++;
    const info = classifyName(name);
    const category = info.source || "zip";
    if (index >= MAX_ARCHIVE_ENTRIES) {
      entry.error = `This entry is beyond the ${MAX_ARCHIVE_ENTRIES} entry archive limit.`;
      return;
    }
    if (!info.source) {
      entry.error = "This archive entry is not a supported guideline format.";
      return;
    }
    if (encrypted.has(file.name) || encrypted.has(name)) {
      entry.error = "This archive entry is encrypted and cannot be read.";
      return;
    }
    if (info.source === "zip") {
      entry.error = "Nested ZIP archives are not processed.";
      return;
    }
    if (file.compression !== 0 && file.compression !== 8) {
      entry.error = "This archive entry uses an unsupported compression method.";
      return;
    }
    const declared = file.originalSize;
    if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_ENTRY_BYTES)) {
      entry.error = `This entry is larger than the ${MAX_ENTRY_BYTES / 1024 / 1024} MB entry limit.`;
      return;
    }
    if (budget.stopped || (declared !== undefined && budget.value + declared > MAX_ARCHIVE_UNCOMPRESSED_BYTES)) {
      budget.stopped = true;
      entry.error = "The archive exceeds the total uncompressed size limit. No remaining content was truncated.";
      return;
    }
    pending.push((async () => {
      const collected = await collectUnzipFile(file, MAX_ENTRY_BYTES, budget, MAX_ARCHIVE_UNCOMPRESSED_BYTES);
      if (collected.error) entry.error = collected.error;
      else if (!collected.bytes) entry.error = `This archive entry could not be read as ${category}.`;
      else entry.bytes = collected.bytes;
    })());
  };
  try {
    unzipper.push(bytes, true);
    const settled = await Promise.allSettled(pending);
    if (settled.some((item) => item.status === "rejected")) throw new Error("An archive entry stream failed before it completed.");
  } catch {
    throw new Error("This ZIP archive could not be opened. It may be encrypted, damaged, or use unsupported compression.");
  }
  return entries;
}

async function processArchive(client: ReturnType<typeof createSuperdevClient>, bytes: Uint8Array, archiveName: string, headers: Record<string, string>): Promise<SourceResult[]> {
  let entries: ArchiveEntry[];
  try {
    entries = await streamArchiveEntries(bytes, encryptedEntryNames(bytes));
  } catch {
    return [unsupported(archiveName, "zip", "This ZIP archive could not be opened. It may be encrypted, damaged, or unsupported.")];
  }
  const results: SourceResult[] = [];
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    const displayName = `${safeName(archiveName)} › ${safeName(entry.name)}`;
    const info = classifyName(entry.name);
    const category = info.source || "zip";
    if (entry.error) {
      results.push(unsupported(displayName, category, entry.error));
      continue;
    }
    if (!entry.bytes || !info.source) {
      results.push(unsupported(displayName, category, "This archive entry could not be read."));
      continue;
    }
    try {
      const text = await extractBytes(client, entry.bytes, entry.name, info.source, headers);
      results.push(boundedSourceText(displayName, info.source, text));
    } catch (error) {
      results.push(unsupported(displayName, info.source, message(error instanceof Error ? error.message : "This archive entry could not be read.") || "This archive entry could not be read."));
    }
  }
  if (!results.length) return [unsupported(archiveName, "zip", "This ZIP archive contains no supported guideline files.")];
  return results;
}

async function readCapped(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_FILE_BYTES) throw new Error("This file is larger than the 10 MB upload limit.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("This file is larger than the 10 MB upload limit.");
  return bytes;
}

function managedUploadUrl(value: unknown): URL {
  if (typeof value !== "string") throw new Error("A managed uploaded file reference is required.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("The uploaded file reference is invalid."); }
  if (url.protocol !== "https:" || url.port || !MANAGED_UPLOAD_HOSTS.has(url.hostname) || !url.pathname.startsWith("/storage/v1/")) throw new Error("Only Buildy-managed uploaded files can be processed.");
  return url;
}

Deno.serve(async (request) => {
  const authorization = request.headers.get("Authorization");
  if (!authorization) return json({ error: "Authentication required." }, 401);
  try {
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Authentication required." }, 401);
    const client = createSuperdevClient({ appId: Deno.env.get("SUPERDEV_APP_ID") });
    client.auth.setToken(token);
    let user: JsonRecord;
    try { user = await client.auth.me() as JsonRecord; } catch { return json({ error: "Authentication required." }, 401); }
    const body = await request.json() as JsonRecord;
    const fileUrl = managedUploadUrl(body.file_url);
    const originalName = safeName(body.original_name, "Guideline file");
    const mimeType = typeof body.mime_type === "string" ? body.mime_type.slice(0, 160) : "";
    const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";
    if (sessionId) {
      try {
        const session = await client.entities.TranscriptionSession.get(sessionId) as JsonRecord;
        if (!session || (session.created_by && session.created_by !== user.email)) return json({ error: "The requested session is not available." }, 404);
      } catch { return json({ error: "The requested session is not available." }, 404); }
    }
    const response = await fetch(fileUrl);
    if (!response.ok) return json({ error: "The uploaded file could not be downloaded." }, 502);
    const bytes = await readCapped(response);
    if (!bytes.byteLength) return json({ error: "The uploaded file is empty." }, 400);
    const info = classifyName(originalName, mimeType);
    if (!info.source || info.source === "txt" && !PLAIN[info.extension] && !mimeType.toLowerCase().startsWith("text/")) return json({ error: "This file type is not supported." }, 400);
    const headers = integrationHeaders(request);
    const sources = info.source === "zip"
      ? await processArchive(client, bytes, originalName, headers)
      : [boundedSourceText(originalName, info.source, await extractBytes(client, bytes, originalName, info.source, headers))];
    return json({ sources });
  } catch (error) {
    console.error("process-custom-guideline-file failed", message(error instanceof Error ? error.message : "unknown error"));
    return json({ error: message(error instanceof Error ? error.message : "The guideline file could not be processed.") || "The guideline file could not be processed." }, 400);
  }
});
