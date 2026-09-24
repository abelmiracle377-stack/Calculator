import type { AudioClockSource, AudioPhase, CaptureEventPayload } from "./types";

export interface AudioAnalysisFrame {
  sourceStartMs: number;
  sourceEndMs: number;
  rms: number;
  peak: number;
  phase: AudioPhase;
  meaningfulEndMs?: number;
}

export interface AudioAnalysisSnapshot {
  sourceTimeMs: number;
  meaningfulEndMs?: number;
  phase: AudioPhase;
  rms: number;
  peak: number;
}

export interface AudioAnalysisEpoch {
  contextTimeMs: number;
  sourceTimeMs: number;
  clockSource: AudioClockSource;
}

export interface AudioAnalysisCallbacks {
  onFrame: (frame: AudioAnalysisFrame) => void;
  onEvent: (event: CaptureEventPayload) => void;
}

export interface AudioAnalysisHandle {
  context: AudioContext;
  analyser: AnalyserNode;
  clockSource: AudioClockSource;
  clockSourceNote: string;
  beginCaptureEpoch: () => AudioAnalysisEpoch;
  snapshot: () => Promise<AudioAnalysisSnapshot>;
  getSourceTimeMs: () => number;
  close: () => Promise<void>;
}

type ProcessorMessage = {
  kind: string;
  start_ms?: number;
  end_ms?: number;
  rms?: number;
  peak?: number;
  phase?: AudioPhase;
  meaningful_end_ms?: number | null;
  source_time_ms?: number;
  context_time_ms?: number;
  request_id?: number;
  event?: CaptureEventPayload;
};

type PendingSnapshot = {
  resolve: (snapshot: AudioAnalysisSnapshot) => void;
  timeout: number;
};

const WORKLET_NAME = "verbatim-vad";
const WORKLET_NOTE = "AudioWorklet frame clock.";
const FALLBACK_NOTE = "Best-effort ScriptProcessor playback clock. Hidden-tab timing may be less precise.";

function contextConstructor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

function finite(value: number | undefined | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function emptyFrame(startMs: number, endMs: number, rms: number, peak: number, phase: AudioPhase, meaningfulEndMs: number | undefined): AudioAnalysisFrame {
  return { sourceStartMs: startMs, sourceEndMs: endMs, rms, peak, phase, ...(meaningfulEndMs == null ? {} : { meaningfulEndMs }) };
}

class FallbackAnalyzer {
  phase: AudioPhase = "waiting";
  noise = 0.006;
  activeMs = 0;
  quietMs = 0;
  loudMs = 0;
  lastMeaningful = -1;
  lastClip = -Infinity;
  lastTransient = -Infinity;
  lastDistortion = -Infinity;

  process(channels: Float32Array[], firstSample: number, startMs: number, durationMs: number) {
    let sampleCount = 0;
    let sum = 0;
    let peak = 0;
    let maxDelta = 0;
    for (const channel of channels) {
      if (!channel || firstSample >= channel.length) continue;
      let previous = channel[firstSample] || 0;
      for (let index = firstSample; index < channel.length; index += 1) {
        const sample = channel[index] || 0;
        const absolute = Math.abs(sample);
        sampleCount += 1;
        sum += sample * sample;
        peak = Math.max(peak, absolute);
        maxDelta = Math.max(maxDelta, Math.abs(sample - previous));
        previous = sample;
      }
    }
    if (!sampleCount) return { frame: emptyFrame(startMs, startMs, 0, 0, this.phase, undefined), events: [] as CaptureEventPayload[] };

    const rms = Math.sqrt(sum / sampleCount);
    const endMs = startMs + Math.max(0, durationMs);
    const activeThreshold = Math.max(0.018, this.noise * 3.4);
    const quietThreshold = Math.max(0.012, this.noise * 1.8);
    const events: CaptureEventPayload[] = [];
    if (rms < activeThreshold) this.noise = Math.max(0.001, this.noise * 0.98 + rms * 0.02);

    if (this.phase === "active") {
      if (rms > quietThreshold) {
        this.quietMs = 0;
        this.lastMeaningful = endMs;
      } else {
        this.quietMs += durationMs;
        if (this.quietMs >= 900) {
          const quietStart = this.lastMeaningful >= 0 ? this.lastMeaningful : Math.max(0, endMs - this.quietMs);
          this.phase = "quiet";
          this.activeMs = 0;
          events.push({ type: "vad_transition", label: "audio-quiet", source: "vad", severity: "info", start_ms: quietStart, end_ms: endMs, phase: "quiet", notes: "The source is quiet and remains monitored for audio returning." });
        }
      }
    } else if (rms >= activeThreshold) {
      this.activeMs += durationMs;
      if (this.activeMs >= 240) {
        const wasWaiting = this.phase === "waiting";
        const onset = Math.max(0, endMs - this.activeMs);
        this.phase = "active";
        this.quietMs = 0;
        this.activeMs = 0;
        this.lastMeaningful = endMs;
        events.push({ type: "vad_transition", label: wasWaiting ? "meaningful-audio-start" : "meaningful-audio-resumed", source: "vad", severity: "info", start_ms: onset, phase: "active", notes: wasWaiting ? "Sustained incoming signal confirmed by the fallback audio processor." : "Audio returned while the source remained under capture." });
      }
    } else {
      this.activeMs = 0;
    }

    if (peak >= 0.985 && endMs - this.lastClip >= 3000) {
      this.lastClip = endMs;
      events.push({ type: "local_signal", label: "possible-clipping", source: "vad", severity: "warning", start_ms: startMs, end_ms: endMs, possible: true, notes: "Possible clipping from a near-full-scale source peak. Review the source signal." });
    }
    if (peak >= 0.88 && rms < 0.18 && maxDelta >= 0.55 && endMs - this.lastTransient >= 1800) {
      this.lastTransient = endMs;
      events.push({ type: "local_signal", label: "possible-pop-click", source: "vad", severity: "warning", start_ms: startMs, end_ms: endMs, possible: true, notes: "Possible short pop or click detected by a local transient check." });
    }
    if (peak >= 0.93 && rms >= 0.62) this.loudMs += durationMs;
    else this.loudMs = 0;
    if (this.loudMs >= 100 && endMs - this.lastDistortion >= 3000) {
      this.lastDistortion = endMs;
      events.push({ type: "local_signal", label: "possible-distortion", source: "vad", severity: "warning", start_ms: Math.max(0, endMs - this.loudMs), end_ms: endMs, possible: true, notes: "Possible sustained signal distortion detected locally. The exact cause is unknown." });
    }

    return {
      frame: emptyFrame(startMs, endMs, rms, peak, this.phase, this.lastMeaningful >= 0 ? this.lastMeaningful : undefined),
      events,
    };
  }
}

export async function createAudioAnalysis(stream: MediaStream, callbacks: AudioAnalysisCallbacks): Promise<AudioAnalysisHandle> {
  const AudioCtx = contextConstructor();
  if (!AudioCtx) throw new Error("Audio processing is not available in this browser.");

  const context = new AudioCtx();
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let silentSink: GainNode | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let fallbackNode: ScriptProcessorNode | null = null;
  let closed = false;
  let epoch: AudioAnalysisEpoch | null = null;
  let fallbackEpochContextMs: number | null = null;
  let lastSourceMs = 0;
  let lastFrameEndMs = 0;
  let lastMeaningfulEndMs: number | undefined;
  let lastPhase: AudioPhase = "waiting";
  let lastRms = 0;
  let lastPeak = 0;
  let nextSnapshotId = 0;
  const pendingSnapshots = new Map<number, PendingSnapshot>();

  const currentSnapshot = (): AudioAnalysisSnapshot => ({
    sourceTimeMs: lastSourceMs,
    ...(lastMeaningfulEndMs == null ? {} : { meaningfulEndMs: lastMeaningfulEndMs }),
    phase: lastPhase,
    rms: lastRms,
    peak: lastPeak,
  });

  const dispatchFrame = (frame: AudioAnalysisFrame) => {
    if (closed || !epoch) return;
    const rawStart = Math.max(0, finite(frame.sourceStartMs) ? frame.sourceStartMs : 0);
    const rawEnd = Math.max(rawStart, finite(frame.sourceEndMs) ? frame.sourceEndMs : rawStart);
    const startMs = Math.max(lastFrameEndMs, rawStart);
    const endMs = Math.max(startMs, rawEnd);
    if (endMs <= lastFrameEndMs && endMs <= 0) return;
    lastFrameEndMs = Math.max(lastFrameEndMs, endMs);
    lastSourceMs = Math.max(lastSourceMs, endMs);
    if (frame.meaningfulEndMs != null) {
      const candidateMeaningfulEndMs = Math.min(lastSourceMs, Math.max(0, frame.meaningfulEndMs));
      lastMeaningfulEndMs = Math.max(lastMeaningfulEndMs ?? 0, candidateMeaningfulEndMs);
    }
    lastPhase = frame.phase;
    lastRms = finite(frame.rms) ? frame.rms : 0;
    lastPeak = finite(frame.peak) ? frame.peak : 0;
    callbacks.onFrame(emptyFrame(startMs, endMs, lastRms, lastPeak, lastPhase, lastMeaningfulEndMs));
  };

  const dispatchEvent = (event: CaptureEventPayload) => {
    if (closed || !epoch) return;
    const startMs = Math.max(0, finite(event.start_ms) ? event.start_ms : 0);
    const endMs = event.end_ms == null ? undefined : Math.max(startMs, event.end_ms);
    callbacks.onEvent({ ...event, start_ms: startMs, ...(endMs == null ? {} : { end_ms: endMs }) });
  };

  const dispatch = (message: ProcessorMessage) => {
    if (message.kind === "frame") {
      dispatchFrame({ sourceStartMs: message.start_ms || 0, sourceEndMs: message.end_ms || 0, rms: message.rms || 0, peak: message.peak || 0, phase: message.phase || "waiting", meaningfulEndMs: message.meaningful_end_ms == null ? undefined : message.meaningful_end_ms });
    } else if (message.kind === "event" && message.event) {
      dispatchEvent(message.event);
    } else if (message.kind === "snapshot" && finite(message.request_id)) {
      const pending = pendingSnapshots.get(message.request_id);
      if (!pending) return;
      pendingSnapshots.delete(message.request_id);
      window.clearTimeout(pending.timeout);
      const sourceTimeMs = Math.max(lastSourceMs, finite(message.source_time_ms) ? message.source_time_ms : 0);
      if (message.meaningful_end_ms != null) {
        const candidateMeaningfulEndMs = Math.min(sourceTimeMs, Math.max(0, message.meaningful_end_ms));
        lastMeaningfulEndMs = Math.max(lastMeaningfulEndMs ?? 0, candidateMeaningfulEndMs);
      }
      lastSourceMs = sourceTimeMs;
      lastFrameEndMs = Math.max(lastFrameEndMs, sourceTimeMs);
      lastPhase = message.phase || lastPhase;
      lastRms = finite(message.rms) ? message.rms : lastRms;
      lastPeak = finite(message.peak) ? message.peak : lastPeak;
      pending.resolve(currentSnapshot());
    }
  };

  const beginCaptureEpoch = (): AudioAnalysisEpoch => {
    if (closed) throw new Error("Audio analysis is already closed.");
    if (epoch) return epoch;
    const contextTimeMs = Math.max(0, context.currentTime * 1000);
    epoch = { contextTimeMs, sourceTimeMs: 0, clockSource: workletNode ? "audio-context" : "script-processor" };
    if (workletNode) {
      workletNode.port.postMessage({ kind: "capture-epoch", context_time_ms: contextTimeMs });
    } else {
      fallbackEpochContextMs = contextTimeMs;
    }
    return epoch;
  };

  const snapshot = async (): Promise<AudioAnalysisSnapshot> => {
    if (closed || !epoch || !workletNode) return currentSnapshot();
    const requestId = ++nextSnapshotId;
    return new Promise<AudioAnalysisSnapshot>((resolve) => {
      const timeout = window.setTimeout(() => {
        pendingSnapshots.delete(requestId);
        resolve(currentSnapshot());
      }, 900);
      pendingSnapshots.set(requestId, { resolve, timeout });
      try {
        workletNode?.port.postMessage({ kind: "snapshot", request_id: requestId });
      } catch {
        window.clearTimeout(timeout);
        pendingSnapshots.delete(requestId);
        resolve(currentSnapshot());
      }
    });
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    const finalSnapshot = currentSnapshot();
    pendingSnapshots.forEach((pending) => {
      window.clearTimeout(pending.timeout);
      pending.resolve(finalSnapshot);
    });
    pendingSnapshots.clear();
    if (workletNode) {
      workletNode.port.onmessage = null;
      try { workletNode.port.close(); } catch { /* already closed */ }
      workletNode.disconnect();
    }
    if (fallbackNode) {
      fallbackNode.onaudioprocess = null;
      fallbackNode.disconnect();
    }
    source?.disconnect();
    analyser?.disconnect();
    silentSink?.disconnect();
    await context.close().catch(() => undefined);
  };

  try {
    await context.resume().catch(() => undefined);
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.75;
    silentSink = context.createGain();
    silentSink.gain.value = 0;
    source.connect(analyser);

    if (context.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      try {
        const workletUrl = new URL("/verbatim-vad-worklet.js", window.location.origin).href;
        await context.audioWorklet.addModule(workletUrl);
        workletNode = new AudioWorkletNode(context, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        workletNode.channelCountMode = "max";
        workletNode.port.onmessage = (event: MessageEvent<ProcessorMessage>) => dispatch(event.data);
        source.connect(workletNode);
        workletNode.connect(silentSink);
      } catch (error) {
        console.warn("AudioWorklet unavailable, using the best-effort audio processor fallback.", error);
        if (workletNode) {
          workletNode.port.onmessage = null;
          try { workletNode.port.close(); } catch { /* ignore */ }
          workletNode.disconnect();
          workletNode = null;
        }
        analyser.disconnect();
      }
    }

    if (!workletNode) {
      const configuredChannels = Number(stream.getAudioTracks()[0]?.getSettings().channelCount) || 2;
      const inputChannels = Math.max(1, Math.min(32, Math.round(configuredChannels)));
      fallbackNode = context.createScriptProcessor(2048, inputChannels, 1);
      const fallback = new FallbackAnalyzer();
      fallbackNode.onaudioprocess = (event) => {
        if (closed || fallbackEpochContextMs == null) return;
        const input = event.inputBuffer;
        const channels = Array.from({ length: input.numberOfChannels }, (_, index) => input.getChannelData(index));
        if (!channels.length || !input.length) return;
        const durationMs = input.length / context.sampleRate * 1000;
        const playbackTime = Number(event.playbackTime);
        const endContextMs = Number.isFinite(playbackTime) ? playbackTime * 1000 : context.currentTime * 1000;
        const startContextMs = endContextMs - durationMs;
        if (endContextMs <= fallbackEpochContextMs) return;
        const firstSample = Math.max(0, Math.min(input.length, Math.ceil((fallbackEpochContextMs - startContextMs) / 1000 * context.sampleRate)));
        const startMs = Math.max(0, startContextMs + firstSample / context.sampleRate * 1000 - fallbackEpochContextMs);
        const clippedDurationMs = Math.max(0, endContextMs - Math.max(fallbackEpochContextMs, startContextMs + firstSample / context.sampleRate * 1000));
        const result = fallback.process(channels, firstSample, startMs, clippedDurationMs);
        dispatchFrame(result.frame);
        result.events.forEach(dispatchEvent);
      };
      source.connect(fallbackNode);
      fallbackNode.connect(silentSink);
    }
    silentSink.connect(context.destination);
  } catch (error) {
    await close();
    throw error instanceof Error ? error : new Error("Could not create the audio analysis graph.");
  }

  const analyserNode = analyser;
  if (!analyserNode) {
    await close();
    throw new Error("The audio monitor could not be connected.");
  }

  return {
    context,
    analyser: analyserNode,
    clockSource: workletNode ? "audio-context" : "script-processor",
    clockSourceNote: workletNode ? WORKLET_NOTE : FALLBACK_NOTE,
    beginCaptureEpoch,
    snapshot,
    getSourceTimeMs: () => lastSourceMs,
    close,
  };
}
