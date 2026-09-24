import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Archive, Ban, CheckCircle2, ClipboardCheck, FileCheck2, Info, LockKeyhole, Pencil, Plus, RefreshCw, Search, ShieldAlert, ShieldCheck, Target, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cyberSecurityAdmin } from "@/functions";
import { CYBER_ASSET_TYPES, CYBER_TESTING_METHODS, type CyberAsset, type CyberAssetType, type CyberAuthorizationRecord, type CyberAuditEvent, type CyberSecurityOverview, type CyberTestingMethod } from "@/lib/security/types";
import { assetType, dateInputToIso, dateInputValue, listInput, normalizeCyberTarget, validatePortList } from "@/lib/security/validation";

type Props = { refreshToken: number; onDenied: () => void };
type AssetDraft = { name: string; asset_type: CyberAssetType; target: string; description: string };
type AuthorizationDraft = { scope_target: string; scope_ports: string; scope_web_paths: string; allowed_testing_methods: CyberTestingMethod[]; evidence_reference: string; valid_from: string; valid_until: string };
const CYBER_REQUEST_TIMEOUT_MS = 12_000;
const METHOD_LABELS: Record<CyberTestingMethod, string> = {
  PORT_DISCOVERY: "Port discovery",
  SERVICE_IDENTIFICATION: "Service identification",
  HTTP_SECURITY_REVIEW: "HTTP security review",
  TLS_CONFIGURATION_REVIEW: "TLS configuration review",
  DNS_CONFIGURATION_REVIEW: "DNS configuration review",
  VULNERABILITY_ASSESSMENT: "Vulnerability assessment",
};

function today(offset = 0): string { const date = new Date(); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); }
function newAssetDraft(): AssetDraft { return { name: "", asset_type: "Domain", target: "", description: "" }; }
function newAuthorizationDraft(): AuthorizationDraft { return { scope_target: "", scope_ports: "", scope_web_paths: "", allowed_testing_methods: ["PORT_DISCOVERY"], evidence_reference: "", valid_from: today(), valid_until: today(30) }; }
function emptyOverview(): CyberSecurityOverview { return { assets: [], authorization_records: [], audit_events: [], metrics: { total_assets: 0, active_assets: 0, active_authorizations: 0, authorizations_expiring_30_days: 0 }, scope: { assessment_enabled: false, external_targets_contacted: false, future_role_expansion: "Future role expansion is deferred." } }; }
function objectValue(value: unknown): Record<string, unknown> {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current === "string") { try { current = JSON.parse(current); continue; } catch { return {}; } }
    if (!current || typeof current !== "object" || Array.isArray(current)) return {};
    const record = current as Record<string, unknown>;
    const nested = record.result ?? record.data;
    if (nested !== undefined && nested !== current) {
      const nestedRecord = objectValue(nested);
      if (Object.keys(nestedRecord).length) return { ...record, ...nestedRecord };
    }
    return record;
  }
  return {};
}
function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const response = record.response && typeof record.response === "object" ? record.response as Record<string, unknown> : {};
  const status = Number(record.status ?? record.statusCode ?? response.status);
  return Number.isFinite(status) && status > 0 ? status : undefined;
}
function errorText(value: unknown): string { if (typeof value === "string") return value; if (value && typeof value === "object" && "message" in value) return String((value as Record<string, unknown>).message || ""); return "The protected security service could not be reached."; }
class CyberActionError extends Error { status?: number; constructor(message: string, status?: number) { super(message); this.name = "CyberActionError"; this.status = status; } }
function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CyberActionError("The protected security request timed out. Try again.", 408)), CYBER_REQUEST_TIMEOUT_MS);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
async function callCyber(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const body = objectValue(await withTimeout(Promise.resolve(cyberSecurityAdmin(payload))));
    if (body.error) throw new CyberActionError(errorText(body.error), errorStatus(body));
    return body;
  } catch (error) {
    if (error instanceof CyberActionError) throw error;
    throw new CyberActionError(errorText(error), errorStatus(error));
  }
}
function denied(error: unknown): boolean {
  const status = error instanceof CyberActionError ? error.status : errorStatus(error);
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase();
  return status === 401 || status === 403 || status === 404 || message.includes("not found") || message.includes("authentication required") || message.includes("unauthorized") || message.includes("forbidden");
}
function formatDate(value: string): string { if (!value) return "Not recorded"; const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date) : "Not recorded"; }
function formatDateTime(value: string): string { if (!value) return "Not recorded"; const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date) : "Not recorded"; }
function statusTone(value: string): string {
  const status = value.toUpperCase();
  if (status === "ACTIVE") return "border-[hsl(var(--mint)/0.38)] bg-[hsl(var(--mint)/0.1)] text-[hsl(var(--mint))]";
  if (status === "PENDING") return "border-[hsl(var(--warn)/0.4)] bg-[hsl(var(--warn)/0.1)] text-[hsl(var(--warn))]";
  if (status === "ARCHIVED") return "border-[hsl(var(--line))] bg-[hsl(var(--ink-soft)/0.45)] text-[hsl(var(--muted-foreground))]";
  return "border-[hsl(var(--coral)/0.38)] bg-[hsl(var(--coral)/0.1)] text-[hsl(var(--coral))]";
}
function safeOverview(body: Record<string, unknown>): CyberSecurityOverview {
  const metrics = body.metrics && typeof body.metrics === "object" ? body.metrics as Record<string, unknown> : {};
  const scope = body.scope && typeof body.scope === "object" ? body.scope as Record<string, unknown> : {};
  const number = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
  return { assets: Array.isArray(body.assets) ? body.assets as CyberAsset[] : [], authorization_records: Array.isArray(body.authorization_records) ? body.authorization_records as CyberAuthorizationRecord[] : [], audit_events: Array.isArray(body.audit_events) ? body.audit_events as CyberAuditEvent[] : [], metrics: { total_assets: number(metrics.total_assets), active_assets: number(metrics.active_assets), active_authorizations: number(metrics.active_authorizations), authorizations_expiring_30_days: number(metrics.authorizations_expiring_30_days) }, scope: { assessment_enabled: false, external_targets_contacted: false, future_role_expansion: typeof scope.future_role_expansion === "string" ? scope.future_role_expansion : "Future role expansion is deferred." } };
}
function Metric({ label, value, tone = "", detail }: { label: string; value: number; tone?: string; detail: string }) { return <div className={`admin-metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }
function DetailPoint({ label, value }: { label: string; value: string }) { return <div className="admin-data-point"><span>{label}</span><strong>{value || "Not recorded"}</strong></div>; }
function StatusBadge({ value }: { value: string }) { const label = value || "UNKNOWN"; return <span className={`admin-status ${statusTone(label)}`}>{label.replaceAll("_", " ")}</span>; }

export function CyberSecurityPanel({ refreshToken, onDenied }: Props) {
  const [overview, setOverview] = useState<CyberSecurityOverview>(() => emptyOverview());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [savingAction, setSavingAction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [selectedId, setSelectedId] = useState("");
  const [assetFormOpen, setAssetFormOpen] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [assetDraft, setAssetDraft] = useState<AssetDraft>(newAssetDraft);
  const [authorizationDraft, setAuthorizationDraft] = useState<AuthorizationDraft>(newAuthorizationDraft);
  const [renewingId, setRenewingId] = useState("");
  const [renewalDate, setRenewalDate] = useState("");
  const [renewalNote, setRenewalNote] = useState("");
  const [archiveConfirmationId, setArchiveConfirmationId] = useState("");
  const [revokeConfirmationId, setRevokeConfirmationId] = useState("");
  const deniedHandler = useRef(onDenied);
  const loadSequence = useRef(0);
  useEffect(() => { deniedHandler.current = onDenied; }, [onDenied]);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true); setLoadError(""); setError("");
    try {
      const body = await callCyber({ action: "overview" });
      if (!Array.isArray(body.assets) || !Array.isArray(body.authorization_records)) throw new CyberActionError("The protected security service returned an unexpected records response.");
      if (sequence === loadSequence.current) setOverview(safeOverview(body));
    } catch (requestError) {
      if (sequence !== loadSequence.current) return;
      console.error("Could not load CyberAI security records", requestError);
      if (denied(requestError)) deniedHandler.current();
      else { const message = requestError instanceof Error ? requestError.message : "The CyberAI security records could not be loaded."; setLoadError(message); setError(message); }
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load, refreshToken]);

  const assets = overview.assets;
  const authorizations = overview.authorization_records;
  const audits = overview.audit_events;
  const selectedAsset = assets.find((asset) => asset.id === selectedId) || null;
  const selectedAuthorizations = useMemo(() => selectedAsset ? authorizations.filter((record) => record.asset_id === selectedAsset.id) : [], [authorizations, selectedAsset]);
  const visibleAssets = useMemo(() => assets.filter((asset) => {
    const needle = search.trim().toLowerCase();
    const matchesSearch = !needle || [asset.name, asset.target, asset.asset_type, asset.owner_email].some((value) => String(value || "").toLowerCase().includes(needle));
    return matchesSearch && (statusFilter === "ALL" || asset.status === statusFilter) && (typeFilter === "ALL" || asset.asset_type === typeFilter);
  }), [assets, search, statusFilter, typeFilter]);
  useEffect(() => { if (selectedId && assets.some((asset) => asset.id === selectedId)) return; setSelectedId(visibleAssets[0]?.id || assets[0]?.id || ""); }, [assets, selectedId, visibleAssets]);

  const isActionRunning = (action: string) => savingAction === action;
  const runAction = async (action: string, payload: Record<string, unknown>, successMessage: string): Promise<boolean> => {
    setSavingAction(action); setError(""); setNotice("");
    try { await callCyber({ action, ...payload }); setNotice(successMessage); await load(); return true; }
    catch (requestError) { console.error(`CyberAI action failed: ${action}`, requestError); if (denied(requestError)) deniedHandler.current(); else setError(requestError instanceof Error ? requestError.message : "The protected action could not be completed."); return false; }
    finally { setSavingAction((current) => current === action ? "" : current); }
  };

  const closeAssetForm = () => { setAssetFormOpen(false); setEditingId(""); setAssetDraft(newAssetDraft()); };
  const submitAsset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const type = assetType(assetDraft.asset_type); const target = normalizeCyberTarget(type, assetDraft.target);
      if (!assetDraft.name.trim()) throw new Error("An asset name is required.");
      const action = editingId ? "update_asset" : "create_asset";
      const saved = await runAction(action, editingId ? { asset_id: editingId, name: assetDraft.name.trim(), description: assetDraft.description } : { name: assetDraft.name.trim(), asset_type: type, target, description: assetDraft.description }, editingId ? "Asset metadata updated." : "Authorized asset added.");
      if (saved) closeAssetForm();
    } catch (validationError) { setError(validationError instanceof Error ? validationError.message : "Check the asset details and try again."); }
  };
  const beginEdit = () => { if (!selectedAsset) return; setEditingId(selectedAsset.id); setAssetDraft({ name: selectedAsset.name, asset_type: selectedAsset.asset_type, target: selectedAsset.target, description: selectedAsset.description }); setAssetFormOpen(true); setError(""); setNotice(""); };
  const beginCreate = () => { setEditingId(""); setAssetDraft(newAssetDraft()); setAssetFormOpen(true); setError(""); setNotice(""); };
  const clearFilters = () => { setSearch(""); setStatusFilter("ALL"); setTypeFilter("ALL"); };
  const requestArchive = () => { if (selectedAsset) { setArchiveConfirmationId(selectedAsset.id); setError(""); setNotice(""); } };
  const confirmArchive = async () => { if (!selectedAsset || archiveConfirmationId !== selectedAsset.id) return; setArchiveConfirmationId(""); await runAction("archive_asset", { asset_id: selectedAsset.id }, "Asset archived."); };
  const submitAuthorization = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!selectedAsset) return;
    try {
      const scopeTarget = authorizationDraft.scope_target.trim(); if (!scopeTarget) throw new Error("An explicit authorization scope is required.");
      const methods = authorizationDraft.allowed_testing_methods; if (!methods.length) throw new Error("Select at least one allowed testing method.");
      const validFrom = dateInputToIso(authorizationDraft.valid_from, "Valid from"); const validUntil = dateInputToIso(authorizationDraft.valid_until, "Valid until");
      if (new Date(validUntil).getTime() <= new Date(validFrom).getTime()) throw new Error("Valid until must be later than valid from.");
      const saved = await runAction("create_authorization", { asset_id: selectedAsset.id, scope_target: scopeTarget, scope_ports: validatePortList(listInput(authorizationDraft.scope_ports)), scope_web_paths: listInput(authorizationDraft.scope_web_paths), allowed_testing_methods: methods, evidence_reference: authorizationDraft.evidence_reference.trim(), valid_from: validFrom, valid_until: validUntil }, "Authorization submitted for explicit approval.");
      if (saved) setAuthorizationDraft(newAuthorizationDraft());
    } catch (validationError) { setError(validationError instanceof Error ? validationError.message : "Check the authorization details and try again."); }
  };
  const approve = (record: CyberAuthorizationRecord) => { void runAction("approve_authorization", { authorization_id: record.id, approval_note: "" }, "Authorization approved and active within its recorded window."); };
  const requestRevoke = (record: CyberAuthorizationRecord) => { setRevokeConfirmationId(record.id); setError(""); setNotice(""); };
  const confirmRevoke = async (record: CyberAuthorizationRecord) => { if (revokeConfirmationId !== record.id) return; setRevokeConfirmationId(""); await runAction("revoke_authorization", { authorization_id: record.id, revocation_note: "Revoked by an administrator." }, "Authorization revoked."); };
  const submitRenewal = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!renewingId) return; try { const saved = await runAction("renew_authorization", { authorization_id: renewingId, valid_until: dateInputToIso(renewalDate, "New valid until"), renewal_note: renewalNote }, "Authorization validity window renewed."); if (saved) { setRenewingId(""); setRenewalDate(""); setRenewalNote(""); } } catch (validationError) { setError(validationError instanceof Error ? validationError.message : "Check the renewal date and try again."); } };
  const toggleMethod = (method: CyberTestingMethod, checked: boolean) => setAuthorizationDraft((draft) => ({ ...draft, allowed_testing_methods: checked ? [...new Set([...draft.allowed_testing_methods, method])] : draft.allowed_testing_methods.filter((item) => item !== method) }));

  return <section className="admin-overview space-y-4" aria-labelledby="cyberai-panel-title">
    <div className="admin-overview-intro"><div><p className="admin-section-kicker">Defensive authorization boundary</p><h3 id="cyberai-panel-title">CyberAI Security Range</h3><p>Maintain the administrator-approved inventory and authorization records used by the future security range. Every target needs an explicit scope and evidence reference before any assessment could be considered.</p></div><ShieldCheck className="h-7 w-7" aria-hidden="true" /></div>
    <div className="admin-feedback" role="note"><LockKeyhole className="h-4 w-4" /><span>No external target is contacted in Phase 1. This panel stores authorization metadata only. Scanning, shell access, Nmap, Nuclei, OWASP ZAP, Metasploit, findings, monitoring, and reports remain disabled.</span></div>
    {error && <div className="admin-feedback is-error" role="alert"><ShieldAlert className="h-4 w-4" />{error}</div>}
    {notice && <div className="admin-feedback is-success" role="status"><CheckCircle2 className="h-4 w-4" />{notice}</div>}
    <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground" role="status" aria-live="polite"><span className="inline-flex items-center gap-2">{loading ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" />Loading protected security records…</> : loadError ? <><ShieldAlert className="h-3.5 w-3.5 text-[hsl(var(--coral))]" />Protected records are unavailable.</> : <><CheckCircle2 className="h-3.5 w-3.5 text-[hsl(var(--mint))]" />Protected records ready.</>}</span>{loadError && <Button type="button" size="sm" variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className="h-3.5 w-3.5" />Retry loading</Button>}</div>
    <div className="admin-metric-grid"><Metric label="Total assets" value={overview.metrics.total_assets} detail="Stored authorized inventory" /><Metric label="Active assets" value={overview.metrics.active_assets} tone="is-mint" detail="Not archived" /><Metric label="Active authorizations" value={overview.metrics.active_authorizations} tone="is-mint" detail="Currently within window" /><Metric label="Expiring within 30 days" value={overview.metrics.authorizations_expiring_30_days} tone="is-amber" detail="Review renewal timing" /></div>
    <div className="admin-scope-note"><Info className="h-4 w-4" /><span>{overview.scope.future_role_expansion} No fabricated ports, services, risk scores, findings, alerts, trends, or scan activity are shown.</span></div>
    <div className="admin-section-heading"><div><p className="admin-section-kicker">Authorized inventory</p><h3>Assets and scope records</h3><p>Search the protected inventory, review the latest authorization evidence, and keep lifecycle changes explicit.</p></div><Button type="button" className="admin-primary-button" onClick={beginCreate}><Plus className="h-4 w-4" />Add asset</Button></div>
    <div className="admin-directory-toolbar"><label className="admin-search-field"><Search className="h-4 w-4" /><span className="sr-only">Search authorized assets</span><Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, target, type, or owner" /></label><label className="sr-only" htmlFor="cyber-status-filter">Asset lifecycle</label><select id="cyber-status-filter" className="admin-filter-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="ALL">All lifecycles</option><option value="ACTIVE">Active</option><option value="ARCHIVED">Archived</option></select><label className="sr-only" htmlFor="cyber-type-filter">Asset type</label><select id="cyber-type-filter" className="admin-filter-select" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="ALL">All types</option>{CYBER_ASSET_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select><span className="admin-result-count">{visibleAssets.length} shown</span></div>
    {assetFormOpen && <form className="admin-detail-card" onSubmit={(event) => void submitAsset(event)}><div className="admin-detail-card-heading"><Pencil className="h-4 w-4" /><div><strong>{editingId ? "Edit asset metadata" : "Add an authorized asset"}</strong><span>{editingId ? "Asset type and target stay fixed after creation." : "Targets are normalized and checked without making a network request."}</span></div><Button type="button" variant="ghost" size="icon" className="ml-auto" aria-label="Close asset form" onClick={closeAssetForm}><X className="h-4 w-4" /></Button></div><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="grid gap-1.5 text-xs text-muted-foreground">Asset name<Input required value={assetDraft.name} onChange={(event) => setAssetDraft({ ...assetDraft, name: event.target.value })} placeholder="Production web property" /></label><label className="grid gap-1.5 text-xs text-muted-foreground">Asset type<select className="admin-filter-select w-full" disabled={Boolean(editingId)} value={assetDraft.asset_type} onChange={(event) => setAssetDraft({ ...assetDraft, asset_type: assetType(event.target.value) })}>{CYBER_ASSET_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label><label className="grid gap-1.5 text-xs text-muted-foreground sm:col-span-2">Target<Input required disabled={Boolean(editingId)} value={assetDraft.target} onChange={(event) => setAssetDraft({ ...assetDraft, target: event.target.value })} placeholder={assetDraft.asset_type === "Website" || assetDraft.asset_type === "API endpoint" ? "https://example.org/app" : "example.org or 203.0.113.10"} /></label><label className="grid gap-1.5 text-xs text-muted-foreground sm:col-span-2">Description<Textarea value={assetDraft.description} onChange={(event) => setAssetDraft({ ...assetDraft, description: event.target.value })} placeholder="Internal ownership or purpose note" /></label></div><div className="mt-3 flex flex-wrap gap-2"><Button type="submit" className="admin-primary-button" disabled={isActionRunning(editingId ? "update_asset" : "create_asset")}>{isActionRunning(editingId ? "update_asset" : "create_asset") ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{editingId ? "Save metadata" : "Create asset"}</Button><Button type="button" variant="outline" onClick={closeAssetForm}>Cancel</Button></div></form>}
    <div className="admin-users-layout"><div className="admin-user-list" aria-label="Authorized assets">{visibleAssets.length ? visibleAssets.map((asset) => <button type="button" key={asset.id} className={`admin-user-list-item ${asset.id === selectedId ? "is-selected" : ""}`} onClick={() => { setSelectedId(asset.id); setArchiveConfirmationId(""); }}><span className="admin-user-avatar"><Target className="h-4 w-4" /></span><span className="admin-user-list-copy"><strong>{asset.name}</strong><small>{asset.target}</small><StatusBadge value={asset.status} /></span></button>) : assets.length ? <div className="admin-empty"><Target className="h-5 w-5" /><span>No assets match these filters.</span><Button type="button" variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button></div> : <div className="admin-empty"><Target className="h-5 w-5" /><span>No authorized assets have been added.</span><Button type="button" className="admin-primary-button" size="sm" onClick={beginCreate}><Plus className="h-4 w-4" />Add your first asset</Button></div>}</div>
      {selectedAsset ? <div className="admin-user-detail"><div className="admin-user-detail-head"><div><p className="admin-section-kicker">Selected asset</p><h4>{selectedAsset.name}</h4><p><Target className="h-3.5 w-3.5" />{selectedAsset.target}</p></div><div className="flex flex-wrap justify-end gap-2"><StatusBadge value={selectedAsset.status} /><Button type="button" variant="outline" className="admin-header-button" onClick={beginEdit}><Pencil className="h-3.5 w-3.5" />Edit</Button>{selectedAsset.status === "ACTIVE" && (archiveConfirmationId === selectedAsset.id ? <div className="flex flex-wrap items-center gap-2 rounded-md border border-[hsl(var(--coral)/0.35)] bg-[hsl(var(--coral)/0.08)] p-2" role="alert"><span className="text-xs text-foreground">Archive this asset?</span><Button type="button" size="sm" className="admin-danger-button" onClick={() => void confirmArchive()} disabled={isActionRunning("archive_asset")}>Confirm</Button><Button type="button" size="sm" variant="ghost" onClick={() => setArchiveConfirmationId("")}>Cancel</Button></div> : <Button type="button" variant="outline" className="admin-danger-button" onClick={requestArchive} disabled={isActionRunning("archive_asset")}><Archive className="h-3.5 w-3.5" />Archive</Button>)}</div></div><div className="admin-data-grid"><DetailPoint label="Type" value={selectedAsset.asset_type} /><DetailPoint label="Owner" value={selectedAsset.owner_email} /><DetailPoint label="Created" value={formatDate(selectedAsset.created_at)} /><DetailPoint label="Last updated" value={formatDate(selectedAsset.updated_at)} /><DetailPoint label="Last updated by" value={selectedAsset.last_updated_by} /><DetailPoint label="Archived" value={formatDate(selectedAsset.archived_at)} /></div>{selectedAsset.description && <p className="admin-detail-muted">{selectedAsset.description}</p>}
        <div className="admin-detail-card"><div className="admin-detail-card-heading"><ClipboardCheck className="h-4 w-4" /><div><strong>Authorization records</strong><span>Approval is separate from record creation. A pending record cannot authorize an assessment.</span></div></div>{selectedAuthorizations.length ? <div className="mt-3 grid gap-3">{selectedAuthorizations.map((record) => <AuthorizationCard key={record.id} record={record} savingAction={savingAction} renewingId={renewingId} renewalDate={renewalDate} renewalNote={renewalNote} revokePending={revokeConfirmationId === record.id} onApprove={() => approve(record)} onRequestRevoke={() => requestRevoke(record)} onConfirmRevoke={() => void confirmRevoke(record)} onCancelRevoke={() => setRevokeConfirmationId("")} onRenew={() => { setRenewingId(record.id); setRenewalDate(dateInputValue(record.valid_until)); setRenewalNote(""); }} onRenewalDateChange={setRenewalDate} onRenewalNoteChange={setRenewalNote} onSubmitRenewal={(event) => void submitRenewal(event)} onCancelRenewal={() => setRenewingId("")} />)}</div> : <div className="admin-empty mt-3"><FileCheck2 className="h-5 w-5" /><span>No authorization record exists for this asset.</span></div>}</div>
        {selectedAsset.status === "ACTIVE" && <form className="admin-detail-card" onSubmit={(event) => void submitAuthorization(event)}><div className="admin-detail-card-heading"><FileCheck2 className="h-4 w-4" /><div><strong>Request authorization</strong><span>Record the exact scope and evidence reference. The request starts in PENDING state.</span></div></div><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="grid gap-1.5 text-xs text-muted-foreground sm:col-span-2">Explicit scope target<Input required value={authorizationDraft.scope_target} onChange={(event) => setAuthorizationDraft({ ...authorizationDraft, scope_target: event.target.value })} placeholder="Exact domain, IP, URL, or bounded scope description" /></label><label className="grid gap-1.5 text-xs text-muted-foreground">Ports or ranges<Input value={authorizationDraft.scope_ports} onChange={(event) => setAuthorizationDraft({ ...authorizationDraft, scope_ports: event.target.value })} placeholder="443, 8000-8010" /></label><label className="grid gap-1.5 text-xs text-muted-foreground">Web paths<Input value={authorizationDraft.scope_web_paths} onChange={(event) => setAuthorizationDraft({ ...authorizationDraft, scope_web_paths: event.target.value })} placeholder="/, /login, /api" /></label><label className="grid gap-1.5 text-xs text-muted-foreground sm:col-span-2">Authorization evidence reference<Input required value={authorizationDraft.evidence_reference} onChange={(event) => setAuthorizationDraft({ ...authorizationDraft, evidence_reference: event.target.value })} placeholder="Internal ticket, contract, or approval reference" /></label><label className="grid gap-1.5 text-xs text-muted-foreground">Valid from<Input required type="date" value={authorizationDraft.valid_from} onChange={(event) => setAuthorizationDraft({ ...authorizationDraft, valid_from: event.target.value })} /></label><label className="grid gap-1.5 text-xs text-muted-foreground">Valid until<Input required type="date" value={authorizationDraft.valid_until} onChange={(event) => setAuthorizationDraft({ ...authorizationDraft, valid_until: event.target.value })} /></label></div><fieldset className="mt-3 grid gap-2"><legend className="text-xs text-muted-foreground">Allowed testing methods</legend><div className="grid gap-2 sm:grid-cols-2">{CYBER_TESTING_METHODS.map((method) => <label key={method} className="flex items-center gap-2 text-xs text-foreground"><input type="checkbox" checked={authorizationDraft.allowed_testing_methods.includes(method)} onChange={(event) => toggleMethod(method, event.target.checked)} />{METHOD_LABELS[method]}</label>)}</div></fieldset><Button type="submit" className="admin-primary-button" disabled={isActionRunning("create_authorization")}>{isActionRunning("create_authorization") ? <RefreshCw className="h-4 w-4 animate-spin" /> : <FileCheck2 className="h-4 w-4" />}Submit for approval</Button></form>}
      </div> : <div className="admin-user-detail admin-empty"><Target className="h-6 w-6" /><span>Select an authorized asset to review its scope.</span></div>}
    </div>
    <div className="admin-detail-card"><div className="admin-detail-card-heading"><Ban className="h-4 w-4" /><div><strong>Assessment capability</strong><span>Phase 1 intentionally stops at authorized inventory and approvals.</span></div></div><div className="mt-3 rounded-lg border border-dashed border-[hsl(var(--line))] bg-[hsl(var(--ink)/0.28)] p-4 text-sm text-muted-foreground"><p className="font-medium text-foreground">Scanning is disabled</p><p className="mt-1">No button in this workspace can contact a domain, IP address, URL, or service. The future scan orchestrator will require an approved scope, bounded profile, rate limits, and a separate implementation review.</p><Button type="button" variant="outline" className="mt-3" disabled aria-label="Start assessment unavailable in Phase 1"><ShieldAlert className="h-4 w-4" />Start assessment unavailable</Button></div></div>
    <div className="admin-detail-card"><div className="admin-detail-card-heading"><RefreshCw className="h-4 w-4" /><div><strong>Recent CyberAI audit activity</strong><span>Server-generated events for protected writes and access decisions.</span></div></div>{audits.length ? <ol className="admin-history-list">{audits.slice(0, 12).map((event) => <li className="admin-history-item" key={event.id}><span className="admin-history-marker"><ShieldCheck className="h-3.5 w-3.5" /></span><div className="admin-history-body"><div className="admin-history-top"><div><strong>{event.action.replaceAll("_", " ")}</strong><span>{event.actor_email || "Protected server event"}</span></div><time dateTime={event.occurred_at}>{formatDateTime(event.occurred_at)}</time></div><p>{event.message}</p><div className="admin-history-meta"><span>{event.outcome.replaceAll("_", " ")}</span>{event.asset_id && <span>Asset {event.asset_id}</span>}{event.authorization_id && <span>Authorization {event.authorization_id}</span>}</div></div></li>)}</ol> : <div className="admin-empty mt-3"><ShieldCheck className="h-5 w-5" /><span>No CyberAI audit activity has been recorded yet.</span></div>}</div>
  </section>;
}

function AuthorizationCard({ record, savingAction, renewingId, renewalDate, renewalNote, revokePending, onApprove, onRequestRevoke, onConfirmRevoke, onCancelRevoke, onRenew, onRenewalDateChange, onRenewalNoteChange, onSubmitRenewal, onCancelRenewal }: { record: CyberAuthorizationRecord; savingAction: string; renewingId: string; renewalDate: string; renewalNote: string; revokePending: boolean; onApprove: () => void; onRequestRevoke: () => void; onConfirmRevoke: () => void; onCancelRevoke: () => void; onRenew: () => void; onRenewalDateChange: (value: string) => void; onRenewalNoteChange: (value: string) => void; onSubmitRenewal: (event: FormEvent<HTMLFormElement>) => void; onCancelRenewal: () => void }) {
  const active = record.status === "ACTIVE";
  return <div className="rounded-lg border border-[hsl(var(--line))] bg-[hsl(var(--ink)/0.28)] p-3"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><StatusBadge value={record.status} /><span className="font-mono text-[10px] text-muted-foreground">{record.id}</span></div><p className="mt-2 text-xs text-foreground">{record.scope_target}</p></div><div className="flex flex-wrap gap-2">{record.status === "PENDING" && <Button type="button" size="sm" className="admin-primary-button" onClick={onApprove} disabled={savingAction === "approve_authorization"}><CheckCircle2 className="h-3.5 w-3.5" />Approve</Button>}{active && <Button type="button" size="sm" variant="outline" onClick={onRenew} disabled={savingAction === "renew_authorization"}><RefreshCw className="h-3.5 w-3.5" />Renew</Button>}{record.status !== "REVOKED" && (revokePending ? <div className="flex flex-wrap items-center gap-2 rounded-md border border-[hsl(var(--coral)/0.35)] bg-[hsl(var(--coral)/0.08)] p-2" role="alert"><span className="text-xs text-foreground">Revoke this authorization?</span><Button type="button" size="sm" className="admin-danger-button" onClick={onConfirmRevoke} disabled={savingAction === "revoke_authorization"}>Confirm</Button><Button type="button" size="sm" variant="ghost" onClick={onCancelRevoke}>Cancel</Button></div> : <Button type="button" size="sm" variant="outline" className="admin-danger-button" onClick={onRequestRevoke} disabled={savingAction === "revoke_authorization"}><Ban className="h-3.5 w-3.5" />Revoke</Button>)}</div></div><div className="admin-data-grid"><DetailPoint label="Evidence" value={record.evidence_reference} /><DetailPoint label="Valid from" value={formatDate(record.valid_from)} /><DetailPoint label="Valid until" value={formatDate(record.valid_until)} /><DetailPoint label="Ports" value={record.scope_ports.join(", ") || "No ports listed"} /><DetailPoint label="Web paths" value={record.scope_web_paths.join(", ") || "No web paths listed"} /><DetailPoint label="Methods" value={record.allowed_testing_methods.map((method) => METHOD_LABELS[method] || method).join(", ")} /></div><p className="mt-3 text-[11px] leading-5 text-muted-foreground">Requested by {record.requested_by || "Not recorded"}. {record.approved_by ? `Approved by ${record.approved_by} on ${formatDateTime(record.approved_at)}.` : "Awaiting explicit approval."}</p>{record.status === "REVOKED" && record.revocation_note && <p className="mt-2 text-[11px] text-[hsl(var(--coral))]">Revocation note: {record.revocation_note}</p>}{renewingId === record.id && <form className="mt-3 grid gap-2 border-t border-[hsl(var(--line))] pt-3 sm:grid-cols-[auto_1fr_auto]" onSubmit={onSubmitRenewal}><label className="grid gap-1 text-[11px] text-muted-foreground">New valid until<Input required type="date" value={renewalDate} onChange={(event) => onRenewalDateChange(event.target.value)} /></label><label className="grid gap-1 text-[11px] text-muted-foreground">Renewal note<Input value={renewalNote} onChange={(event) => onRenewalNoteChange(event.target.value)} placeholder="Why the window is extended" /></label><div className="flex items-end gap-2"><Button type="submit" size="sm" className="admin-primary-button" disabled={savingAction === "renew_authorization"}>Save</Button><Button type="button" size="sm" variant="ghost" onClick={onCancelRenewal}>Cancel</Button></div></form>}</div>;
}
