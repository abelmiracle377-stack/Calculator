import { invokeLLM } from "@/integrations/core";
import type { CustomGuidelineSource, CustomGuidelineSourceRecord, CustomGuidelineStatus } from "@/lib/transcription/types";

export const MAX_CUSTOM_GUIDELINE_CHARS = 12_000;
export const MAX_CUSTOM_GUIDELINE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_CUSTOM_GUIDELINE_SOURCES = 24;
export const MAX_CUSTOM_GUIDELINE_SOURCE_NAME = 160;
export const MAX_CUSTOM_GUIDELINE_MESSAGE = 520;

const SOURCE_CATEGORIES = new Set<CustomGuidelineSource>([
  "text", "txt", "md", "csv", "json", "yaml", "xml", "log", "srt", "vtt", "pdf", "image",
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "doc", "docx", "zip",
]);
const PLAIN_TEXT_BY_EXTENSION: Record<string, CustomGuidelineSource> = {
  txt: "txt", md: "md", markdown: "md", csv: "csv", json: "json", yaml: "yaml", yml: "yaml",
  xml: "xml", log: "log", srt: "srt", vtt: "vtt",
};
const IMAGE_EXTENSIONS: Record<string, CustomGuidelineSource> = {
  png: "png", jpg: "jpg", jpeg: "jpeg", webp: "webp", gif: "gif", bmp: "bmp", avif: "avif",
};
const NEGATION = /\b(?:do not|don't|never|must not|mustn't|avoid|without|cannot|can't|no)\b/;

export interface CustomGuidelineFileInfo {
  supported: boolean;
  source?: CustomGuidelineSource;
  extension: string;
  reason?: string;
}

export interface CustomGuidelineConflict {
  source_a: string;
  source_b: string;
  excerpt_a: string;
  excerpt_b: string;
  reason: string;
}

export interface CustomGuidelineProcessingResult {
  status: CustomGuidelineStatus;
  text: string;
  source?: CustomGuidelineSource;
  message: string;
  character_count: number;
  conflicts?: CustomGuidelineConflict[];
  block_save?: boolean;
}

export interface CustomGuidelineConflictAuditResult {
  ok: boolean;
  conflicts: CustomGuidelineConflict[];
  error?: string;
}

function fileExtension(name: string): string {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "";
}

export function safeCustomGuidelineName(value: unknown, fallback = "Guideline source"): string {
  const safe = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
    : "";
  return (safe || fallback).slice(0, MAX_CUSTOM_GUIDELINE_SOURCE_NAME);
}

export function isCustomGuidelineSourceCategory(value: unknown): value is CustomGuidelineSource {
  return typeof value === "string" && SOURCE_CATEGORIES.has(value as CustomGuidelineSource);
}

export function classifyCustomGuidelineFile(file: Pick<File, "name" | "type">): CustomGuidelineFileInfo {
  const extension = fileExtension(file.name);
  const mime = (file.type || "").toLowerCase();
  if (PLAIN_TEXT_BY_EXTENSION[extension]) return { supported: true, source: PLAIN_TEXT_BY_EXTENSION[extension], extension };
  if (extension === "pdf" || mime === "application/pdf") return { supported: true, source: "pdf", extension };
  if (extension === "doc") return { supported: true, source: "doc", extension };
  if (extension === "docx" || mime.includes("wordprocessingml.document")) return { supported: true, source: "docx", extension };
  if (extension === "zip" || mime === "application/zip" || mime === "application/x-zip-compressed") return { supported: true, source: "zip", extension };
  if (IMAGE_EXTENSIONS[extension]) return { supported: true, source: IMAGE_EXTENSIONS[extension], extension };
  if (mime.startsWith("image/")) return { supported: true, source: "image", extension };
  if (mime.startsWith("text/")) return { supported: true, source: "txt", extension };
  return {
    supported: false,
    extension,
    reason: "This file type is not supported. Choose an image, DOC/DOCX, PDF, TXT, MD, CSV, JSON, YAML, XML, LOG, SRT, VTT, or ZIP file.",
  };
}

export function isPlainTextCustomGuidelineSource(source: CustomGuidelineSource): boolean {
  return ["txt", "md", "csv", "json", "yaml", "xml", "log", "srt", "vtt"].includes(source);
}

export function normalizeCustomGuidelineText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function boundedMessage(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_CUSTOM_GUIDELINE_MESSAGE) : "";
}

function clauses(value: string): string[] {
  return value.toLowerCase().split(/[\n.!?;]+/).map((part) => part.trim()).filter(Boolean);
}

function hasPositiveInstruction(value: string, pattern: RegExp): boolean {
  return clauses(value).some((clause) => pattern.test(clause) && !NEGATION.test(clause.slice(0, 110)));
}

function excerptFor(value: string, pattern: RegExp): string {
  const found = clauses(value).find((clause) => pattern.test(clause));
  return (found || value.replace(/\s+/g, " ").trim()).slice(0, 180);
}

function directiveFlags(value: string) {
  const full = /\b(?:full|strict|exact)\s+verbatim\b/;
  const clean = /\bclean\s+verbatim\b/;
  const keepFillers = /\b(?:preserve|keep|retain|include)\b.{0,70}\bfillers?\b/;
  const removeFillers = /\b(?:remove|omit|delete|strip)\b.{0,70}\bfillers?\b/;
  return {
    full: hasPositiveInstruction(value, full),
    clean: hasPositiveInstruction(value, clean),
    keepFillers: hasPositiveInstruction(value, keepFillers),
    removeFillers: hasPositiveInstruction(value, removeFillers),
    fullExcerpt: excerptFor(value, full),
    cleanExcerpt: excerptFor(value, clean),
    keepExcerpt: excerptFor(value, keepFillers),
    removeExcerpt: excerptFor(value, removeFillers),
  };
}

function ownProblems(value: string): { conflicts: string[]; unsupported: string[] } {
  const conflicts: string[] = [];
  const unsupported: string[] = [];
  const flags = directiveFlags(value);
  if (flags.full && flags.clean) conflicts.push("Full verbatim and Clean verbatim are both required.");
  if ((flags.keepFillers && flags.removeFillers) ||
      (hasPositiveInstruction(value, /\b(?:preserve|keep|retain|include|remove|omit|delete|strip)\s+fillers?\b/) &&
       hasPositiveInstruction(value, /\b(?:preserve|keep|retain|include)\b.{0,70}\bfillers?\b/) &&
       hasPositiveInstruction(value, /\b(?:remove|omit|delete|strip)\b.{0,70}\bfillers?\b/))) {
    conflicts.push("The guideline gives opposite directions about keeping and removing fillers.");
  }
  if (hasPositiveInstruction(value, /\b(?:invent|fabricate|make up|guess|reconstruct|hallucinate|fill in)\b/)) unsupported.push("It asks the transcript to invent, guess, or reconstruct speech.");
  if (hasPositiveInstruction(value, /\b(?:identify|infer|deduce|determine|recognize)\b.{0,70}\b(?:speaker|person|identity|role)\b/) ||
      hasPositiveInstruction(value, /\b(?:rename|change|relocate)\b.{0,70}\bspeaker\s+labels?\b/)) unsupported.push("It asks the system to identify speakers or change their source labels.");
  if (hasPositiveInstruction(value, /\b(?:add|remove|rename|change|move|relocate|reset|restart|retime|generate|invent)\b.{0,80}\b(?:timestamps?|speaker\s+labels?|sound[- ]event|event\s+markers?)\b/)) unsupported.push("It asks the system to change source timestamps, speaker labels, or sound-event markers.");
  if (hasPositiveInstruction(value, /\b(?:translate|transliterate|summarize|paraphrase)\b/) || hasPositiveInstruction(value, /\brewrite\b.{0,50}\b(?:meaning|speech|what\s+was\s+said)\b/)) unsupported.push("It asks the system to translate, summarize, or change the meaning of spoken words.");
  if (hasPositiveInstruction(value, /\[sic\]/) || hasPositiveInstruction(value, /\b(?:use|put|format|write)\b.{0,80}\([^)]*(?:audio|laugh|cough|noise|inaudible)\b/)) unsupported.push("It requests a marking format that conflicts with the app's source-truth rules.");
  return { conflicts: Array.from(new Set(conflicts)), unsupported: Array.from(new Set(unsupported)) };
}

function deterministicAudit(sources: CustomGuidelineSourceRecord[]): { conflicts: CustomGuidelineConflict[]; unsupported: string[] } {
  const conflicts: CustomGuidelineConflict[] = [];
  const unsupported: string[] = [];
  const seen = new Set<string>();
  const addConflict = (a: CustomGuidelineSourceRecord, b: CustomGuidelineSourceRecord, excerptA: string, excerptB: string, reason: string) => {
    const key = `${a.name}|${b.name}|${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    conflicts.push({ source_a: a.name, source_b: b.name, excerpt_a: excerptA.slice(0, 180), excerpt_b: excerptB.slice(0, 180), reason: reason.slice(0, 240) });
  };
  sources.forEach((source) => {
    const problems = ownProblems(source.text);
    problems.unsupported.forEach((message) => unsupported.push(`Source “${source.name}”: ${message}`));
    problems.conflicts.forEach((reason) => addConflict(source, source, excerptFor(source.text, /\b(?:verbatim|fillers?)\b/), excerptFor(source.text, /\b(?:verbatim|fillers?)\b/), `Source “${source.name}”: ${reason}`));
  });
  for (let i = 0; i < sources.length; i += 1) {
    const left = sources[i];
    const leftFlags = directiveFlags(left.text);
    for (let j = i; j < sources.length; j += 1) {
      const right = sources[j];
      const rightFlags = directiveFlags(right.text);
      if (leftFlags.full && rightFlags.clean) addConflict(left, right, leftFlags.fullExcerpt, rightFlags.cleanExcerpt, "One source requires full verbatim while another requires clean verbatim.");
      if (leftFlags.clean && rightFlags.full) addConflict(left, right, leftFlags.cleanExcerpt, rightFlags.fullExcerpt, "One source requires clean verbatim while another requires full verbatim.");
      if (leftFlags.keepFillers && rightFlags.removeFillers) addConflict(left, right, leftFlags.keepExcerpt, rightFlags.removeExcerpt, "The sources give opposite directions about keeping and removing fillers.");
      if (leftFlags.removeFillers && rightFlags.keepFillers) addConflict(left, right, leftFlags.removeExcerpt, rightFlags.keepExcerpt, "The sources give opposite directions about keeping and removing fillers.");
    }
  }
  return { conflicts, unsupported: Array.from(new Set(unsupported)) };
}

function boundaryText(source: CustomGuidelineSourceRecord): string {
  return `--- Source: ${safeCustomGuidelineName(source.name)} ---\n${source.text}\n--- End source: ${safeCustomGuidelineName(source.name)} ---`;
}

export function mergeCustomGuidelineSources(sources: CustomGuidelineSourceRecord[]): string {
  const usable = sources.filter((source) => normalizeCustomGuidelineText(source.text)).map((source) => ({ ...source, text: normalizeCustomGuidelineText(source.text) }));
  if (usable.length === 1) return usable[0].text;
  return usable.map(boundaryText).join("\n\n");
}

export function processCustomGuidelineSources(sources: CustomGuidelineSourceRecord[]): CustomGuidelineProcessingResult {
  if (sources.length > MAX_CUSTOM_GUIDELINE_SOURCES) {
    return {
      status: "unsupported",
      text: "",
      message: `There are ${sources.length} guideline sources. Remove sources until there are ${MAX_CUSTOM_GUIDELINE_SOURCES} or fewer before saving.`,
      character_count: 0,
      block_save: true,
    };
  }
  const bounded = sources.map((source) => ({
    ...source,
    name: safeCustomGuidelineName(source.name),
    text: normalizeCustomGuidelineText(source.text),
    message: boundedMessage(source.message),
    character_count: normalizeCustomGuidelineText(source.text).length,
  }));
  if (!bounded.length || !bounded.some((source) => source.text)) return { status: "empty", text: "", message: "Paste rules or add a guideline file before saving.", character_count: 0 };
  const failed = bounded.find((source) => source.status !== "ready" || !source.text);
  if (failed) {
    const message = failed.message || `Source “${failed.name}” could not be included.`;
    return { status: failed.status === "conflict" ? "conflict" : "unsupported", text: "", source: failed.category, message, character_count: 0, block_save: true };
  }
  const merged = mergeCustomGuidelineSources(bounded);
  if (merged.length > MAX_CUSTOM_GUIDELINE_CHARS) return { status: "unsupported", text: merged, message: `The combined guidelines contain ${merged.length.toLocaleString()} characters. The limit is ${MAX_CUSTOM_GUIDELINE_CHARS.toLocaleString()}, and no content was truncated. Remove a source or shorten the instructions before saving.`, character_count: merged.length, block_save: true };
  const audit = deterministicAudit(bounded);
  if (audit.conflicts.length) {
    const details = audit.conflicts.slice(0, 4).map((item) => `“${item.source_a}” vs “${item.source_b}”: ${item.reason}`).join(" ");
    return { status: "conflict", text: merged, message: `Resolve these conflicting instructions before capture. ${details}`, character_count: merged.length, conflicts: audit.conflicts, block_save: true };
  }
  if (audit.unsupported.length) return { status: "unsupported", text: merged, message: audit.unsupported.slice(0, 4).join(" "), character_count: merged.length, block_save: true };
  return { status: "ready", text: merged, message: "Guidelines are ready for this session.", character_count: merged.length };
}

export function processCustomGuideline(value: unknown, source: CustomGuidelineSource = "text"): CustomGuidelineProcessingResult {
  const text = normalizeCustomGuidelineText(value);
  const record: CustomGuidelineSourceRecord = { name: source === "text" ? "Pasted or typed guidelines" : `${source.toUpperCase()} guideline`, category: source, text, status: text ? "ready" : "empty", message: "", character_count: text.length };
  return processCustomGuidelineSources(text ? [record] : []);
}

function responseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return responseObject(JSON.parse(value)); } catch { return {}; }
  }
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return record.result !== undefined ? responseObject(record.result) : record;
}

export async function auditCustomGuidelineConflicts(sources: CustomGuidelineSourceRecord[]): Promise<CustomGuidelineConflictAuditResult> {
  const material = sources.filter((source) => source.status === "ready" && normalizeCustomGuidelineText(source.text)).slice(0, MAX_CUSTOM_GUIDELINE_SOURCES);
  if (!material.length) return { ok: true, conflicts: [] };
  try {
    const response = await invokeLLM({
      mode: "standard",
      prompt: [
        "Audit these transcription guideline sources for direct contradictions in instructions.",
        "Look for incompatible requirements within one source or between sources. Do not flag different wording that can be followed together, and do not flag the app's immutable timestamp, speaker, or sound-marker safety rules unless a source explicitly contradicts them.",
        "Return only strict JSON matching the schema. Use the exact source names supplied. Each excerpt must be a short verbatim excerpt from its source, with no more than 180 characters.",
        `Sources:\n${JSON.stringify(material.map((source) => ({ name: source.name, text: source.text })))}`,
      ].join("\n\n"),
      response_json_schema: {
        type: "object",
        properties: {
          conflicts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                source_a: { type: "string" }, source_b: { type: "string" }, excerpt_a: { type: "string" }, excerpt_b: { type: "string" }, reason: { type: "string" },
              },
              required: ["source_a", "source_b", "excerpt_a", "excerpt_b", "reason"],
            },
          },
        },
        required: ["conflicts"],
      },
    });
    const parsed = responseObject(response);
    if (!Array.isArray(parsed.conflicts)) throw new Error("The conflict audit returned no validated conflict list.");
    const names = new Set(material.map((source) => source.name));
    const conflicts: CustomGuidelineConflict[] = [];
    for (const item of parsed.conflicts) {
      if (!item || typeof item !== "object") throw new Error("The conflict audit returned an invalid finding.");
      const record = item as Record<string, unknown>;
      const sourceA = safeCustomGuidelineName(record.source_a, "");
      const sourceB = safeCustomGuidelineName(record.source_b, "");
      if (!sourceA || !sourceB || !names.has(sourceA) || !names.has(sourceB)) throw new Error("The conflict audit returned an unknown source.");
      const excerptA = boundedMessage(record.excerpt_a).slice(0, 180);
      const excerptB = boundedMessage(record.excerpt_b).slice(0, 180);
      const reason = boundedMessage(record.reason).slice(0, 240);
      if (!excerptA || !excerptB || !reason) throw new Error("The conflict audit returned incomplete evidence.");
      conflicts.push({ source_a: sourceA, source_b: sourceB, excerpt_a: excerptA, excerpt_b: excerptB, reason });
    }
    return { ok: true, conflicts: conflicts.slice(0, 12) };
  } catch (error) {
    console.error("Custom guideline conflict audit failed", error instanceof Error ? error.message : "unknown error");
    return { ok: false, conflicts: [], error: "The conflict audit could not complete. Try saving again before starting Custom Guidelines." };
  }
}

export function normalizeCustomGuidelineStatus(value: unknown): CustomGuidelineStatus {
  return value === "ready" || value === "conflict" || value === "unsupported" || value === "empty" ? value : "empty";
}

export function sanitizeCustomGuidelineSource(value: unknown): CustomGuidelineSourceRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const category = isCustomGuidelineSourceCategory(record.category) ? record.category : "text";
  const text = normalizeCustomGuidelineText(record.text);
  const status = normalizeCustomGuidelineStatus(record.status);
  if (text.length > MAX_CUSTOM_GUIDELINE_CHARS) {
    return {
      name: safeCustomGuidelineName(record.name),
      category,
      text: "",
      status: "unsupported",
      message: "This saved source is larger than the safe guideline limit and must be replaced.",
      character_count: text.length,
    };
  }
  return { name: safeCustomGuidelineName(record.name), category, text, status, message: boundedMessage(record.message), character_count: text.length };
}

export function sanitizeCustomGuidelineSources(value: unknown): CustomGuidelineSourceRecord[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_CUSTOM_GUIDELINE_SOURCES).flatMap((item) => {
    const source = sanitizeCustomGuidelineSource(item);
    return source ? [source] : [];
  });
}

export function extractedGuidelineText(value: unknown): string {
  const collect = (candidate: unknown, depth: number): string[] => {
    if (depth > 5) return [];
    if (typeof candidate === "string") return [candidate];
    if (Array.isArray(candidate)) return candidate.flatMap((item) => collect(item, depth + 1));
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    const preferred = ["text", "guideline_text", "content", "output", "data", "result"];
    for (const key of preferred) {
      if (record[key] !== undefined) {
        const found = collect(record[key], depth + 1);
        if (found.length) return found;
      }
    }
    return Object.values(record).flatMap((item) => collect(item, depth + 1));
  };
  return normalizeCustomGuidelineText(collect(value, 0).join("\n"));
}

export function isCustomGuidelineReady(status: unknown, text: unknown): boolean {
  return normalizeCustomGuidelineStatus(status) === "ready" && normalizeCustomGuidelineText(text).length > 0 && normalizeCustomGuidelineText(text).length <= MAX_CUSTOM_GUIDELINE_CHARS;
}

export function customGuidelineReadinessMessage(status: unknown, text: unknown, savedMessage = ""): string {
  if (isCustomGuidelineReady(status, text)) return "";
  const safeMessage = typeof savedMessage === "string" ? savedMessage.trim().slice(0, 360) : "";
  if (safeMessage) return safeMessage;
  switch (normalizeCustomGuidelineStatus(status)) {
    case "conflict": return "Resolve the conflicting guideline directions before starting Custom Guidelines.";
    case "unsupported": return "Update the guideline to remove unsupported instructions before starting Custom Guidelines.";
    case "empty": return "Save a transcription guideline before starting Custom Guidelines.";
    default: return "Save a valid transcription guideline before starting Custom Guidelines.";
  }
}

export function customGuidelineStatusLabel(status: unknown): string {
  switch (normalizeCustomGuidelineStatus(status)) {
    case "ready": return "Ready";
    case "conflict": return "Needs review";
    case "unsupported": return "Needs attention";
    default: return "Empty";
  }
}
