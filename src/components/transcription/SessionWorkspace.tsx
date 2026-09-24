import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AlertCircle, CircleStop, Disc, ListChecks, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { WaveformMonitor } from "./WaveformMonitor";
import { SegmentList } from "./SegmentList";
import { IssueLog } from "./IssueLog";
import { SessionSettings } from "./SessionSettings";
import { AudioTranscriptionPanel } from "./AudioTranscriptionPanel";
import { TranscriptEditor } from "./TranscriptEditor";
import { FormattedPreview } from "./FormattedPreview";
import { TimelineAnnotations, type AnnotationDraft } from "./TimelineAnnotations";
import { TranscriptionCleanupDialog } from "./TranscriptionCleanupDialog";
import { PulsarReviewPanel } from "./PulsarReviewPanel";
import { TranslationPanel } from "./TranslationPanel";
import { formatDuration, statusLabel } from "@/lib/transcription/format";
import { calculatePulsarReadiness, evaluatePulsarQa } from "@/lib/transcription/pulsar";
import { aggregateDetectedLanguages, averageLanguageConfidence, formatConfidenceText, formatLanguageList, getManualLanguagePreferences, getSessionLanguageMode, getTranscriptionCounts, getTranscriptionStatus, languageModeLabel } from "@/lib/transcription/transcription";
import type { AudioIssueRecord, AudioSegmentRecord, CaptureStatus, CleanupProposal, InputMode, MeterLevels, PulsarClipStatus, PulsarReadiness, PulsarTagDefinition, TranscriptAnnotationRecord, TranscriptLineRecord, TranscriptStyle, TranscriptionSessionRecord, UnclearMarkerKind } from "@/lib/transcription/types";

interface SessionWorkspaceProps {
  session: TranscriptionSessionRecord;
  lines: TranscriptLineRecord[];
  segments: AudioSegmentRecord[];
  issues: AudioIssueRecord[];
  annotations: TranscriptAnnotationRecord[];
  captureStatus: CaptureStatus;
  levels: MeterLevels;
  captureBusy: boolean;
  settingsSaving: boolean;
  customGuidelineSaving: boolean;
  transcriptionBusyIds: Set<string>;
  cleanupOpen: boolean;
  cleanupLoading: boolean;
  cleanupProposals: CleanupProposal[];
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onStartCapture: () => void;
  onStopCapture: () => void;
  onSettingsChange: (patch: Partial<TranscriptionSessionRecord>) => void;
  onCustomGuidelineChange: (patch: Partial<TranscriptionSessionRecord>) => void | Promise<boolean | void>;
  onAudioSubmit?: (file: File, durationMs: number) => void | Promise<void>;
  audioSubmitting?: boolean;
  audioSubmitStatus?: string;
  audioSubmitError?: string;
  onAddSpeech: () => void;
  onAddMarker: () => void;
  onAddTimestamp: () => void;
  onAddUnclear: (kind: UnclearMarkerKind) => void;
  onUpdateLine: (id: string, patch: Partial<TranscriptLineRecord>) => void;
  onSplitLine: (id: string, cursor: number) => void;
  onDeleteLine: (id: string) => void;
  onSpeakerUsed: (label: string) => void;
  onAddCustomSpeaker: (label: string) => void;
  onTranscribeSegment: (id: string) => void;
  onTranscribePending: () => void;
  onRetryFailed: () => void;
  onCleanTranscript: () => void;
  onCreateAnnotation: (draft: AnnotationDraft) => void | Promise<void>;
  onUpdateAnnotation: (id: string, patch: Partial<AnnotationDraft>) => void | Promise<void>;
  onDeleteAnnotation: (id: string) => void | Promise<void>;
  onCleanupOpenChange: (open: boolean) => void;
  onApplyCleanup: (proposals: CleanupProposal[]) => void | Promise<void>;
  onDiscard: () => void;
  onPulsarStatusChange: (segmentId: string, status: PulsarClipStatus) => void | Promise<void>;
  onInsertPulsarTag: (lineId: string, tag: PulsarTagDefinition) => void | Promise<void>;
  onRunPulsarQA: () => void | Promise<void>;
  onExportPulsar: () => void | Promise<void>;
  onSetPulsarReadiness: (state: PulsarReadiness) => void | Promise<void>;
  onReadinessInvalid: () => void;
}

export function SessionWorkspace({
  session, lines, segments, issues, annotations, captureStatus, levels, captureBusy, settingsSaving, customGuidelineSaving, transcriptionBusyIds, cleanupOpen, cleanupLoading, cleanupProposals, canvasRef, onStartCapture, onStopCapture, onSettingsChange, onCustomGuidelineChange, onAudioSubmit, audioSubmitting, audioSubmitStatus, audioSubmitError, onAddSpeech, onAddMarker, onAddTimestamp, onAddUnclear, onUpdateLine, onSplitLine, onDeleteLine, onSpeakerUsed, onAddCustomSpeaker, onTranscribeSegment, onTranscribePending, onRetryFailed, onCleanTranscript, onCreateAnnotation, onUpdateAnnotation, onDeleteAnnotation, onCleanupOpenChange, onApplyCleanup, onDiscard, onPulsarStatusChange, onInsertPulsarTag, onRunPulsarQA, onExportPulsar, onSetPulsarReadiness, onReadinessInvalid,
}: SessionWorkspaceProps) {
  const captureBelongsToSession = !captureStatus.captureSessionId || captureStatus.captureSessionId === session.id;
  const workspaceCaptureStatus: CaptureStatus = captureBelongsToSession
    ? captureStatus
    : { state: "idle", sourceLabel: "", elapsedMs: 0, captureElapsedMs: 0, sourceElapsedMs: 0, phase: "waiting" };
  const workspaceLevels = captureBelongsToSession ? levels : { rms: 0, peak: 0 };
  const sessionCaptureState = workspaceCaptureStatus.state;
  const isRecording = captureBelongsToSession && (session.status === "recording" || sessionCaptureState === "recording");
  const canStart = captureBelongsToSession && !captureBusy && sessionCaptureState !== "recording" && sessionCaptureState !== "requesting" && sessionCaptureState !== "stopping" && session.status !== "discarded";
  const canStop = captureBelongsToSession && !captureBusy && (sessionCaptureState === "recording" || session.status === "recording");
  const counts = getTranscriptionCounts(segments);
  const durationMs = Math.max(session.duration_ms || 0, workspaceCaptureStatus.elapsedMs || 0, ...segments.map((segment) => segment.end_ms || 0));
  const completedSegments = segments.filter((segment) => segment.upload_status === "uploaded" && getTranscriptionStatus(segment) === "completed");
  const languageMode = getSessionLanguageMode(session);
  const languagePreferences = getManualLanguagePreferences(session);
  const detectedLanguages = aggregateDetectedLanguages(segments, session.detected_languages || []);
  const confidence = averageLanguageConfidence(completedSegments);
  const hasPrimaryOnlySignal = completedSegments.some((segment) => segment.detected_language && (segment.detected_languages || []).length <= 1);
  const detectionPending = isRecording || counts.pending > 0 || counts.active > 0 || segments.some((segment) => segment.upload_status === "pending");
  const reviewMode = session.review_mode || "standard";
  const inputMode: InputMode = session.input_mode || "browser_capture";
  const isAudioTranscription = inputMode === "audio_transcription";
  const audioSubmitLocked = typeof onAudioSubmit !== "function";
  const audioSubmitHandler = onAudioSubmit ?? (() => Promise.reject(new Error("Audio transcription submission is not connected on this page yet.")));
  const [selectedLineId, setSelectedLineId] = useState<string | undefined>();
  const livePulsarQa = useMemo(() => evaluatePulsarQa({ session, lines, segments, issues, annotations }, session.pulsar_qa_ran_at), [annotations, issues, lines, segments, session]);
  const livePulsarReadiness = useMemo(() => calculatePulsarReadiness({ session, lines, segments, qa: livePulsarQa }), [lines, livePulsarQa, segments, session]);
  const liveNoticeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { if (isRecording) liveNoticeRef.current?.focus(); }, [isRecording]);
  useEffect(() => { setSelectedLineId(undefined); }, [session.id]);
  useEffect(() => {
    if (selectedLineId && !lines.some((line) => line.id === selectedLineId)) setSelectedLineId(undefined);
  }, [lines, selectedLineId]);
  useEffect(() => {
    if (reviewMode === "pulsar_review" && session.pulsar_readiness === "ready" && livePulsarReadiness.state !== "ready") onReadinessInvalid();
  }, [livePulsarReadiness.state, onReadinessInvalid, reviewMode, session.pulsar_readiness]);

  return <div className="tx-workspace">
    <div className="tx-workspace-bar"><div><p className="tx-kicker">Active recording</p><h2 className="tx-workspace-title">{session.title || "Untitled session"}</h2><div className="tx-workspace-sub"><span className={`tx-status-pill status-${session.status}`}>{statusLabel(session.status)}</span><span className="tx-muted">{formatDuration(durationMs)}</span>{session.source_label && <span className="tx-muted">{session.source_label}</span>}</div></div><div className="tx-capture-actions">
      {!isAudioTranscription && canStart && <Button type="button" className="tx-btn-record" onClick={onStartCapture} disabled={captureBusy}><Disc className="h-4 w-4" />{session.status === "completed" || session.status === "failed" ? "Record again" : "Start capture"}</Button>}
      {!isAudioTranscription && canStop && <Button type="button" className="tx-btn-stop" onClick={onStopCapture} disabled={captureBusy}><CircleStop className="h-4 w-4" />Stop</Button>}
      {session.status !== "discarded" && <AlertDialog><AlertDialogTrigger asChild><Button type="button" variant="outline" className="tx-btn-ghost" size="sm"><Trash2 className="h-3.5 w-3.5" />Discard</Button></AlertDialogTrigger><AlertDialogContent className="tx-dialog"><AlertDialogHeader><AlertDialogTitle>Discard this recording?</AlertDialogTitle><AlertDialogDescription>The recording will leave your active workflow. Its audio clips and transcript lines remain available for reference.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep recording</AlertDialogCancel><AlertDialogAction onClick={onDiscard}>Discard</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>}
    </div></div>

    {!isAudioTranscription && <div className="tx-capture-notice" tabIndex={-1} ref={liveNoticeRef}><AlertCircle className="h-4 w-4 shrink-0 mt-0.5" /><div><p>Choose a <strong>Chrome tab</strong> and enable <strong>Share tab audio</strong>. Window or screen shares often have no audio track.</p><p>Only audio is kept. Video stops immediately after access. Each uploaded clip is transcribed with word timing and best-effort speaker separation.</p></div></div>}
    {session.error_summary && <div className="tx-error-banner" role="alert">{session.error_summary}</div>}
    {session.transcription_error_summary && <div className="tx-error-banner tx-transcription-error" role="alert">{session.transcription_error_summary}</div>}

    {isAudioTranscription && <div className={`tx-audio-transcription-shell ${audioSubmitLocked ? "is-submit-locked" : ""}`} aria-disabled={audioSubmitLocked} onClickCapture={(event) => {
      if (!audioSubmitLocked) return;
      const target = event.target;
      if (target instanceof Element && target.closest("section.tx-panel > .tx-field:last-child button")) {
        event.preventDefault();
        event.stopPropagation();
      }
    }} onKeyDownCapture={(event) => {
      if (!audioSubmitLocked || (event.key !== "Enter" && event.key !== " ")) return;
      const target = event.target;
      if (target instanceof Element && target.closest("section.tx-panel > .tx-field:last-child button")) {
        event.preventDefault();
        event.stopPropagation();
      }
    }}>
      <AudioTranscriptionPanel session={session} onMethodChange={(nextMode) => onSettingsChange({ review_mode: nextMode })} onSubmit={audioSubmitHandler} submitting={Boolean(audioSubmitting)} submitStatus={audioSubmitStatus} submitError={audioSubmitError} />
      {audioSubmitLocked && <p className="tx-audio-submit-note" role="status">Audio transcription is available for review here. Start transcription stays disabled until the submission action is connected.</p>}
    </div>}

    <div className="tx-transcription-strip">
      <div className="tx-transcription-summary"><div><span className="tx-kicker">Automatic audio transcript</span><strong>{counts.completed} of {counts.total} clips ready</strong></div><div className="tx-count-group"><span className="tx-queue-count state-pending">{counts.pending} waiting</span><span className="tx-queue-count state-active">{counts.active} working</span><span className="tx-queue-count state-failed">{counts.failed} failed</span></div></div>
      <div className="tx-transcription-actions">
        {counts.pending > 0 && <Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={onTranscribePending}><ListChecks className="h-3.5 w-3.5" />Transcribe pending</Button>}
        {counts.failed > 0 && <Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={onRetryFailed}><RotateCcw className="h-3.5 w-3.5" />Retry failed</Button>}
        {lines.some((line) => line.kind === "speech" && line.text?.trim()) && <Button type="button" size="sm" className="tx-btn-primary" onClick={onCleanTranscript} disabled={cleanupLoading}><Sparkles className="h-3.5 w-3.5" />{cleanupLoading ? "Preparing review…" : "Review cleanup"}</Button>}
      </div>

      <div className="tx-language-summary" aria-label="Language detection summary">
        <div className="tx-language-summary-head"><div><span className="tx-kicker">Language signal</span><strong>{languageModeLabel(languageMode)}</strong></div><span className="tx-language-confidence">{confidence != null ? formatConfidenceText(confidence) : "Confidence pending"}</span></div>
        <div className="tx-language-summary-body">
          <div className="tx-language-summary-row"><span className="tx-language-summary-label">Preferences</span>{languageMode === "manual" && languagePreferences.length ? <div className="tx-language-chips">{languagePreferences.map((language) => <span key={language} className="tx-language-chip is-preference">{language}</span>)}</div> : <span className="tx-language-summary-value">{languageMode === "manual" ? "Add one or more language hints in Session settings." : "Provider detection is on for every uploaded clip."}</span>}</div>
          <div className="tx-language-summary-row"><span className="tx-language-summary-label">Detected</span>{detectedLanguages.length ? <div className="tx-language-chips">{detectedLanguages.map((language) => <span key={language} className="tx-language-chip">{formatLanguageList([language])}</span>)}</div> : <span className="tx-language-summary-value">{detectionPending ? "Detecting as clips finish…" : completedSegments.length ? "No provider language label was returned." : "No completed audio clips yet."}</span>}</div>
        </div>
        {hasPrimaryOnlySignal && <p className="tx-language-note">The provider returned a primary language for one or more clips. Per-word language labels appear only when the provider supplies them.</p>}
      </div>
      <p className="tx-help">Full verbatim keeps speech as spoken. Clean verbatim removes only non-meaningful disfluencies. Every speech range uses the full recording offset, never a clip reset.</p>
    </div>

    {session.session_mode === "translation" && <TranslationPanel session={session} segments={segments} lines={lines} />}

    {reviewMode === "pulsar_review" && <PulsarReviewPanel session={session} lines={lines} segments={segments} qa={livePulsarQa} readiness={livePulsarReadiness} selectedLineId={selectedLineId} onSelectLine={setSelectedLineId} onInsertTag={onInsertPulsarTag} onRunQA={onRunPulsarQA} onExport={onExportPulsar} onSetReadiness={onSetPulsarReadiness} />}

    <div className="tx-workspace-grid"><div className="tx-col-main"><TranscriptEditor session={session} lines={lines} segments={segments} elapsedMs={workspaceCaptureStatus.elapsedMs || durationMs} selectedLineId={reviewMode === "pulsar_review" ? selectedLineId : undefined} onSelectLine={reviewMode === "pulsar_review" ? setSelectedLineId : undefined} onAddSpeech={onAddSpeech} onAddMarker={onAddMarker} onAddTimestamp={onAddTimestamp} onAddUnclear={onAddUnclear} onUpdateLine={onUpdateLine} onSplitLine={onSplitLine} onDeleteLine={onDeleteLine} onSpeakerUsed={onSpeakerUsed} onAddCustomSpeaker={onAddCustomSpeaker} /><TimelineAnnotations durationMs={durationMs} annotations={annotations} segments={segments} lines={lines} onCreateAnnotation={onCreateAnnotation} onUpdateAnnotation={onUpdateAnnotation} onDeleteAnnotation={onDeleteAnnotation} /><FormattedPreview title={session.title || "Untitled session"} lines={lines} annotations={annotations} style={(session.transcript_style as TranscriptStyle) || "full_verbatim"} cadence={session.timestamp_cadence || "speaker_change"} durationMs={durationMs} languageMode={languageMode} manualLanguages={languagePreferences} detectedLanguages={detectedLanguages} accentHint={session.accent_hint} /></div><div className="tx-col-side"><WaveformMonitor ref={canvasRef} status={workspaceCaptureStatus} levels={workspaceLevels} /><SessionSettings session={session} saving={settingsSaving} customGuidelineSaving={customGuidelineSaving} onChange={onSettingsChange} onCustomGuidelineChange={onCustomGuidelineChange} /><SegmentList segments={segments} busyIds={transcriptionBusyIds} onTranscribe={onTranscribeSegment} pulsarReview={reviewMode === "pulsar_review"} onPulsarStatusChange={onPulsarStatusChange} /><IssueLog issues={issues} /></div></div>
    <TranscriptionCleanupDialog open={cleanupOpen} busy={cleanupLoading} proposals={cleanupProposals} onOpenChange={onCleanupOpenChange} onApply={onApplyCleanup} />
  </div>;
}
