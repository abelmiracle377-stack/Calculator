import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { LogIn, LogOut, Mic2, Radar, ShieldCheck } from "lucide-react";
import { AppSettings } from "@/entities";
import { Button } from "@/components/ui/button";
import { InstallAppControl } from "@/components/pwa/InstallAppControl";

const LOGO_URL =
  "https://ellprnxjjzatijdxcogk.supabase.co/storage/v1/render/image/public/files/chat-generated-images/project-zsluhniotqu8lwiuishg/56d2d814-484f-4356-bfee-d2bcefbd2f4b.png?width=128&resize=contain&quality=75";

const DEFAULT_BRANDING = {
  workspaceName: "Verbatim Desk",
  shortLabel: "Internal staff tool",
  description: "Private audio transcription workspace for accurate review.",
};

type PublicSettingsRow = Record<string, unknown>;

function safeBrandingText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

interface AppHeaderProps {
  isAuth: boolean;
  userEmail?: string;
  loginUrl: string;
  signupUrl: string;
  onLogout: () => void;
}

export function AppHeader({
  isAuth,
  userEmail,
  loginUrl,
  signupUrl,
  onLogout,
}: AppHeaderProps) {
  const [branding, setBranding] = useState(DEFAULT_BRANDING);

  useEffect(() => {
    let cancelled = false;
    const loadBranding = async () => {
      try {
        const rows = await AppSettings.filter({ settings_key: "default" }, "-updated_at", 1) as PublicSettingsRow[];
        const row = Array.isArray(rows) ? rows[0] : undefined;
        if (!row || cancelled) return;
        setBranding({
          workspaceName: safeBrandingText(row.workspace_name, DEFAULT_BRANDING.workspaceName, 80),
          shortLabel: safeBrandingText(row.short_label, DEFAULT_BRANDING.shortLabel, 80),
          description: safeBrandingText(row.description, DEFAULT_BRANDING.description, 360),
        });
      } catch {
        // The public header keeps its built-in identity when settings are unavailable.
      }
    };
    void loadBranding();
    return () => { cancelled = true; };
  }, []);

  return (
    <header className="tx-header">
      <div className="tx-header-brand" title={branding.description}>
        <img src={LOGO_URL} alt="" className="tx-logo" width={36} height={36} />
        <div className="min-w-0">
          <p className="tx-kicker">{branding.shortLabel}</p>
          <h1 className="tx-title">
            <Mic2 className="tx-title-icon" aria-hidden />
            <span className="truncate">{branding.workspaceName}</span>
          </h1>
          <p className="hidden max-w-[24rem] truncate text-[11px] text-muted-foreground lg:block" title={branding.description}>{branding.description}</p>
        </div>
      </div>

      <div className="tx-header-actions">
        <InstallAppControl />
        {isAuth ? (
          <>
            <span className="tx-user-chip" title={userEmail}>
              {userEmail}
            </span>
            <Link
              to="/pentesting"
              className="tx-link-btn tx-link-btn-ghost shrink-0 px-2.5 sm:px-3.5"
              aria-label="Open AI Pentesting workspace"
              title="Open AI Pentesting workspace"
            >
              <Radar className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="hidden sm:inline">AI Pentesting</span>
              <span className="sm:hidden">Pentest</span>
            </Link>
            <Link
              to="/admin"
              className="tx-link-btn tx-link-btn-ghost shrink-0 px-2.5 sm:px-3.5"
              aria-label="Open administrator panel"
              title="Open administrator panel"
            >
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="hidden sm:inline">Admin panel</span>
              <span className="sm:hidden">Admin</span>
            </Link>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="tx-btn-ghost shrink-0"
              onClick={onLogout}
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </Button>
          </>
        ) : (
          <>
            <a href={loginUrl} className="tx-link-btn tx-link-btn-ghost">
              <LogIn className="h-3.5 w-3.5" />
              Sign in
            </a>
            <a href={signupUrl} className="tx-link-btn tx-link-btn-solid">
              Create account
            </a>
          </>
        )}
      </div>
    </header>
  );
}
