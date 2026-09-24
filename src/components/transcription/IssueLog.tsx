import { AlertTriangle } from "lucide-react";
import { formatIssueTimestampRange, issueLabel } from "@/lib/transcription/format";
import type { AudioIssueRecord } from "@/lib/transcription/types";

interface IssueLogProps {
  issues: AudioIssueRecord[];
}

function issueSourceLabel(issue: AudioIssueRecord): { label: string; possible: boolean } {
  const possible = Boolean(issue.possible || issue.kind.startsWith("possible_"));
  const source = issue.source === "provider"
    ? "Provider"
    : issue.source === "recorder"
      ? "Recorder"
      : issue.source === "vad"
        ? "VAD / local"
        : "Source";
  return { label: possible ? `Possible finding · ${source}` : source, possible };
}

export function IssueLog({ issues }: IssueLogProps) {
  const sorted = [...issues].sort((a, b) => b.timestamp_ms - a.timestamp_ms);

  return (
    <section className="tx-panel" aria-label="Issue log">
      <div className="tx-panel-head">
        <h3>
          <AlertTriangle className="h-4 w-4 inline mr-1.5 opacity-70" />
          Issues
        </h3>
        <span className="tx-count-chip">{sorted.length}</span>
      </div>

      {sorted.length === 0 ? (
        <p className="tx-help">
          Preserved silence stays on the source timeline. Possible local signal findings, provider events, recorder interruptions, and upload problems show up here when detected. Editing stays available either way.
        </p>
      ) : (
        <ul className="tx-issue-list">
          {sorted.map((issue) => {
            const source = issueSourceLabel(issue);
            return (
              <li key={issue.id} className={`tx-issue severity-${issue.severity}`}>
                <div className="tx-issue-top">
                  <div className="tx-issue-heading">
                    <span className="tx-issue-kind">{issueLabel(issue.kind)}</span>
                    <span className={`tx-issue-source ${source.possible ? "is-possible" : ""}`}>
                      {source.label}
                    </span>
                  </div>
                  <span className="tx-issue-time">
                    {formatIssueTimestampRange(issue.timestamp_ms, issue.end_timestamp_ms)}
                  </span>
                </div>
                <p>{issue.notes}</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
