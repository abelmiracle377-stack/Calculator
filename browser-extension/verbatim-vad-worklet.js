class VerbatimVadProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.epochContextMs = null;
    this.phase = "waiting";
    this.noise = 0.006;
    this.activeMs = 0;
    this.quietMs = 0;
    this.lastMeaningfulBoundary = -1;
    this.lastSourceMs = 0;
    this.lastFramePostMs = -Infinity;
    this.lastClipMs = -Infinity;
    this.lastTransientMs = -Infinity;
    this.lastDistortionMs = -Infinity;
    this.loudMs = 0;
    this.lastRms = 0;
    this.lastPeak = 0;

    this.port.onmessage = (message) => {
      const data = message.data || {};
      if (data.kind === "capture-epoch" && this.epochContextMs === null) {
        const epoch = Number(data.context_time_ms);
        if (!Number.isFinite(epoch)) return;
        this.epochContextMs = epoch;
        this.phase = "waiting";
        this.noise = 0.006;
        this.activeMs = 0;
        this.quietMs = 0;
        this.lastMeaningfulBoundary = -1;
        this.lastSourceMs = 0;
        this.lastFramePostMs = -Infinity;
        this.port.postMessage({ kind: "epoch-ack", context_time_ms: epoch });
      } else if (data.kind === "snapshot") {
        this.port.postMessage({
          kind: "snapshot",
          request_id: data.request_id,
          source_time_ms: this.lastSourceMs,
          meaningful_end_ms: this.lastMeaningfulBoundary >= 0 ? this.lastMeaningfulBoundary : null,
          phase: this.phase,
          rms: this.lastRms,
          peak: this.lastPeak,
        });
      }
    };
  }

  postSignal(label, startMs, endMs, notes) {
    this.port.postMessage({
      kind: "event",
      event: {
        type: "local_signal",
        label,
        source: "vad",
        severity: "warning",
        start_ms: startMs,
        end_ms: endMs,
        possible: true,
        notes,
      },
    });
  }

  analyze(channels, firstSample, startMs, durationMs) {
    let sampleCount = 0;
    let sum = 0;
    let peak = 0;
    let maxDelta = 0;

    for (const channel of channels) {
      if (!channel || firstSample >= channel.length) continue;
      let previous = channel[firstSample] || 0;
      const length = channel.length;
      for (let index = firstSample; index < length; index += 1) {
        const sample = channel[index] || 0;
        const absolute = Math.abs(sample);
        sampleCount += 1;
        sum += sample * sample;
        peak = Math.max(peak, absolute);
        maxDelta = Math.max(maxDelta, Math.abs(sample - previous));
        previous = sample;
      }
    }

    if (!sampleCount) return;
    const rms = Math.sqrt(sum / sampleCount);
    const endMs = startMs + durationMs;
    const activeThreshold = Math.max(0.018, this.noise * 3.4);
    const quietThreshold = Math.max(0.012, this.noise * 1.8);
    if (rms < activeThreshold) {
      this.noise = Math.max(0.001, this.noise * 0.98 + rms * 0.02);
    }

    if (this.phase === "active") {
      if (rms > quietThreshold) {
        this.quietMs = 0;
        this.lastMeaningfulBoundary = endMs;
      } else {
        this.quietMs += durationMs;
        if (this.quietMs >= 900) {
          const quietStart = this.lastMeaningfulBoundary >= 0
            ? this.lastMeaningfulBoundary
            : Math.max(0, endMs - this.quietMs);
          this.phase = "quiet";
          this.activeMs = 0;
          this.port.postMessage({
            kind: "event",
            event: {
              type: "vad_transition",
              label: "audio-quiet",
              source: "vad",
              severity: "info",
              start_ms: quietStart,
              end_ms: endMs,
              phase: "quiet",
              notes: "The source is quiet and remains monitored for audio returning.",
            },
          });
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
        this.lastMeaningfulBoundary = endMs;
        this.port.postMessage({
          kind: "event",
          event: {
            type: "vad_transition",
            label: wasWaiting ? "meaningful-audio-start" : "meaningful-audio-resumed",
            source: "vad",
            severity: "info",
            start_ms: onset,
            phase: "active",
            notes: wasWaiting
              ? "Sustained incoming signal confirmed by the audio processor."
              : "Audio returned while the source remained under capture.",
          },
        });
      }
    } else {
      this.activeMs = 0;
    }

    if (peak >= 0.985 && endMs - this.lastClipMs >= 3000) {
      this.lastClipMs = endMs;
      this.postSignal(
        "possible-clipping",
        startMs,
        endMs,
        "Possible clipping from a near-full-scale source peak. Review the source signal.",
      );
    }
    if (peak >= 0.88 && rms < 0.18 && maxDelta >= 0.55 && endMs - this.lastTransientMs >= 1800) {
      this.lastTransientMs = endMs;
      this.postSignal(
        "possible-pop-click",
        startMs,
        endMs,
        "Possible short pop or click detected by a local transient check.",
      );
    }
    if (peak >= 0.93 && rms >= 0.62) this.loudMs += durationMs;
    else this.loudMs = 0;
    if (this.loudMs >= 100 && endMs - this.lastDistortionMs >= 3000) {
      this.lastDistortionMs = endMs;
      this.postSignal(
        "possible-distortion",
        Math.max(0, endMs - this.loudMs),
        endMs,
        "Possible sustained signal distortion detected locally. The exact cause is unknown.",
      );
    }

    this.lastSourceMs = Math.max(this.lastSourceMs, endMs);
    this.lastRms = rms;
    this.lastPeak = peak;
    if (endMs - this.lastFramePostMs >= 80 || this.lastFramePostMs === -Infinity) {
      this.lastFramePostMs = endMs;
      this.port.postMessage({
        kind: "frame",
        start_ms: startMs,
        end_ms: endMs,
        rms,
        peak,
        phase: this.phase,
        meaningful_end_ms: this.lastMeaningfulBoundary >= 0 ? this.lastMeaningfulBoundary : null,
      });
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (output) {
      for (const channel of output) channel.fill(0);
    }

    const channels = inputs[0] || [];
    if (this.epochContextMs === null || !channels.length) return true;
    let sampleLength = 0;
    for (const channel of channels) sampleLength = Math.max(sampleLength, channel.length);
    if (!sampleLength) return true;

    const blockStartMs = currentTime * 1000;
    const blockDurationMs = sampleLength / sampleRate * 1000;
    const blockEndMs = blockStartMs + blockDurationMs;
    if (blockEndMs <= this.epochContextMs) return true;

    const samplesBeforeEpoch = Math.max(
      0,
      Math.min(sampleLength, Math.ceil((this.epochContextMs - blockStartMs) / 1000 * sampleRate)),
    );
    const startMs = Math.max(0, blockStartMs + samplesBeforeEpoch / sampleRate * 1000 - this.epochContextMs);
    const durationMs = Math.max(0, blockEndMs - Math.max(this.epochContextMs, blockStartMs + samplesBeforeEpoch / sampleRate * 1000));
    this.analyze(channels, samplesBeforeEpoch, startMs, durationMs);
    return true;
  }
}

registerProcessor("verbatim-vad", VerbatimVadProcessor);
