import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, LogIn, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { superdevClient } from "@/lib/superdev/client";
import { AdminWorkspace } from "@/components/admin/AdminWorkspace";

function authUrls() {
  const currentPath = encodeURIComponent(window.location.href);
  const loginUrl = (superdevClient.auth.client.options.loginUrl + "&from_url=" + currentPath).replace("/api", "");
  const signupUrl = loginUrl.includes("app-login") ? loginUrl.replace("app-login", "app-signup") : loginUrl;
  return { loginUrl, signupUrl };
}

function PrivateFallback({ loginUrl, signedIn, onLogout }: { loginUrl: string; signedIn: boolean; onLogout?: () => void }) {
  return <main className="admin-page"><div className="admin-fallback"><div className="admin-fallback-mark"><ShieldCheck className="h-6 w-6" /></div><p className="admin-eyebrow">Private workspace</p><h1>{signedIn ? "Page not found" : "Sign in to continue"}</h1><p>{signedIn ? "This protected workspace could not be opened." : "Sign in with your Buildy account to continue."}</p><div className="admin-fallback-actions">{signedIn ? <><Button type="button" variant="outline" onClick={onLogout}><LogOut className="h-4 w-4" />Sign out</Button><a className="admin-link-button" href="/"><ArrowLeft className="h-4 w-4" />Return to Verbatim Desk</a></> : <><a className="admin-link-button is-primary" href={loginUrl}><LogIn className="h-4 w-4" />Sign in</a><a className="admin-link-button" href="/"><ArrowLeft className="h-4 w-4" />Return to Verbatim Desk</a></>}</div></div></main>;
}

const Admin = () => {
  const { loginUrl } = useMemo(() => authUrls(), []);
  const [isAuth, setIsAuth] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  useEffect(() => { let cancelled = false; superdevClient.isAuthenticated().then((value) => { if (!cancelled) setIsAuth(value); }).catch(() => { if (!cancelled) setIsAuth(false); }).finally(() => { if (!cancelled) setAuthChecked(true); }); return () => { cancelled = true; }; }, []);
  const logout = async () => { try { await superdevClient.auth.logout(); } catch (error) { console.error("Could not sign out of private workspace", error); } setIsAuth(false); };
  if (!authChecked) return <main className="admin-page"><div className="admin-loading"><RefreshCw className="h-4 w-4 animate-spin" />Checking sign-in…</div></main>;
  if (!isAuth) return <PrivateFallback loginUrl={loginUrl} signedIn={false} />;
  return <AdminWorkspace onLogout={() => void logout()} />;
};

export default Admin;
