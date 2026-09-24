import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink, LifeBuoy, Mail, MessageCircle } from "lucide-react";
import { AppSettings } from "@/entities";
import { HelpDeskDialog } from "@/components/leads/HelpDeskDialog";

const MAX_SLACK_URL = 500;
const MAX_EMAIL = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
type PublicSettingsRow = Record<string, unknown>;

function safeSlackUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_SLACK_URL) return "";
  const candidate = value.trim();
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) return "";
    return parsed.toString();
  } catch { return ""; }
}
function safeEmail(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_EMAIL) return "";
  const candidate = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(candidate) ? candidate : "";
}
function safeSettingBoolean(value: unknown, fallback: boolean): boolean { return typeof value === "boolean" ? value : fallback; }

export function SignInContactOptions() {
  const [supportSlackUrl, setSupportSlackUrl] = useState("");
  const [supportEmail, setSupportEmail] = useState("");
  const [supportSlackEnabled, setSupportSlackEnabled] = useState(false);
  const [supportEmailEnabled, setSupportEmailEnabled] = useState(false);
  const [supportAiHelpDeskEnabled, setSupportAiHelpDeskEnabled] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const loadSettings = async () => {
      try {
        const rows = await AppSettings.filter({ settings_key: "default" }, "-updated_at", 1) as PublicSettingsRow[];
        const row = Array.isArray(rows) ? rows[0] : undefined;
        if (!cancelled && row) {
          setSupportSlackUrl(safeSlackUrl(row.support_slack_url));
          setSupportEmail(safeEmail(row.support_email));
          setSupportSlackEnabled(safeSettingBoolean(row.support_slack_enabled, false));
          setSupportEmailEnabled(safeSettingBoolean(row.support_email_enabled, false));
          setSupportAiHelpDeskEnabled(safeSettingBoolean(row.support_ai_help_desk_enabled, true));
        }
      } catch {
        /* Contact options remain safe and inactive when public settings are unavailable. */
      } finally { if (!cancelled) setSettingsLoading(false); }
    };
    void loadSettings();
    return () => { cancelled = true; };
  }, []);

  return <section className="mt-5 border-t border-[hsl(var(--line))] pt-5" aria-labelledby="sign-in-contact-heading">
    <div className="flex items-start gap-3"><div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--mint)/0.12)] text-[hsl(var(--mint))]" aria-hidden="true"><LifeBuoy className="h-4 w-4" /></div><div className="min-w-0"><p className="tx-kicker">Need a hand?</p><h3 id="sign-in-contact-heading" className="mt-1 text-base font-semibold text-foreground">Contact us</h3><p className="tx-help mt-1">Choose the support route that works best for you.</p></div></div>
    <div className="mt-3 grid gap-2 sm:grid-cols-3">
      {supportSlackEnabled && supportSlackUrl ? <a href={supportSlackUrl} target="_blank" rel="noopener noreferrer" className="tx-link-btn tx-link-btn-ghost min-h-[3.5rem] justify-between rounded-xl px-3 py-2 text-left text-xs" aria-label="Contact us on Slack, opens in a new tab"><span className="flex min-w-0 items-center gap-2"><MessageCircle className="h-4 w-4 shrink-0 text-[hsl(var(--mint))]" aria-hidden="true" /><span className="min-w-0"><span className="block font-semibold">Contact us on Slack</span><span className="mt-0.5 block text-[10px] text-muted-foreground">Open support</span></span></span><ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /></a> : <UnavailableOption icon={<MessageCircle className="h-4 w-4" aria-hidden="true" />} label="Contact us on Slack" loading={settingsLoading} enabled={supportSlackEnabled} />}
      {supportEmailEnabled && supportEmail ? <a href={`mailto:${supportEmail}`} className="tx-link-btn tx-link-btn-ghost min-h-[3.5rem] justify-between rounded-xl px-3 py-2 text-left text-xs" aria-label="Contact us by Email"><span className="flex min-w-0 items-center gap-2"><Mail className="h-4 w-4 shrink-0 text-[hsl(var(--mint))]" aria-hidden="true" /><span className="min-w-0"><span className="block font-semibold">Contact us by Email</span><span className="mt-0.5 block truncate text-[10px] text-muted-foreground">Send a message</span></span></span><ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /></a> : <UnavailableOption icon={<Mail className="h-4 w-4" aria-hidden="true" />} label="Contact us by Email" loading={settingsLoading} enabled={supportEmailEnabled} />}
      {supportAiHelpDeskEnabled ? <HelpDeskDialog /> : <UnavailableOption icon={<MessageCircle className="h-4 w-4" aria-hidden="true" />} label="AI Help Desk" loading={settingsLoading} enabled={supportAiHelpDeskEnabled} />}
    </div>
  </section>;
}

function UnavailableOption({ icon, label, loading, enabled }: { icon: ReactNode; label: string; loading: boolean; enabled: boolean }) {
  const status = loading ? "Checking availability…" : enabled ? "Not configured" : "Disabled";
  return <div className="flex min-h-[3.5rem] items-center gap-2 rounded-xl border border-[hsl(var(--line)/0.7)] bg-[hsl(var(--ink)/0.28)] px-3 py-2 text-xs text-muted-foreground" aria-disabled="true"><span className="shrink-0 opacity-60">{icon}</span><span className="min-w-0"><span className="block font-semibold text-foreground/75">{label}</span><span className="mt-0.5 block text-[10px]">{status}</span></span></div>;
}
