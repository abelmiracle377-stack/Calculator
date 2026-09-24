import { adminAiLearning } from "@/functions";
import type { AiLearningAdminActionResponse, AiLearningAdminResponse } from "@/lib/learning/types";

export class AdminLearningRequestError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "AdminLearningRequestError";
    this.status = status;
  }
}

const PENDING_STRING_FIELDS = [
  "source_owner_email", "scope_key", "source_kind", "target_surface", "source_session_id", "source_segment_id", "source_line_id", "source_conversation_id", "source_message_id", "source_document_id", "source_support_request_id", "source_document_name", "source_question_excerpt", "source_answer_excerpt", "source_resolution_excerpt", "pattern_key", "source_content_hash", "original_text_snapshot", "corrected_text_snapshot", "proposed_rule", "final_rule", "category", "rationale", "review_mode", "session_mode", "transcript_style", "source_language", "target_language", "status", "submitted_by", "submitted_at", "approved_by", "approved_at", "rejected_by", "rejected_at", "note",
] as const;
const SOURCE_KINDS = new Set(["transcript_correction", "assistant_answer", "document_guidance", "support_resolution", "repeated_pattern"]);
const TARGET_SURFACES = new Set(["TRANSCRIPT_AND_TRANSLATION", "ASSISTANT"]);
const CATEGORIES = new Set(["transcription_style", "wording", "terminology", "punctuation", "assistant_guidance", "document_guidance", "support_resolution", "repeated_pattern", "other"]);

function responseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return responseObject(JSON.parse(value)); } catch { return {}; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return record.result && typeof record.result === "object" && !Array.isArray(record.result) ? record.result as Record<string, unknown> : record;
}
function malformedResponse(detail: string): AdminLearningRequestError { return new AdminLearningRequestError(`The private learning review returned an invalid response: ${detail}`); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function finiteCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) throw malformedResponse(`${label} count is missing or invalid.`);
  return value;
}
function pendingItem(value: unknown, index: number): AiLearningAdminResponse["items"][number] {
  if (!isRecord(value)) throw malformedResponse(`pending item ${index + 1} is not an object.`);
  const item = value;
  if (typeof item.id !== "string" || !item.id.trim()) throw malformedResponse(`pending item ${index + 1} is missing its id.`);
  for (const field of PENDING_STRING_FIELDS) if (typeof item[field] !== "string") throw malformedResponse(`pending item ${index + 1} is missing ${field}.`);
  if (!Array.isArray(item.source_reference_labels) || item.source_reference_labels.some((label) => typeof label !== "string")) throw malformedResponse(`pending item ${index + 1} has invalid source references.`);
  if (!Array.isArray(item.evidence_item_ids) || item.evidence_item_ids.some((id) => typeof id !== "string")) throw malformedResponse(`pending item ${index + 1} has invalid evidence ids.`);
  if (item.scope_key !== "PRIVATE_PROJECT" || !SOURCE_KINDS.has(item.source_kind) || !TARGET_SURFACES.has(item.target_surface) || !CATEGORIES.has(item.category)) throw malformedResponse(`pending item ${index + 1} has unsupported protected fields.`);
  if (item.status !== "PENDING" || item.active !== false) throw malformedResponse(`pending item ${index + 1} is not an inactive pending item.`);
  if (!String(item.proposed_rule).trim()) throw malformedResponse(`pending item ${index + 1} has no proposed rule to review.`);
  if (typeof item.active !== "boolean" || typeof item.version !== "number" || !Number.isFinite(item.version) || !Number.isInteger(item.version) || item.version < 1) throw malformedResponse(`pending item ${index + 1} has invalid review state.`);
  if (typeof item.occurrence_count !== "number" || !Number.isFinite(item.occurrence_count) || !Number.isInteger(item.occurrence_count) || item.occurrence_count < 0) throw malformedResponse(`pending item ${index + 1} has an invalid occurrence count.`);
  return item as AiLearningAdminResponse["items"][number];
}
function validatePendingResponse(body: Record<string, unknown>): AiLearningAdminResponse {
  if (body.ok !== true) throw malformedResponse("the success signal is missing.");
  if (!Array.isArray(body.items)) throw malformedResponse("the pending items list is missing.");
  if (!isRecord(body.counts)) throw malformedResponse("the review counts are missing.");
  const counts = body.counts;
  return {
    ok: true,
    items: body.items.map((item, index) => pendingItem(item, index)),
    counts: { pending: finiteCount(counts.pending, "Pending"), approved: finiteCount(counts.approved, "Approved"), rejected: finiteCount(counts.rejected, "Rejected") },
  };
}

async function call<T>(payload: Record<string, unknown>): Promise<T> {
  try {
    const body = responseObject(await adminAiLearning(payload));
    if (body.error) throw new AdminLearningRequestError(String(body.error), Number(body.status) || undefined);
    if (payload.action === "list_pending") return validatePendingResponse(body) as T;
    return body as T;
  } catch (error) {
    if (error instanceof AdminLearningRequestError) throw error;
    const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const status = Number(record.status) || undefined;
    throw new AdminLearningRequestError("The private learning review service could not be reached.", status);
  }
}

export function adminLearningAction<T = AiLearningAdminResponse | AiLearningAdminActionResponse>(payload: Record<string, unknown>): Promise<T> { return call<T>(payload); }

export function isLearningAccessDenied(error: unknown): boolean {
  const status = error instanceof AdminLearningRequestError ? error.status : undefined;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase();
  return status === 401 || status === 403 || status === 404 || message.includes("not found") || message.includes("authentication required") || message.includes("unauthorized") || message.includes("forbidden");
}
