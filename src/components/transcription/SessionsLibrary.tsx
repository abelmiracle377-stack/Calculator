import { useState } from "react";
import { format } from "date-fns";
import { Archive, Plus, RotateCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { formatDuration, statusLabel } from "@/lib/transcription/format";
import type { SessionStatus, TranscriptionSessionRecord } from "@/lib/transcription/types";

type SessionFilter = "all" | SessionStatus | "archived";
type SessionAction = { kind: "archive" | "restore"; session: TranscriptionSessionRecord } | null;

const FILTERS: Array<{ id: SessionFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "recording", label: "Recording" },
  { id: "completed", label: "Done" },
  { id: "failed", label: "Failed" },
  { id: "discarded", label: "Discarded" },
  { id: "archived", label: "Archived" },
];

interface SessionsLibraryProps {
  sessions: TranscriptionSessionRecord[];
  activeId: string | null;
  search: string;
  statusFilter: SessionFilter;
  loading: boolean;
  onSearch: (value: string) => void;
  onFilter: (value: SessionFilter) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  creating: boolean;
  canArchive: (session: TranscriptionSessionRecord) => boolean;
  onArchive: (id: string) => Promise<boolean>;
  onRestore: (id: string) => Promise<boolean>;
}

export function SessionsLibrary({
  sessions,
  activeId,
  search,
  statusFilter,
  loading,
  onSearch,
  onFilter,
  onSelect,
  onNew,
  creating,
  canArchive,
  onArchive,
  onRestore,
}: SessionsLibraryProps) {
  const [action, setAction] = useState<SessionAction>(null);
  const [workingId, setWorkingId] = useState("");
  const archived = action?.kind === "restore";

  const confirmAction = async () => {
    if (!action || workingId) return;
    setWorkingId(action.session.id);
    const succeeded = action.kind === "archive"
      ? await onArchive(action.session.id)
      : await onRestore(action.session.id);
    setWorkingId("");
    if (succeeded) setAction(null);
  };

  return (
    <aside className="tx-rail" aria-label="Sessions library">
      <div className="tx-rail-head">
        <div>
          <p className="tx-kicker">Library</p>
          <h2 className="tx-rail-title">Sessions</h2>
        </div>
        <Button type="button" size="sm" className="tx-btn-primary" onClick={onNew} disabled={creating}>
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
      </div>

      <div className="tx-search-wrap">
        <Search className="tx-search-icon" aria-hidden />
        <Input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search titles or sources…" className="tx-search" aria-label="Search sessions" />
      </div>

      <div className="tx-filter-row" role="tablist" aria-label="Filter by status">
        {FILTERS.map((filter) => (
          <button key={filter.id} type="button" role="tab" aria-selected={statusFilter === filter.id} className={`tx-filter-chip ${statusFilter === filter.id ? "is-active" : ""}`} onClick={() => onFilter(filter.id)}>
            {filter.label}
          </button>
        ))}
      </div>

      <div className="tx-session-list">
        {loading && <p className="tx-muted-block">Loading sessions…</p>}
        {!loading && sessions.length === 0 && (
          <div className="tx-empty-rail">
            <Archive className="h-8 w-8 opacity-40" />
            <p>No sessions match this view.</p>
            <p className="tx-help">Archived sessions remain available under Archived.</p>
          </div>
        )}
        {sessions.map((session) => {
          const isActive = session.id === activeId;
          const isArchived = session.archive_status === "ARCHIVED";
          const actionBusy = workingId === session.id;
          const allowed = canArchive(session);
          return (
            <div key={session.id} className={`tx-session-card ${isActive ? "is-active" : ""}`}>
              <button type="button" className="w-full text-left" onClick={() => onSelect(session.id)} disabled={actionBusy}>
                <div className="tx-session-card-top">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className={`tx-status-pill status-${session.status}`}>{statusLabel(session.status)}</span>
                    {isArchived && <span className="tx-status-pill border border-[hsl(var(--mint)/0.25)] bg-[hsl(var(--mint)/0.08)] text-[hsl(var(--mint))]">Archived</span>}
                  </div>
                  <span className="tx-session-time">{session.duration_ms != null ? formatDuration(session.duration_ms) : "—"}</span>
                </div>
                <p className="tx-session-name">{session.title || "Untitled session"}</p>
                <p className="tx-session-meta">
                  {session.source_label || "No source yet"}
                  {session.started_at ? ` · ${format(new Date(session.started_at), "MMM d, HH:mm")}` : ""}
                </p>
              </button>
              <div className="mt-2 flex items-center justify-between gap-2 border-t border-[hsl(var(--line)/0.65)] pt-2">
                <span className="min-w-0 text-[10px] leading-relaxed text-muted-foreground">
                  {isArchived ? "Hidden from normal session views." : allowed ? "Archive keeps the recording and transcript available." : "Finish capture or processing before archiving."}
                </span>
                {isArchived ? (
                  <Button type="button" className="tx-btn-ghost h-8 shrink-0 px-2.5 text-xs" onClick={() => setAction({ kind: "restore", session })} disabled={actionBusy}>
                    <RotateCcw className="h-3.5 w-3.5" />
                    Restore
                  </Button>
                ) : (
                  <Button type="button" className="tx-btn-ghost h-8 shrink-0 px-2.5 text-xs text-[hsl(var(--coral))]" onClick={() => setAction({ kind: "archive", session })} disabled={!allowed || actionBusy} title={allowed ? "Archive this session" : "Stop capture or wait for processing to finish before archiving"}>
                    <Archive className="h-3.5 w-3.5" />
                    Archive
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <AlertDialog open={Boolean(action)} onOpenChange={(open) => { if (!open && !workingId) setAction(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{archived ? "Restore this session?" : "Archive this session?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {archived
                ? "This session will return to the normal session views. Its recording, transcript, review data, translations, and audio links will stay intact."
                : "This session will leave the normal session views and remain available under Archived. Its recording, transcript, review data, translations, and audio links will stay intact."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(workingId)}>Keep session</AlertDialogCancel>
            <AlertDialogAction onClick={(event) => { event.preventDefault(); void confirmAction(); }} disabled={Boolean(workingId)}>
              {workingId ? (archived ? "Restoring…" : "Archiving…") : archived ? "Restore session" : "Archive session"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
