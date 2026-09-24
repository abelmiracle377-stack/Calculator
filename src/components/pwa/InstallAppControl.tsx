import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useInstallPrompt } from "@/lib/pwa";

const GENERIC_INSTALL_HINT =
  "Open your browser menu and choose Install app or Add to Home Screen.";

function getManualInstallHint(): string {
  if (typeof navigator === "undefined") return GENERIC_INSTALL_HINT;

  const userAgent = navigator.userAgent || "";
  const isIpadInDesktopMode =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  const isAppleTouchDevice = /iPhone|iPad|iPod/i.test(userAgent) || isIpadInDesktopMode;

  if (isAppleTouchDevice) {
    return "Tap Share, then Add to Home Screen.";
  }

  if (/Android/i.test(userAgent) && /Firefox/i.test(userAgent)) {
    return "Open the browser menu, then tap Install.";
  }

  return GENERIC_INSTALL_HINT;
}

/**
 * Compact install affordance for the shared Verbatim Desk header.
 * The preview deliberately stays quiet because it cannot provide a durable install.
 */
export function InstallAppControl() {
  const { canInstall, isInstalled, install } = useInstallPrompt();

  if (!import.meta.env.PROD || isInstalled) return null;

  if (canInstall) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="tx-btn-ghost h-8 shrink-0 rounded-full px-2.5 text-xs sm:px-3"
        onClick={() => void install()}
        aria-label="Install app"
        title="Install app"
      >
        <Download className="h-3.5 w-3.5" aria-hidden />
        <span className="hidden sm:inline">Install app</span>
        <span className="sm:hidden">Install</span>
      </Button>
    );
  }

  const hint = getManualInstallHint();

  return (
    <span
      className="tx-install-hint"
      role="note"
      aria-label={`Install app. ${hint}`}
      title={hint}
    >
      <Download aria-hidden />
      <span>{hint}</span>
    </span>
  );
}
