import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertCircle, ArrowLeft, Bot, CheckCircle2, LifeBuoy, LoaderCircle, RefreshCw, Send } from "lucide-react";
import { helpDeskChat } from "@/functions";
import { contacts, events } from "@/integrations/core";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const MAX_NAME = 120;
const MAX_EMAIL = 254;
const MAX_REASON = 1_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
type ChatMessage = { id: string; role: "user" | "assistant"; text: string };
type ChatResponse = { conversation_id?: unknown; response?: unknown; human_help_suggested?: unknown; ok?: unknown; human_support_request_id?: unknown };

type HandoffFormProps = { name: string; email: string; reason: string; busy: boolean; error: string; onNameChange: (value: string) => void; onEmailChange: (value: string) => void; onReasonChange: (value: string) => void; onBack: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void };

function safeEmail(value: unknown): string { if (typeof value !== "string" || value.length > MAX_EMAIL) return ""; const candidate = value.trim().toLowerCase(); return EMAIL_PATTERN.test(candidate) ? candidate : ""; }
function responseText(value: unknown): string { return typeof value === "string" ? value.replace(/\u0000/g, "").trim().slice(0, 4_000) : ""; }
function cleanSingleLine(value: string, max: number): string { return value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max); }
function cleanReason(value: string): string { return value.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_REASON); }
function splitName(value: string): { first_name: string; last_name?: string } { const parts = value.split(" ").filter(Boolean); return { first_name: parts[0] || value, ...(parts.length > 1 ? { last_name: parts.slice(1).join(" ") } : {}) }; }
function obviousHumanRequest(value: string): boolean { return /\b(?:human|person|expert|agent|staff|representative)\b/i.test(value) && /\b(?:help|support|speak|talk|contact|connect|reach|answer)\b/i.test(value); }

function HumanHelpInvitation({ conversationId, handoffAvailable, disabled, onOpen }: { conversationId: string; handoffAvailable: boolean; disabled: boolean; onOpen: () => void }) {
  return <div className="shrink-0 border-b border-[hsl(var(--line))] bg-[hsl(var(--mint)/0.05)] px-4 py-3 sm:px-6"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-start gap-2 text-xs"><LifeBuoy className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--mint))]" aria-hidden="true" /><span><strong className="block text-foreground">Need a human expert?</strong><span className="text-muted-foreground">{conversationId ? handoffAvailable ? "A support specialist can follow up by email." : "You can ask for a person at any point." : "A support conversation will start when you send the request."}</span></span></div><Button type="button" variant="outline" className="shrink-0" onClick={onOpen} disabled={disabled}><LifeBuoy className="h-4 w-4" />Request human help</Button></div></div>;
}

function HandoffForm({ name, email, reason, busy, error, onNameChange, onEmailChange, onReasonChange, onBack, onSubmit }: HandoffFormProps) {
  return <form className="flex min-h-full flex-col px-4 py-4 sm:px-6 sm:py-5" onSubmit={onSubmit}><div className="flex shrink-0 items-center justify-between gap-3"><div><p className="tx-kicker">Human support request</p><h3 className="mt-1 text-base font-semibold text-foreground">Tell us where to reach you</h3></div><Button type="button" variant="ghost" className="shrink-0" onClick={onBack} disabled={busy}><ArrowLeft className="h-4 w-4" />Back to chat</Button></div><div className="grid flex-1 content-start gap-3 pt-4"><p className="text-xs leading-relaxed text-muted-foreground">A human expert will review this conversation and follow up by email.</p><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1.5 text-xs text-muted-foreground" htmlFor="human-help-name">Name<Input id="human-help-name" className="tx-input" value={name} onChange={(event) => onNameChange(event.target.value)} maxLength={MAX_NAME} autoComplete="name" disabled={busy} /></label><label className="grid gap-1.5 text-xs text-muted-foreground" htmlFor="human-help-email">Email<Input id="human-help-email" className="tx-input" type="email" value={email} onChange={(event) => onEmailChange(event.target.value)} maxLength={MAX_EMAIL} autoComplete="email" disabled={busy} /></label></div><label className="grid gap-1.5 text-xs text-muted-foreground" htmlFor="human-help-reason">What should we help with? <span className="text-[10px]">optional</span><Textarea id="human-help-reason" className="tx-line-text min-h-[5rem]" value={reason} onChange={(event) => onReasonChange(event.target.value)} maxLength={MAX_REASON} disabled={busy} placeholder="Briefly describe what you need from a human expert." /></label>{error && <div className="tx-error-banner flex items-start gap-2 text-xs" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{error}</div>}</div><div className="mt-5 flex shrink-0 flex-wrap justify-end gap-2 border-t border-[hsl(var(--line))] pt-4"><Button type="button" variant="outline" onClick={onBack} disabled={busy}>Cancel</Button><Button type="submit" className="tx-btn-primary" disabled={busy}>{busy ? <><RefreshCw className="h-4 w-4 animate-spin" />Sending request…</> : <><LifeBuoy className="h-4 w-4" />Send to human support</>}</Button></div></form>;
}

export function HelpDeskDialog() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState("");
  const [draft, setDraft] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState("");
  const [handoffAvailable, setHandoffAvailable] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffName, setHandoffName] = useState("");
  const [handoffEmail, setHandoffEmail] = useState("");
  const [handoffReason, setHandoffReason] = useState("");
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState("");
  const [handoffSuccess, setHandoffSuccess] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const dialogBodyRef = useRef<HTMLDivElement>(null);
  const conversationStartRef = useRef<Promise<string> | null>(null);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [messages, chatBusy]);
  const startConversation = async (): Promise<string> => {
    if (conversationId) return conversationId;
    if (conversationStartRef.current) return conversationStartRef.current;
    const request = (async () => { setChatError(""); setChatBusy(true); try { const result = await helpDeskChat({ mode: "init" }) as ChatResponse; const nextConversationId = typeof result?.conversation_id === "string" ? result.conversation_id.trim() : ""; if (!nextConversationId) throw new Error("The help desk conversation could not be started."); setConversationId(nextConversationId); const greeting = responseText(result.response); if (greeting) setMessages([{ id: `assistant-${Date.now()}`, role: "assistant", text: greeting }]); return nextConversationId; } catch { console.error("AI Help Desk could not start"); setChatError("The AI Help Desk could not be reached. Please try again or use another contact option."); return ""; } finally { setChatBusy(false); conversationStartRef.current = null; } })();
    conversationStartRef.current = request;
    return request;
  };
  const handleOpenChange = (nextOpen: boolean) => { setOpen(nextOpen); if (!nextOpen) { setHandoffOpen(false); setHandoffError(""); return; } if (!conversationId) void startConversation(); };
  const resetDialogBody = () => { if (typeof window !== "undefined") window.requestAnimationFrame(() => { if (dialogBodyRef.current) dialogBodyRef.current.scrollTop = 0; }); };
  const openHandoff = () => { setHandoffError(""); setHandoffOpen(true); resetDialogBody(); };
  const backToChat = () => { setHandoffOpen(false); setHandoffError(""); resetDialogBody(); };
  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const text = draft.replace(/\u0000/g, "").trim().slice(0, 1_200); if (!text || !conversationId || chatBusy) return; if (obviousHumanRequest(text)) setHandoffAvailable(true); setDraft(""); setChatError(""); setMessages((current) => [...current, { id: `user-${Date.now()}`, role: "user", text }]); setChatBusy(true);
    try { const result = await helpDeskChat({ mode: "message", message: text, conversation_id: conversationId }) as ChatResponse; const reply = responseText(result.response); if (!reply) throw new Error("The help desk returned no reply."); setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: "assistant", text: reply }]); if (result.human_help_suggested === true) setHandoffAvailable(true); } catch { console.error("AI Help Desk could not reply"); setDraft(text); setChatError("The AI Help Desk could not reply. Check your connection and try again."); } finally { setChatBusy(false); }
  };
  const submitHandoff = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (handoffBusy) return; const name = cleanSingleLine(handoffName, MAX_NAME); const email = safeEmail(handoffEmail); const reason = cleanReason(handoffReason); if (!name) { setHandoffError("Enter your name."); return; } if (!email) { setHandoffError("Enter a valid email address."); return; } setHandoffBusy(true); setHandoffError("");
    try { const nextConversationId = conversationId || await startConversation(); if (!nextConversationId) throw new Error("The help desk conversation could not be started."); const result = await helpDeskChat({ mode: "human_handoff", conversation_id: nextConversationId, name, email, reason }) as ChatResponse; if (result?.ok !== true || typeof result.human_support_request_id !== "string" || !result.human_support_request_id.trim()) throw new Error("The support request was not accepted."); setHandoffSuccess(true); setHandoffOpen(false); setHandoffName(""); setHandoffEmail(""); setHandoffReason(""); void Promise.resolve().then(() => Promise.allSettled([contacts({ email, ...splitName(name), contact_stage: "lead", tags: ["support-handoff"], source: "verbatim-desk-help-desk", append_notes: reason ? `Human support requested through AI Help Desk: ${reason}` : "Human support requested through the AI Help Desk." }), events({ event_name: "support_handoff_requested", contact_email: email, source: "verbatim-desk-help-desk", source_event_id: `support_handoff:${nextConversationId}`, properties: { source: "signed_out_help_desk", has_reason: Boolean(reason) } })])).then((results) => { if (results.some((entry) => entry.status === "rejected")) console.warn("Optional support contact tracking failed"); }).catch(() => console.warn("Optional support contact tracking failed")); } catch { console.error("Could not complete human support handoff"); setHandoffError("We could not send your request. Check your details and try again."); } finally { setHandoffBusy(false); }
  };

  return <Dialog open={open} onOpenChange={handleOpenChange}>
    <button type="button" className="tx-link-btn tx-link-btn-ghost min-h-[3.5rem] justify-between rounded-xl px-3 py-2 text-left text-xs" onClick={() => handleOpenChange(true)} aria-haspopup="dialog"><span className="flex min-w-0 items-center gap-2"><LifeBuoy className="h-4 w-4 shrink-0 text-[hsl(var(--coral))]" aria-hidden="true" /><span className="min-w-0"><span className="block font-semibold">AI Help Desk</span><span className="mt-0.5 block text-[10px] text-muted-foreground">Chat with support</span></span></span><Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /></button>
    <DialogContent className="!flex h-[calc(100vh_-_1.5rem)] max-h-[calc(100vh_-_1.5rem)] w-[calc(100vw_-_1.5rem)] max-w-xl flex-col gap-0 overflow-hidden rounded-2xl p-0 supports-[height:100dvh]:h-[calc(100dvh_-_1.5rem)] supports-[height:100dvh]:max-h-[calc(100dvh_-_1.5rem)]">
      <DialogHeader className="shrink-0 border-b border-[hsl(var(--line))] px-4 py-4 pr-12 text-left sm:px-6 sm:py-5"><DialogTitle>AI Help Desk</DialogTitle><DialogDescription>Ask about Verbatim Desk. This support chat cannot access private transcription sessions.</DialogDescription></DialogHeader>
      {!handoffOpen && !handoffSuccess && <HumanHelpInvitation conversationId={conversationId} handoffAvailable={handoffAvailable} disabled={handoffBusy} onOpen={openHandoff} />}
      <div ref={dialogBodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{handoffOpen && !handoffSuccess ? <HandoffForm name={handoffName} email={handoffEmail} reason={handoffReason} busy={handoffBusy} error={handoffError} onNameChange={setHandoffName} onEmailChange={setHandoffEmail} onReasonChange={setHandoffReason} onBack={backToChat} onSubmit={(event) => void submitHandoff(event)} /> : <div className="grid min-h-full content-start gap-3 px-4 py-4 sm:px-6 sm:py-5"><div className="flex min-h-[12rem] max-h-[min(42vh,26rem)] flex-col gap-2 overflow-y-auto rounded-xl border border-[hsl(var(--line))] bg-[hsl(var(--ink)/0.42)] p-3" aria-live="polite" aria-label="AI Help Desk conversation">{!messages.length && !chatError && <div className="m-auto flex max-w-xs flex-col items-center gap-2 text-center text-xs text-muted-foreground">{chatBusy ? <LoaderCircle className="h-5 w-5 animate-spin text-[hsl(var(--mint))]" aria-hidden="true" /> : <Bot className="h-5 w-5 text-[hsl(var(--mint))]" aria-hidden="true" />}<span>{chatBusy ? "Connecting to the help desk…" : "Ask a question to get started."}</span></div>}{messages.map((message) => <div key={message.id} className={`max-w-[88%] rounded-xl px-3 py-2 text-sm leading-relaxed ${message.role === "user" ? "ml-auto bg-[hsl(var(--coral)/0.16)] text-foreground" : "bg-[hsl(var(--ink-elevated))] text-foreground"}`}><span className="sr-only">{message.role === "user" ? "You: " : "AI Help Desk: "}</span>{message.text}</div>)}{chatBusy && conversationId && <div className="flex items-center gap-2 self-start rounded-xl bg-[hsl(var(--ink-elevated))] px-3 py-2 text-xs text-muted-foreground"><LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Writing a reply…</div>}<div ref={messagesEndRef} /></div>{chatError && <div className="flex items-start gap-2 rounded-lg border border-[hsl(var(--coral)/0.35)] bg-[hsl(var(--coral)/0.08)] p-3 text-xs leading-relaxed text-[hsl(var(--coral))]" role="alert"><span className="min-w-0 flex-1">{chatError}</span>{!conversationId && <button type="button" className="shrink-0 underline underline-offset-2" onClick={() => void startConversation()} disabled={chatBusy}>{chatBusy ? "Trying…" : "Retry"}</button>}</div>}{handoffSuccess && <div className="flex items-start gap-2 rounded-xl border border-[hsl(var(--mint)/0.35)] bg-[hsl(var(--mint)/0.08)] p-3 text-xs leading-relaxed text-[hsl(var(--mint))]" role="status"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>Your request was sent. A human support team will review this conversation and follow up by email.</span></div>}<form className="flex shrink-0 items-center gap-2" onSubmit={(event) => void sendMessage(event)}><Input value={draft} onChange={(event) => setDraft(event.target.value)} className="tx-input min-w-0" placeholder="Type your question" maxLength={1_200} disabled={!conversationId || chatBusy} aria-label="Message AI Help Desk" /><Button type="submit" className="tx-btn-primary shrink-0" disabled={!conversationId || !draft.trim() || chatBusy} aria-label="Send message">{chatBusy ? <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}<span className="sr-only">Send</span></Button></form></div>}</div>
    </DialogContent>
  </Dialog>;
}
