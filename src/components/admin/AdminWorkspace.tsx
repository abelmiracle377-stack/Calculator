import { useCallback, useEffect, useState } from "react";
import { BellRing, BookOpen, CircleDollarSign, Clock3, FileText, Inbox, LayoutDashboard, LifeBuoy, LogOut, Mic2, Palette, Radar, RefreshCw, Settings2, ShieldCheck, Sparkles, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AdminPaymentPanel } from "@/components/billing/AdminPaymentPanel";
import { AdminUsers } from "@/components/admin/AdminUsers";
import { AdminAccessHistory } from "@/components/admin/AdminAccessHistory";
import { AdminLearningPanel } from "@/components/admin/AdminLearningPanel";
import { AdminAppSettingsPanel } from "@/components/admin/AdminAppSettingsPanel";
import { AdminAccessRequests } from "@/components/admin/AdminAccessRequests";
import { AdminSupportCenter } from "@/components/admin/AdminSupportCenter";
import { CyberSecurityPanel } from "@/components/admin/CyberSecurityPanel";
import { adminAccessAction, isAdminAccessDenied } from "@/lib/admin/adminAccess";
import type { AdminHistoryResponse, AdminOverviewResponse, AdminUsersResponse } from "@/lib/billing/types";

const LOGO_URL = "https://ellprnxjjzatijdxcogk.supabase.co/storage/v1/render/image/public/files/chat-generated-images/project-zsluhniotqu8lwiuishg/56d2d814-484f-4356-bfee-d2bcefbd2f4b.png?width=96&resize=contain&quality=75";
type AdminTab = "overview" | "users" | "access-requests" | "support" | "app-settings" | "billing" | "settings" | "history" | "learning" | "security-range";
const NAV: { id: AdminTab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "users", label: "User management", icon: Users },
  { id: "access-requests", label: "Access requests", icon: Inbox },
  { id: "billing", label: "Payment review", icon: CircleDollarSign },
  { id: "support", label: "Support", icon: LifeBuoy },
  { id: "app-settings", label: "App settings", icon: Palette },
  { id: "settings", label: "Settings", icon: Settings2 },
  { id: "history", label: "Access history", icon: Clock3 },
  { id: "learning", label: "AI Learning", icon: Sparkles },
  { id: "security-range", label: "CyberAI Security Range", icon: Radar },
];
type NotificationSummary = { unread_count?: unknown; notifications?: Array<{ is_read?: unknown }> };

function Metric({ label, value, tone = "", detail }: { label: string; value: number | string; tone?: string; detail?: string }) { return <div className={`admin-metric ${tone}`}><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>; }
function GenericPrivateFallback({ onLogout }: { onLogout: () => void }) { return <main className="admin-page"><div className="admin-fallback"><div className="admin-fallback-mark"><ShieldCheck className="h-6 w-6" /></div><p className="admin-eyebrow">Private workspace</p><h1>Page not found</h1><p>This protected workspace could not be opened.</p><div className="admin-fallback-actions"><Button type="button" variant="outline" onClick={onLogout}><LogOut className="h-4 w-4" />Sign out</Button><a className="admin-link-button" href="/"><BookOpen className="h-4 w-4" />Return to Verbatim Desk</a></div></div></main>; }

export function AdminWorkspace({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState<AdminTab>("overview");
  const [overview, setOverview] = useState<AdminOverviewResponse | null>(null);
  const [users, setUsers] = useState<AdminUsersResponse | null>(null);
  const [history, setHistory] = useState<AdminHistoryResponse | null>(null);
  const [appSettingsRefreshToken, setAppSettingsRefreshToken] = useState(0);
  const [accessRequestsRefreshToken, setAccessRequestsRefreshToken] = useState(0);
  const [supportRefreshToken, setSupportRefreshToken] = useState(0);
  const [learningRefreshToken, setLearningRefreshToken] = useState(0);
  const [securityRefreshToken, setSecurityRefreshToken] = useState(0);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [loading, setLoading] = useState(true); const [refreshing, setRefreshing] = useState(false); const [error, setError] = useState(""); const [denied, setDenied] = useState(false);
  const loadOverview = useCallback(async (quiet = false) => { if (quiet) setRefreshing(true); else setLoading(true); setError(""); try { setOverview(await adminAccessAction<AdminOverviewResponse>({ action: "overview" })); setDenied(false); } catch (requestError) { console.error("Could not load administrator overview", requestError); if (isAdminAccessDenied(requestError)) setDenied(true); else setError("The private overview could not be loaded."); } finally { setLoading(false); setRefreshing(false); } }, []);
  const loadUnreadNotifications = useCallback(async () => { try { const next = await adminAccessAction<NotificationSummary>({ action: "notifications" }); const supplied = Number(next.unread_count); const fallback = Array.isArray(next.notifications) ? next.notifications.filter((row) => row.is_read !== true).length : 0; setUnreadNotificationCount(Number.isFinite(supplied) ? Math.max(0, Math.floor(supplied)) : fallback); } catch (requestError) { if (isAdminAccessDenied(requestError)) setDenied(true); else console.error("Could not load administrator notification count"); } }, []);
  const loadUsers = useCallback(async () => { setLoading(true); setError(""); try { setUsers(await adminAccessAction<AdminUsersResponse>({ action: "users" })); setDenied(false); } catch (requestError) { console.error("Could not load administrator users", requestError); if (isAdminAccessDenied(requestError)) setDenied(true); else setError("The user directory could not be loaded."); } finally { setLoading(false); } }, []);
  const loadHistory = useCallback(async () => { setLoading(true); setError(""); try { setHistory(await adminAccessAction<AdminHistoryResponse>({ action: "history" })); setDenied(false); } catch (requestError) { console.error("Could not load access history", requestError); if (isAdminAccessDenied(requestError)) setDenied(true); else setError("Access history could not be loaded."); } finally { setLoading(false); } }, []);
  useEffect(() => { void loadOverview(); }, [loadOverview]);
  useEffect(() => { void loadUnreadNotifications(); }, [loadUnreadNotifications]);
  useEffect(() => { if (tab === "users" && !users) void loadUsers(); if (tab === "history" && !history) void loadHistory(); }, [tab, users, history, loadUsers, loadHistory]);
  const refresh = async () => { if (tab === "users") await loadUsers(); else if (tab === "history") await loadHistory(); else if (tab === "app-settings") setAppSettingsRefreshToken((value) => value + 1); else if (tab === "access-requests") setAccessRequestsRefreshToken((value) => value + 1); else if (tab === "support") setSupportRefreshToken((value) => value + 1); else if (tab === "learning") setLearningRefreshToken((value) => value + 1); else if (tab === "security-range") setSecurityRefreshToken((value) => value + 1); else await loadOverview(true); };
  const reloadAfterUserChange = async () => { await Promise.all([loadUsers(), loadOverview(true)]); };
  if (denied) return <GenericPrivateFallback onLogout={onLogout} />;
  const counts = overview?.counts;
  return <main className="admin-page"><div className="tx-atmosphere" aria-hidden /><div className="admin-frame"><header className="admin-header"><div className="admin-brand"><img src={LOGO_URL} alt="" width={36} height={36} /><div><p className="admin-eyebrow">Private operations</p><h1><Mic2 className="h-4 w-4" />Verbatim Desk</h1></div></div><div className="admin-header-actions"><span className="admin-connection"><span aria-hidden />Server access confirmed</span><Button type="button" variant="outline" className="admin-header-button" onClick={onLogout}><LogOut className="h-4 w-4" />Sign out</Button></div></header>
    <nav className="admin-nav" aria-label="Administrator sections">{NAV.map(({ id, label, icon: Icon }) => <button type="button" key={id} className={`admin-nav-button ${tab === id ? "is-active" : ""}`} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}><Icon className="h-4 w-4" />{label}{id === "support" && unreadNotificationCount > 0 && <span className="ml-auto rounded-full bg-[hsl(var(--coral))] px-1.5 py-0.5 text-[10px] leading-none text-white" aria-label={`${unreadNotificationCount} unread notifications`}>{unreadNotificationCount > 99 ? "99+" : unreadNotificationCount}</span>}</button>)}</nav>
    <div className="admin-content"><div className="admin-content-top"><div><p className="admin-eyebrow">Administrator workspace</p><h2>{NAV.find((item) => item.id === tab)?.label}</h2><p className="admin-subtitle">Review access, payment decisions, account activity, and AI learning from one protected view.</p></div><div className="admin-content-actions"><Button type="button" variant="outline" className="admin-header-button" onClick={() => void refresh()} disabled={loading || refreshing}><RefreshCw className={`h-4 w-4 ${loading || refreshing ? "animate-spin" : ""}`} />Refresh</Button><a className="admin-back-link" href="/"><BookOpen className="h-3.5 w-3.5" />Open transcription desk</a></div></div>
      {error && <div className="admin-feedback is-error" role="alert">{error}</div>}
      {tab === "overview" && <section className="admin-overview"><div className="admin-overview-intro"><div><p className="admin-section-kicker">Live account picture</p><h3>Access at a glance</h3><p>Counts are derived from current access profiles, payment submissions, and Premium dates. The directory never fabricates missing account or network data.</p></div><ShieldCheck className="h-7 w-7" /></div>{loading && !overview ? <div className="admin-loading"><RefreshCw className="h-4 w-4 animate-spin" />Loading protected records…</div> : <><div className="admin-metric-grid"><Metric label="Accounts available" value={counts?.total_users ?? "—"} detail={overview?.scope.user_list_available ? "Platform account list" : "Profile scope only"} /><Metric label="Access profiles" value={counts?.total_profiles ?? 0} detail="Server-maintained records" /><Metric label="Trialing" value={counts?.trialing ?? 0} tone="is-mint" /><Metric label="Trial expired" value={counts?.trial_expired ?? 0} tone="is-coral" /><Metric label="Payment pending" value={counts?.payment_pending ?? 0} tone="is-amber" /><Metric label="Premium active" value={counts?.premium_active ?? 0} tone="is-mint" /><Metric label="Premium expired" value={counts?.premium_expired ?? 0} tone="is-coral" /><Metric label="Manually restricted" value={counts?.manually_restricted ?? 0} tone="is-amber" /></div><div className="admin-scope-note"><FileText className="h-4 w-4" /><span>{overview?.scope.account_timing_note}</span></div><div className="admin-quick-actions"><button type="button" onClick={() => setTab("users")}><Users className="h-4 w-4" /><span><strong>Open user directory</strong><small>Search account status, dates, notes, and trusted IP history.</small></span></button><button type="button" onClick={() => setTab("billing")}><CircleDollarSign className="h-4 w-4" /><span><strong>Open Payment review</strong><small>Review submitted payments, inspect private receipts, and make manual approval decisions.</small></span></button><button type="button" onClick={() => setTab("history")}><Clock3 className="h-4 w-4" /><span><strong>Trace access history</strong><small>See lifecycle and billing events without receipt payloads.</small></span></button><button type="button" className="is-alert" onClick={() => setTab("app-settings")}><BellRing className="h-4 w-4" /><span><strong>Access request alerts</strong><small>New requests can email the administrator. Manage the destination and switch in App settings.</small></span></button></div></>}</section>}
      {tab === "users" && <AdminUsers users={users?.users || []} scope={users?.scope} loading={loading} onRefresh={() => void loadUsers()} onChanged={() => void reloadAfterUserChange()} onDenied={() => setDenied(true)} />}
      {tab === "access-requests" && <AdminAccessRequests refreshToken={accessRequestsRefreshToken} onDenied={() => setDenied(true)} />}
      {tab === "support" && <AdminSupportCenter refreshToken={supportRefreshToken} onDenied={() => setDenied(true)} onUnreadCountChange={setUnreadNotificationCount} onOpenAccessRequest={() => { setTab("access-requests"); setAccessRequestsRefreshToken((value) => value + 1); }} />}
      {tab === "app-settings" && <AdminAppSettingsPanel refreshToken={appSettingsRefreshToken} onDenied={() => setDenied(true)} />}
      {tab === "history" && <AdminAccessHistory history={history} loading={loading} onRefresh={() => void loadHistory()} onDenied={() => setDenied(true)} />}
      {tab === "learning" && <AdminLearningPanel refreshToken={learningRefreshToken} onDenied={() => setDenied(true)} />}
      {tab === "security-range" && <CyberSecurityPanel refreshToken={securityRefreshToken} onDenied={() => setDenied(true)} />}
      {tab === "billing" && <AdminPaymentPanel view="billing" onClose={() => setTab("overview")} onBillingChanged={() => void loadOverview(true)} />}
      {tab === "settings" && <AdminPaymentPanel view="settings" onClose={() => setTab("overview")} onBillingChanged={() => void loadOverview(true)} />}
    </div></div></main>;
}
