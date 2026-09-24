import { useRef, useState, type FormEvent } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, LockKeyhole, RefreshCw } from "lucide-react";
import { contacts, events } from "@/integrations/core";
import { submitAccessRequest } from "@/functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const MAX_NAME_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 500;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

type RequestField = "name" | "email" | "message" | null;

type ValidationResult = {
  field: RequestField;
  message: string;
};

function cleanSingleLine(value: string, maxLength: number): string {
  return value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanMessage(value: string): string {
  return value.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_MESSAGE_LENGTH);
}

function validateRequest(name: string, email: string, message: string): ValidationResult {
  const cleanedName = cleanSingleLine(name, MAX_NAME_LENGTH);
  const cleanedEmail = email.trim();
  const cleanedMessage = cleanMessage(message);
  if (!cleanedName) return { field: "name", message: "Enter your name." };
  if (!cleanedEmail) return { field: "email", message: "Enter your email address." };
  if (!EMAIL_PATTERN.test(cleanedEmail)) return { field: "email", message: "Enter a valid email address." };
  if (cleanedMessage.length > MAX_MESSAGE_LENGTH) return { field: "message", message: "Keep your message under 500 characters." };
  return { field: null, message: "" };
}

function splitName(value: string): { first_name: string; last_name?: string } {
  const parts = value.split(" ").filter(Boolean);
  return {
    first_name: parts[0] || value,
    ...(parts.length > 1 ? { last_name: parts.slice(1).join(" ") } : {}),
  };
}

export function RequestAccessForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState<RequestField>(null);
  const submitInFlight = useRef(false);

  const clearFeedback = () => {
    setError("");
    setErrorField(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitInFlight.current) return;

    const cleanedName = cleanSingleLine(name, MAX_NAME_LENGTH);
    const cleanedEmail = email.trim().toLowerCase();
    const cleanedMessage = cleanMessage(message);
    const validation = validateRequest(cleanedName, cleanedEmail, cleanedMessage);
    if (validation.message) {
      setError(validation.message);
      setErrorField(validation.field);
      return;
    }

    submitInFlight.current = true;
    setSubmitting(true);
    clearFeedback();
    try {
      const nameParts = splitName(cleanedName);
      await contacts({
        email: cleanedEmail,
        ...nameParts,
        contact_stage: "lead",
        tags: ["request-access"],
        source: "verbatim-desk-request-access",
        append_notes: cleanedMessage
          ? `Public access request message: ${cleanedMessage}`
          : "Requested access through the public Verbatim Desk form.",
      });

      try {
        await submitAccessRequest({
          name: cleanedName,
          email: cleanedEmail,
          message: cleanedMessage,
        });
      } catch {
        console.warn("Access request was saved, but its private review record could not be created.");
      }

      try {
        await events({
          event_name: "request_access",
          contact_email: cleanedEmail,
          source: "verbatim-desk-request-access",
          source_event_id: `request_access:${cleanedEmail}`,
          properties: {
            source: "signed_out_access_form",
            has_message: Boolean(cleanedMessage),
          },
        });
      } catch {
        console.warn("Access request was saved, but its event could not be recorded.");
      }

      setName("");
      setEmail("");
      setMessage("");
      setSuccess(true);
    } catch {
      console.error("Could not save access request.");
      setError("We could not record your request. Check your details and try again.");
      setErrorField(null);
    } finally {
      submitInFlight.current = false;
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <section className="tx-panel h-full p-5 sm:p-6" aria-labelledby="request-access-success-heading" role="status" aria-live="polite">
        <div className="flex h-full flex-col justify-center gap-4 py-4 sm:py-8">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[hsl(var(--mint)/0.14)] text-[hsl(var(--mint))]">
            <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
          </div>
          <div className="space-y-2">
            <p className="tx-kicker">Request received</p>
            <h2 id="request-access-success-heading" className="text-2xl font-semibold sm:text-3xl">Your access request is recorded.</h2>
            <p className="tx-help max-w-md">Thank you for sharing what you need from Verbatim Desk. Your details are ready for access review.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="tx-panel h-full p-5 sm:p-6" aria-labelledby="request-access-heading">
      <div className="tx-panel-head">
        <div>
          <p className="tx-kicker">Request access</p>
          <h2 id="request-access-heading" className="text-2xl font-semibold sm:text-3xl">Bring your transcription work here.</h2>
          <p className="tx-help mt-2 max-w-xl">Tell us who you are and what you need from the private Verbatim Desk workspace.</p>
        </div>
      </div>

      <form className="space-y-4" onSubmit={(event) => void submit(event)} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="tx-field">
            <Label htmlFor="request-access-name">Name <span className="tx-label-optional" aria-hidden="true">required</span></Label>
            <Input id="request-access-name" className="tx-input" value={name} onChange={(event) => { setName(event.target.value); clearFeedback(); }} maxLength={MAX_NAME_LENGTH} autoComplete="name" aria-invalid={errorField === "name"} required />
          </div>
          <div className="tx-field">
            <Label htmlFor="request-access-email">Email <span className="tx-label-optional" aria-hidden="true">required</span></Label>
            <Input id="request-access-email" className="tx-input" type="email" value={email} onChange={(event) => { setEmail(event.target.value); clearFeedback(); }} maxLength={254} autoComplete="email" aria-invalid={errorField === "email"} required />
          </div>
        </div>

        <div className="tx-field">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="request-access-message">What do you need? <span className="tx-label-optional">optional</span></Label>
            <span id="request-access-message-help" className="tx-help tabular-nums">{message.length}/{MAX_MESSAGE_LENGTH}</span>
          </div>
          <Textarea id="request-access-message" className="tx-line-text min-h-[104px]" value={message} onChange={(event) => { setMessage(event.target.value); clearFeedback(); }} maxLength={MAX_MESSAGE_LENGTH} placeholder="A short note about your team or transcription workflow." aria-describedby="request-access-message-help" aria-invalid={errorField === "message"} />
        </div>

        {error && <div id="request-access-error" className="tx-error-banner flex items-start gap-2" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>{error}</span></div>}

        <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
          <p className="tx-help flex items-start gap-2"><LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--mint))]" aria-hidden="true" /><span>We use these details only to follow up about access to Verbatim Desk.</span></p>
          <Button type="submit" className="tx-btn-primary shrink-0" disabled={submitting}>{submitting ? <><RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />Saving request…</> : <>Request access<ArrowRight className="h-4 w-4" aria-hidden="true" /></>}</Button>
        </div>
      </form>
    </section>
  );
}
