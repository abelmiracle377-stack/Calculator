import { useEffect, useMemo, useState } from "react";
import { CheckCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatTimestampTag } from "@/lib/transcription/format";
import type { CleanupProposal } from "@/lib/transcription/types";

interface TranscriptionCleanupDialogProps {
  open: boolean;
  proposals: CleanupProposal[];
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (proposals: CleanupProposal[]) => void | Promise<void>;
}

export function TranscriptionCleanupDialog({
  open,
  proposals,
  busy = false,
  onOpenChange,
  onApply,
}: TranscriptionCleanupDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set(proposals.map((proposal) => proposal.line_id))), [proposals]);
  const selectedProposals = useMemo(
    () => proposals.filter((proposal) => selected.has(proposal.line_id)),
    [proposals, selected]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="tx-dialog tx-cleanup-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-[hsl(var(--coral))]" /> Review transcript cleanup</DialogTitle>
          <DialogDescription>
            Verbatim Desk suggests small wording and punctuation corrections. Review each change before applying it. Speaker labels, timestamps, and every existing bracketed sound-event tag stay unchanged. Cleanup never creates missing sound events and cannot guarantee factual accuracy.
          </DialogDescription>
        </DialogHeader>
        <div className="tx-cleanup-list">
          {proposals.map((proposal) => {
            const checked = selected.has(proposal.line_id);
            return (
              <article key={proposal.line_id} className={`tx-cleanup-item ${checked ? "is-selected" : ""}`}>
                <div className="tx-cleanup-item-head">
                  <Checkbox checked={checked} onCheckedChange={(value) => setSelected((current) => { const next = new Set(current); if (value === true) next.add(proposal.line_id); else next.delete(proposal.line_id); return next; })} aria-label={`Select cleanup for ${proposal.speaker_label}`} />
                  <div><strong>{proposal.speaker_label}</strong><span>{proposal.start_ms != null ? formatTimestampTag(proposal.start_ms) : "No timestamp"}</span></div>
                </div>
                <div className="tx-cleanup-diff"><div><span>Current</span><p>{proposal.original_text}</p></div><div><span>Suggested</span><p>{proposal.proposed_text}</p></div></div>
              </article>
            );
          })}
        </div>
        <DialogFooter className="tx-cleanup-footer">
          <span className="tx-help">{selectedProposals.length} of {proposals.length} selected</span>
          <Button type="button" variant="outline" className="tx-btn-ghost" onClick={() => setSelected(new Set())} disabled={busy}>Clear selection</Button>
          <Button type="button" variant="outline" className="tx-btn-ghost" onClick={() => void onApply(proposals)} disabled={busy || proposals.length === 0}><CheckCheck className="h-3.5 w-3.5" /> Apply all</Button>
          <Button type="button" className="tx-btn-primary" onClick={() => void onApply(selectedProposals)} disabled={busy || selectedProposals.length === 0}>{busy ? "Applying…" : "Apply selected"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
