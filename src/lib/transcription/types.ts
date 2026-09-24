export type SessionStatus = "recording" | "completed" | "failed" | "discarded";
export type SessionArchiveStatus = "ACTIVE" | "ARCHIVED";
export type TranscriptStyle = "full_verbatim" | "clean_verbatim";
export type LanguageMode = "auto" | "manual";
export interface LanguageDetectionSummary {
  languages: string[];
  confidence?: number;
}
export type SpeakerScheme = "numbered" | "letters" | "custom";
/** Legacy 30s and 60s values remain readable for older saved sessions. */
export type TimestampCadence =
  | "speaker_change"
  | "two_minutes"
  | "both"
  | "manual"
  | "none"
  | "30s"
  | "60s";
export type UnclearMarkerKind = "inaudible" | "unintelligible";
export type LineKind = "speech" | "marker" | "timestamp";
export type UploadStatus = "pending" | "uploaded" | "failed";
export type TranscriptionStatus = "pending" | "transcribing" | "completed" | "failed";
export type SessionTranscriptionStatus = "idle" | "processing" | "partial" | "completed" | "failed";
export type CleanupStatus = "idle" | "reviewing" | "applied";
export type AudioPhase = "waiting" | "active" | "quiet" | "ended";
export type AudioClockSource = "audio-context" | "script-processor";
export type CaptureEventType = "vad_transition" | "local_signal";
export type CaptureEventSource = "vad" | "provider" | "recorder";
export type IssueKind =
  | "clipping"
  | "possible_clipping"
  | "possible_pop_click"
  | "possible_distortion"
  | "silence"
  | "leading_silence"
  | "trailing_silence"
  | "source_signal_start"
  | "source_signal_end"
  | "missing_audio"
  | "sharing_ended"
  | "recorder_error"
  | "upload_failure"
  | "transcription_failure";
export type IssueSeverity = "info" | "warning" | "error";
export type ReviewMode = "standard" | "pulsar_review" | "custom_guidelines";
export type InputMode = "browser_capture" | "audio_transcription";
export type SessionMode = "transcription" | "translation";
export type TranslationStatus = "translating" | "completed" | "failed";
export type TranslationAudioStatus = "idle" | "synthesizing" | "completed" | "failed";
export type CustomGuidelineStatus = "empty" | "ready" | "conflict" | "unsupported";
/** The safe category retained for a processed guideline source, never a file URL. */
export type CustomGuidelineSource =
  | "text"
  | "txt"
  | "md"
  | "csv"
  | "json"
  | "yaml"
  | "xml"
  | "log"
  | "srt"
  | "vtt"
  | "pdf"
  | "image"
  | "png"
  | "jpg"
  | "jpeg"
  | "webp"
  | "gif"
  | "bmp"
  | "avif"
  | "doc"
  | "docx"
  | "zip";

export interface CustomGuidelineSourceRecord {
  name: string;
  category: CustomGuidelineSource;
  text: string;
  status: CustomGuidelineStatus;
  message: string;
  character_count: number;
}

export type PulsarClipStatus = "not_started" | "in_progress" | "done";
export type PulsarReadiness = "not_started" | "in_progress" | "ready";
export type PulsarQaSeverity = "info" | "warning" | "error";
export type PulsarTagCategory = "non_lexical" | "style" | "background_audio" | "uncertainty" | "end_of_file" | "discard";
export type PulsarTagInsertMode = "append" | "append_direct" | "wrap" | "standalone";

export interface PulsarTagDefinition {
  category: PulsarTagCategory;
  displayLabel: string;
  insertionValue: string;
  placementGuidance: string;
  insertMode: PulsarTagInsertMode;
  allowedTokens?: string[];
  wrapperName?: "ws" | "lv" | "sg";
  discard?: boolean;
  endOfFile?: boolean;
  standalone?: boolean;
}

export interface PulsarQaFinding {
  id: string;
  code: string;
  severity: PulsarQaSeverity;
  message: string;
  line_id?: string;
  segment_id?: string;
  sequence?: number;
  reference_line_id?: string;
}

export interface PulsarQaSummary {
  total: number;
  errors: number;
  warnings: number;
  infos: number;
  blocking: number;
}

export interface PulsarQaResult {
  ran_at?: string;
  findings: PulsarQaFinding[];
  summary: PulsarQaSummary;
}

export interface PulsarReadinessResult {
  state: PulsarReadiness;
  eligible: boolean;
  uploaded_clip_count: number;
  reviewed_clip_count: number;
  unreviewed_segment_ids: string[];
  progress_percent: number;
  blockers: PulsarQaFinding[];
}

export interface PulsarJsonExportPackage {
  package_type: "verbatim_desk_pulsar_review";
  package_version: "1.0";
  local_only: true;
  exported_at: string;
  external_submission: {
    attempted: false;
    status: "not_submitted";
    note: string;
  };
  session: Record<string, unknown>;
  source_timing: Record<string, unknown>;
  transcript_lines: Record<string, unknown>[];
  audio_clips: Record<string, unknown>[];
  issues: Record<string, unknown>[];
  annotations: Record<string, unknown>[];
  tag_vocabulary: { version: string; tags: PulsarTagDefinition[] };
  qa: PulsarQaResult;
  readiness: PulsarReadinessResult;
}

export interface CaptureCallbackContext {
  sessionId: string;
  captureRunId: string;
}

/** A source-positioned VAD transition or conservative local signal finding. */
export interface CaptureEventPayload {
  type: CaptureEventType;
  label: string;
  source: "vad";
  severity: IssueSeverity;
  start_ms: number;
  end_ms?: number;
  confidence?: number;
  phase?: AudioPhase;
  possible?: boolean;
  notes?: string;
  captureSessionId?: string;
  captureRunId?: string;
}

/** Timing values use the complete session source timeline, including silence. */
export interface CaptureTimingSnapshot {
  elapsedMs: number;
  captureElapsedMs: number;
  sourceElapsedMs: number;
  phase: AudioPhase;
  clockSource?: AudioClockSource;
  clockSourceNote?: string;
  captureStartedAt?: string;
  captureEndedAt?: string;
  meaningfulAudioStartedMs?: number;
  meaningfulAudioEndedMs?: number;
  leadingSilenceMs?: number;
  trailingSilenceMs?: number;
  captureSessionId?: string;
  captureRunId?: string;
}

export interface TranscriptionSessionRecord {
  id: string;
  title: string;
  status: SessionStatus;
  archive_status?: SessionArchiveStatus;
  source_label?: string;
  language?: string;
  language_mode?: LanguageMode;
  language_preferences?: string[];
  accent_hint?: string;
  detected_languages?: string[];
  transcript_style?: TranscriptStyle;
  speaker_scheme?: SpeakerScheme;
  timestamp_cadence?: TimestampCadence;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  capture_started_at?: string;
  capture_ended_at?: string;
  meaningful_audio_started_ms?: number;
  meaningful_audio_ended_ms?: number;
  leading_silence_ms?: number;
  trailing_silence_ms?: number;
  audio_phase?: AudioPhase;
  audio_clock_source?: AudioClockSource;
  error_summary?: string;
  last_speaker?: string;
  custom_speakers?: string[];
  transcription_status?: SessionTranscriptionStatus;
  transcription_total_count?: number;
  transcription_pending_count?: number;
  transcription_active_count?: number;
  transcription_completed_count?: number;
  transcription_failed_count?: number;
  transcription_error_summary?: string;
  last_transcription_at?: string;
  cleanup_status?: CleanupStatus;
  cleanup_at?: string;
  cleanup_summary?: string;
  review_mode?: ReviewMode;
  input_mode?: InputMode;
  session_mode?: SessionMode;
  translation_source_language?: string;
  translation_target_language?: string;
  custom_guideline_text?: string;
  custom_guideline_source_label?: string;
  custom_guideline_status?: CustomGuidelineStatus;
  custom_guideline_message?: string;
  custom_guideline_saved_at?: string;
  custom_guideline_locked_at?: string;
  custom_guideline_sources?: CustomGuidelineSourceRecord[];
  pulsar_readiness?: PulsarReadiness;
  pulsar_qa_ran_at?: string;
  created_at?: string;
  updated_at?: string;
  created_by?: string;
}

export interface TranscriptLineRecord {
  id: string;
  session_id: string;
  sequence: number;
  kind: LineKind;
  speaker_label?: string;
  text?: string;
  start_ms?: number;
  end_ms?: number;
  source_segment_id?: string;
  origin?: "generated" | "manual";
  provider_speaker_id?: string;
  raw_text?: string;
  confidence?: number;
  provider_start_ms?: number;
  provider_end_ms?: number;
  edit_state?: "provider" | "edited";
  edited_at?: string;
  cleanup_text?: string;
  cleanup_applied?: boolean;
  audio_event_tags?: string[];
  automatic_marker?: boolean;
  audio_event_source?: "provider" | "vad" | "manual";
  audio_event_type?: string;
  audio_event_confidence?: number;
}

export interface AudioSegmentRecord {
  id: string;
  session_id: string;
  sequence: number;
  audio_url?: string;
  mime_type?: string;
  byte_size?: number;
  start_ms: number;
  end_ms: number;
  upload_status: UploadStatus;
  error_message?: string;
  is_final_segment?: boolean;
  meaningful_audio_started_ms?: number;
  meaningful_audio_ended_ms?: number;
  leading_silence_ms?: number;
  trailing_silence_ms?: number;
  clock_source?: AudioClockSource;
  transcription_status?: TranscriptionStatus;
  transcription_error?: string;
  transcription_started_at?: string;
  transcribed_at?: string;
  detected_language?: string;
  language_probability?: number;
  detected_languages?: string[];
  speaker_count?: number;
  detected_speakers?: string[];
  provider_speaker_ids?: string[];
  word_count?: number;
  provider_text?: string;
  pulsar_review_status?: PulsarClipStatus;
}

export interface AudioIssueRecord {
  id: string;
  session_id: string;
  kind: IssueKind;
  severity: IssueSeverity;
  timestamp_ms: number;
  end_timestamp_ms?: number;
  notes?: string;
  source?: CaptureEventSource;
  possible?: boolean;
  confidence?: number;
  created_at?: string;
}

export interface TranscriptAnnotationRecord {
  id: string;
  session_id: string;
  start_ms: number;
  end_ms: number;
  label: string;
  notes?: string;
  color?: string;
  category?: string;
  sequence: number;
  created_at?: string;
  updated_at?: string;
}

export interface CleanupProposal {
  line_id: string;
  original_text: string;
  proposed_text: string;
  speaker_label: string;
  start_ms?: number;
  end_ms?: number;
}

export interface TranscriptionCounts {
  total: number;
  pending: number;
  active: number;
  completed: number;
  failed: number;
}

export interface TranscriptionJobResult {
  ok?: boolean;
  status?: "completed" | "failed" | "in_progress";
  error?: string;
  segment?: AudioSegmentRecord;
  session?: TranscriptionSessionRecord;
  lines?: TranscriptLineRecord[];
  issue?: AudioIssueRecord | null;
  counts?: TranscriptionCounts;
}

export interface TranslationLineSnapshot {
  source_line_id: string;
  sequence: number;
  kind: LineKind;
  source_text: string;
  translated_text: string;
  speaker_label?: string;
  provider_speaker_id?: string;
  start_ms?: number;
  end_ms?: number;
}

export interface TranslationResultRecord {
  id: string;
  session_id: string;
  source_segment_id: string;
  source_sequence: number;
  status: TranslationStatus;
  requested_source_language: string;
  detected_source_language?: string;
  target_language: string;
  source_hash: string;
  settings_hash: string;
  lines: TranslationLineSnapshot[];
  error?: string;
  retry?: number;
  translation_started_at?: string;
  translated_at?: string;
  failed_at?: string;
  audio_status?: TranslationAudioStatus;
  audio_url?: string;
  audio_mime_type?: string;
  audio_voice_id?: string;
  audio_error?: string;
  audio_generated_at?: string;
  created_at?: string;
  updated_at?: string;
  created_by?: string;
}

export interface TranslationJobResult {
  ok?: boolean;
  status?: TranslationStatus | "in_progress";
  error?: string;
  result?: TranslationResultRecord;
}

export interface TranslationAudioJobResult {
  ok?: boolean;
  audio_status?: TranslationAudioStatus;
  error?: string;
  result?: TranslationResultRecord;
}

export interface MeterLevels {
  rms: number;
  peak: number;
}

export interface CaptureStatus extends CaptureTimingSnapshot {
  state: "idle" | "requesting" | "recording" | "stopping" | "error";
  sourceLabel: string;
  message?: string;
}
