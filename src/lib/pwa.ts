/**
 * Installable app support. Managed by Buildy (Website Settings > Installable app).
 *
 * Registers the service worker in production builds, exposes the browser's
 * install prompt so the app can offer its own "Install app" button, shows an
 * offline bar while the connection is down, and recovers from stale route
 * chunks after a new publish. Importing this module once from src/main.tsx is
 * all the setup needed.
 */
import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type InstallOutcome = "accepted" | "dismissed" | "unavailable";

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<(canInstall: boolean) => void>();

function notifyListeners() {
  for (const listener of listeners) listener(deferredPrompt !== null);
}

/** True when the browser is ready to show its install dialog. */
export function canInstallApp(): boolean {
  return deferredPrompt !== null;
}

/** True when the page is running as an installed app, not in a browser tab. */
export function isInstalledApp(): boolean {
  if (typeof window === "undefined") return false;
  const standalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return window.matchMedia("(display-mode: standalone)").matches || standalone === true;
}

/** Opens the browser's install dialog. Call from a click handler. */
export async function promptInstallApp(): Promise<InstallOutcome> {
  if (!deferredPrompt) return "unavailable";
  const event = deferredPrompt;
  deferredPrompt = null;
  notifyListeners();
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  } catch {
    // The event is one-shot, so it is not restored; the browser fires a new
    // beforeinstallprompt when it is ready again.
    return "unavailable";
  }
}

/** Subscribe to install availability. Returns an unsubscribe function. */
export function onInstallAvailabilityChange(listener: (canInstall: boolean) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React hook for an install button.
 *
 * const { canInstall, isInstalled, install } = useInstallPrompt();
 * {canInstall && <Button onClick={install}>Install app</Button>}
 */
export function useInstallPrompt() {
  const [canInstall, setCanInstall] = useState(canInstallApp);
  const [isInstalled, setIsInstalled] = useState(isInstalledApp);

  useEffect(() => {
    const unsubscribe = onInstallAvailabilityChange(setCanInstall);
    const onInstalled = () => setIsInstalled(true);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      unsubscribe();
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  return { canInstall, isInstalled, install: promptInstallApp };
}

/** True when the browser reports a network connection. */
export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

/** Subscribe to connectivity changes. Returns an unsubscribe function. */
export function onOnlineStatusChange(listener: (online: boolean) => void) {
  if (typeof window === "undefined") return () => {};
  const goOnline = () => listener(true);
  const goOffline = () => listener(false);
  window.addEventListener("online", goOnline);
  window.addEventListener("offline", goOffline);
  return () => {
    window.removeEventListener("online", goOnline);
    window.removeEventListener("offline", goOffline);
  };
}

/**
 * React hook for pages that depend on live data.
 *
 * const online = useOnlineStatus();
 * {!online && <p>You are offline. Showing saved data.</p>}
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(isOnline);
  useEffect(() => onOnlineStatusChange(setOnline), []);
  return online;
}

// A bar along the bottom of the page while the browser is offline, so a
// visitor knows why data and buttons stop working, and a short "Back online"
// note when the connection returns. Production only; the Buildy preview is a
// dev server and should not show app chrome.
function showOfflineBar() {
  if (!import.meta.env.PROD) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const BAR_ID = "buildy-offline-bar";
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const render = (online: boolean) => {
    let bar = document.getElementById(BAR_ID);
    if (!bar) {
      bar = document.createElement("div");
      bar.id = BAR_ID;
      bar.setAttribute("role", "status");
      bar.style.cssText =
        "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:10px 16px;" +
        "font:14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;" +
        "color:#fff;transition:transform .2s ease";
      document.body.appendChild(bar);
    }
    clearTimeout(hideTimer);
    bar.style.background = online ? "#15803d" : "#111";
    bar.style.transform = "translateY(0)";
    bar.textContent = online
      ? "Back online"
      : "You are offline. Some features may not work until you reconnect.";
    if (online) {
      hideTimer = setTimeout(() => {
        bar.style.transform = "translateY(100%)";
      }, 2000);
    }
  };

  const start = () => {
    if (!isOnline()) render(false);
    onOnlineStatusChange((online) => {
      // "Back online" only after an offline period, never on a plain page load.
      if (online && !document.getElementById(BAR_ID)) return;
      render(online);
    });
  };

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}

// After a new publish, a tab that still runs the old build asks the server for
// route chunks that no longer exist and gets 404s. Vite reports the failed lazy
// import as "vite:preloadError" and the page would otherwise go blank. Online,
// reload once to pick up the new build. Offline, leave it to the offline bar.
const CHUNK_RELOAD_KEY = "buildy-pwa-chunk-reload";
const CHUNK_RELOAD_COOLDOWN_MS = 10_000;

function recoverFromStaleChunks() {
  if (!import.meta.env.PROD) return;
  if (typeof window === "undefined") return;

  window.addEventListener("vite:preloadError", (event) => {
    if (!isOnline()) return;
    let lastReload = 0;
    try {
      lastReload = Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)) || 0;
    } catch {
      // Storage blocked; still try one reload.
    }
    if (Date.now() - lastReload < CHUNK_RELOAD_COOLDOWN_MS) return;
    try {
      window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    } catch {
      // Storage blocked; the cooldown does not apply.
    }
    event.preventDefault();
    window.location.reload();
  });
}

function registerServiceWorker() {
  // The dev server (Buildy preview) must never run a service worker: it would
  // cache dev modules and hide edits. Only production builds register it.
  if (!import.meta.env.PROD) return;
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

  window.addEventListener("load", async () => {
    try {
      // On the very first install the worker claims the page and fires
      // controllerchange; only later changes mean a new version shipped.
      let hadController = Boolean(navigator.serviceWorker.controller);
      let reloading = false;

      const registration = await navigator.serviceWorker.register("/sw.js", {
        updateViaCache: "none",
      });

      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            worker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });

      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!hadController) {
          hadController = true;
          return;
        }
        if (reloading) return;
        reloading = true;
        window.location.reload();
      });
    } catch (error) {
      console.warn("[pwa] Service worker registration failed", error);
    }
  });
}

// The Buildy live preview runs the dev server and serves the same index.html as
// the published build, so the install manifest is present there too. But the
// preview registers no service worker (production only, above) and its URL is a
// temporary sandbox host, so an app installed from the preview cannot work
// offline and breaks the moment the network drops. Remove the manifest in the
// preview so only the published production site is installable.
function disablePreviewInstall() {
  if (import.meta.env.PROD) return;
  if (typeof document === "undefined") return;
  document.querySelectorAll('link[rel="manifest"]').forEach((link) => link.remove());
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notifyListeners();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notifyListeners();
  });
}

disablePreviewInstall();
showOfflineBar();
recoverFromStaleChunks();
registerServiceWorker();
