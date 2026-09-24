import { requestTabAudioStream } from "@/lib/transcription/audio";
import { createAudioAnalysis, type AudioAnalysisFrame, type AudioAnalysisHandle } from "@/lib/transcription/audio-vad";
import type { AudioIssueRecord, CaptureEventPayload, CaptureStatus } from "@/lib/transcription/types";
import { callbackContext, localFindingKind, localFindingNotes, makeRunId, notifyFatal, safeMessage } from "./audio-capture-helpers";
import { abortRecorderCycle, startRecorderCycle, stopRecorderCycle, type RecorderHost } from "./audio-capture-recorder";
import { MIN_INTERVAL_MS, SEGMENT_MS, type CaptureControllerCallbacks, type CaptureRun, type CycleResult, type FinalizeReason, type SegmentTiming, type StartCaptureOptions } from "./audio-capture-model";
import { demotePreviousFinal, markFinalSegment, persistIssue, timingForRun, uploadSegment } from "./audio-capture-persistence";

export type ControllerStartResult = "recording" | "cancelled" | "error";

interface ControllerOptions {
  sessionId: string;
  initialStatus: CaptureStatus;
  callbacks: CaptureControllerCallbacks;
}

export class AudioCaptureController implements RecorderHost {
  private readonly sessionId: string;
  private readonly callbacks: CaptureControllerCallbacks;
  private status: CaptureStatus;
  private run: CaptureRun | null = null;
  private disposed = false;

  constructor({ sessionId, initialStatus, callbacks }: ControllerOptions) {
    this.sessionId = sessionId;
    this.status = initialStatus;
    this.callbacks = callbacks;
  }

  get currentRun(): CaptureRun | null {
    return this.run;
  }

  sourceNow(run: CaptureRun): number {
    if (run.analysisFrozen) return run.offsetMs + run.sourceElapsedMs;
    run.sourceElapsedMs = Math.max(run.sourceElapsedMs, run.analysis.getSourceTimeMs(), 0);
    return run.offsetMs + run.sourceElapsedMs;
  }

  notifyFatal(run: CaptureRun, message: string): void {
    notifyFatal(run, this.callbacks, message);
  }

  requestFinalize(run: CaptureRun, reason: "error"): void {
    void this.finalizeRun(run, reason);
  }

  enqueueSegmentUpload(run: CaptureRun, result: CycleResult, timing: SegmentTiming, isFinalSegment: boolean): void {
    if (run.closed || result.blob.size === 0) return;
    const task = uploadSegment(run, this.callbacks, result, timing, isFinalSegment);
    run.uploadTasks.push(task);
  }

  private publishStatus(run: CaptureRun, patch: Partial<CaptureStatus>): void {
    if (run.closed || this.disposed || this.callbacks.isDisposed()) return;
    const next: CaptureStatus = {
      ...this.status,
      ...patch,
      captureSessionId: run.sessionId,
      captureRunId: run.captureRunId,
    };
    this.status = next;
    this.callbacks.onStatus(next);
  }

  private publishStandalone(patch: Partial<CaptureStatus>): void {
    if (this.disposed || this.callbacks.isDisposed()) return;
    this.status = { ...this.status, ...patch, captureSessionId: this.sessionId };
    this.callbacks.onStatus(this.status);
  }

  private notifyDuration(run: CaptureRun, fullSourceMs: number): void {
    if (run.closed || this.disposed || this.callbacks.isDisposed()) return;
    this.callbacks.onDuration(fullSourceMs, callbackContext(run));
  }

  private handleFrame(run: CaptureRun, frame: AudioAnalysisFrame): void {
    if (run.closed || run.analysisFrozen || this.disposed || this.callbacks.isDisposed()) return;
    run.sourceElapsedMs = Math.max(run.sourceElapsedMs, frame.sourceEndMs, 0);
    if (frame.meaningfulEndMs != null) run.meaningfulEndMs = Math.max(run.meaningfulEndMs ?? 0, run.offsetMs + frame.meaningfulEndMs);
    run.phase = frame.phase;
    const fullEnd = run.offsetMs + run.sourceElapsedMs;
    if (frame.sourceEndMs - run.lastMeterSourceMs >= 80) {
      run.lastMeterSourceMs = frame.sourceEndMs;
      this.callbacks.onLevels({ rms: frame.rms, peak: frame.peak });
    }
    if (frame.phase !== this.status.phase || frame.sourceEndMs - run.lastStatusSourceMs >= 250) {
      run.lastStatusSourceMs = frame.sourceEndMs;
      this.publishStatus(run, {
        phase: run.phase,
        elapsedMs: fullEnd,
        captureElapsedMs: run.sourceElapsedMs,
        sourceElapsedMs: fullEnd,
        meaningfulAudioStartedMs: run.meaningfulStartMs,
        meaningfulAudioEndedMs: run.meaningfulEndMs,
        leadingSilenceMs: run.leadingSilenceMs,
        trailingSilenceMs: run.trailingSilenceMs,
      });
    }
    if (frame.sourceEndMs - run.lastDurationSourceMs >= 250) {
      run.lastDurationSourceMs = frame.sourceEndMs;
      this.notifyDuration(run, fullEnd);
    }
    const cycle = run.currentCycle;
    if (!run.stopRequested && cycle && !cycle.settled && !run.rolloverPromise && fullEnd - cycle.startMs >= SEGMENT_MS) {
      const pending = this.rollover(run);
      run.rolloverPromise = pending;
      void pending.finally(() => {
        if (run.rolloverPromise === pending) run.rolloverPromise = null;
      }).catch(() => undefined);
    }
  }

  private handleEvent(run: CaptureRun, event: CaptureEventPayload): void {
    if (run.closed || run.analysisFrozen || this.disposed || this.callbacks.isDisposed()) return;
    const adjusted: CaptureEventPayload = {
      ...event,
      label: event.label === "meaningful-audio-start" && run.meaningfulStartMs != null
        ? "meaningful-audio-resumed"
        : event.label,
      start_ms: run.offsetMs + Math.max(0, event.start_ms),
      ...(event.end_ms == null ? {} : { end_ms: run.offsetMs + Math.max(event.start_ms, event.end_ms) }),
      captureSessionId: run.sessionId,
      captureRunId: run.captureRunId,
    };
    this.callbacks.onEvent(adjusted);
    if (event.type === "local_signal") {
      const kind = localFindingKind(event.label);
      if (kind) void persistIssue(run, this.callbacks, {
        kind,
        severity: "warning",
        notes: event.notes || localFindingNotes(event.label),
        timestampMs: adjusted.start_ms,
        endTimestampMs: adjusted.end_ms,
        source: "vad",
        possible: true,
        confidence: event.confidence,
      });
      return;
    }
    if (event.phase === "active") {
      if (run.meaningfulStartMs == null) {
        run.meaningfulStartMs = adjusted.start_ms;
        run.leadingSilenceMs = Math.max(0, adjusted.start_ms);
        if (run.leadingSilenceMs >= MIN_INTERVAL_MS) void persistIssue(run, this.callbacks, {
          kind: "leading_silence",
          severity: "info",
          notes: "Leading silence was preserved before sustained meaningful audio began.",
          timestampMs: 0,
          endTimestampMs: adjusted.start_ms,
          source: "vad",
          preferredId: run.leadingIssueId,
        });
      }
      if (adjusted.end_ms != null) run.meaningfulEndMs = Math.max(run.meaningfulEndMs ?? 0, adjusted.end_ms);
      run.phase = "active";
      this.publishStatus(run, {
        phase: "active",
        elapsedMs: this.sourceNow(run),
        captureElapsedMs: run.sourceElapsedMs,
        sourceElapsedMs: this.sourceNow(run),
        meaningfulAudioStartedMs: run.meaningfulStartMs,
        meaningfulAudioEndedMs: run.meaningfulEndMs,
        leadingSilenceMs: run.leadingSilenceMs,
      });
    } else if (event.phase === "quiet") {
      run.meaningfulEndMs = Math.max(run.meaningfulEndMs ?? 0, run.offsetMs + event.start_ms);
      run.phase = "quiet";
      const elapsed = this.sourceNow(run);
      this.publishStatus(run, {
        phase: "quiet",
        elapsedMs: elapsed,
        captureElapsedMs: run.sourceElapsedMs,
        sourceElapsedMs: elapsed,
        meaningfulAudioStartedMs: run.meaningfulStartMs,
        meaningfulAudioEndedMs: run.meaningfulEndMs,
        leadingSilenceMs: run.leadingSilenceMs,
      });
    }
  }

  private async rollover(run: CaptureRun): Promise<CycleResult | null> {
    const cycle = run.currentCycle;
    if (!cycle) return null;
    const result = await stopRecorderCycle(this, run, cycle);
    if (!result) return null;
    if (run.closed || run.stopRequested || run.finalizationRequested) return result;
    run.nextSequence = result.sequence + 1;
    cycle.uploadEnqueued = result.blob.size > 0;
    if (cycle.uploadEnqueued) this.enqueueSegmentUpload(run, result, timingForRun(run, result.endMs), false);
    const nextStartMs = Math.max(result.endMs, this.sourceNow(run));
    const next = startRecorderCycle(this, run, nextStartMs, run.nextSequence);
    if (!next) {
      run.stopRequested = true;
      run.recorderError = run.recorderError || "The next audio segment could not be started.";
      void this.finalizeRun(run, "error");
    }
    return result;
  }

  private async closeRunResources(run: CaptureRun): Promise<void> {
    run.track.removeEventListener("ended", run.trackEndedHandler);
    await run.analysis.close().catch((error) => console.error("Audio analysis cleanup failed", error));
    run.stream.getTracks().forEach((track) => track.stop());
    run.displayStream.getTracks().forEach((track) => track.stop());
  }

  private async failStart(run: CaptureRun, message: string, report: boolean): Promise<void> {
    run.stopRequested = true;
    run.finalizationRequested = true;
    if (run.currentCycle && !run.currentCycle.settled) await stopRecorderCycle(this, run, run.currentCycle);
    if (report) {
      await persistIssue(run, this.callbacks, {
        kind: message.toLowerCase().includes("audio") ? "missing_audio" : "recorder_error",
        severity: "error",
        notes: message,
        timestampMs: run.offsetMs,
        source: "recorder",
      });
      this.notifyFatal(run, message);
    }
    await this.closeRunResources(run);
    run.closed = true;
    if (this.run === run) this.run = null;
  }

  async start(options: StartCaptureOptions = {}): Promise<ControllerStartResult> {
    if (this.disposed) return "error";
    const offsetMs = Math.max(0, options.elapsedOffsetMs ?? 0);
    let audioStream: MediaStream | null = null;
    let displayStream: MediaStream | null = null;
    let analysis: AudioAnalysisHandle | null = null;
    let run: CaptureRun | null = null;
    try {
      const resources = await requestTabAudioStream();
      audioStream = resources.audioStream;
      displayStream = resources.displayStream;
      if (this.disposed || this.callbacks.isDisposed()) {
        audioStream.getTracks().forEach((track) => track.stop());
        displayStream.getTracks().forEach((track) => track.stop());
        return "cancelled";
      }
      analysis = await createAudioAnalysis(audioStream, {
        onFrame: (frame) => { if (this.run) this.handleFrame(this.run, frame); },
        onEvent: (event) => { if (this.run) this.handleEvent(this.run, event); },
      });
      if (this.disposed || this.callbacks.isDisposed()) {
        await analysis.close().catch((cleanupError) => console.error("Audio analysis cleanup failed", cleanupError));
        audioStream.getTracks().forEach((track) => track.stop());
        displayStream.getTracks().forEach((track) => track.stop());
        analysis = null;
        return "cancelled";
      }
      const track = audioStream.getAudioTracks()[0];
      if (!track) throw new Error("The shared source did not provide an audio track.");
      run = {
        captureRunId: this.status.captureRunId || makeRunId(),
        sessionId: this.sessionId,
        offsetMs,
        nextSequence: Math.max(0, options.nextSequence ?? 0),
        sourceElapsedMs: 0,
        analysis,
        stream: audioStream,
        displayStream,
        track,
        trackEndedHandler: () => undefined,
        sourceLabel: resources.sourceLabel,
        captureStartedAt: "",
        clockSource: analysis.clockSource,
        clockSourceNote: analysis.clockSourceNote,
        captureEpochStarted: false,
        phase: "waiting",
        meaningfulStartMs: options.existingMeaningfulAudioStartedMs,
        meaningfulEndMs: options.existingMeaningfulAudioEndedMs,
        leadingSilenceMs: options.existingLeadingSilenceMs ?? (options.existingMeaningfulAudioStartedMs == null ? undefined : options.existingMeaningfulAudioStartedMs),
        trailingSilenceMs: options.existingTrailingSilenceMs,
        leadingIssueId: options.leadingSilenceIssueId,
        trailingIssueId: options.trailingSilenceIssueId,
        leadingIssueRecorded: Boolean(options.leadingSilenceAlreadyRecorded || options.leadingSilenceIssueId),
        trailingIssueRecorded: Boolean(options.trailingSilenceAlreadyRecorded || options.trailingSilenceIssueId),
        leadingIssuePending: false,
        trailingIssuePending: false,
        previousFinalSegmentId: options.previousFinalSegmentId,
        currentCycle: null,
        rolloverPromise: null,
        uploadTasks: [],
        fatalNotified: false,
        sharingEndedRecorded: false,
        stopRequested: false,
        finalizationRequested: false,
        analysisFrozen: false,
        connected: false,
        closed: false,
        finalizationPromise: null,
        lastMeterSourceMs: -Infinity,
        lastStatusSourceMs: -Infinity,
        lastDurationSourceMs: -Infinity,
      };
      this.run = run;
      run.trackEndedHandler = () => {
        if (this.run !== run || run.closed || run.stopRequested) return;
        void this.finalizeRun(run, "track");
      };
      track.addEventListener("ended", run.trackEndedHandler);
      const firstCycle = startRecorderCycle(this, run, offsetMs, run.nextSequence);
      if (!firstCycle || !run.captureEpochStarted) throw new Error(run.recorderError || "The media recorder could not start.");
      run.connected = true;
      this.publishStatus(run, {
        state: "recording",
        sourceLabel: run.sourceLabel,
        elapsedMs: offsetMs,
        captureElapsedMs: 0,
        sourceElapsedMs: offsetMs,
        phase: "waiting",
        clockSource: run.clockSource,
        clockSourceNote: run.clockSourceNote,
        captureStartedAt: run.captureStartedAt,
        meaningfulAudioStartedMs: run.meaningfulStartMs,
        meaningfulAudioEndedMs: run.meaningfulEndMs,
        leadingSilenceMs: run.leadingSilenceMs,
        trailingSilenceMs: run.trailingSilenceMs,
        message: run.clockSource === "script-processor"
          ? "Recording shared audio. Timing is best effort while the fallback analyzer is active."
          : "Recording shared audio. Waiting for sustained meaningful audio.",
      });
      this.callbacks.onConnected?.(analysis.analyser);
      return "recording";
    } catch (error) {
      const cancelled = typeof DOMException !== "undefined" && error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
      const message = safeMessage(error, "Could not start capture. Check browser permissions.");
      if (run) await this.failStart(run, message, !cancelled);
      else {
        await analysis?.close().catch((cleanupError) => console.error("Audio analysis cleanup failed", cleanupError));
        audioStream?.getTracks().forEach((track) => track.stop());
        displayStream?.getTracks().forEach((track) => track.stop());
      }
      this.publishStandalone({
        state: cancelled ? "idle" : "error",
        sourceLabel: "",
        elapsedMs: offsetMs,
        captureElapsedMs: 0,
        sourceElapsedMs: offsetMs,
        phase: cancelled ? "waiting" : "ended",
        captureRunId: this.status.captureRunId,
        message: cancelled ? "Capture cancelled." : message,
      });
      return cancelled ? "cancelled" : "error";
    }
  }

  async stop(): Promise<CaptureStatus> {
    const run = this.run;
    if (!run) return this.status;
    return this.finalizeRun(run, "user");
  }

  private finalizeRun(run: CaptureRun, reason: FinalizeReason): Promise<CaptureStatus> {
    if (run.finalizationPromise) return run.finalizationPromise;
    const promise = this.performFinalization(run, reason);
    run.finalizationPromise = promise;
    return promise;
  }

  private async performFinalization(run: CaptureRun, reason: FinalizeReason): Promise<CaptureStatus> {
    run.stopRequested = true;
    run.finalizationRequested = true;
    this.publishStatus(run, {
      state: "stopping",
      message: reason === "track" ? "Sharing ended. Finalizing the captured source timeline." : "Finalizing the last source clip.",
    });
    try {
      const flushed = await run.analysis.snapshot();
      run.sourceElapsedMs = Math.max(run.sourceElapsedMs, flushed.sourceTimeMs);
      if (flushed.meaningfulEndMs != null) run.meaningfulEndMs = Math.max(run.meaningfulEndMs ?? 0, run.offsetMs + flushed.meaningfulEndMs);
      run.phase = flushed.phase;
      run.analysisFrozen = true;

      const rolloverResult = run.rolloverPromise ? await run.rolloverPromise : null;
      const cycleAtFinalization = run.currentCycle;
      let finalCycle = await stopRecorderCycle(this, run, cycleAtFinalization);
      if (!finalCycle) finalCycle = rolloverResult;
      if (cycleAtFinalization?.uploadEnqueued) finalCycle = null;
      const finalMs = Math.max(run.offsetMs + run.sourceElapsedMs, finalCycle?.endMs || 0);
      run.sourceElapsedMs = Math.max(0, finalMs - run.offsetMs);

      if (run.meaningfulStartMs == null) {
        run.leadingSilenceMs = finalMs;
        run.trailingSilenceMs = 0;
        if (finalMs >= MIN_INTERVAL_MS) await persistIssue(run, this.callbacks, {
          kind: "leading_silence",
          severity: "info",
          notes: "This capture contains only preserved silence. No sustained meaningful audio was detected.",
          timestampMs: 0,
          endTimestampMs: finalMs,
          source: "vad",
          preferredId: run.leadingIssueId,
        });
      } else {
        run.leadingSilenceMs = Math.max(0, run.leadingSilenceMs ?? run.meaningfulStartMs);
        if (run.meaningfulEndMs == null && run.phase === "active") run.meaningfulEndMs = finalMs;
        if (run.meaningfulEndMs != null) {
          run.meaningfulEndMs = Math.min(finalMs, Math.max(run.meaningfulStartMs, run.meaningfulEndMs));
          run.trailingSilenceMs = Math.max(0, finalMs - run.meaningfulEndMs);
          if (run.trailingSilenceMs >= MIN_INTERVAL_MS) await persistIssue(run, this.callbacks, {
            kind: "trailing_silence",
            severity: "info",
            notes: "Trailing silence was preserved after the last meaningful source signal.",
            timestampMs: run.meaningfulEndMs,
            endTimestampMs: finalMs,
            source: "vad",
            preferredId: run.trailingIssueId,
          });
        }
      }

      const timing = timingForRun(run, finalMs);
      const finalUploadQueued = Boolean(finalCycle && finalCycle.blob.size > 0);
      if (finalUploadQueued) this.enqueueSegmentUpload(run, finalCycle!, timing, true);
      if (run.meaningfulEndMs != null && !this.disposed && !this.callbacks.isDisposed()) {
        this.callbacks.onEvent({
          type: "vad_transition",
          label: "meaningful-audio-end",
          source: "vad",
          severity: "info",
          start_ms: run.meaningfulEndMs,
          end_ms: finalMs,
          phase: "ended",
          notes: run.trailingSilenceMs && run.trailingSilenceMs > 0
            ? "The last meaningful signal ended before capture stopped; trailing silence remains on the source timeline."
            : "The final meaningful source signal ended at capture finalization.",
          captureSessionId: run.sessionId,
          captureRunId: run.captureRunId,
        });
      }
      await Promise.allSettled(run.uploadTasks);
      if (finalUploadQueued) {
        // A failed metadata create leaves the previous final clip authoritative.
        if (run.lastFinalSegmentId) await demotePreviousFinal(run, this.callbacks, run.lastFinalSegmentId);
      } else {
        const fallbackFinal = run.lastNonEmptySegment;
        if (fallbackFinal?.upload_status === "uploaded") {
          const marked = await markFinalSegment(run, this.callbacks, fallbackFinal, timing);
          if (marked) await demotePreviousFinal(run, this.callbacks, fallbackFinal.id);
        }
      }
      if (reason === "track" && !run.sharingEndedRecorded) {
        run.sharingEndedRecorded = true;
        await persistIssue(run, this.callbacks, {
          kind: "sharing_ended",
          severity: "info",
          notes: "The shared tab or window stopped providing audio. The captured source timeline was preserved.",
          timestampMs: finalMs,
          source: "recorder",
        });
      }
      await this.closeRunResources(run);
      run.closed = true;
      if (this.run === run) this.run = null;
      const failed = reason === "error" || Boolean(run.recorderError || run.uploadError);
      const finalStatus: CaptureStatus = {
        ...this.status,
        state: failed ? "error" : "idle",
        sourceLabel: run.sourceLabel,
        elapsedMs: finalMs,
        captureElapsedMs: run.sourceElapsedMs,
        sourceElapsedMs: finalMs,
        phase: "ended",
        clockSource: run.clockSource,
        clockSourceNote: run.clockSourceNote,
        captureStartedAt: run.captureStartedAt,
        captureEndedAt: new Date().toISOString(),
        meaningfulAudioStartedMs: run.meaningfulStartMs,
        meaningfulAudioEndedMs: run.meaningfulEndMs,
        leadingSilenceMs: run.leadingSilenceMs,
        trailingSilenceMs: run.trailingSilenceMs,
        captureSessionId: run.sessionId,
        captureRunId: run.captureRunId,
        message: failed
          ? run.recorderError || run.uploadError || "The capture could not be completed."
          : reason === "track"
            ? "Sharing ended. The captured source timeline was preserved."
            : "Recording stopped. Source silence remains in the timeline.",
      };
      this.status = finalStatus;
      if (!this.disposed && !this.callbacks.isDisposed()) {
        this.callbacks.onStatus(finalStatus);
        this.callbacks.onDuration(finalMs, callbackContext(run));
        this.callbacks.onLevels({ rms: 0, peak: 0 });
      }
      return finalStatus;
    } catch (error) {
      const message = safeMessage(error, "The capture could not be finalized.");
      run.recorderError = run.recorderError || message;
      this.notifyFatal(run, message);
      if (run.currentCycle && !run.currentCycle.settled) await stopRecorderCycle(this, run, run.currentCycle);
      await Promise.allSettled(run.uploadTasks);
      await this.closeRunResources(run).catch((cleanupError) => console.error("Capture cleanup failed", cleanupError));
      run.closed = true;
      if (this.run === run) this.run = null;
      const finalMs = run.offsetMs + run.sourceElapsedMs;
      const finalStatus: CaptureStatus = {
        ...this.status,
        state: "error",
        sourceLabel: run.sourceLabel,
        elapsedMs: finalMs,
        captureElapsedMs: run.sourceElapsedMs,
        sourceElapsedMs: finalMs,
        phase: "ended",
        clockSource: run.clockSource,
        clockSourceNote: run.clockSourceNote,
        captureStartedAt: run.captureStartedAt,
        captureEndedAt: new Date().toISOString(),
        captureSessionId: run.sessionId,
        captureRunId: run.captureRunId,
        message,
      };
      this.status = finalStatus;
      if (!this.disposed && !this.callbacks.isDisposed()) this.callbacks.onStatus(finalStatus);
      return finalStatus;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const run = this.run;
    if (!run) return;
    run.closed = true;
    run.stopRequested = true;
    run.finalizationRequested = true;
    run.track.removeEventListener("ended", run.trackEndedHandler);
    abortRecorderCycle(this, run, run.currentCycle);
    void run.analysis.close();
    run.stream.getTracks().forEach((track) => track.stop());
    run.displayStream.getTracks().forEach((track) => track.stop());
    this.run = null;
  }
}
