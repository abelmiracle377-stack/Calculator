import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatBillingMoney, formatExchangeRate } from "@/lib/billing/manualPayments";
import type { AdminSettings } from "@/lib/billing/types";

interface AdminSettingsFormProps {
  settings: AdminSettings;
  saving: boolean;
  onChange: (patch: Partial<AdminSettings>) => void;
  onSave: () => void;
}

const PREMIUM_PRICE_USD = 20;

type FieldProps = {
  label: string;
  id: string;
  value: string | number;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "number";
  min?: string;
  step?: string;
};

function Field({ label, id, value, onChange, placeholder, type = "text", min, step }: FieldProps) {
  return <div className="billing-field-group"><Label htmlFor={id}>{label}</Label><Input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} min={min} step={step} /></div>;
}

function Toggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="billing-toggle"><input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span className="billing-toggle-track" aria-hidden /><span>{label}</span></label>;
}

function displayTimestamp(value: string): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Not recorded";
}

function RatePreview({ currency, rate, amount }: { currency: "NGN" | "GBP"; rate: number; amount: number }) {
  const hasRate = Number.isFinite(rate) && rate > 0;
  return <div className={`billing-rate-preview ${hasRate ? "is-ready" : ""}`}>
    <div className="billing-rate-preview-top"><span className="billing-rate-preview-label">$20 USD → {currency}</span>{hasRate ? <strong>≈ {formatBillingMoney(amount, currency)}</strong> : <strong className="billing-rate-preview-empty">Enter a rate above zero</strong>}</div>
    <span className="billing-rate-preview-detail">{hasRate ? formatExchangeRate(rate, currency) : "The preview appears after you enter a rate."}</span>
  </div>;
}

export function AdminSettingsForm({ settings, saving, onChange, onSave }: AdminSettingsFormProps) {
  const nigeriaRate = Number(settings.nigeria_ngn_rate);
  const ukRate = Number(settings.uk_gbp_rate);
  const nigeriaPreview = nigeriaRate > 0 ? Math.max(100, Math.round((PREMIUM_PRICE_USD * nigeriaRate) / 100) * 100) : 0;
  const ukPreview = ukRate > 0 ? Number((PREMIUM_PRICE_USD * ukRate).toFixed(2)) : 0;

  return <form className="billing-admin-settings" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
    <div className="billing-admin-settings-top"><div><p className="billing-section-kicker">Payment settings</p><h3>Where users can send payment</h3><p className="billing-help">Premium is $20 USD for one calendar month. USA Bank Transfer is the only discounted destination at $10 USD. Enable only destinations that are ready to receive funds. NGN and GBP rates still use the $20 standard price and are entered here by the administrator.</p></div><Button type="submit" className="tx-btn-primary" disabled={saving}><Save className="h-4 w-4" />{saving ? "Saving…" : "Save settings"}</Button></div>
    <div className="billing-rate-preview-grid" aria-live="polite"><RatePreview currency="NGN" rate={nigeriaRate} amount={nigeriaPreview} /><RatePreview currency="GBP" rate={ukRate} amount={ukPreview} /></div><p className="billing-rate-preview-note">These are typing previews only. Saving records the administrator-entered rate, while the server calculates the final amount shown to users. Rates do not update automatically.</p>
    <div className="billing-setting-section"><div className="billing-setting-title"><div><h4>Nigeria Bank Transfer</h4><p>Show a rounded NGN amount using your manual USD → NGN rate.</p></div><Toggle id="nigeria-enabled" label="Enabled" checked={settings.nigeria_enabled} onChange={(checked) => onChange({ nigeria_enabled: checked })} /></div><div className="billing-form-grid">
      <Field label="Bank name" id="nigeria-bank" value={settings.nigeria_bank_name} onChange={(value) => onChange({ nigeria_bank_name: value })} />
      <Field label="Account name" id="nigeria-account-name" value={settings.nigeria_account_name} onChange={(value) => onChange({ nigeria_account_name: value })} />
      <Field label="Account number" id="nigeria-account-number" value={settings.nigeria_account_number} onChange={(value) => onChange({ nigeria_account_number: value })} />
      <Field label="USD → NGN rate" id="nigeria-rate" type="number" min="0" step="1" value={settings.nigeria_ngn_rate || ""} onChange={(value) => onChange({ nigeria_ngn_rate: Number(value) || 0 })} placeholder="e.g. 1600" />
    </div><div className="billing-rate-stamp">Last rate update: {displayTimestamp(settings.nigeria_rate_timestamp)}</div><div className="billing-field-group"><Label htmlFor="nigeria-instructions">Payment instructions</Label><Textarea id="nigeria-instructions" value={settings.nigeria_instructions} onChange={(event) => onChange({ nigeria_instructions: event.target.value })} maxLength={2000} /></div></div>
    <div className="billing-setting-section"><div className="billing-setting-title"><div><h4>UK Bank Transfer</h4><p>Show a two-decimal GBP amount using your manual USD → GBP rate.</p></div><Toggle id="uk-enabled" label="Enabled" checked={settings.uk_enabled} onChange={(checked) => onChange({ uk_enabled: checked })} /></div><div className="billing-form-grid">
      <Field label="Account holder / name" id="uk-holder" value={settings.uk_account_holder_name} onChange={(value) => onChange({ uk_account_holder_name: value })} />
      <Field label="Bank name" id="uk-bank" value={settings.uk_bank_name} onChange={(value) => onChange({ uk_bank_name: value })} />
      <Field label="Account number" id="uk-account" value={settings.uk_account_number} onChange={(value) => onChange({ uk_account_number: value })} />
      <Field label="Sort code" id="uk-sort-code" value={settings.uk_sort_code} onChange={(value) => onChange({ uk_sort_code: value })} />
      <Field label="IBAN" id="uk-iban" value={settings.uk_iban} onChange={(value) => onChange({ uk_iban: value })} />
      <Field label="BIC / SWIFT" id="uk-bic" value={settings.uk_bic_swift} onChange={(value) => onChange({ uk_bic_swift: value })} />
      <Field label="USD → GBP rate" id="uk-rate" type="number" min="0" step="0.0001" value={settings.uk_gbp_rate || ""} onChange={(value) => onChange({ uk_gbp_rate: Number(value) || 0 })} placeholder="e.g. 0.79" />
      <Field label="Bank address" id="uk-bank-address" value={settings.uk_bank_address} onChange={(value) => onChange({ uk_bank_address: value })} />
      <Field label="Account holder address" id="uk-holder-address" value={settings.uk_account_holder_address} onChange={(value) => onChange({ uk_account_holder_address: value })} />
    </div><div className="billing-rate-stamp">Last rate update: {displayTimestamp(settings.uk_rate_timestamp)}</div><div className="billing-field-group"><Label htmlFor="uk-instructions">Payment instructions</Label><Textarea id="uk-instructions" value={settings.uk_instructions} onChange={(event) => onChange({ uk_instructions: event.target.value })} maxLength={2000} /></div></div>
    <div className="billing-setting-section"><div className="billing-setting-title"><div><h4>USA Bank Transfer</h4><p>Users should send $10.00 USD here. This is the only discounted destination; other methods use the $20 standard price.</p></div><Toggle id="usa-enabled" label="Enabled" checked={settings.usa_enabled} onChange={(checked) => onChange({ usa_enabled: checked })} /></div><div className="billing-form-grid">
      <Field label="Account holder / name" id="usa-holder" value={settings.usa_account_holder_name} onChange={(value) => onChange({ usa_account_holder_name: value })} />
      <Field label="Bank name" id="usa-bank" value={settings.usa_bank_name} onChange={(value) => onChange({ usa_bank_name: value })} />
      <Field label="Account number" id="usa-account" value={settings.usa_account_number} onChange={(value) => onChange({ usa_account_number: value })} />
      <Field label="Routing number" id="usa-routing" value={settings.usa_routing_number} onChange={(value) => onChange({ usa_routing_number: value })} />
      <Field label="Bank address" id="usa-bank-address" value={settings.usa_bank_address} onChange={(value) => onChange({ usa_bank_address: value })} />
      <Field label="Account holder address" id="usa-holder-address" value={settings.usa_account_holder_address} onChange={(value) => onChange({ usa_account_holder_address: value })} />
    </div><div className="billing-field-group"><Label htmlFor="usa-instructions">Payment instructions</Label><Textarea id="usa-instructions" value={settings.usa_instructions} onChange={(event) => onChange({ usa_instructions: event.target.value })} maxLength={2000} /></div></div>
  </form>;
}
