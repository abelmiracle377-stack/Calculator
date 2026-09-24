import { useState } from "react";
import { Archive, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

export type HistoryView = "active" | "archived";
type Conversation = {
  id: string;
  selected_document_id: string;
  title: string;
  status: string;
  message_count: number;
  last_message_at: string;
};

interface AssistantHistoryControlsProps {
  conversations: Conversation[];
  conversationId: string;
  historyView: HistoryView;
  busy: boolean;
  onHistoryViewChange: (value: HistoryView) => void;
  onConversationChange: (value: string) => void;
  onArchive: (id: string) => Promise<boolean>;
  onRestore: (id: string) => Promise<boolean>;
}

export function AssistantHistoryControls({
  conversations,
  conversationId,
  historyView,
  busy,
  onHistoryViewChange,
  onConversationChange,
  onArchive,
  onRestore,
}: AssistantHistoryControlsProps) {
  const [confirmAction, setConfirmAction] = useState<"archive" | "restore" | null>(null);
  const selected = conversations.find((conversation) => conversation.id === conversationId);
  const confirming = Boolean(confirmAction && selected);

  const confirm = async () => {
    if (!selected || !confirmAction) return;
    const succeeded = confirmAction === "archive"
      ? await onArchive(selected.id)
      : await onRestore(selected.id);
    if (succeeded) setConfirmAction(null);
  };

  return (
    <div className="grid gap-2">
      <label className="grid gap-1.5 text-xs text-muted-foreground" htmlFor="assistant-history-view">
        History view
        <select
          id="assistant-history-view"
          value={historyView}
          onChange={(event) => onHistoryViewChange(event.target.value === "archived" ? "archived" : "active")}
          disabled={busy}
          className="tx-input h-10 w-full px-3"
        >
          <option value="active">Active history</option>
          <option value="archived">Archived</option>
        </select>
      </label>
      <label className="grid gap-1.5 text-xs text-muted-foreground" htmlFor="assistant-history-picker">
        {historyView === "archived" ? "Archived conversation" : "Saved conversation"}
        <select
          id="assistant-history-picker"
          value={conversationId}
          onChange={(event) => onConversationChange(event.target.value)}
          disabled={busy || conversations.length === 0}
          className="tx-input h-10 w-full px-3"
        >
          <option value="">{conversations.length ? "Choose a conversation" : historyView === "archived" ? "No archived conversations" : "No saved conversations"}</option>
          {conversations.map((conversation) => (
            <option key={conversation.id} value={conversation.id}>{conversation.title}</option>
          ))}
        </select>
      </label>
      {selected && (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {historyView === "archived" ? (
            <Button type="button" className="tx-btn-ghost h-8 px-2.5 text-xs" onClick={() => setConfirmAction("restore")} disabled={busy}>
              <RotateCcw className="h-3.5 w-3.5" />
              Restore
            </Button>
          ) : (
            <Button type="button" className="tx-btn-ghost h-8 px-2.5 text-xs text-[hsl(var(--coral))]" onClick={() => setConfirmAction("archive")} disabled={busy}>
              <Archive className="h-3.5 w-3.5" />
              Archive
            </Button>
          )}
          <span className="text-[10px] text-muted-foreground">
            {historyView === "archived" ? "Available again after restore." : "Hide this conversation from active history."}
          </span>
        </div>
      )}
      {historyView === "archived" && <p className="text-[10px] leading-relaxed text-muted-foreground">Archived conversations remain available with their messages and document links.</p>}
      <AlertDialog open={confirming} onOpenChange={(open) => { if (!open && !busy) setConfirmAction(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction === "restore" ? "Restore this conversation?" : "Archive this conversation?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "restore"
                ? "This conversation will return to active history. Its messages and document links will stay intact."
                : "This conversation will leave active history but remain available under Archived. Its messages and document links will stay intact."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={(event) => { event.preventDefault(); void confirm(); }} disabled={busy}>
              {busy ? (confirmAction === "restore" ? "Restoring…" : "Archiving…") : confirmAction === "restore" ? "Restore conversation" : "Archive conversation"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
