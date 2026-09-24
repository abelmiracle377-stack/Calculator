import { Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  buildPlainTextExport,
  buildPreviewRows,
  linePreviewParts,
} from "@/lib/transcription/format";
import { formatLanguageList, languageModeLabel, timestampCadenceLabel } from "@/lib/transcription/transcription";
import type { LanguageMode, TranscriptAnnotationRecord, TranscriptLineRecord, TranscriptStyle, TimestampCadence } from "@/lib/transcription/types";

interface FormattedPreviewProps {
  title: string;
  lines: TranscriptLineRecord[];
  annotations: TranscriptAnnotationRecord[];
  style: TranscriptStyle;
  cadence: TimestampCadence;
  durationMs: number;
  languageMode: LanguageMode;
  manualLanguages: string[];
  detectedLanguages: string[];
  accentHint?: string;
}

const WHOLE_TIMESTAMP = /\[(?:\d{2}:){2}\d{2}\]/;

function renderAnnotationText(text: string) {
  return text.split(/(\[(?:\d{2}:){2}\d{2}\])/g).map((part, index) =>
    WHOLE_TIMESTAMP.test(part)
      ? <strong key={`${part}-${index}`} className="tx-preview-timestamp">{part}</strong>
      : <span key={`${part}-${index}`}>{part}</span>
  );
}

function PreviewRow({ row, style }: { row: ReturnType<typeof buildPreviewRows>[number]; style: TranscriptStyle }) {
  if (row.kind === "timestamp") return <><strong className="tx-preview-timestamp">{row.text}</strong></>;
  if (row.kind === "annotation") return <>{renderAnnotationText(row.text)}</>;
  if (row.line?.kind === "speech") {
    const parts = linePreviewParts(row.line, style);
    return <>{parts.timing && <strong className="tx-preview-range">{parts.timing}</strong>} <strong className="tx-preview-speaker">{parts.speaker}:</strong> <span>{parts.text}</span></>;
  }
  if (row.line?.kind === "marker") {
    const parts = linePreviewParts(row.line, style);
    return <>{parts.timing && <strong className="tx-preview-timestamp">{parts.timing}</strong>}{parts.timing && " "}<span>{parts.text}</span></>;
  }
  return <span>{row.text}</span>;
}

export function FormattedPreview({ title, lines, annotations, style, cadence, durationMs, languageMode, manualLanguages, detectedLanguages, accentHint }: FormattedPreviewProps) {
  const rows = buildPreviewRows(lines, annotations, style, cadence, durationMs);
  const download = () => {
    const text = buildPlainTextExport(lines, style, title, annotations, cadence, durationMs);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${(title || "transcript").replace(/[^a-z0-9-_]+/gi, "_").slice(0, 60)}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="tx-panel tx-preview" aria-label="Formatted audio transcript preview">
      <div className="tx-panel-head">
        <div>
          <p className="tx-kicker">Output check</p>
          <h3>Formatted preview</h3>
          <p className="tx-help">{style === "clean_verbatim" ? "Clean verbatim removes only non-meaningful disfluencies and expands listed slang in this view. The stored full-verbatim text stays unchanged." : "Full verbatim keeps the words as spoken, including fillers, false starts, repetitions, stutters, contractions, and provider event tags."}</p>
        </div>
        <Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={download}><Download className="h-3.5 w-3.5" />Download .txt</Button>
      </div>
      <div className="tx-preview-standard"><strong>{style === "clean_verbatim" ? "Clean verbatim" : "Full verbatim"}</strong><span>{timestampCadenceLabel(cadence)}. Speech ranges use the full recording, including across clip boundaries.</span></div>
      <div className="tx-preview-context" aria-label="Transcript language context">
        <span className="tx-preview-context-label">Language context</span>
        <span className="tx-preview-context-value">{languageModeLabel(languageMode)}{manualLanguages.length ? `: ${manualLanguages.join(", ")}` : ""}</span>
        {detectedLanguages.length > 0 && <span className="tx-preview-context-value">Detected: {formatLanguageList(detectedLanguages)}</span>}
        {accentHint?.trim() && <span className="tx-preview-context-value">Accent or dialect context provided: {accentHint.trim()}</span>}
      </div>
      <div className="tx-preview-body">
        {rows.length === 0 ? <div className="tx-preview-empty"><FileText className="h-6 w-6" /><p>Add transcript lines or timeline sections to see the export.</p></div> : rows.map((row) => <p key={row.key} className={`tx-preview-line kind-${row.kind}`}><PreviewRow row={row} style={style} /></p>)}
      </div>
      <p className="tx-phase-note">The download is plain text, so bold styling is unavailable. It still keeps every bracketed timestamp mark and speaker label exactly visible. Review the transcript before delivery.</p>
    </section>
  );
}

