import { useEffect, useState } from "react";
import { Pencil, Plus, QrCode, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createLocalQrDataUrl } from "@/lib/billing/manualPayments";
import type { CryptoOption } from "@/lib/billing/types";

export type CryptoDraft = Partial<CryptoOption> & { id?: string };

interface AdminCryptoOptionsProps {
  options: CryptoOption[];
  saving: boolean;
  onSave: (draft: CryptoDraft) => void;
  onDelete: (id: string) => void;
}

const blankDraft: CryptoDraft = { name: "", network: "", wallet_address: "", instructions: "", enabled: true, display_order: 0 };

function CryptoQrPreview({ name, network, wallet_address, compact = false }: { name?: string; network?: string; wallet_address?: string; compact?: boolean }) {
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [error, setError] = useState("");
  const wallet = wallet_address?.trim() || "";
  useEffect(() => {
    let current = true;
    setQrDataUrl(""); setError("");
    if (!wallet) return () => { current = false; };
    createLocalQrDataUrl(wallet).then((url) => { if (current) setQrDataUrl(url); }).catch((qrError) => { console.error("Could not prepare local crypto QR", qrError); if (current) setError("QR preview unavailable"); });
    return () => { current = false; };
  }, [wallet]);
  return <div className={`billing-crypto-qr-card ${compact ? "is-compact" : "is-editor"}`}>
    <div className="billing-crypto-qr-image">{qrDataUrl ? <img src={qrDataUrl} alt={`${name || "Cryptocurrency"} wallet QR preview`} /> : <div className="billing-crypto-qr-placeholder"><QrCode className="h-5 w-5" /><span>{error || (wallet ? "Preparing local preview…" : "Enter an address to preview the QR")}</span></div>}</div>
    <div className="billing-crypto-qr-copy"><div className="billing-crypto-qr-heading"><QrCode className="h-4 w-4" /><div><strong>{compact ? "Local QR preview" : "Wallet QR preview"}</strong><span>Encodes the exact wallet address only.</span></div></div><span className="billing-crypto-network">Network: {network?.trim() || "Not set"}</span>{wallet && <code className="billing-crypto-qr-address">{wallet}</code>}<p className="billing-crypto-qr-warning">Verify the asset and network before sending. No QR image is uploaded.</p></div>
  </div>;
}

export function AdminCryptoOptions({ options, saving, onSave, onDelete }: AdminCryptoOptionsProps) {
  const [draft, setDraft] = useState<CryptoDraft>(blankDraft);
  const edit = (option: CryptoOption) => setDraft({ ...option });
  const update = (patch: Partial<CryptoDraft>) => setDraft((current) => ({ ...current, ...patch }));
  return <div className="billing-crypto-admin"><div className="billing-admin-settings-top"><div><p className="billing-section-kicker">Cryptocurrency</p><h3>Receiving wallets</h3><p className="billing-help">Each destination is shown with its network. Users must submit a receipt for every transfer.</p></div><Button type="button" variant="outline" onClick={() => setDraft({ ...blankDraft })}><Plus className="h-4 w-4" />New destination</Button></div>
    <div className="billing-crypto-editor"><div className="billing-form-grid"><div className="billing-field-group"><Label htmlFor="crypto-name">Cryptocurrency name</Label><Input id="crypto-name" value={draft.name || ""} onChange={(event) => update({ name: event.target.value })} placeholder="USDT" /></div><div className="billing-field-group"><Label htmlFor="crypto-network">Network / blockchain</Label><Input id="crypto-network" value={draft.network || ""} onChange={(event) => update({ network: event.target.value })} placeholder="TRC20" /></div><div className="billing-field-group billing-field-wide"><Label htmlFor="crypto-wallet">Wallet address</Label><Input id="crypto-wallet" value={draft.wallet_address || ""} onChange={(event) => update({ wallet_address: event.target.value })} placeholder="Paste the receiving address" /></div><div className="billing-field-group"><Label htmlFor="crypto-order">Display order</Label><Input id="crypto-order" type="number" min="0" step="1" value={draft.display_order ?? 0} onChange={(event) => update({ display_order: Number(event.target.value) || 0 })} /></div></div><div className="billing-field-group"><Label htmlFor="crypto-instructions">Payment instructions</Label><Textarea id="crypto-instructions" value={draft.instructions || ""} onChange={(event) => update({ instructions: event.target.value })} maxLength={2000} placeholder="Tell users anything important before they transfer." /></div><CryptoQrPreview name={draft.name} network={draft.network} wallet_address={draft.wallet_address} /><label className="billing-toggle"><input type="checkbox" checked={draft.enabled !== false} onChange={(event) => update({ enabled: event.target.checked })} /><span className="billing-toggle-track" aria-hidden /><span>Show this destination to users</span></label><div className="billing-editor-actions"><Button type="button" className="tx-btn-primary" disabled={saving} onClick={() => onSave(draft)}><Save className="h-4 w-4" />{saving ? "Saving…" : draft.id ? "Save destination" : "Add destination"}</Button>{draft.id && <Button type="button" variant="ghost" onClick={() => setDraft({ ...blankDraft })}>Cancel edit</Button>}</div></div>
    <div className="billing-crypto-list">{options.length ? options.map((option) => <div className="billing-crypto-admin-row" key={option.id}><CryptoQrPreview name={option.name} network={option.network} wallet_address={option.wallet_address} compact /><div className="billing-crypto-admin-row-info"><strong>{option.name} <span>{option.network}</span></strong><code>{option.wallet_address}</code></div><div className="billing-row-actions"><span className={`billing-tag ${option.enabled ? "billing-tag-active" : "billing-tag-muted"}`}>{option.enabled ? "Enabled" : "Disabled"}</span><Button type="button" size="sm" variant="outline" onClick={() => edit(option)}><Pencil className="h-3.5 w-3.5" />Edit</Button><Button type="button" size="sm" variant="ghost" onClick={() => onDelete(option.id)} aria-label={`Delete ${option.name}`}><Trash2 className="h-3.5 w-3.5" /></Button></div></div>) : <p className="billing-empty-state">No cryptocurrency destinations yet. Add one only when its wallet and network are ready.</p>}</div>
  </div>;
}
