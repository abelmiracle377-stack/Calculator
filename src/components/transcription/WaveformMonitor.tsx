import { forwardRef } from "react";
import { Activity, Radio } from "lucide-react";
import { formatDuration } from "@/lib/transcription/format";
import type { CaptureStatus, MeterLevels } from "@/lib/transcription/types";

interface WaveformMonitorProps {
  status: CaptureStatus;
  levels: MeterLevels;
}

const phaseLabels: Record<CaptureStatus["phase"], string> = {
  waiting: "Waiting for audio",
  active: "Meaningful audio",
  quiet: "Audio quiet",
  ended: "Audio ended",
};

const phaseDescriptions: Record<CaptureStatus["phase"], string> = {
  waiting: "Monitoring for the first meaningful signal.",
  active: "Meaningful audio is on the source timeline.",
  quiet: "Audio is quiet, but monitoring continues.",
  ended: "Audio sharing ended. The captured timeline is preserved.",
};

export const WaveformMonitor = forwardRef<HTMLCanvasElement, WaveformMonitorProps>(
  function WaveformMonitor({ status, levels }, ref) {
    const rmsPct = Math.min(100, Math.round(levels.rms * 140));
    const peakPct = Math.min(100, Math.round(levels.peak * 100));
    const isLive = status.state === "recording";
    const phase = status.phase ?? (isLive ? "waiting" : "ended");

    return (
      <section className={`tx-monitor ${isLive ? "is-live" : ""}`} aria-label="Live monitor">
        <div className="tx-monitor-head">
          <div className="tx-monitor-title-row">
            <span className={`tx-rec-dot ${isLive ? "is-pulsing" : ""}`} aria-hidden />
            <h3>{isLive ? "Live capture" : "Monitor"}</h3>
          </div>
          <div className="tx-elapsed" aria-live="polite">
            {formatDuration(status.elapsedMs)}
          </div>
        </div>

        <div className="tx-monitor-phase-row" aria-live="polite">
          <span className={`tx-phase-badge phase-${phase}`} role="status">
            <span className="tx-phase-indicator" aria-hidden />
            {phaseLabels[phase]}
          </span>
          <span className="tx-phase-description">{phaseDescriptions[phase]}</span>
        </div>

        <canvas
          ref={ref}
          className="tx-waveform"
          aria-label="Audio waveform"
          role="img"
        />

        <div className="tx-meters">
          <div className="tx-meter">
            <div className="tx-meter-label">
              <Activity className="h-3.5 w-3.5" />
              RMS
            </div>
            <div className="tx-meter-track" aria-hidden>
              <div
                className="tx-meter-fill is-rms"
                style={{ width: `${rmsPct}%` }}
              />
            </div>
            <span className="tx-meter-value">{rmsPct}%</span>
          </div>
          <div className="tx-meter">
            <div className="tx-meter-label">
              <Radio className="h-3.5 w-3.5" />
              Peak
            </div>
            <div className="tx-meter-track" aria-hidden>
              <div
                className={`tx-meter-fill is-peak ${peakPct > 90 ? "is-hot" : ""}`}
                style={{ width: `${peakPct}%` }}
              />
            </div>
            <span className="tx-meter-value">{peakPct}%</span>
          </div>
        </div>

        <div className="tx-monitor-timing" aria-label="Source timing">
          <div className="tx-timing-row">
            <span>Capture duration</span>
            <strong>{formatDuration(status.captureElapsedMs)}</strong>
          </div>
          <div className="tx-timing-row">
            <span>Source position</span>
            <strong>{formatDuration(status.sourceElapsedMs)}</strong>
          </div>
          {status.meaningfulAudioStartedMs != null && (
            <div className="tx-timing-row">
              <span>Meaningful audio started</span>
              <strong>{formatDuration(status.meaningfulAudioStartedMs)}</strong>
            </div>
          )}
          {status.meaningfulAudioEndedMs != null && (
            <div className="tx-timing-row">
              <span>Meaningful audio ended</span>
              <strong>{formatDuration(status.meaningfulAudioEndedMs)}</strong>
            </div>
          )}
          {status.leadingSilenceMs != null && (
            <div className="tx-timing-row">
              <span>Leading silence</span>
              <strong>{formatDuration(status.leadingSilenceMs)}</strong>
            </div>
          )}
          {status.trailingSilenceMs != null && (
            <div className="tx-timing-row">
              <span>Trailing silence</span>
              <strong>{formatDuration(status.trailingSilenceMs)}</strong>
            </div>
          )}
        </div>

        <p className="tx-phase-note">
          Quiet sections stay monitored. The first meaningful signal is detected automatically, and preserved silence stays on the source timeline.
        </p>
        {status.clockSource === "script-processor" && status.clockSourceNote && (
          <p className="tx-clock-note">{status.clockSourceNote}</p>
        )}

        <div className="tx-monitor-meta">
          <p>
            <span className="tx-meta-label">Source</span>
            {status.sourceLabel || "Waiting for tab share"}
          </p>
          <p>
            <span className="tx-meta-label">Status</span>
            {status.message ||
              (isLive
                ? "Recording audio in ~20s segments"
                : "Idle, start capture when ready")}
          </p>
        </div>
      </section>
    );
  }
);
