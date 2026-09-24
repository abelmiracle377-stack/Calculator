import { pickSupportedMimeType } from "@/lib/transcription/audio";
import type { CaptureRun, CycleResult, RecorderCycle, SegmentTiming } from "./audio-capture-model";

export interface RecorderHost {
  sourceNow: (run: CaptureRun) => number;
  enqueueSegmentUpload: (run: CaptureRun, result: CycleResult, timing: SegmentTiming, isFinalSegment: boolean) => void;
  notifyFatal: (run: CaptureRun, message: string) => void;
  requestFinalize: (run: CaptureRun, reason: "error") => void;
}

export function settleRecorderCycle(host: RecorderHost, run: CaptureRun, cycle: RecorderCycle): void {
  if (cycle.settled) return;
  cycle.settled = true;
  if (cycle.timeout != null) window.clearTimeout(cycle.timeout);
  cycle.timeout = null;
  const endMs = Math.max(cycle.startMs, host.sourceNow(run));
  const result: CycleResult = {
    blob: new Blob(cycle.chunks, { type: cycle.recorder.mimeType || "audio/webm" }),
    startMs: cycle.startMs,
    endMs,
    sequence: cycle.sequence,
  };
  cycle.result = result;
  cycle.recorder.ondataavailable = null;
  cycle.recorder.onerror = null;
  cycle.recorder.onstop = null;
  cycle.resolve(result);
}

export function startRecorderCycle(host: RecorderHost, run: CaptureRun, startMs: number, sequence: number): RecorderCycle | null {
  if (run.closed || run.stopRequested) return null;
  let recorder: MediaRecorder;
  try {
    const mimeType = pickSupportedMimeType();
    const options: MediaRecorderOptions = { audioBitsPerSecond: 128000 };
    if (mimeType) options.mimeType = mimeType;
    recorder = new MediaRecorder(run.stream, options);
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Could not create the media recorder.";
    run.recorderError = message;
    host.notifyFatal(run, message);
    return null;
  }

  let resolveCycle!: (result: CycleResult) => void;
  const cycle: RecorderCycle = {
    recorder,
    sequence,
    startMs,
    chunks: [],
    completion: new Promise<CycleResult>((resolve) => { resolveCycle = resolve; }),
    resolve: resolveCycle,
    settled: false,
    uploadEnqueued: false,
    stopRequested: false,
    timeout: null,
  };
  run.currentCycle = cycle;
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) cycle.chunks.push(event.data);
  };
  recorder.onerror = () => {
    const message = "The media recorder reported an error.";
    run.recorderError = message;
    run.stopRequested = true;
    host.notifyFatal(run, message);
    host.requestFinalize(run, "error");
  };
  recorder.onstop = () => settleRecorderCycle(host, run, cycle);

  try {
    recorder.start();
    if (!run.captureEpochStarted) {
      const epoch = run.analysis.beginCaptureEpoch();
      run.captureEpochStarted = true;
      run.captureStartedAt = new Date().toISOString();
      run.clockSource = epoch.clockSource;
    }
    return cycle;
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Recorder failed to start.";
    run.recorderError = message;
    try { recorder.stop(); } catch { /* already inactive */ }
    settleRecorderCycle(host, run, cycle);
    host.notifyFatal(run, message);
    return null;
  }
}

export function stopRecorderCycle(host: RecorderHost, run: CaptureRun, cycle: RecorderCycle | null): Promise<CycleResult | null> {
  if (!cycle) return Promise.resolve(null);
  if (cycle.settled) return cycle.completion;
  cycle.stopRequested = true;
  if (cycle.recorder.state === "inactive") {
    settleRecorderCycle(host, run, cycle);
    return cycle.completion;
  }
  try {
    cycle.recorder.stop();
    cycle.timeout = window.setTimeout(() => {
      if (cycle.settled) return;
      run.recorderError = run.recorderError || "The media recorder did not finish its final data event.";
      host.notifyFatal(run, run.recorderError);
      settleRecorderCycle(host, run, cycle);
    }, 5000);
  } catch (error) {
    run.recorderError = error instanceof Error && error.message ? error.message : "The media recorder could not stop.";
    host.notifyFatal(run, run.recorderError);
    settleRecorderCycle(host, run, cycle);
  }
  return cycle.completion;
}

export function abortRecorderCycle(host: RecorderHost, run: CaptureRun, cycle: RecorderCycle | null): void {
  if (!cycle || cycle.settled) return;
  cycle.recorder.ondataavailable = null;
  cycle.recorder.onerror = null;
  cycle.recorder.onstop = null;
  try { if (cycle.recorder.state !== "inactive") cycle.recorder.stop(); } catch { /* browser already stopped it */ }
  settleRecorderCycle(host, run, cycle);
}
