import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleAlert, Download, LocateFixed, LockKeyhole, Play, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PULSAR_TAG_CATEGORIES, PULSAR_TAG_VOCABULARY } from "@/lib/transcription/pulsar";
import type { AudioSegmentRecord, PulsarQaFinding, PulsarQaResult, PulsarReadiness, PulsarReadinessResult, PulsarTagDefinition, TranscriptionSessionRecord, TranscriptLineRecord } from "@/lib/transcription/types";

interface PulsarReviewPanelProps {
  session: TranscriptionSessionRecord;
  lines: TranscriptLineRecord[];
  segments: AudioSegmentRecord[];
  qa: PulsarQaResult;
  readiness: PulsarReadinessResult;
  selectedLineId?: string;
  onSelectLine: (id: string) => void;
  onInsertTag: (lineId: string, tag: PulsarTagDefinition) => void;
  onRunQA: () => void | Promise<void>;
  onExport: () => void | Promise<void>;
  onSetReadiness: (state: PulsarReadiness) => void | Promise<void>;
}

function FindingIcon({ severity }: { severity: PulsarQaFinding["severity"] }) {
  if (severity === "error") return <XCircle className="h-4 w-4" aria-hidden="true" />;
  if (severity === "warning") return <AlertTriangle className="h-4 w-4" aria-hidden="true" />;
  return <CheckCircle2 className="h-4 w-4" aria-hidden="true" />;
}

function readinessLabel(state: PulsarReadiness) {
  if (state === "ready") return "Ready locally";
  if (state === "in_progress") return "Review in progress";
  return "Not started";
}

function lineSnippet(line: TranscriptLineRecord) {
  const text = (line.text || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 58) : "(empty line)";
}

export function PulsarReviewPanel({ session, lines, segments, qa, readiness, selectedLineId, onSelectLine, onInsertTag, onRunQA, onExport, onSetReadiness }: PulsarReviewPanelProps) {
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const speechLines = useMemo(() => [...lines].filter((line) => line.kind === "speech").sort((a, b) => a.sequence - b.sequence), [lines]);
  const uploadedCount = segments.filter((segment) => segment.upload_status === "uploaded").length;
  const selectedTagLine = speechLines.some((line) => line.id === selectedLineId) ? selectedLineId : "";
  const hasErrors = readiness.blockers.length > 0;
  const runQA = async () => { setRunning(true); try { await onRunQA(); } finally { setRunning(false); } };
  const exportPackage = async () => { setExporting(true); try { await onExport(); } finally { setExporting(false); } };

  return (
    <section className="tx-panel tx-pulsar-panel" aria-label="Pulsar Review workflow">
      <div className="tx-pulsar-header">
        <div>
          <div className="tx-pulsar-eyebrow"><span className="tx-kicker">Opt-in review workflow</span><span className="tx-pulsar-version">Pulsar Review</span></div>
          <h2 className="tx-pulsar-title">Prepare this transcript for Pulsar rules</h2>
          <p className="tx-help">This first slice reviews the grouped lines already in Verbatim Desk. It keeps Full Verbatim, Clean Verbatim, audio timing, and the existing editor intact. Word-level editing is not part of this workflow yet.</p>
        </div>
        <span className="tx-pulsar-local-badge"><LockKeyhole className="h-3.5 w-3.5" />Local only</span>
      </div>
      <div className="tx-pulsar-scope-note">No Labelbox or Vercel task is loaded or submitted. The JSON action below downloads a local review package from this browser.</div>

      <div className="tx-pulsar-overview">
        <div className="tx-pulsar-card tx-pulsar-progress-card">
          <div className="tx-pulsar-card-head"><div><span className="tx-kicker">Clip review</span><strong>{readiness.reviewed_clip_count} of {readiness.uploaded_clip_count} uploaded clips reviewed</strong></div><span className="tx-pulsar-progress-value">{readiness.progress_percent}%</span></div>
          <div className="tx-pulsar-progress-track" role="progressbar" aria-label="Pulsar clip review progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={readiness.progress_percent}><span style={{ width: `${readiness.progress_percent}%` }} /></div>
          <p className="tx-help">{uploadedCount ? "Mark each uploaded clip reviewed after checking its audio, source timing, and transcript." : "Upload and transcribe an audio clip before starting clip review."}</p>
        </div>
        <div className="tx-pulsar-card">
          <div className="tx-pulsar-card-head"><div><span className="tx-kicker">Local QA</span><strong>{qa.ran_at ? `Last run ${new Date(qa.ran_at).toLocaleString()}` : "QA has not run yet"}</strong></div><span className={`tx-pulsar-qa-state ${!qa.ran_at ? "is-pending" : qa.summary.errors ? "is-error" : qa.summary.warnings ? "is-warning" : "is-pass"}`}>{!qa.ran_at ? "Awaiting QA" : qa.summary.errors ? "Needs fixes" : qa.summary.warnings ? "Review warnings" : "Pass"}</span></div>
          <div className="tx-pulsar-qa-stats" aria-live="polite"><span className="is-error"><XCircle className="h-3.5 w-3.5" />{qa.summary.errors} errors</span><span className="is-warning"><AlertTriangle className="h-3.5 w-3.5" />{qa.summary.warnings} warnings</span><span className="is-pass"><CheckCircle2 className="h-3.5 w-3.5" />{qa.summary.infos} notes</span></div>
          <Button type="button" size="sm" className="tx-btn-primary tx-pulsar-action-button" onClick={() => void runQA()} disabled={running}><Play className="h-3.5 w-3.5" />{running ? "Running QA…" : "Run QA"}</Button>
        </div>
      </div>

      <div className="tx-pulsar-readiness">
        <div className="tx-pulsar-readiness-copy"><span className="tx-kicker">Local completion</span><strong>{readinessLabel(readiness.state)}</strong><p className="tx-help">Ready means the local prerequisites pass and every uploaded clip is marked reviewed. It does not submit or publish anything.</p></div>
        <div className="tx-pulsar-readiness-actions">
          {readiness.state === "ready" ? <Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={() => void onSetReadiness("in_progress")}><RotateCcw className="h-3.5 w-3.5" />Reopen readiness</Button> : <Button type="button" size="sm" className="tx-btn-primary" disabled={!readiness.eligible || hasErrors} onClick={() => void onSetReadiness("ready")}><CheckCircle2 className="h-3.5 w-3.5" />Mark session ready</Button>}
          <Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={() => void exportPackage()} disabled={exporting}><Download className="h-3.5 w-3.5" />{exporting ? "Preparing JSON…" : "Download local JSON"}</Button>
        </div>
        {readiness.blockers.length > 0 && <ul className="tx-pulsar-blockers" aria-label="Local readiness blockers">{readiness.blockers.slice(0, 5).map((blocker) => <li key={blocker.id}><CircleAlert className="h-3.5 w-3.5" />{blocker.message}</li>)}{readiness.blockers.length > 5 && <li>+ {readiness.blockers.length - 5} more finding{readiness.blockers.length - 5 === 1 ? "" : "s"}</li>}</ul>}
      </div>

      <div className="tx-pulsar-tag-helper">
        <div className="tx-pulsar-card-head"><div><span className="tx-kicker">Tag helper</span><strong>Add a supported Pulsar tag to a grouped line</strong></div></div>
        <p className="tx-help">Choose a speech line, then insert a tag. Existing text stays in place. Wrappers use the line text as their current grouped-line selection. Review and adjust placement in the editor below.</p>
        {speechLines.length ? <div className="tx-pulsar-line-picker"><label htmlFor={`pulsar-line-${session.id}`}>Selected transcript line</label><select id={`pulsar-line-${session.id}`} className="tx-input" value={selectedTagLine} onChange={(event) => onSelectLine(event.target.value)}><option value="" disabled>Choose a speech line</option>{speechLines.map((line) => <option key={line.id} value={line.id}>#{line.sequence + 1} · {line.speaker_label || "No speaker"} · {lineSnippet(line)}</option>)}</select></div> : <p className="tx-pulsar-empty">No speech lines are available yet. Transcribe a clip or add a line in the existing editor.</p>}
        <div className="tx-pulsar-tag-groups">{PULSAR_TAG_CATEGORIES.map((category) => { const tags = PULSAR_TAG_VOCABULARY.filter((tag) => tag.category === category.key); return <div key={category.key} className="tx-pulsar-tag-category"><div className="tx-pulsar-tag-category-head"><span>{category.label}</span>{category.key === "discard" && <small>alone only</small>}</div><div className="tx-pulsar-tag-list">{tags.map((tag) => <button key={tag.insertionValue} type="button" className="tx-pulsar-tag-button" disabled={!selectedTagLine} onClick={() => selectedTagLine && onInsertTag(selectedTagLine, tag)} title={tag.placementGuidance}><code>{tag.insertionValue}</code><span>{tag.displayLabel}</span></button>)}</div></div>; })}</div>
      </div>

      <div className="tx-pulsar-findings">
        <div className="tx-pulsar-card-head"><div><span className="tx-kicker">Findings</span><strong>{qa.findings.length ? "Review each local QA finding" : "No findings"}</strong></div><span className="tx-muted">{qa.summary.total} total</span></div>
        {qa.findings.length ? <ul>{qa.findings.map((finding) => { const line = finding.line_id ? lines.find((item) => item.id === finding.line_id) : undefined; const segment = finding.segment_id ? segments.find((item) => item.id === finding.segment_id) : undefined; return <li key={finding.id} className={`tx-pulsar-finding severity-${finding.severity}`}><div className="tx-pulsar-finding-top"><span className="tx-pulsar-finding-severity"><FindingIcon severity={finding.severity} />{finding.severity}</span><span className="tx-pulsar-finding-code">{finding.code}</span>{line && <span>Line {line.sequence + 1}</span>}{segment && <span>Clip {segment.sequence + 1}</span>}</div><p>{finding.message}</p>{line && <button type="button" className="tx-pulsar-finding-action" onClick={() => onSelectLine(line.id)}><LocateFixed className="h-3.5 w-3.5" />Locate line {line.sequence + 1}</button>}</li>; })}</ul> : <p className="tx-pulsar-empty">Run QA after editing to refresh this list. Findings never change transcript text automatically.</p>}
      </div>
    </section>
  );
}
