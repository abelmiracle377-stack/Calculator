import { uploadFile } from "@/integrations/core";
import { AudioIssue, AudioSegment } from "@/entities";
import type { AudioIssueRecord, AudioSegmentRecord, IssueKind, IssueSeverity } from "@/lib/transcription/types";
import { notifyFatal, safeMessage } from "./audio-capture-helpers";
import type { CaptureControllerCallbacks, CaptureRun, CycleResult, SegmentTiming } from "./audio-capture-model";

export interface PersistIssueInput {
  kind: IssueKind;
  severity: IssueSeverity;
  notes: string;
  timestampMs: number;
  endTimestampMs?: number;
  source?: "vad" | "provider" | "recorder";
  possible?: boolean;
  confidence?: number;
  preferredId?: string;
}

export function timingForRun(run: CaptureRun, fullSourceMs: number): SegmentTiming {
  return {
    sourceElapsedMs: Math.max(0, fullSourceMs),
    ...(run.meaningfulStartMs == null ? {} : { meaningfulStartMs: run.meaningfulStartMs }),
    ...(run.meaningfulEndMs == null ? {} : { meaningfulEndMs: Math.min(fullSourceMs, run.meaningfulEndMs) }),
    leadingSilenceMs: Math.max(0, run.leadingSilenceMs ?? 0),
    trailingSilenceMs: Math.max(0, run.trailingSilenceMs ?? 0),
  };
}

export async function persistIssue(
  run: CaptureRun,
  callbacks: CaptureControllerCallbacks,
  input: PersistIssueInput,
): Promise<AudioIssueRecord | undefined> {
  if (run.closed || callbacks.isDisposed()) return undefined;
  const isLeading = input.kind === "leading_silence";
  const isTrailing = input.kind === "trailing_silence";
  const existingId = input.preferredId || (isLeading ? run.leadingIssueId : isTrailing ? run.trailingIssueId : undefined);
  if (isLeading) {
    if (run.leadingIssuePending) return undefined;
    if (run.leadingIssueRecorded && !existingId) return undefined;
    run.leadingIssuePending = true;
  }
  if (isTrailing) {
    if (run.trailingIssuePending) return undefined;
    if (run.trailingIssueRecorded && !existingId) return undefined;
    run.trailingIssuePending = true;
  }

  const start = Math.max(0, Math.round(input.timestampMs));
  const end = input.endTimestampMs == null ? undefined : Math.max(start, Math.round(input.endTimestampMs));
  const payload = {
    session_id: run.sessionId,
    kind: input.kind,
    severity: input.severity,
    timestamp_ms: start,
    ...(end == null ? {} : { end_timestamp_ms: end }),
    notes: input.notes,
    source: input.source || "vad",
    possible: input.possible || false,
    ...(input.confidence == null ? {} : { confidence: input.confidence }),
  };

  try {
    const issue = (existingId ? await AudioIssue.update(existingId, payload) : await AudioIssue.create(payload)) as AudioIssueRecord;
    if (isLeading) {
      run.leadingIssueId = issue.id;
      run.leadingIssueRecorded = true;
      run.leadingIssuePending = false;
    }
    if (isTrailing) {
      run.trailingIssueId = issue.id;
      run.trailingIssueRecorded = true;
      run.trailingIssuePending = false;
    }
    if (!run.closed && !callbacks.isDisposed()) callbacks.onIssue(issue);
    return issue;
  } catch (error) {
    if (isLeading) run.leadingIssuePending = false;
    if (isTrailing) run.trailingIssuePending = false;
    console.error("Failed to save audio finding", error);
    return undefined;
  }
}

export async function uploadSegment(
  run: CaptureRun,
  callbacks: CaptureControllerCallbacks,
  result: CycleResult,
  timing: SegmentTiming,
  isFinalSegment: boolean,
): Promise<void> {
  if (run.closed || callbacks.isDisposed() || result.blob.size === 0) return;
  const mime = result.blob.type || "audio/webm";
  const file = new File([result.blob], `segment-${result.sequence}.${extensionForMime(mime)}`, { type: mime });
  const startsInSegment = timing.meaningfulStartMs != null && timing.meaningfulStartMs >= result.startMs && timing.meaningfulStartMs <= result.endMs;
  const endsInSegment = timing.meaningfulEndMs != null && timing.meaningfulEndMs >= result.startMs && timing.meaningfulEndMs <= result.endMs;
  const segmentTrailingMs = timing.meaningfulEndMs == null
    ? Math.max(0, result.endMs - result.startMs)
    : Math.max(0, result.endMs - Math.max(result.startMs, timing.meaningfulEndMs));
  const segmentLeadingMs = timing.meaningfulStartMs == null && result.startMs === 0
    ? Math.max(0, result.endMs - result.startMs)
    : startsInSegment
      ? Math.max(0, timing.meaningfulStartMs as number - result.startMs)
      : undefined;
  const payload = {
    session_id: run.sessionId,
    sequence: result.sequence,
    mime_type: mime,
    byte_size: result.blob.size,
    start_ms: Math.round(result.startMs),
    end_ms: Math.round(result.endMs),
    upload_status: "pending",
    audio_url: "",
    error_message: "",
    is_final_segment: isFinalSegment,
    clock_source: run.clockSource,
    ...(startsInSegment ? { meaningful_audio_started_ms: Math.round(timing.meaningfulStartMs as number) } : {}),
    ...(segmentLeadingMs == null ? {} : { leading_silence_ms: Math.round(segmentLeadingMs) }),
    ...(endsInSegment || (isFinalSegment && timing.meaningfulEndMs != null) ? { meaningful_audio_ended_ms: Math.round(timing.meaningfulEndMs as number) } : {}),
    ...(isFinalSegment ? { trailing_silence_ms: Math.round(segmentTrailingMs) } : {}),
  };

  let record: AudioSegmentRecord;
  try {
    record = (await AudioSegment.create(payload)) as AudioSegmentRecord;
    if (!run.lastNonEmptySegment || record.sequence >= run.lastNonEmptySegment.sequence) run.lastNonEmptySegment = record;
    if (isFinalSegment) run.lastFinalSegmentId = record.id;
    if (!run.closed && !callbacks.isDisposed()) callbacks.onSegment(record);
  } catch (error) {
    const message = safeMessage(error, "Could not save segment metadata before upload.");
    console.error("Failed to create segment record", error);
    run.uploadError = message;
    await persistIssue(run, callbacks, { kind: "upload_failure", severity: "error", notes: message, timestampMs: result.endMs, source: "recorder" });
    notifyFatal(run, callbacks, message);
    return;
  }

  try {
    const { file_url } = await uploadFile({ file });
    const updated = (await AudioSegment.update(record.id, { audio_url: file_url, upload_status: "uploaded", error_message: "" })) as AudioSegmentRecord;
    const merged = { ...record, ...updated, audio_url: file_url, upload_status: "uploaded" as const };
    if (run.lastNonEmptySegment?.id === record.id) run.lastNonEmptySegment = merged;
    if (!run.closed && !callbacks.isDisposed()) callbacks.onSegment(merged);
  } catch (error) {
    const message = safeMessage(error, "Upload failed for this segment.");
    console.error("Segment upload failed", error);
    run.uploadError = message;
    try {
      const updated = (await AudioSegment.update(record.id, { upload_status: "failed", error_message: message })) as AudioSegmentRecord;
      const merged = { ...record, ...updated, upload_status: "failed" as const, error_message: message };
      if (run.lastNonEmptySegment?.id === record.id) run.lastNonEmptySegment = merged;
      if (!run.closed && !callbacks.isDisposed()) callbacks.onSegment(merged);
    } catch (updateError) {
      console.error("Failed to save segment upload status", updateError);
      const merged = { ...record, upload_status: "failed" as const, error_message: message };
      if (run.lastNonEmptySegment?.id === record.id) run.lastNonEmptySegment = merged;
      if (!run.closed && !callbacks.isDisposed()) callbacks.onSegment(merged);
    }
    await persistIssue(run, callbacks, { kind: "upload_failure", severity: "error", notes: message, timestampMs: result.endMs, source: "recorder" });
    notifyFatal(run, callbacks, message);
  }
}

export function extensionForMime(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  return "webm";
}

export async function markFinalSegment(
  run: CaptureRun,
  callbacks: CaptureControllerCallbacks,
  segment: AudioSegmentRecord,
  timing: SegmentTiming,
): Promise<boolean> {
  const segmentTrailingMs = timing.meaningfulEndMs == null
    ? Math.max(0, segment.end_ms - segment.start_ms)
    : Math.max(0, segment.end_ms - Math.max(segment.start_ms, timing.meaningfulEndMs));
  try {
    const updated = (await AudioSegment.update(segment.id, {
      is_final_segment: true,
      ...(timing.meaningfulEndMs == null ? {} : { meaningful_audio_ended_ms: Math.round(timing.meaningfulEndMs) }),
      trailing_silence_ms: Math.round(segmentTrailingMs),
    })) as AudioSegmentRecord;
    const merged = { ...segment, ...updated, is_final_segment: true as const };
    if (run.lastNonEmptySegment?.id === segment.id) run.lastNonEmptySegment = merged;
    if (!run.closed && !callbacks.isDisposed()) callbacks.onSegment(merged);
    return true;
  } catch (error) {
    const message = safeMessage(error, "Could not mark the final segment.");
    run.uploadError = message;
    console.error("Failed to mark final segment", error);
    await persistIssue(run, callbacks, { kind: "upload_failure", severity: "error", notes: message, timestampMs: timing.sourceElapsedMs, source: "recorder" });
    notifyFatal(run, callbacks, message);
    return false;
  }
}

export async function demotePreviousFinal(
  run: CaptureRun,
  callbacks: CaptureControllerCallbacks,
  finalSegmentId?: string,
): Promise<void> {
  if (!run.previousFinalSegmentId || !finalSegmentId || run.previousFinalSegmentId === finalSegmentId) return;
  try {
    const updated = (await AudioSegment.update(run.previousFinalSegmentId, { is_final_segment: false })) as AudioSegmentRecord;
    if (!run.closed && !callbacks.isDisposed()) callbacks.onSegment(updated);
  } catch (error) {
    const message = safeMessage(error, "Could not update the previous final segment.");
    run.uploadError = message;
    console.error("Failed to update the previous final segment", error);
    await persistIssue(run, callbacks, { kind: "upload_failure", severity: "error", notes: message, timestampMs: run.offsetMs + run.sourceElapsedMs, source: "recorder" });
    notifyFatal(run, callbacks, message);
  }
}
