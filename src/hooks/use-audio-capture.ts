import { useEffect, useRef, useState } from "react";
import { drawWaveform } from "@/lib/transcription/audio";
import { AudioCaptureController } from "./audio-capture-controller";
import type { StartCaptureOptions } from "./audio-capture-model";
import type { AudioIssueRecord, AudioSegmentRecord, CaptureCallbackContext, CaptureEventPayload, CaptureStatus, MeterLevels } from "@/lib/transcription/types";

interface UseAudioCaptureOptions {
  sessionId: string | null;
  onSegment: (segment: AudioSegmentRecord) => void;
  onIssue: (issue: AudioIssueRecord) => void;
  onDuration: (ms: number, context: CaptureCallbackContext) => void;
  onCaptureState?: (status: CaptureStatus) => void;
  onCaptureEvent?: (event: CaptureEventPayload) => void;
  onFatal: (message: string, context: CaptureCallbackContext) => void;
}

export type { StartCaptureOptions } from "./audio-capture-model";

function idleCaptureStatus(): CaptureStatus {
  return { state: "idle", sourceLabel: "", elapsedMs: 0, captureElapsedMs: 0, sourceElapsedMs: 0, phase: "waiting" };
}

export function useAudioCapture({ sessionId, onSegment, onIssue, onDuration, onCaptureState, onCaptureEvent, onFatal }: UseAudioCaptureOptions) {
  const [status, setStatus] = useState<CaptureStatus>(idleCaptureStatus);
  const [levels, setLevels] = useState<MeterLevels>({ rms: 0, peak: 0 });
  const [isBusy, setIsBusy] = useState(false);

  const statusRef = useRef(status);
  const sessionIdRef = useRef<string | null>(sessionId);
  const disposedRef = useRef(false);
  const busyRef = useRef(false);
  const controllerRef = useRef<AudioCaptureController | null>(null);
  const visualRafRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onSegmentRef = useRef(onSegment);
  const onIssueRef = useRef(onIssue);
  const onDurationRef = useRef(onDuration);
  const onCaptureStateRef = useRef(onCaptureState);
  const onCaptureEventRef = useRef(onCaptureEvent);
  const onFatalRef = useRef(onFatal);

  const resetPublicState = () => {
    if (disposedRef.current) return;
    if (visualRafRef.current != null) {
      cancelAnimationFrame(visualRafRef.current);
      visualRafRef.current = null;
    }
    const next = idleCaptureStatus();
    statusRef.current = next;
    setStatus(next);
    setLevels({ rms: 0, peak: 0 });
    if (!busyRef.current) setIsBusy(false);
  };

  const reconcilePublicState = () => {
    if (disposedRef.current || controllerRef.current || busyRef.current) return;
    const ownerId = statusRef.current.captureSessionId;
    if (ownerId && ownerId !== sessionIdRef.current) resetPublicState();
  };

  useEffect(() => {
    const previousSessionId = sessionIdRef.current;
    sessionIdRef.current = sessionId;
    if (previousSessionId === sessionId || controllerRef.current || busyRef.current) return;
    resetPublicState();
  }, [sessionId]);
  useEffect(() => {
    onSegmentRef.current = onSegment;
    onIssueRef.current = onIssue;
    onDurationRef.current = onDuration;
    onCaptureStateRef.current = onCaptureState;
    onCaptureEventRef.current = onCaptureEvent;
    onFatalRef.current = onFatal;
  }, [onCaptureEvent, onCaptureState, onDuration, onFatal, onIssue, onSegment]);

  const updateStatus = (next: CaptureStatus) => {
    if (disposedRef.current) return;
    statusRef.current = next;
    setStatus(next);
    onCaptureStateRef.current?.(next);
    if (next.phase === "ended") {
      if (visualRafRef.current != null) {
        cancelAnimationFrame(visualRafRef.current);
        visualRafRef.current = null;
      }
      controllerRef.current = null;
      reconcilePublicState();
    }
  };

  const startVisualLoop = (analyser: AnalyserNode) => {
    if (visualRafRef.current != null) cancelAnimationFrame(visualRafRef.current);
    const draw = () => {
      if (disposedRef.current || !controllerRef.current || !canvasRef.current) return;
      drawWaveform(canvasRef.current, analyser, "hsl(8 85% 62%)", "hsla(210 30% 40% / 0.35)");
      visualRafRef.current = requestAnimationFrame(draw);
    };
    visualRafRef.current = requestAnimationFrame(draw);
  };

  const makeController = (targetSessionId: string, initialStatus: CaptureStatus) => new AudioCaptureController({
    sessionId: targetSessionId,
    initialStatus,
    callbacks: {
      onStatus: updateStatus,
      onLevels: (next) => { if (!disposedRef.current) setLevels(next); },
      onDuration: (ms, context) => onDurationRef.current(ms, context),
      onEvent: (event) => onCaptureEventRef.current?.(event),
      onIssue: (issue) => onIssueRef.current(issue),
      onSegment: (segment) => onSegmentRef.current(segment),
      onFatal: (message, context) => onFatalRef.current(message, context),
      onConnected: (analyser) => startVisualLoop(analyser),
      isDisposed: () => disposedRef.current,
    },
  });

  const start = async (options: StartCaptureOptions = {}): Promise<"recording" | "cancelled" | "error"> => {
    if (busyRef.current || controllerRef.current) return statusRef.current.state === "recording" ? "recording" : "error";
    const targetSessionId = sessionIdRef.current;
    if (!targetSessionId) return "error";
    busyRef.current = true;
    if (!disposedRef.current) setIsBusy(true);
    const runId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `capture-${Math.random().toString(36).slice(2)}`;
    const offsetMs = Math.max(0, options.elapsedOffsetMs ?? 0);
    const initialStatus: CaptureStatus = { state: "requesting", sourceLabel: "", elapsedMs: offsetMs, captureElapsedMs: 0, sourceElapsedMs: offsetMs, phase: "waiting", captureSessionId: targetSessionId, captureRunId: runId, message: "Choose a Chrome tab and enable Share tab audio." };
    statusRef.current = initialStatus;
    if (!disposedRef.current) setStatus(initialStatus);
    const controller = makeController(targetSessionId, initialStatus);
    controllerRef.current = controller;
    try {
      const result = await controller.start({ ...options });
      if (result !== "recording") controllerRef.current = null;
      return result;
    } catch (error) {
      console.error("Capture start failed", error);
      controllerRef.current = null;
      const message = error instanceof Error ? error.message : "Could not start capture.";
      updateStatus({ ...initialStatus, state: "error", phase: "ended", message });
      return "error";
    } finally {
      busyRef.current = false;
      if (!disposedRef.current) setIsBusy(false);
      reconcilePublicState();
    }
  };

  const stop = async (): Promise<CaptureStatus> => {
    const controller = controllerRef.current;
    if (!controller) return statusRef.current;
    busyRef.current = true;
    if (!disposedRef.current) setIsBusy(true);
    try {
      return await controller.stop();
    } finally {
      controllerRef.current = null;
      if (visualRafRef.current != null) cancelAnimationFrame(visualRafRef.current);
      visualRafRef.current = null;
      busyRef.current = false;
      if (!disposedRef.current) setIsBusy(false);
      reconcilePublicState();
    }
  };

  useEffect(() => () => {
    disposedRef.current = true;
    if (visualRafRef.current != null) cancelAnimationFrame(visualRafRef.current);
    visualRafRef.current = null;
    controllerRef.current?.dispose();
    controllerRef.current = null;
  }, []);

  return {
    status,
    levels,
    isBusy,
    canvasRef,
    start,
    stop,
    setCanvas: (element: HTMLCanvasElement | null) => { canvasRef.current = element; },
  };
}
