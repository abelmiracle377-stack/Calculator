import { type FormEvent, useState } from "react";
import { AlertTriangle, CheckCircle2, Mail, RefreshCw, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export type AdminReplyTargetKind = "access_request" | "support_conversation" | "human_support";
export type AdminReplyPayload = { targetKind: AdminReplyTargetKind; targetId: string; subject: string; body: string };

type AdminReplyComposerProps = {
  targetKind: AdminReplyTargetKind;
  targetId: string;
  recipientEmail?: string;
  defaultSubject?: string;
  onSend: (payload: AdminReplyPayload) => Promise<void>;
  onCancel: () => void;
};

const SUBJECT_MAX = 120;
const BODY_MAX = 2_000;

export function AdminReplyComposer({ targetKind, targetId, recipientEmail = "", defaultSubject = "", onSend, onCancel }: AdminReplyComposerProps) {
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const cleanSubject = subject.trim();
    const cleanBody = body.trim();
    if (!cleanSubject) { setError("Add a subject before sending."); setNotice(""); return; }
    if (!cleanBody) { setError("Write a message before sending."); setNotice(""); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      await onSend({ targetKind, targetId, subject: cleanSubject, body: cleanBody });
      setSubject(""); setBody(""); setNotice("Email sent and saved to the protected thread.");
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "The email could not be sent. Nothing was changed.");
    } finally { setBusy(false); }
  };

  return <form className="mt-4 rounded-xl border border-[hsl(var(--mint)/0.34)] bg-[hsl(var(--mint)/0.06)] p-4" onSubmit={submit} aria-label="Reply by email">
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-2">
        <Mail className="mt-0.5 h-4 w-4 text-[hsl(var(--mint))]" aria-hidden="true" />
        <div><h5 className="text-sm font-semibold text-foreground">Reply by email</h5><p className="mt-1 text-xs leading-relaxed text-muted-foreground">The message will be emailed to the stored requester address and saved to this protected thread.</p></div>
      </div>
      <Button type="button" variant="ghost" className="h-8 px-2 text-xs" onClick={onCancel} disabled={busy}><X className="h-3.5 w-3.5" />Cancel</Button>
    </div>
    {recipientEmail && <div className="mt-3 flex items-center gap-2 rounded-lg border border-[hsl(var(--line))] bg-[hsl(var(--ink)/0.22)] px-3 py-2 text-xs text-muted-foreground"><Mail className="h-3.5 w-3.5" aria-hidden="true" /><span>Recipient</span><strong className="break-all text-foreground">{recipientEmail}</strong></div>}
    <div className="mt-3 grid gap-3">
      <label className="grid gap-1.5 text-xs text-muted-foreground" htmlFor={`reply-subject-${targetId}`}>Subject<Input id={`reply-subject-${targetId}`} value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={SUBJECT_MAX} autoComplete="off" placeholder="Write a clear subject" disabled={busy} required /><span className="text-[11px] text-muted-foreground">{subject.length}/{SUBJECT_MAX}</span></label>
      <label className="grid gap-1.5 text-xs text-muted-foreground" htmlFor={`reply-body-${targetId}`}>Message<Textarea id={`reply-body-${targetId}`} value={body} onChange={(event) => setBody(event.target.value)} maxLength={BODY_MAX} rows={6} placeholder="Write the response the requester should receive" disabled={busy} required /><span className="text-[11px] text-muted-foreground">{body.length}/{BODY_MAX}</span></label>
    </div>
    {error && <div className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-[hsl(var(--coral))]" role="alert"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</div>}
    {notice && <div className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-[hsl(var(--mint))]" role="status"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />{notice}</div>}
    <div className="mt-4 flex flex-wrap justify-end gap-2"><Button type="submit" className="admin-primary-button mt-0" disabled={busy || !subject.trim() || !body.trim()}>{busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {busy ? "Sending…" : "Send email"}</Button></div>
  </form>;
}
