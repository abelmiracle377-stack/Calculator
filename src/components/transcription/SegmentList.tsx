import { AlertCircle, CheckCircle2, ClipboardCheck, Clock3, Languages, Loader2, RotateCcw, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDuration, formatTimestampTag } from "@/lib/transcription/format";
import { getTranscriptionStatus } from "@/lib/transcription/transcription";
import { getPulsarClipStatus } from "@/lib/transcription/pulsar";
import type { AudioSegmentRecord, PulsarClipStatus } from "@/lib/transcription/types";

interface SegmentListProps {
  segments: AudioSegmentRecord[];
  busyIds?: Set<string>;
  onTranscribe?: (segmentId: string) => void;
  pulsarReview?: boolean;
  onPulsarStatusChange?: (segmentId: string, status: PulsarClipStatus) => void;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "uploaded" || status === "completed") return <CheckCircle2 className="h-3.5 w-3.5 text-[hsl(var(--mint))]" />;
  if (status === "failed") return <AlertCircle className="h-3.5 w-3.5 text-[hsl(var(--coral))]" />;
  if (status === "transcribing") return <Loader2 className="h-3.5 w-3.5 animate-spin text-[hsl(var(--coral))]" />;
  return <Clock3 className="h-3.5 w-3.5 opacity-70" />;
}

function transcriptionLabel(status: string) {
  switch (status) {
    case "completed": return "Transcribed";
    case "transcribing": return "Transcribing";
    case "failed": return "Needs retry";
    default: return "Waiting";
  }
}

function pulsarReviewLabel(status: PulsarClipStatus) {
  if (status === "done") return "Reviewed";
  if (status === "in_progress") return "Review in progress";
  return "Not started";
}

export function SegmentList({ segments, busyIds = new Set(), onTranscribe, pulsarReview = false, onPulsarStatusChange }: SegmentListProps) {
  const sorted = [...segments].sort((a, b) => a.sequence - b.sequence);

  return (
    <section className="tx-panel" aria-label="Audio segments">
      <div className="tx-panel-head">
        <div><p className="tx-kicker">Source clips</p><h3>Audio segments</h3></div>
        <span className="tx-count-chip">{sorted.length}</span>
      </div>
      {sorted.length === 0 ? (
        <p className="tx-help">Completed clips appear here with independent playback and transcription status.</p>
      ) : (
        <ul className="tx-segment-list">
          {sorted.map((seg) => {
            const dur = Math.max(0, (seg.end_ms ?? 0) - (seg.start_ms ?? 0));
            const status = getTranscriptionStatus(seg);
            const busy = busyIds.has(seg.id) || status === "transcribing";
            const canTranscribe = seg.upload_status === "uploaded" && status !== "completed" && !busy;
            return (
              <li key={seg.id} className="tx-segment-row">
                <div className="tx-segment-meta">
                  <span className="tx-segment-seq">#{seg.sequence + 1}</span>
                  <span>{formatTimestampTag(seg.start_ms)} to {formatTimestampTag(seg.end_ms)}</span>
                  <span className="tx-muted">{formatDuration(dur)}</span>
                  <span className={`tx-segment-status tx-transcription-state state-${status}`}><StatusIcon status={status} />{transcriptionLabel(status)}</span>
                </div>
                {seg.upload_status === "uploaded" && seg.audio_url ? <audio controls preload="none" src={seg.audio_url} className="tx-audio" aria-label={`Play audio segment ${seg.sequence + 1}`} /> : seg.upload_status === "failed" ? <p className="tx-error-inline">{seg.error_message || "Upload failed for this segment."}</p> : <p className="tx-help">Uploading audio…</p>}
                {seg.upload_status === "uploaded" && (
                  <div className="tx-segment-transcription-row">
                    <div className="tx-segment-detection">
                      {seg.detected_language && <span><Languages className="h-3 w-3" />{seg.detected_language}</span>}
                      {!!seg.speaker_count && <span>{seg.speaker_count} {seg.speaker_count === 1 ? "speaker" : "speakers"}</span>}
                      {seg.word_count != null && <span>{seg.word_count} words</span>}
                    </div>
                    {canTranscribe && onTranscribe && <Button type="button" size="sm" variant="outline" className="tx-btn-ghost tx-segment-action" onClick={() => onTranscribe(seg.id)}><WandSparkles className="h-3.5 w-3.5" />{status === "failed" ? <><RotateCcw className="h-3 w-3" /> Retry</> : "Transcribe"}</Button>}
                    {busy && <span className="tx-segment-working"><Loader2 className="h-3 w-3 animate-spin" />Working…</span>}
                  </div>
                )}
                {status === "failed" && <p className="tx-error-inline">{seg.transcription_error || "Transcription failed. Check the key and retry this clip."}</p>}
                {pulsarReview && <div className="tx-pulsar-clip-review" aria-label={`Pulsar review status for clip ${seg.sequence + 1}`}>
                  <div className="tx-pulsar-clip-status"><ClipboardCheck className="h-3.5 w-3.5" /><span>{seg.upload_status === "uploaded" ? pulsarReviewLabel(getPulsarClipStatus(seg)) : "Waiting for upload"}</span></div>
                  {seg.upload_status === "uploaded" && onPulsarStatusChange && <Button type="button" size="sm" variant="outline" className="tx-btn-ghost tx-pulsar-clip-action" onClick={() => { const next = getPulsarClipStatus(seg) === "done" ? "in_progress" : getPulsarClipStatus(seg) === "not_started" ? "in_progress" : "done"; onPulsarStatusChange(seg.id, next); }}>
                    {getPulsarClipStatus(seg) === "done" ? "Reopen" : getPulsarClipStatus(seg) === "in_progress" ? "Mark reviewed" : "Start review"}
                  </Button>}
                </div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
