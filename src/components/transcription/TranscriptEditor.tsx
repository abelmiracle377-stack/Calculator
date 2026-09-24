import { useEffect, useRef, useState } from "react";
import { AlertCircle, BadgeCheck, BookmarkPlus, Clock, Languages, Plus, Scissors, Trash2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { defaultSpeakers, formatExportTimestampTag, formatLineTimestampRange } from "@/lib/transcription/format";
import { detectedLanguagesForSegment, formatConfidenceText, formatLanguageList } from "@/lib/transcription/transcription";
import type { AudioSegmentRecord, SpeakerScheme, TranscriptLineRecord, TranscriptionSessionRecord, UnclearMarkerKind } from "@/lib/transcription/types";

interface TranscriptEditorProps {
  session: TranscriptionSessionRecord;
  lines: TranscriptLineRecord[];
  segments: AudioSegmentRecord[];
  elapsedMs: number;
  onAddSpeech: () => void;
  onAddMarker: () => void;
  onAddTimestamp: () => void;
  onAddUnclear: (kind: UnclearMarkerKind) => void;
  onUpdateLine: (id: string, patch: Partial<TranscriptLineRecord>) => void;
  onSplitLine: (id: string, cursor: number) => void;
  onDeleteLine: (id: string) => void;
  onSpeakerUsed: (label: string) => void;
  onAddCustomSpeaker: (label: string) => void;
  selectedLineId?: string;
  onSelectLine?: (id: string) => void;
}

export function TranscriptEditor({
  session, lines, segments, elapsedMs, onAddSpeech, onAddMarker, onAddTimestamp, onAddUnclear,
  onUpdateLine, onSplitLine, onDeleteLine, onSpeakerUsed, onAddCustomSpeaker, selectedLineId, onSelectLine,
}: TranscriptEditorProps) {
  const sorted = [...lines].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const speakers = defaultSpeakers(session.speaker_scheme as SpeakerScheme, session.custom_speakers);
  const [customDraft, setCustomDraft] = useState("");
  const cursorMap = useRef<Record<string, number>>({});
  const lineRefs = useRef<Record<string, HTMLElement | null>>({});
  const segmentsById = new Map(segments.map((segment) => [segment.id, segment]));
  const shownLanguageSegments = new Set<string>();

  useEffect(() => {
    if (!selectedLineId) return;
    const lineNode = lineRefs.current[selectedLineId];
    if (lineNode) lineNode.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [selectedLineId]);

  return (
    <section className="tx-editor" aria-label="Audio transcript editor">
      <div className="tx-editor-head">
        <div>
          <p className="tx-kicker">Editable audio record</p>
          <h2>Transcript</h2>
          <p className="tx-help">Generated lines keep provider wording and full-recording timing until you edit them. Manual lines use the same review controls.</p>
        </div>
        <div className="tx-editor-actions">
          <Button type="button" size="sm" className="tx-btn-primary" onClick={onAddSpeech}><Plus className="h-3.5 w-3.5" />Line</Button>
          <Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={onAddMarker}><BookmarkPlus className="h-3.5 w-3.5" />Marker</Button>
          <Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={onAddTimestamp}><Clock className="h-3.5 w-3.5" />Timestamp</Button>
        </div>
      </div>
      <div className="tx-diarization-note"><BadgeCheck className="h-4 w-4 shrink-0" /><span>Speaker separation is best-effort, especially when voices overlap. Change any label below, use a role or name, or add ? before an uncertain label.</span></div>

      <div className="tx-unclear-tools">
        <div><p className="tx-unclear-title">Mark unclear audio</p><p className="tx-help">Insert a tag only when you hear the problem. Low confidence never creates one automatically.</p></div>
        <div className="tx-unclear-actions">
          <Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={() => onAddUnclear("inaudible")}><VolumeX className="h-3.5 w-3.5" />Inaudible</Button>
          <Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={() => onAddUnclear("unintelligible")}><AlertCircle className="h-3.5 w-3.5" />Unintelligible</Button>
        </div>
      </div>

      {session.speaker_scheme === "custom" && <div className="tx-custom-speaker-row">
        <Input value={customDraft} onChange={(event) => setCustomDraft(event.target.value)} placeholder="Add a speaker label" className="tx-input" onKeyDown={(event) => { if (event.key === "Enter" && customDraft.trim()) { onAddCustomSpeaker(customDraft.trim()); setCustomDraft(""); } }} />
        <Button type="button" size="sm" variant="outline" className="tx-btn-ghost" disabled={!customDraft.trim()} onClick={() => { onAddCustomSpeaker(customDraft.trim()); setCustomDraft(""); }}>Add speaker</Button>
      </div>}

      <div className="tx-line-list">
        {sorted.length === 0 && <div className="tx-empty-editor"><p>No transcript lines yet.</p><p className="tx-help">Transcribe an uploaded clip, or add a line while listening. New speech defaults to <strong>{session.last_speaker || speakers[0]}</strong>.</p></div>}
        {sorted.map((line) => {
          const generated = line.origin === "generated";
          const selected = selectedLineId === line.id;
          const confidence = line.confidence != null ? Math.round(line.confidence * 100) : null;
          const lineRange = formatLineTimestampRange(line);
          const sourceSegment = line.source_segment_id ? segmentsById.get(line.source_segment_id) : undefined;
          const lineLanguages = generated ? detectedLanguagesForSegment(sourceSegment) : [];
          const showLanguageContext = Boolean(line.source_segment_id && lineLanguages.length && !shownLanguageSegments.has(line.source_segment_id));
          if (showLanguageContext && line.source_segment_id) shownLanguageSegments.add(line.source_segment_id);
          return <article key={line.id} ref={onSelectLine ? (node) => { lineRefs.current[line.id] = node; } : undefined} className={`tx-line-row kind-${line.kind} ${generated ? "is-generated" : ""} ${selected ? "is-pulsar-selected" : ""}`}>
            <div className="tx-line-rail">
              {onSelectLine && <button type="button" className={`tx-line-select ${selected ? "is-selected" : ""}`} aria-pressed={selected} onClick={() => onSelectLine(line.id)}>{selected ? "Selected" : "Select line"}</button>}
              <span className="tx-line-seq">{line.sequence + 1}</span>
              <span className="tx-line-kind">{line.kind}</span>
              {line.start_ms != null && <span className="tx-line-time">{line.kind === "speech" ? lineRange : formatExportTimestampTag(line.start_ms)}</span>}
              <span className={`tx-origin-badge ${generated ? "is-generated" : "is-manual"}`}>{generated ? "Auto" : "Manual"}</span>
              {confidence != null && generated && <span className="tx-confidence">{confidence}%</span>}
              {showLanguageContext && sourceSegment && <span className="tx-line-language" title={`Provider detected ${formatLanguageList(lineLanguages)}${sourceSegment.language_probability != null ? `, ${formatConfidenceText(sourceSegment.language_probability)}` : ""}`}><Languages className="h-3 w-3" />{formatLanguageList(lineLanguages)}</span>}
            </div>
            <div className="tx-line-body">
              {line.kind === "speech" && <div className="tx-speaker-row tx-line-header">
                <span className="tx-line-range">{lineRange || "[No timing]"}</span>
                <Select value={line.speaker_label || speakers[0]} onValueChange={(value) => { onUpdateLine(line.id, { speaker_label: value }); onSpeakerUsed(value); }}>
                  <SelectTrigger className="tx-speaker-select" aria-label={`Speaker label for line ${line.sequence + 1}`}><SelectValue /></SelectTrigger>
                  <SelectContent>{Array.from(new Set([...speakers, line.speaker_label || "", session.last_speaker || ""].filter(Boolean))).map((speaker) => <SelectItem key={speaker} value={speaker}>{speaker}</SelectItem>)}</SelectContent>
                </Select>
              </div>}
              {line.kind === "speech" && <Input className="tx-input tx-speaker-custom" placeholder="Or type a label" defaultValue="" onBlur={(event) => { const value = event.target.value.trim(); if (!value) return; onUpdateLine(line.id, { speaker_label: value }); onSpeakerUsed(value); if (session.speaker_scheme === "custom") onAddCustomSpeaker(value); event.target.value = ""; }} onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }} />}
              <Textarea className="tx-line-text" value={line.text || ""} rows={line.kind === "speech" ? 2 : 1} placeholder={line.kind === "speech" ? "Type what you hear…" : line.kind === "marker" ? "Marker label" : "Optional note"} onChange={(event) => onUpdateLine(line.id, { text: event.target.value })} onSelect={(event) => { cursorMap.current[line.id] = (event.target as HTMLTextAreaElement).selectionStart ?? 0; }} onKeyUp={(event) => { cursorMap.current[line.id] = (event.target as HTMLTextAreaElement).selectionStart ?? 0; }} onClick={(event) => { cursorMap.current[line.id] = (event.target as HTMLTextAreaElement).selectionStart ?? 0; }} />
              {line.cleanup_applied && <p className="tx-line-history">Reviewed cleanup applied. Original text remains stored for reference.</p>}
              {line.kind === "speech" && <div className="tx-line-timing">
                <label>Start <Input type="number" min={0} className="tx-input tx-time-input" value={line.start_ms ?? ""} placeholder="ms" onChange={(event) => onUpdateLine(line.id, { start_ms: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
                <label>End <Input type="number" min={0} className="tx-input tx-time-input" value={line.end_ms ?? ""} placeholder="ms" onChange={(event) => onUpdateLine(line.id, { end_ms: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
                <Button type="button" size="sm" variant="outline" className="tx-btn-ghost" title="Use current elapsed time as start" onClick={() => onUpdateLine(line.id, { start_ms: Math.round(elapsedMs) })}>Set start now</Button>
              </div>}
            </div>
            <div className="tx-line-tools">
              {line.kind === "speech" && <Button type="button" size="icon" variant="ghost" className="tx-icon-btn" title="Split at cursor" onClick={() => onSplitLine(line.id, cursorMap.current[line.id] ?? (line.text || "").length)}><Scissors className="h-4 w-4" /></Button>}
              <Button type="button" size="icon" variant="ghost" className="tx-icon-btn is-danger" title="Delete line" onClick={() => onDeleteLine(line.id)}><Trash2 className="h-4 w-4" /></Button>
            </div>
          </article>;
        })}
      </div>
    </section>
  );
}
