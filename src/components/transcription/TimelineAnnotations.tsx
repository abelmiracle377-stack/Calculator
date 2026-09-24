import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight, GripHorizontal, Maximize2, Plus, Trash2 } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatTimestampTag } from "@/lib/transcription/format";
import type {
  AudioSegmentRecord,
  TranscriptAnnotationRecord,
  TranscriptLineRecord,
} from "@/lib/transcription/types";

export type AnnotationDraft = Pick<
  TranscriptAnnotationRecord,
  "start_ms" | "end_ms" | "label" | "notes" | "color" | "category"
>;

type DragMode = "move" | "resize-start" | "resize-end";
type Selection = { anchor: number; current: number };
type ActiveDrag = {
  id: string;
  mode: DragMode;
  startX: number;
  originalStart: number;
  originalEnd: number;
  previewStart: number;
  previewEnd: number;
};

interface TimelineAnnotationsProps {
  durationMs: number;
  annotations: TranscriptAnnotationRecord[];
  segments: AudioSegmentRecord[];
  lines: TranscriptLineRecord[];
  onCreateAnnotation: (draft: AnnotationDraft) => void | Promise<void>;
  onUpdateAnnotation: (id: string, patch: Partial<AnnotationDraft>) => void | Promise<void>;
  onDeleteAnnotation: (id: string) => void | Promise<void>;
}

const COLORS = ["coral", "mint", "amber", "violet"];
const MIN_RANGE_MS = 100;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function orderedRange(a: number, b: number, duration: number) {
  const safeDuration = Math.max(0, duration);
  const start = clamp(Math.min(a, b), 0, safeDuration);
  const end = clamp(Math.max(a, b), 0, safeDuration);
  const minimumEnd = Math.min(safeDuration, start + MIN_RANGE_MS);
  return { start_ms: start, end_ms: Math.max(start, end, minimumEnd) };
}

function percent(value: number, duration: number) {
  return duration > 0 ? `${(clamp(value, 0, duration) / duration) * 100}%` : "0%";
}

export function TimelineAnnotations({
  durationMs,
  annotations,
  segments,
  lines,
  onCreateAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
}: TimelineAnnotationsProps) {
  const duration = Math.max(0, durationMs || 0);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [draftRange, setDraftRange] = useState<{ start_ms: number; end_ms: number } | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftNotes, setDraftNotes] = useState("");
  const [draftColor, setDraftColor] = useState("coral");
  const [draftCategory, setDraftCategory] = useState("note");
  const [fallbackStart, setFallbackStart] = useState(0);
  const [fallbackEnd, setFallbackEnd] = useState(Math.max(0, duration));
  const [drafts, setDrafts] = useState<Record<string, { label: string; notes: string }>>({});
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);

  useEffect(() => {
    setFallbackEnd((current) => clamp(current || duration, 0, duration));
  }, [duration]);

  const sortedAnnotations = useMemo(
    () => [...annotations].sort((a, b) => (a.start_ms - b.start_ms) || (a.sequence - b.sequence)),
    [annotations]
  );

  const positionToMs = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || duration <= 0) return 0;
    return clamp(((clientX - rect.left) / rect.width) * duration, 0, duration);
  };

  useEffect(() => {
    if (!selection && !activeDrag) return;
    const onPointerMove = (event: globalThis.PointerEvent) => {
      if (selection) {
        setSelection((current) => current ? { ...current, current: positionToMs(event.clientX) } : current);
      }
      if (activeDrag) {
        const delta = positionToMs(event.clientX) - positionToMs(activeDrag.startX);
        let start = activeDrag.originalStart;
        let end = activeDrag.originalEnd;
        if (activeDrag.mode === "move") {
          const width = activeDrag.originalEnd - activeDrag.originalStart;
          start = clamp(activeDrag.originalStart + delta, 0, Math.max(0, duration - width));
          end = start + width;
        } else if (activeDrag.mode === "resize-start") {
          start = clamp(activeDrag.originalStart + delta, 0, Math.max(0, end - MIN_RANGE_MS));
        } else {
          end = clamp(activeDrag.originalEnd + delta, Math.min(duration, start + MIN_RANGE_MS), duration);
        }
        setActiveDrag((current) => current ? { ...current, previewStart: start, previewEnd: end } : current);
      }
    };
    const onPointerUp = () => {
      if (selection) {
        const range = orderedRange(selection.anchor, selection.current, duration);
        setSelection(null);
        if (duration > 0 && range.end_ms - range.start_ms >= MIN_RANGE_MS) setDraftRange(range);
      }
      if (activeDrag) {
        const current = sortedAnnotations.find((annotation) => annotation.id === activeDrag.id);
        if (current) {
          void onUpdateAnnotation(activeDrag.id, {
            start_ms: Math.round(activeDrag.previewStart),
            end_ms: Math.round(activeDrag.previewEnd),
          });
        }
        setActiveDrag(null);
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [selection, activeDrag, duration, sortedAnnotations, onUpdateAnnotation]);

  const startSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (duration <= 0 || event.button !== 0) return;
    const value = positionToMs(event.clientX);
    setDraftRange(null);
    setSelection({ anchor: value, current: value });
  };

  const startExistingDrag = (
    event: ReactPointerEvent<HTMLElement>,
    annotation: TranscriptAnnotationRecord,
    mode: DragMode
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setActiveDrag({
      id: annotation.id,
      mode,
      startX: event.clientX,
      originalStart: annotation.start_ms,
      originalEnd: annotation.end_ms,
      previewStart: annotation.start_ms,
      previewEnd: annotation.end_ms,
    });
  };

  const saveDraft = async () => {
    if (!draftRange || !draftLabel.trim()) return;
    await onCreateAnnotation({
      ...draftRange,
      label: draftLabel.trim(),
      notes: draftNotes.trim(),
      color: draftColor,
      category: draftCategory,
    });
    setDraftRange(null);
    setDraftLabel("");
    setDraftNotes("");
  };

  const setFallbackRange = () => {
    if (duration <= 0) return;
    const range = orderedRange(fallbackStart, fallbackEnd, duration);
    if (range.end_ms - range.start_ms >= MIN_RANGE_MS) setDraftRange(range);
  };

  const nudge = (annotation: TranscriptAnnotationRecord, mode: DragMode, amount: number) => {
    const width = annotation.end_ms - annotation.start_ms;
    let start = annotation.start_ms;
    let end = annotation.end_ms;
    if (mode === "move") {
      start = clamp(start + amount, 0, Math.max(0, duration - width));
      end = start + width;
    } else if (mode === "resize-start") {
      start = clamp(start + amount, 0, Math.max(0, end - MIN_RANGE_MS));
    } else {
      end = clamp(end + amount, Math.min(duration, start + MIN_RANGE_MS), duration);
    }
    void onUpdateAnnotation(annotation.id, { start_ms: Math.round(start), end_ms: Math.round(end) });
  };

  return (
    <section className="tx-panel tx-timeline-panel" aria-label="Timeline annotations">
      <div className="tx-panel-head">
        <div>
          <p className="tx-kicker">Mark the recording</p>
          <h3>Timeline annotations</h3>
        </div>
        <span className="tx-count-chip">{annotations.length} {annotations.length === 1 ? "section" : "sections"}</span>
      </div>
      <p className="tx-help tx-timeline-limit">
        Drag across the recording to label a moment or add a note. This annotates the audio inside Verbatim Desk and cannot control the shared Chrome tab.
      </p>

      <div className="tx-timeline-scale" aria-hidden>
        <span>00:00.00</span>
        <span>{formatTimestampTag(duration).replace(/[\[\]]/g, "")}</span>
      </div>
      <div
        ref={trackRef}
        className={`tx-timeline-track ${duration <= 0 ? "is-empty" : ""}`}
        onPointerDown={startSelection}
        role="application"
        aria-label={duration > 0 ? "Recording timeline. Drag to select a range." : "Recording timeline. Record audio before selecting a range."}
      >
        {segments.filter((segment) => segment.upload_status === "uploaded" && duration > 0).map((segment) => (
          <span
            key={segment.id}
            className="tx-timeline-segment"
            style={{ left: percent(segment.start_ms, duration), width: percent(Math.max(segment.end_ms - segment.start_ms, 1), duration) }}
            title={`Audio segment ${segment.sequence + 1}`}
          />
        ))}
        {lines.filter((line) => line.start_ms != null && duration > 0).map((line) => (
          <span
            key={line.id}
            className="tx-timeline-line-mark"
            style={{ left: percent(line.start_ms || 0, duration) }}
            title={line.text || line.kind}
          />
        ))}
        {selection && (
          <span
            className="tx-timeline-selection"
            style={{ left: percent(Math.min(selection.anchor, selection.current), duration), width: percent(Math.abs(selection.current - selection.anchor), duration) }}
          />
        )}
        {sortedAnnotations.map((annotation) => {
          const isDragging = activeDrag?.id === annotation.id;
          const start = isDragging ? activeDrag.previewStart : annotation.start_ms;
          const end = isDragging ? activeDrag.previewEnd : annotation.end_ms;
          return (
            <div
              key={annotation.id}
              className={`tx-annotation-bar color-${annotation.color || "coral"}`}
              style={{ left: percent(start, duration), width: percent(Math.max(end - start, MIN_RANGE_MS), duration) }}
              onPointerDown={(event) => startExistingDrag(event, annotation, "move")}
              title={`${annotation.label}: ${formatTimestampTag(start)} to ${formatTimestampTag(end)}`}
            >
              <button type="button" className="tx-annotation-handle is-start" aria-label={`Resize ${annotation.label} start`} onPointerDown={(event) => startExistingDrag(event, annotation, "resize-start")}>
                <GripHorizontal className="h-3 w-3" />
              </button>
              <span className="tx-annotation-bar-label">{annotation.label || "Section"}</span>
              <button type="button" className="tx-annotation-handle is-end" aria-label={`Resize ${annotation.label} end`} onPointerDown={(event) => startExistingDrag(event, annotation, "resize-end")}>
                <GripHorizontal className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        {draftRange && (
          <span className="tx-timeline-draft" style={{ left: percent(draftRange.start_ms, duration), width: percent(draftRange.end_ms - draftRange.start_ms, duration) }} />
        )}
      </div>

      <div className="tx-timeline-fallback">
        <span className="tx-meta-label">Keyboard range</span>
        <label>Start <Input type="number" min={0} max={duration} step={100} value={fallbackStart} onChange={(event) => setFallbackStart(Number(event.target.value) || 0)} className="tx-input tx-time-input" /></label>
        <label>End <Input type="number" min={0} max={duration} step={100} value={fallbackEnd} onChange={(event) => setFallbackEnd(Number(event.target.value) || 0)} className="tx-input tx-time-input" /></label>
        <Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={setFallbackRange} disabled={duration <= 0}><Plus className="h-3.5 w-3.5" /> Add range</Button>
      </div>

      {draftRange && (
        <motion.div className="tx-annotation-draft" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <div className="tx-annotation-draft-head">
            <div><strong>New section</strong><span>{formatTimestampTag(draftRange.start_ms)} to {formatTimestampTag(draftRange.end_ms)}</span></div>
            <Button type="button" variant="ghost" size="sm" className="tx-icon-btn" onClick={() => setDraftRange(null)} aria-label="Cancel new section">×</Button>
          </div>
          <div className="tx-annotation-fields">
            <Input value={draftLabel} onChange={(event) => setDraftLabel(event.target.value)} placeholder="Label, for example: pricing explanation" className="tx-input" aria-label="New section label" autoFocus />
            <Textarea value={draftNotes} onChange={(event) => setDraftNotes(event.target.value)} placeholder="Add context for the team" className="tx-line-text" rows={2} aria-label="New section notes" />
          </div>
          <div className="tx-annotation-draft-actions">
            <div className="tx-color-picker" aria-label="Annotation color">
              {COLORS.map((color) => <button key={color} type="button" aria-label={`Use ${color} color`} className={`tx-color-dot color-${color} ${draftColor === color ? "is-selected" : ""}`} onClick={() => setDraftColor(color)} />)}
            </div>
            <label className="tx-category-field">Category <Input value={draftCategory} onChange={(event) => setDraftCategory(event.target.value)} className="tx-input" /></label>
            <Button type="button" size="sm" className="tx-btn-primary" onClick={() => void saveDraft()} disabled={!draftLabel.trim()}><Plus className="h-3.5 w-3.5" /> Save section</Button>
          </div>
        </motion.div>
      )}

      <div className="tx-annotation-list">
        {sortedAnnotations.length === 0 && !draftRange && <p className="tx-help">No sections yet. A drag selection becomes a saved, editable range.</p>}
        {sortedAnnotations.map((annotation) => {
          const draft = drafts[annotation.id] || { label: annotation.label, notes: annotation.notes || "" };
          const commit = (patch: { label?: string; notes?: string }) => {
            setDrafts((current) => ({ ...current, [annotation.id]: { ...draft, ...patch } }));
            void onUpdateAnnotation(annotation.id, patch);
          };
          return (
            <article key={annotation.id} className={`tx-annotation-card color-${annotation.color || "coral"}`}>
              <div className="tx-annotation-card-head"><div><span className="tx-annotation-category">{annotation.category || "note"}</span><strong>{formatTimestampTag(annotation.start_ms)} to {formatTimestampTag(annotation.end_ms)}</strong></div><Button type="button" variant="ghost" size="icon" className="tx-icon-btn is-danger" onClick={() => void onDeleteAnnotation(annotation.id)} aria-label={`Delete ${annotation.label || "annotation"}`}><Trash2 className="h-4 w-4" /></Button></div>
              <Input value={draft.label} onChange={(event) => setDrafts((current) => ({ ...current, [annotation.id]: { ...draft, label: event.target.value } }))} onBlur={(event) => commit({ label: event.target.value.trim() || "Untitled section" })} className="tx-input tx-annotation-label-input" aria-label="Annotation label" />
              <Textarea value={draft.notes} onChange={(event) => setDrafts((current) => ({ ...current, [annotation.id]: { ...draft, notes: event.target.value } }))} onBlur={(event) => commit({ notes: event.target.value })} className="tx-line-text" rows={2} placeholder="Team note" aria-label="Annotation notes" />
              <div className="tx-annotation-adjust"><span className="tx-help">Drag the bar or use the controls.</span><div className="tx-adjust-buttons"><Button type="button" variant="ghost" size="icon" className="tx-icon-btn" title="Move section left" onClick={() => nudge(annotation, "move", -1000)}><ChevronLeft className="h-4 w-4" /></Button><Button type="button" variant="ghost" size="icon" className="tx-icon-btn" title="Move section right" onClick={() => nudge(annotation, "move", 1000)}><ChevronRight className="h-4 w-4" /></Button><Button type="button" variant="ghost" size="icon" className="tx-icon-btn" title="Resize section earlier" onClick={() => nudge(annotation, "resize-start", -1000)}><Maximize2 className="h-3.5 w-3.5 rotate-180" /></Button><Button type="button" variant="ghost" size="icon" className="tx-icon-btn" title="Resize section later" onClick={() => nudge(annotation, "resize-end", 1000)}><Maximize2 className="h-3.5 w-3.5" /></Button></div></div>
            </article>
          );
        })}
      </div>
      <p className="tx-timeline-accessibility">Tip: drag is optional. The start and end fields above create the same range with keyboard controls.</p>
    </section>
  );
}
