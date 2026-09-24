import { useCallback, useEffect, useRef, useState } from "react";
import { validateAudioSize } from "@/lib/transcription/audio-upload";

export const AUDIO_RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/wav",
] as const;

export type AudioInputStatus = "idle" | "requesting" | "recording" | "paused" | "stopping" | "ready" | "error";

export interface UseAudioInputResult {
  status: AudioInputStatus;
  state: AudioInputStatus;
  file: File | null;
  previewUrl: string | null;
  durationMs: number;
  error: string | null;
  isRecording: boolean;
  isPaused: boolean;
  start: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<File | null>;
  finalize: () => Promise<File | null>;
  reset: () => void;
  reRecord: () => void;
}

type PendingFinalize = { promise: Promise<File | null>; resolve: (file: File | null) => void };

function microphoneErrorMessage(error: unknown): string {
  const name = typeof DOMException !== "undefined" && error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "Microphone access was blocked. Allow microphone access and try again.";
  if (name === "NotFoundError") return "No microphone was found. Connect a microphone and try again.";
  if (name === "NotReadableError" || name === "TrackStartError") return "Your microphone is busy in another app. Close it there and try again.";
  if (name === "SecurityError") return "Microphone access requires a secure connection. Open this app over HTTPS and try again.";
  if (name === "AbortError") return "Microphone access was interrupted. Try recording again.";
  if (error instanceof Error && /permission|denied/i.test(error.message)) return "Microphone access was blocked. Allow microphone access and try again.";
  return "We couldn't start microphone recording. Check your microphone and try again.";
}

function supportedMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  if (typeof MediaRecorder.isTypeSupported !== "function") return AUDIO_RECORDING_MIME_TYPES[0];
  return AUDIO_RECORDING_MIME_TYPES.find((mime) => {
    try { return MediaRecorder.isTypeSupported(mime); } catch { return false; }
  }) || "";
}

function extensionForMime(mime: string): string {
  const base = mime.toLowerCase().split(";", 1)[0];
  if (base.includes("webm")) return "webm";
  if (base.includes("mp4") || base.includes("m4a")) return "m4a";
  if (base.includes("mpeg")) return "mp3";
  if (base.includes("aac")) return "aac";
  if (base.includes("ogg")) return "ogg";
  if (base.includes("wav") || base.includes("wave")) return "wav";
  return "webm";
}

export function useAudioInput(): UseAudioInputResult {
  const [status, setStatus] = useState<AudioInputStatus>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeStartedAtRef = useRef<number | null>(null);
  const elapsedBeforeRef = useRef(0);
  const captureIdRef = useRef(0);
  const previewRef = useRef<string | null>(null);
  const pendingFinalizeRef = useRef<PendingFinalize | null>(null);
  const mountedRef = useRef(true);

  const settleFinalize = useCallback((nextFile: File | null) => { const pending = pendingFinalizeRef.current; pendingFinalizeRef.current = null; pending?.resolve(nextFile); }, []);
  const clearTimer = useCallback(() => { if (timerRef.current !== null) globalThis.clearInterval(timerRef.current); timerRef.current = null; }, []);
  const stopTracks = useCallback(() => { streamRef.current?.getTracks().forEach((track) => track.stop()); streamRef.current = null; }, []);
  const revokePreview = useCallback(() => { if (previewRef.current) URL.revokeObjectURL(previewRef.current); previewRef.current = null; if (mountedRef.current) setPreviewUrl(null); }, []);
  const updateDuration = useCallback((now = Date.now()) => {
    const active = activeStartedAtRef.current === null ? 0 : Math.max(0, now - activeStartedAtRef.current);
    const next = elapsedBeforeRef.current + active;
    if (mountedRef.current) setDurationMs(next);
    return next;
  }, []);
  const abandonRecorder = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onpause = null;
      recorder.onresume = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") { try { recorder.stop(); } catch { /* Tracks still release below. */ } }
    }
    recorderRef.current = null;
    stopTracks();
    clearTimer();
    chunksRef.current = [];
    activeStartedAtRef.current = null;
    elapsedBeforeRef.current = 0;
    settleFinalize(null);
  }, [clearTimer, settleFinalize, stopTracks]);
  const reset = useCallback(() => {
    captureIdRef.current += 1;
    abandonRecorder();
    revokePreview();
    setFile(null);
    setDurationMs(0);
    setError(null);
    setStatus("idle");
  }, [abandonRecorder, revokePreview]);
  const fail = useCallback((message: string, captureId: number) => {
    if (captureId !== captureIdRef.current || !mountedRef.current) return;
    captureIdRef.current += 1;
    abandonRecorder();
    revokePreview();
    setFile(null);
    setDurationMs(0);
    setError(message);
    setStatus("error");
  }, [abandonRecorder, revokePreview]);
  const finalizeCapture = useCallback((captureId: number, recorder: MediaRecorder, preferredMime: string) => {
    if (captureId !== captureIdRef.current || !mountedRef.current) return;
    const finalDuration = updateDuration();
    clearTimer();
    activeStartedAtRef.current = null;
    stopTracks();
    recorder.ondataavailable = null;
    recorder.onerror = null;
    recorder.onpause = null;
    recorder.onresume = null;
    recorder.onstop = null;
    recorderRef.current = null;
    const chunks = chunksRef.current;
    chunksRef.current = [];
    const mime = recorder.mimeType || preferredMime || chunks[0]?.type || "audio/webm";
    const blob = new Blob(chunks, { type: mime });
    if (!blob.size) { fail("No audio was captured. Try recording again.", captureId); return; }
    const sizeError = validateAudioSize(blob, "recording");
    if (sizeError) { fail(sizeError, captureId); return; }
    const nextFile = new File([blob], `microphone-recording-${Date.now()}.${extensionForMime(mime)}`, { type: mime });
    revokePreview();
    const nextPreview = URL.createObjectURL(nextFile);
    previewRef.current = nextPreview;
    setFile(nextFile);
    setPreviewUrl(nextPreview);
    setDurationMs(finalDuration);
    setError(null);
    setStatus("ready");
    settleFinalize(nextFile);
  }, [clearTimer, fail, revokePreview, settleFinalize, stopTracks, updateDuration]);

  const start = useCallback(async () => {
    if (!mountedRef.current || recorderRef.current || status === "requesting") return;
    reset();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Microphone recording is not available in this browser.");
      setStatus("error");
      return;
    }
    const requestId = captureIdRef.current;
    setStatus("requesting");
    let captureId = 0;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current || requestId !== captureIdRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      captureId = captureIdRef.current + 1;
      captureIdRef.current = captureId;
      streamRef.current = stream;
      const preferredMime = supportedMimeType();
      let recorder: MediaRecorder;
      try { recorder = preferredMime ? new MediaRecorder(stream, { mimeType: preferredMime }) : new MediaRecorder(stream); }
      catch { recorder = new MediaRecorder(stream); }
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (captureId === captureIdRef.current && event.data.size) chunksRef.current.push(event.data); };
      recorder.onerror = () => fail("The microphone recording stopped unexpectedly. Try recording again.", captureId);
      recorder.onpause = () => { if (captureId === captureIdRef.current) { updateDuration(); setStatus("paused"); } };
      recorder.onresume = () => { if (captureId === captureIdRef.current) { activeStartedAtRef.current = Date.now(); setStatus("recording"); } };
      recorder.onstop = () => finalizeCapture(captureId, recorder, preferredMime);
      recorder.start();
      activeStartedAtRef.current = Date.now();
      elapsedBeforeRef.current = 0;
      setDurationMs(0);
      setError(null);
      setStatus("recording");
      timerRef.current = globalThis.setInterval(() => updateDuration(), 250);
    } catch (captureError) {
      if (captureId) fail(microphoneErrorMessage(captureError), captureId);
      else { abandonRecorder(); setError(microphoneErrorMessage(captureError)); setStatus("error"); }
    }
  }, [abandonRecorder, fail, finalizeCapture, reset, status, updateDuration]);
  const pause = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    try {
      updateDuration();
      if (activeStartedAtRef.current !== null) elapsedBeforeRef.current += Math.max(0, Date.now() - activeStartedAtRef.current);
      activeStartedAtRef.current = null;
      recorder.pause();
      clearTimer();
      setStatus("paused");
    } catch { fail("The recording could not be paused. Try recording again.", captureIdRef.current); }
  }, [clearTimer, fail, updateDuration]);
  const resume = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "paused") return;
    try {
      recorder.resume();
      activeStartedAtRef.current = Date.now();
      setStatus("recording");
      timerRef.current = globalThis.setInterval(() => updateDuration(), 250);
    } catch { fail("The recording could not be resumed. Try recording again.", captureIdRef.current); }
  }, [fail, updateDuration]);
  const stop = useCallback((): Promise<File | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return Promise.resolve(file);
    if (pendingFinalizeRef.current) return pendingFinalizeRef.current.promise;
    let resolvePending: (nextFile: File | null) => void = () => undefined;
    const promise = new Promise<File | null>((resolve) => { resolvePending = resolve; });
    pendingFinalizeRef.current = { promise, resolve: resolvePending };
    try {
      updateDuration();
      if (activeStartedAtRef.current !== null) elapsedBeforeRef.current += Math.max(0, Date.now() - activeStartedAtRef.current);
      activeStartedAtRef.current = null;
      clearTimer();
      setStatus("stopping");
      recorder.stop();
    } catch { fail("The recording could not be finished. Try recording again.", captureIdRef.current); }
    return promise;
  }, [clearTimer, fail, file, updateDuration]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      captureIdRef.current += 1;
      abandonRecorder();
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    };
  }, [abandonRecorder]);

  return { status, state: status, file, previewUrl, durationMs, error, isRecording: status === "recording", isPaused: status === "paused", start, pause, resume, stop, finalize: stop, reset, reRecord: reset };
}
