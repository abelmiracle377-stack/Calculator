import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, BadgeCheck, BellRing, Bot, Check, CheckCircle2, CircleOff, CreditCard, Mail, MessageCircle, Palette, RefreshCw, RotateCcw, ShieldCheck, UserRound, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { adminAccessAction, isAdminAccessDenied, reengagementAction } from "@/lib/admin/adminAccess";

const MAX_WORKSPACE_NAME = 80;
const MAX_SHORT_LABEL = 80;
const MAX_DESCRIPTION = 360;
const MAX_NOTIFICATION_EMAIL = 254;
const MAX_SUPPORT_SLACK_URL = 500;
const MAX_MESSAGE_SUBJECT = 120;
const MAX_MESSAGE_BODY = 2_000;
const MAX_REENGAGEMENT_SUBJECT = 120;
const MAX_REENGAGEMENT_BODY = 2_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isValidSupportSlackUrl(value: string): boolean {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
  } catch { return false; }
}

type AppSettingsForm = { workspace_name: string; short_label: string; description: string; support_slack_url: string; support_email: string; support_slack_enabled: boolean; support_email_enabled: boolean; support_ai_help_desk_enabled: boolean };
type NotificationSettingsForm = { recipient_email: string; enabled: boolean };
type MessageTemplatesForm = {
  signup_subject: string;
  signup_body: string;
  payment_submitted_subject: string;
  payment_submitted_body: string;
  payment_approved_subject: string;
  payment_approved_body: string;
};
type ReengagementSettingsForm = {
  enabled: boolean;
  subject: string;
  body: string;
  last_run_at: string;
  last_run_count: number;
  last_run_error: string;
};
type AppSettingsResponse = { settings: AppSettingsForm & { id?: string; settings_key?: string }; source?: "default" | "saved" };
type NotificationSettingsResponse = { settings: NotificationSettingsForm & { id?: string; settings_key?: string; updated_by?: string }; source?: "default" | "saved" };
type MessageTemplatesResponse = { templates: MessageTemplatesForm; source?: "default" | "saved" };
type ReengagementSettingsResponse = { settings: Partial<ReengagementSettingsForm>; source?: "default" | "saved" };
type BusyArea = "branding" | "support" | "notifications" | "messages" | "reengagement" | null;
type AdminAppSettingsPanelProps = { refreshToken?: number; onDenied: () => void };

const DEFAULT_SETTINGS: AppSettingsForm = { workspace_name: "Verbatim Desk", short_label: "Internal staff tool", description: "Private audio transcription workspace for accurate review.", support_slack_url: "", support_email: "", support_slack_enabled: false, support_email_enabled: false, support_ai_help_desk_enabled: true };
const DEFAULT_NOTIFICATION: NotificationSettingsForm = { recipient_email: "", enabled: true };
const DEFAULT_MESSAGES: MessageTemplatesForm = {
  signup_subject: "Welcome to Verbatim Desk",
  signup_body: "Welcome to Verbatim Desk, {{first_name}}.\n\nYour account is ready. Sign in to open your private transcription workspace and start your first review.\n\nYour 7-day trial begins with your account access. If you need help, reply to this email.\n\nAccount: {{email}}",
  payment_submitted_subject: "Payment received, verification is pending",
  payment_submitted_body: "Hi {{first_name}},\n\nWe received your manual payment submission for Verbatim Desk. Your evidence is saved and is now waiting for administrator verification.\n\nPayment ID: {{payment_id}}\nPayment method: {{payment_method}}\nAmount: {{amount}} {{currency}}\n\nPremium access starts after the payment is approved. We will email you when a decision is recorded.",
  payment_approved_subject: "Your Verbatim Desk Premium access is active",
  payment_approved_body: "Hi {{first_name}},\n\nYour payment has been approved and one calendar month of Premium access is now active.\n\nPayment ID: {{payment_id}}\nPayment method: {{payment_method}}\nPremium: {{premium_start}} to {{premium_end}}\n\nSign in to continue your transcription work.",
};
const DEFAULT_REENGAGEMENT: ReengagementSettingsForm = {
  enabled: false,
  subject: "Revisit your Verbatim Desk workspace",
  body: "Hi {{first_name}},\n\nYour Verbatim Desk workspace is ready when you are. Sign in to check whether trial access is available for your account, then revisit transcription, translation, review, and export in one workspace.\n\nTrial end: {{trial_end}}\n\nIf your trial has ended, you can review the available Premium option from the workspace. We do not automatically renew or extend access.\n\nAccount: {{email}}",
  last_run_at: "",
  last_run_count: 0,
  last_run_error: "",
};
const REENGAGEMENT_PLACEHOLDER_HELP = "{{first_name}}, {{email}}, {{trial_end}}";
const PLACEHOLDER_HELP = "{{first_name}}, {{email}}, {{payment_id}}, {{payment_method}}, {{amount}}, {{currency}}, {{premium_start}}, {{premium_end}}";
const MESSAGE_CARDS: { id: string; title: string; description: string; icon: LucideIcon; subjectKey: keyof MessageTemplatesForm; bodyKey: keyof MessageTemplatesForm }[] = [
  { id: "signup", title: "After signup", description: "Welcome every new account when it first enters the workspace.", icon: UserRound, subjectKey: "signup_subject", bodyKey: "signup_body" },
  { id: "payment-submitted", title: "After payment is submitted", description: "Confirm that manual payment evidence is saved and waiting for review.", icon: CreditCard, subjectKey: "payment_submitted_subject", bodyKey: "payment_submitted_body" },
  { id: "payment-approved", title: "After payment is approved", description: "Tell the payer when one calendar month of Premium access is active.", icon: BadgeCheck, subjectKey: "payment_approved_subject", bodyKey: "payment_approved_body" },
];

function formFrom(value: Partial<AppSettingsForm> | undefined): AppSettingsForm { return { workspace_name: typeof value?.workspace_name === "string" ? value.workspace_name : DEFAULT_SETTINGS.workspace_name, short_label: typeof value?.short_label === "string" ? value.short_label : DEFAULT_SETTINGS.short_label, description: typeof value?.description === "string" ? value.description : DEFAULT_SETTINGS.description, support_slack_url: typeof value?.support_slack_url === "string" ? value.support_slack_url : DEFAULT_SETTINGS.support_slack_url, support_email: typeof value?.support_email === "string" ? value.support_email : DEFAULT_SETTINGS.support_email, support_slack_enabled: typeof value?.support_slack_enabled === "boolean" ? value.support_slack_enabled : DEFAULT_SETTINGS.support_slack_enabled, support_email_enabled: typeof value?.support_email_enabled === "boolean" ? value.support_email_enabled : DEFAULT_SETTINGS.support_email_enabled, support_ai_help_desk_enabled: typeof value?.support_ai_help_desk_enabled === "boolean" ? value.support_ai_help_desk_enabled : DEFAULT_SETTINGS.support_ai_help_desk_enabled }; }
function notificationFrom(value: Partial<NotificationSettingsForm> | undefined): NotificationSettingsForm { return { recipient_email: typeof value?.recipient_email === "string" ? value.recipient_email : DEFAULT_NOTIFICATION.recipient_email, enabled: typeof value?.enabled === "boolean" ? value.enabled : DEFAULT_NOTIFICATION.enabled }; }
function messagesFrom(value: Partial<MessageTemplatesForm> | undefined): MessageTemplatesForm { return { signup_subject: typeof value?.signup_subject === "string" ? value.signup_subject : DEFAULT_MESSAGES.signup_subject, signup_body: typeof value?.signup_body === "string" ? value.signup_body : DEFAULT_MESSAGES.signup_body, payment_submitted_subject: typeof value?.payment_submitted_subject === "string" ? value.payment_submitted_subject : DEFAULT_MESSAGES.payment_submitted_subject, payment_submitted_body: typeof value?.payment_submitted_body === "string" ? value.payment_submitted_body : DEFAULT_MESSAGES.payment_submitted_body, payment_approved_subject: typeof value?.payment_approved_subject === "string" ? value.payment_approved_subject : DEFAULT_MESSAGES.payment_approved_subject, payment_approved_body: typeof value?.payment_approved_body === "string" ? value.payment_approved_body : DEFAULT_MESSAGES.payment_approved_body }; }
function reengagementFrom(value: Partial<ReengagementSettingsForm> | undefined): ReengagementSettingsForm { return { enabled: typeof value?.enabled === "boolean" ? value.enabled : DEFAULT_REENGAGEMENT.enabled, subject: typeof value?.subject === "string" ? value.subject : DEFAULT_REENGAGEMENT.subject, body: typeof value?.body === "string" ? value.body : DEFAULT_REENGAGEMENT.body, last_run_at: typeof value?.last_run_at === "string" ? value.last_run_at : "", last_run_count: typeof value?.last_run_count === "number" ? value.last_run_count : 0, last_run_error: typeof value?.last_run_error === "string" ? value.last_run_error : "" }; }
function reminderRunStatus(settings: ReengagementSettingsForm): string { if (!settings.last_run_at) return "No daily check has completed yet."; const date = new Date(settings.last_run_at); const when = Number.isFinite(date.getTime()) ? date.toLocaleString() : "Last scheduled check"; return `${when}, ${settings.last_run_count} email${settings.last_run_count === 1 ? "" : "s"} sent.`; }

function SupportOptionToggle({ id, label, description, enabled, disabled, Icon, ariaLabel, onChange }: { id: string; label: string; description: string; enabled: boolean; disabled: boolean; Icon: LucideIcon; ariaLabel: string; onChange: (checked: boolean) => void }) {
  const StatusIcon = enabled ? CheckCircle2 : CircleOff;
  return <div className="flex min-w-0 items-center justify-between gap-3 rounded-xl border px-3 py-2.5">
    <div className="flex min-w-0 items-center gap-3">
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${enabled ? "bg-[hsl(var(--mint)/0.12)] text-[hsl(var(--mint))]" : "bg-[hsl(var(--ink)/0.42)] text-muted-foreground"}`} aria-hidden="true"><Icon className="h-4 w-4" /></span>
      <div className="min-w-0"><p className="text-sm font-medium">{label}</p><p className="text-xs leading-relaxed text-muted-foreground">{description}</p></div>
    </div>
    <div className={`flex shrink-0 items-center gap-2 text-xs font-medium ${enabled ? "text-[hsl(var(--mint))]" : "text-muted-foreground"}`}><span className="inline-flex items-center gap-1"><StatusIcon className="h-3.5 w-3.5" aria-hidden="true" />{enabled ? "Enabled" : "Disabled"}</span><Switch id={id} checked={enabled} onCheckedChange={onChange} disabled={disabled} aria-label={ariaLabel} /></div>
  </div>;
}

function MessageCard({ card, messages, onChange, disabled }: { card: (typeof MESSAGE_CARDS)[number]; messages: MessageTemplatesForm; onChange: (field: keyof MessageTemplatesForm, value: string) => void; disabled: boolean }) {
  const Icon = card.icon;
  const subject = messages[card.subjectKey];
  const body = messages[card.bodyKey];
  return <article className="admin-detail-card mt-0 grid gap-4">
    <div className="admin-detail-card-heading"><Icon className="h-4 w-4" /><div><strong>{card.title}</strong><span>{card.description}</span></div></div>
    <div className="grid gap-4">
      <div className="grid gap-1.5"><div className="flex items-center justify-between gap-3"><Label htmlFor={`${card.id}-subject`}>Email subject</Label><span className="text-xs text-muted-foreground">{subject.length}/{MAX_MESSAGE_SUBJECT}</span></div><Input id={`${card.id}-subject`} value={subject} onChange={(event) => onChange(card.subjectKey, event.target.value)} maxLength={MAX_MESSAGE_SUBJECT} autoComplete="off" disabled={disabled} aria-describedby={`${card.id}-help`} /></div>
      <div className="grid gap-1.5"><div className="flex items-center justify-between gap-3"><Label htmlFor={`${card.id}-body`}>Plain-text message</Label><span className="text-xs text-muted-foreground">{body.length}/{MAX_MESSAGE_BODY}</span></div><Textarea id={`${card.id}-body`} value={body} onChange={(event) => onChange(card.bodyKey, event.target.value)} maxLength={MAX_MESSAGE_BODY} disabled={disabled} className="min-h-[10rem] resize-y" aria-describedby={`${card.id}-help`} /><p id={`${card.id}-help`} className="text-xs leading-relaxed text-muted-foreground">Plain text only. Supported placeholders: {PLACEHOLDER_HELP}. Unknown placeholders are removed when the email is sent.</p></div>
    </div>
  </article>;
}

function ReengagementCard({ settings, source, disabled, loadError, onChange, onSubmit }: { settings: ReengagementSettingsForm; source: "default" | "saved"; disabled: boolean; loadError: string; onChange: <K extends keyof ReengagementSettingsForm>(field: K, value: ReengagementSettingsForm[K]) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <form className="admin-detail-card mt-0 grid gap-4" onSubmit={onSubmit} aria-label="Re-engagement reminder">
    <div className="admin-detail-card-heading"><RotateCcw className="h-4 w-4" /><div><strong>{source === "saved" ? "Saved re-engagement reminder" : "Starter re-engagement reminder"}</strong><span>Daily check, 30 days old, expired or unused trial, one attempt per account.</span></div></div>
    <div className="admin-scope-note mt-0"><ShieldCheck className="h-4 w-4" /><span><strong>{settings.enabled ? "Enabled for the next daily check." : "Off until an administrator enables it."}</strong> Active Premium, current trialing, restricted, and already-attempted accounts are skipped.</span></div>
    {loadError && <div className="admin-feedback is-error" role="alert"><AlertTriangle className="h-4 w-4" />{loadError}</div>}
    <div className="grid gap-4">
      <div className="grid gap-1.5"><div className="flex items-center justify-between gap-3"><Label htmlFor="admin-reengagement-subject">Email subject</Label><span className="text-xs text-muted-foreground">{settings.subject.length}/{MAX_REENGAGEMENT_SUBJECT}</span></div><Input id="admin-reengagement-subject" value={settings.subject} onChange={(event) => onChange("subject", event.target.value)} maxLength={MAX_REENGAGEMENT_SUBJECT} autoComplete="off" disabled={disabled} /></div>
      <div className="grid gap-1.5"><div className="flex items-center justify-between gap-3"><Label htmlFor="admin-reengagement-body">Plain-text message</Label><span className="text-xs text-muted-foreground">{settings.body.length}/{MAX_REENGAGEMENT_BODY}</span></div><Textarea id="admin-reengagement-body" value={settings.body} onChange={(event) => onChange("body", event.target.value)} maxLength={MAX_REENGAGEMENT_BODY} disabled={disabled} className="min-h-[12rem] resize-y" aria-describedby="admin-reengagement-help" /><p id="admin-reengagement-help" className="text-xs leading-relaxed text-muted-foreground">Plain text only. Supported placeholders: {REENGAGEMENT_PLACEHOLDER_HELP}. Unknown placeholders are removed when the email is sent.</p></div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3 rounded-xl border px-3 py-2.5"><div><Label htmlFor="admin-reengagement-enabled" className="text-sm">Reminder</Label><p className="text-xs text-muted-foreground">{settings.enabled ? "Enabled" : "Disabled"}</p></div><Switch id="admin-reengagement-enabled" checked={settings.enabled} onCheckedChange={(checked) => onChange("enabled", checked)} disabled={disabled} aria-label="Enable re-engagement reminder" /></div><span className="text-xs text-muted-foreground">{reminderRunStatus(settings)}</span><Button type="submit" className="admin-primary-button mt-0" disabled={disabled}>{disabled && <RefreshCw className="h-4 w-4 animate-spin" />}Save reminder</Button></div>
    {settings.last_run_error && <p className="text-xs text-destructive" role="status">Last check: {settings.last_run_error}</p>}
  </form>;
}

export function AdminAppSettingsPanel({ refreshToken = 0, onDenied }: AdminAppSettingsPanelProps) {
  const [form, setForm] = useState<AppSettingsForm>(DEFAULT_SETTINGS);
  const [notification, setNotification] = useState<NotificationSettingsForm>(DEFAULT_NOTIFICATION);
  const [messages, setMessages] = useState<MessageTemplatesForm>(DEFAULT_MESSAGES);
  const [reengagement, setReengagement] = useState<ReengagementSettingsForm>(DEFAULT_REENGAGEMENT);
  const [source, setSource] = useState<"default" | "saved">("default");
  const [notificationSource, setNotificationSource] = useState<"default" | "saved">("default");
  const [messageSource, setMessageSource] = useState<"default" | "saved">("default");
  const [reengagementSource, setReengagementSource] = useState<"default" | "saved">("default");
  const [reengagementLoadError, setReengagementLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<BusyArea>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(""); setNotice(""); setReengagementLoadError("");
    const loadExistingSettings = async () => {
      try {
        const [appResponse, notificationResponse, messageResponse] = await Promise.all([
          adminAccessAction<AppSettingsResponse>({ action: "app_settings" }),
          adminAccessAction<NotificationSettingsResponse>({ action: "notification_settings" }),
          adminAccessAction<MessageTemplatesResponse>({ action: "message_templates" }),
        ]);
        setForm(formFrom(appResponse.settings)); setSource(appResponse.source === "saved" ? "saved" : "default");
        setNotification(notificationFrom(notificationResponse.settings)); setNotificationSource(notificationResponse.source === "saved" ? "saved" : "default");
        setMessages(messagesFrom(messageResponse.templates)); setMessageSource(messageResponse.source === "saved" ? "saved" : "default"); setLoaded(true);
      } catch (requestError) {
        if (isAdminAccessDenied(requestError)) { setError("Administrator access is required to view these settings."); onDenied(); } else setError("The protected app settings could not be loaded. Try again.");
      }
    };
    const loadReminderSettings = async () => {
      try {
        const response = await reengagementAction<ReengagementSettingsResponse>({ action: "settings" });
        setReengagement(reengagementFrom(response.settings)); setReengagementSource(response.source === "saved" ? "saved" : "default");
      } catch (requestError) {
        setReengagementLoadError(isAdminAccessDenied(requestError) ? "Administrator access is required to view the re-engagement reminder." : "The re-engagement reminder could not be loaded. Existing app settings remain available.");
      }
    };
    await Promise.all([loadExistingSettings(), loadReminderSettings()]);
    setLoading(false);
  }, [onDenied]);

  useEffect(() => { void load(); }, [load, refreshToken]);
  const update = (field: "workspace_name" | "short_label" | "description" | "support_slack_url" | "support_email", value: string) => { setForm((current) => ({ ...current, [field]: value })); setError(""); setNotice(""); };
  const updateSupportToggle = (field: "support_slack_enabled" | "support_email_enabled" | "support_ai_help_desk_enabled", value: boolean) => { setForm((current) => ({ ...current, [field]: value })); setError(""); setNotice(""); };
  const updateNotification = <K extends keyof NotificationSettingsForm>(field: K, value: NotificationSettingsForm[K]) => { setNotification((current) => ({ ...current, [field]: value })); setError(""); setNotice(""); };
  const updateMessage = (field: keyof MessageTemplatesForm, value: string) => { setMessages((current) => ({ ...current, [field]: value })); setError(""); setNotice(""); };
  const updateReengagement = <K extends keyof ReengagementSettingsForm>(field: K, value: ReengagementSettingsForm[K]) => { setReengagement((current) => ({ ...current, [field]: value })); setError(""); setNotice(""); setReengagementLoadError(""); };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return;
    const workspace_name = form.workspace_name.trim(); const short_label = form.short_label.trim(); const description = form.description.trim();
    if (!workspace_name || workspace_name.length > MAX_WORKSPACE_NAME) { setError("Add a workspace name within 80 characters."); return; }
    if (!short_label || short_label.length > MAX_SHORT_LABEL) { setError("Add a short label within 80 characters."); return; }
    if (!description || description.length > MAX_DESCRIPTION) { setError("Add a short description within 360 characters."); return; }
    setBusy("branding"); setError(""); setNotice("");
    try { const response = await adminAccessAction<AppSettingsResponse>({ action: "save_app_settings", workspace_name, short_label, description }); setForm(formFrom(response.settings)); setSource("saved"); setNotice("Workspace branding saved for the public-safe app header."); }
    catch (requestError) { if (isAdminAccessDenied(requestError)) { setError("Administrator access is required to change these settings."); onDenied(); } else setError("The workspace branding could not be saved. Nothing was changed."); }
    finally { setBusy(null); }
  };

  const saveSupport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return;
    const support_slack_url = form.support_slack_url.trim(); const support_email = form.support_email.trim().toLowerCase();
    if (support_slack_url.length > MAX_SUPPORT_SLACK_URL || !isValidSupportSlackUrl(support_slack_url)) { setError("Enter a valid HTTPS Slack support URL under 500 characters, or leave it blank."); return; }
    if (support_email.length > MAX_NOTIFICATION_EMAIL || (support_email && !EMAIL_PATTERN.test(support_email))) { setError("Enter a valid support email address under 254 characters, or leave it blank."); return; }
    if (form.support_slack_enabled && !support_slack_url) { setError("Add an HTTPS Slack support URL before enabling the Slack contact option."); return; }
    if (form.support_email_enabled && !support_email) { setError("Add a support email address before enabling the email contact option."); return; }
    setBusy("support"); setError(""); setNotice("");
    try {
      const response = await adminAccessAction<AppSettingsResponse>({ action: "save_support_settings", support_slack_url, support_email, support_slack_enabled: form.support_slack_enabled, support_email_enabled: form.support_email_enabled, support_ai_help_desk_enabled: form.support_ai_help_desk_enabled });
      setForm(formFrom(response.settings)); setSource("saved"); setNotice("Contact option settings saved. Disabled options stay hidden from signed-out visitors.");
    } catch (requestError) {
      if (isAdminAccessDenied(requestError)) { setError("Administrator access is required to change contact options."); onDenied(); } else setError("The contact options could not be saved. Nothing was changed.");
    } finally { setBusy(null); }
  };

  const saveNotifications = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return; const recipient_email = notification.recipient_email.trim().toLowerCase();
    if (!recipient_email || recipient_email.length > MAX_NOTIFICATION_EMAIL || !EMAIL_PATTERN.test(recipient_email)) { setError("Enter a valid alert email address under 254 characters."); return; }
    setBusy("notifications"); setError(""); setNotice("");
    try { const response = await adminAccessAction<NotificationSettingsResponse>({ action: "save_notification_settings", recipient_email, enabled: notification.enabled }); setNotification(notificationFrom(response.settings)); setNotificationSource("saved"); setNotice("Access request alerts saved."); }
    catch (requestError) { if (isAdminAccessDenied(requestError)) { setError("Administrator access is required to change these settings."); onDenied(); } else setError("The access request alerts could not be saved. Nothing was changed."); }
    finally { setBusy(null); }
  };

  const saveMessages = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return;
    const next = Object.fromEntries(Object.entries(messages).map(([key, value]) => [key, value.trim()])) as MessageTemplatesForm;
    const invalid = MESSAGE_CARDS.flatMap((card) => [{ value: next[card.subjectKey], label: `${card.title} subject`, max: MAX_MESSAGE_SUBJECT }, { value: next[card.bodyKey], label: `${card.title} message`, max: MAX_MESSAGE_BODY }]).find((field) => !field.value || field.value.length > field.max);
    if (invalid) { setError(`${invalid.label} must contain text and stay within ${invalid.max.toLocaleString()} characters.`); return; }
    setBusy("messages"); setError(""); setNotice("");
    try { const response = await adminAccessAction<MessageTemplatesResponse>({ action: "save_message_templates", templates: next }); setMessages(messagesFrom(response.templates)); setMessageSource("saved"); setNotice("User email messages saved. Future lifecycle emails will use these templates."); }
    catch (requestError) { if (isAdminAccessDenied(requestError)) { setError("Administrator access is required to change these messages."); onDenied(); } else setError("The user email messages could not be saved. Nothing was changed."); }
    finally { setBusy(null); }
  };

  const saveReengagement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy) return;
    const subject = reengagement.subject.trim(); const body = reengagement.body.trim();
    if (!subject || subject.length > MAX_REENGAGEMENT_SUBJECT) { setError(`The reminder subject must contain text and stay within ${MAX_REENGAGEMENT_SUBJECT} characters.`); return; }
    if (!body || body.length > MAX_REENGAGEMENT_BODY) { setError(`The reminder message must contain text and stay within ${MAX_REENGAGEMENT_BODY.toLocaleString()} characters.`); return; }
    setBusy("reengagement"); setError(""); setNotice(""); setReengagementLoadError("");
    try {
      const response = await reengagementAction<ReengagementSettingsResponse>({ action: "save_settings", enabled: reengagement.enabled, subject, body });
      setReengagement(reengagementFrom(response.settings)); setReengagementSource("saved");
      setNotice(reengagement.enabled ? "Re-engagement reminder saved and enabled for the next daily check." : "Re-engagement reminder saved and remains off.");
    } catch (requestError) {
      if (isAdminAccessDenied(requestError)) { setError("Administrator access is required to change the re-engagement reminder."); onDenied(); } else setError("The re-engagement reminder could not be saved. Nothing was changed.");
    } finally { setBusy(null); }
  };

  return <section className="admin-users-panel" aria-labelledby="admin-app-settings-heading">
    <div className="admin-section-heading"><div><p className="admin-section-kicker">Public-safe workspace identity</p><h3 id="admin-app-settings-heading">App settings</h3><p>Change the public-safe workspace text, control administrator alerts, and write the three private lifecycle emails sent to account holders.</p></div><Button type="button" variant="outline" className="admin-header-button" onClick={() => void load()} disabled={loading || Boolean(busy)}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button></div>
    <div className="admin-scope-note"><ShieldCheck className="h-4 w-4" /><span><strong>Private administrator controls.</strong> Branding is safe to show publicly. Alert destinations and user email messages remain available only to authorized administrators.</span></div>
    {error && <div className="admin-feedback is-error" role="alert"><AlertTriangle className="h-4 w-4" />{error}</div>}
    {notice && <div className="admin-feedback is-success" role="status"><Check className="h-4 w-4" />{notice}</div>}
    {loading && !loaded ? <div className="admin-loading"><RefreshCw className="h-4 w-4 animate-spin" />Loading protected settings…</div> : <div className="mt-4 grid max-w-4xl gap-5">
      <form className="grid gap-4" onSubmit={(event) => void save(event)}>
        <div className="admin-detail-card mt-0"><div className="admin-detail-card-heading"><Palette className="h-4 w-4" /><div><strong>{source === "saved" ? "Saved workspace branding" : "Current defaults"}</strong><span>{source === "saved" ? "The app header is using the saved public-safe values." : "No custom record exists yet, so the current Verbatim Desk defaults are active."}</span></div></div></div>
        <div className="grid gap-4 sm:grid-cols-2"><div className="grid gap-1.5"><Label htmlFor="admin-workspace-name">Workspace name</Label><Input id="admin-workspace-name" value={form.workspace_name} onChange={(event) => update("workspace_name", event.target.value)} maxLength={MAX_WORKSPACE_NAME} autoComplete="off" /></div><div className="grid gap-1.5"><Label htmlFor="admin-short-label">Short label or kicker</Label><Input id="admin-short-label" value={form.short_label} onChange={(event) => update("short_label", event.target.value)} maxLength={MAX_SHORT_LABEL} autoComplete="off" /></div></div>
        <div className="grid gap-1.5"><Label htmlFor="admin-workspace-description">Short description</Label><Textarea id="admin-workspace-description" value={form.description} onChange={(event) => update("description", event.target.value)} maxLength={MAX_DESCRIPTION} className="min-h-[7rem]" /><span className="text-xs text-muted-foreground">Used only as public-safe app identity text. Keep it clear and concise.</span></div>
        <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{form.description.length}/{MAX_DESCRIPTION} characters</span><Button type="submit" className="admin-primary-button mt-0" disabled={busy !== null || loading}>{busy === "branding" && <RefreshCw className="h-4 w-4 animate-spin" />}Save app settings</Button></div>
      </form>

      <form className="admin-detail-card mt-0 grid gap-4" onSubmit={(event) => void saveSupport(event)} aria-label="Contact options">
        <div className="admin-detail-card-heading"><MessageCircle className="h-4 w-4" /><div><strong>{form.support_slack_url || form.support_email ? "Saved contact options" : "Contact options"}</strong><span>Optional destinations for signed-out visitors. Leave either field blank to keep that option unavailable.</span></div></div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label htmlFor="admin-support-slack-url">Slack support URL <span className="text-xs text-muted-foreground">optional</span></Label><Input id="admin-support-slack-url" type="url" value={form.support_slack_url} onChange={(event) => update("support_slack_url", event.target.value)} maxLength={MAX_SUPPORT_SLACK_URL} autoComplete="url" placeholder="Paste an HTTPS support link" disabled={busy !== null || loading} /><span className="text-xs leading-relaxed text-muted-foreground">Use a visitor-facing HTTPS support link. Do not use a Slack webhook URL.</span></div>
          <div className="grid gap-1.5"><Label htmlFor="admin-support-email">Support email <span className="text-xs text-muted-foreground">optional</span></Label><Input id="admin-support-email" type="email" value={form.support_email} onChange={(event) => update("support_email", event.target.value)} maxLength={MAX_NOTIFICATION_EMAIL} autoComplete="email" placeholder="Paste a support email address" disabled={busy !== null || loading} /><span className="text-xs leading-relaxed text-muted-foreground">Visitors will open their email app with this address.</span></div>
        </div>
        <div className="grid gap-2 sm:grid-cols-3" aria-label="Contact option availability">
          <SupportOptionToggle id="admin-support-slack-enabled" label="Slack" description="Show the saved Slack link to visitors." enabled={form.support_slack_enabled} disabled={busy !== null || loading} Icon={MessageCircle} ariaLabel="Enable Slack contact option" onChange={(checked) => updateSupportToggle("support_slack_enabled", checked)} />
          <SupportOptionToggle id="admin-support-email-enabled" label="Email" description="Show the saved email route to visitors." enabled={form.support_email_enabled} disabled={busy !== null || loading} Icon={Mail} ariaLabel="Enable email contact option" onChange={(checked) => updateSupportToggle("support_email_enabled", checked)} />
          <SupportOptionToggle id="admin-support-ai-help-desk-enabled" label="AI Help Desk" description="Allow visitors to open the support assistant." enabled={form.support_ai_help_desk_enabled} disabled={busy !== null || loading} Icon={Bot} ariaLabel="Enable AI Help Desk contact option" onChange={(checked) => updateSupportToggle("support_ai_help_desk_enabled", checked)} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{form.support_slack_url ? "Slack link configured" : "Slack link not configured"} · {form.support_email ? "Email configured" : "Email not configured"}</span><Button type="submit" className="admin-primary-button mt-0" disabled={busy !== null || loading}>{busy === "support" && <RefreshCw className="h-4 w-4 animate-spin" />}Save contact options</Button></div>
      </form>

      <form className="admin-detail-card mt-0 grid gap-4" onSubmit={(event) => void saveNotifications(event)}>
        <div className="admin-detail-card-heading"><BellRing className="h-4 w-4" /><div><strong>{notificationSource === "saved" ? "Saved access request alerts" : "Access request alerts"}</strong><span>Send one administrator email after a new Request access submission is recorded. Duplicate submissions stay quiet.</span></div></div>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"><div className="grid gap-1.5"><Label htmlFor="admin-notification-email">Alert destination</Label><Input id="admin-notification-email" type="email" value={notification.recipient_email} onChange={(event) => updateNotification("recipient_email", event.target.value)} maxLength={MAX_NOTIFICATION_EMAIL} autoComplete="email" placeholder="Administrator email address" required /><span className="text-xs text-muted-foreground">Only authorized administrators can view or change this address.</span></div><div className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 sm:min-w-[10.5rem]"><div><Label htmlFor="admin-notification-enabled" className="text-sm">Alerts</Label><p className="text-xs text-muted-foreground">{notification.enabled ? "Enabled" : "Disabled"}</p></div><Switch id="admin-notification-enabled" checked={notification.enabled} onCheckedChange={(checked) => updateNotification("enabled", checked)} disabled={busy !== null || loading} aria-label="Enable access request alerts" /></div></div>
        <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-muted-foreground">Email delivery is best-effort and never blocks the request form.</span><Button type="submit" className="admin-primary-button mt-0" disabled={busy !== null || loading}>{busy === "notifications" && <RefreshCw className="h-4 w-4 animate-spin" />}Save alert settings</Button></div>
      </form>

      <div className="admin-detail-card mt-0 grid gap-3"><div className="admin-detail-card-heading"><Mail className="h-4 w-4" /><div><strong>{messageSource === "saved" ? "Saved user email messages" : "Starter user email messages"}</strong><span>These plain-text templates are sent to the account holder after signup, payment submission, and payment approval. Replace the starter copy with your own message, then save all three together.</span></div></div><div className="admin-scope-note mt-0"><ShieldCheck className="h-4 w-4" /><span>Only the signed-in account email receives these messages. Payment approval still grants one calendar month of Premium after administrator verification.</span></div></div>
      <form className="grid gap-4" onSubmit={(event) => void saveMessages(event)} aria-label="User email messages">
        {MESSAGE_CARDS.map((card) => <MessageCard key={card.id} card={card} messages={messages} onChange={updateMessage} disabled={busy !== null || loading} />)}
        <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-muted-foreground">Subjects allow {MAX_MESSAGE_SUBJECT} characters. Each message allows {MAX_MESSAGE_BODY.toLocaleString()} characters.</span><Button type="submit" className="admin-primary-button mt-0" disabled={busy !== null || loading}>{busy === "messages" && <RefreshCw className="h-4 w-4 animate-spin" />}Save all messages</Button></div>
      </form>

      <ReengagementCard settings={reengagement} source={reengagementSource} disabled={busy !== null || loading} loadError={reengagementLoadError} onChange={updateReengagement} onSubmit={(event) => void saveReengagement(event)} />
    </div>}
  </section>;
}
