import type { AudioIssueRecord, CaptureCallbackContext } from "@/lib/transcription/types";
import type { CaptureControllerCallbacks, CaptureRun } from "./audio-capture-model";

export type LocalFindingKind = "possible_clipping" | "possible_pop_click" | "possible_distortion";

export function localFindingKind(label: string): LocalFindingKind | null {
  if (label === "possible-clipping") return "possible_clipping";
  if (label === "possible-pop-click") return "possible_pop_click";
  if (label === "possible-distortion") return "possible_distortion";
  return null;
}

export function localFindingNotes(label: string): string {
  if (label === "possible-clipping") return "Possible clipping detected by a local signal check. Review the source level; the exact cause is not confirmed.";
  if (label === "possible-pop-click") return "Possible short pop or click detected by a local signal check. The exact acoustic cause is not confirmed.";
  return "Possible signal distortion detected by a local signal check. The exact cause is not confirmed.";
}

export function makeRunId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `capture-${Math.random().toString(36).slice(2)}`;
}

export function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function callbackContext(run: CaptureRun): CaptureCallbackContext {
  return { sessionId: run.sessionId, captureRunId: run.captureRunId };
}

export function notifyFatal(run: CaptureRun, callbacks: CaptureControllerCallbacks, message: string): void {
  if (run.closed || callbacks.isDisposed() || run.fatalNotified) return;
  run.fatalNotified = true;
  callbacks.onFatal(message, callbackContext(run));
}

export function notifyIssue(callbacks: CaptureControllerCallbacks, issue: AudioIssueRecord): void {
  if (!callbacks.isDisposed()) callbacks.onIssue(issue);
}
