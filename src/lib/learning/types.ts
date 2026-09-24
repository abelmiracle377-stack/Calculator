export type AiLearningScope = "PRIVATE_PROJECT";
export type AiLearningStatus = "PENDING" | "APPROVED" | "REJECTED";
export type AiLearningSourceKind = "transcript_correction" | "assistant_answer" | "document_guidance" | "support_resolution" | "repeated_pattern";
export type AiLearningTargetSurface = "TRANSCRIPT_AND_TRANSLATION" | "ASSISTANT";
export type AiLearningCategory = "transcription_style" | "wording" | "terminology" | "punctuation" | "assistant_guidance" | "document_guidance" | "support_resolution" | "repeated_pattern" | "other";
export type AiLearningAction = "list_pending" | "list_sources" | "edit_pending" | "approve" | "reject" | "create_from_assistant" | "create_from_document_guidance" | "create_from_support_resolution" | "create_from_pattern";

export interface AiLearningContextFields {
  review_mode: string;
  session_mode: string;
  transcript_style: string;
  source_language: string;
  target_language: string;
}

export interface AiLearningItemRecord extends AiLearningContextFields {
  id: string;
  source_owner_email: string;
  scope_key: AiLearningScope;
  source_kind: AiLearningSourceKind;
  target_surface: AiLearningTargetSurface;
  source_session_id: string;
  source_segment_id: string;
  source_line_id: string;
  source_conversation_id: string;
  source_message_id: string;
  source_document_id: string;
  source_support_request_id: string;
  source_document_name: string;
  source_question_excerpt: string;
  source_answer_excerpt: string;
  source_resolution_excerpt: string;
  source_reference_labels: string[];
  evidence_item_ids: string[];
  pattern_key: string;
  occurrence_count: number;
  source_content_hash: string;
  original_text_snapshot: string;
  corrected_text_snapshot: string;
  proposed_rule: string;
  final_rule: string;
  category: AiLearningCategory;
  rationale: string;
  status: AiLearningStatus;
  active: boolean;
  version: number;
  submitted_by: string;
  submitted_at: string;
  approved_by: string;
  approved_at: string;
  rejected_by: string;
  rejected_at: string;
  dedupe_key: string;
  note: string;
  created_at?: string;
  updated_at?: string;
}

export interface AiLearningSourceOption {
  id: string;
  source_kind: AiLearningSourceKind;
  source_owner_email: string;
  source_conversation_id: string;
  source_message_id: string;
  source_document_id: string;
  source_support_request_id: string;
  source_document_name: string;
  source_question_excerpt: string;
  source_answer_excerpt: string;
  source_resolution_excerpt: string;
  source_reference_labels: string[];
  target_surface: AiLearningTargetSurface;
  category: AiLearningCategory;
  final_rule: string;
  rationale: string;
  occurrence_count: number;
  approved_at: string;
}

export interface AiLearningSourcesResponse {
  ok: boolean;
  assistant_answers: AiLearningSourceOption[];
  document_guidance: AiLearningSourceOption[];
  support_resolutions: AiLearningSourceOption[];
  pattern_items: AiLearningSourceOption[];
}

export interface AiLearningAuditEventRecord {
  id: string;
  learning_item_id: string;
  action: string;
  actor_email: string;
  source_owner_email: string;
  source_kind: AiLearningSourceKind;
  target_surface: AiLearningTargetSurface;
  source_session_id: string;
  source_line_id: string;
  source_conversation_id: string;
  source_message_id: string;
  source_document_id: string;
  source_support_request_id: string;
  evidence_item_ids: string[];
  scope_key: AiLearningScope;
  previous_rule: string;
  current_rule: string;
  previous_status: AiLearningStatus;
  current_status: AiLearningStatus;
  version: number;
  active: boolean;
  server_timestamp: string;
  dedupe_key: string;
  note: string;
  created_at?: string;
}

export interface AiLearningCandidateSummary {
  id: string;
  status: AiLearningStatus;
  active: boolean;
  scope_key: AiLearningScope;
  category: AiLearningCategory;
  submitted_at: string;
}

export interface AiLearningProposalResponse {
  ok: boolean;
  created: boolean;
  candidate?: AiLearningCandidateSummary;
  reason?: "not_meaningful" | "already_pending" | "already_reviewed" | "no_safe_rule";
}

export interface ApprovedAiLearningRule {
  id: string;
  rule: string;
  category: AiLearningCategory;
  rationale: string;
  scope_key: AiLearningScope;
  context: AiLearningContextFields;
  approved_at: string;
}

export interface ApprovedAiLearningContextResponse {
  ok: boolean;
  rules: ApprovedAiLearningRule[];
}

export interface AiLearningAdminCounts {
  pending: number;
  approved: number;
  rejected: number;
}

export interface AiLearningAdminResponse {
  ok: boolean;
  items: AiLearningItemRecord[];
  counts: AiLearningAdminCounts;
}

export interface AiLearningAdminActionResponse {
  ok: boolean;
  action: AiLearningAction | "APPROVED" | "REJECTED" | "EDITED" | "CREATED";
  item?: AiLearningItemRecord;
  idempotent?: boolean;
  duplicate?: boolean;
  created?: boolean;
}
