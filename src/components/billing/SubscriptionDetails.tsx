import { useEffect, useState } from "react";
import { Copy, Landmark, QrCode, ShieldAlert, WalletCards } from "lucide-react";
import { toast } from "sonner";
import { createLocalQrDataUrl, formatBillingDate, formatBillingMoney, formatExchangeRate } from "@/lib/billing/manualPayments";
import type { CryptoOption, PaymentMethodOption } from "@/lib/billing/types";

interface SubscriptionDetailsProps {
  option: PaymentMethodOption;
  cryptoOptionId: string;
  onCryptoOptionChange: (id: string) => void;
}

function DetailRow({ label, value, copyable = false }: { label: string; value?: string; copyable?: boolean }) {
  if (!value) return null;
  const copyValue = async () => {
    try {
      await navigator.clipboard?.writeText(value);
      toast.success(`${label} copied.`);
    } catch {
      toast.error("Could not copy that value.");
    }
  };
  return (
    <div className="billing-detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
      {copyable && <button type="button" className="billing-copy-button" onClick={() => void copyValue()} aria-label={`Copy ${label}`}><Copy className="h-3.5 w-3.5" /></button>}
    </div>
  );
}

function AmountBox({ option }: { option: PaymentMethodOption }) {
  return (
    <div className="billing-amount-box">
      <span>Amount to transfer</span>
      <strong>{formatBillingMoney(option.expected_amount, option.expected_currency)}</strong>
      {option.exchange_rate > 0 && <>
        <span className="billing-rate">{formatExchangeRate(option.exchange_rate, option.expected_currency)}</span>
        <span className="billing-rate-time">Rate captured {formatBillingDate(option.exchange_rate_timestamp)}</span>
        <p className="billing-manual-rate-note">This {option.expected_currency} rate is manual and is not automatically refreshed. Confirm the rate before sending.</p>
      </>}
      {option.id === "CRYPTO" && <span className="billing-rate">{formatBillingMoney(option.expected_amount, option.expected_currency)} equivalent. Follow the payment instructions for the exact token amount.</span>}
    </div>
  );
}

function CryptoQrCard({ crypto }: { crypto: CryptoOption }) {
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [qrError, setQrError] = useState("");

  useEffect(() => {
    let current = true;
    setQrDataUrl("");
    setQrError("");
    if (!crypto.wallet_address.trim()) return () => { current = false; };
    createLocalQrDataUrl(crypto.wallet_address).then((url) => {
      if (current) setQrDataUrl(url);
    }).catch((error) => {
      console.error("Could not prepare local crypto QR", error);
      if (current) setQrError("The local QR preview could not be prepared. Copy the address instead.");
    });
    return () => { current = false; };
  }, [crypto.id, crypto.wallet_address]);

  return <div className="billing-crypto-qr-card">
    <div className="billing-crypto-qr-image" aria-live="polite">
      {qrDataUrl ? <img src={qrDataUrl} alt={`${crypto.name} wallet address QR code for the ${crypto.network} network`} /> : <div className="billing-crypto-qr-placeholder"><QrCode className="h-6 w-6" /><span>{qrError || "Preparing a local QR preview…"}</span></div>}
    </div>
    <div className="billing-crypto-qr-copy">
      <div className="billing-crypto-qr-heading"><QrCode className="h-4 w-4" /><div><strong>Scan or copy this address</strong><span>Generated in this browser. No QR image service is used.</span></div></div>
      <span className="billing-crypto-network">Network: {crypto.network}</span>
      <DetailRow label="Wallet address" value={crypto.wallet_address} copyable />
      <p className="billing-crypto-qr-warning">The QR encodes only the wallet address. Verify the asset and network in your wallet before sending.</p>
    </div>
  </div>;
}

export function SubscriptionDetails({ option, cryptoOptionId, onCryptoOptionChange }: SubscriptionDetailsProps) {
  const bank = option.bank;
  const crypto = option.crypto_options || [];
  const selectedCrypto = crypto.find((item) => item.id === cryptoOptionId) || crypto[0];

  if (option.id === "CRYPTO") {
    return (
      <div className="billing-method-details">
        <div className="billing-detail-heading"><WalletCards className="h-4 w-4" /><div><strong>Cryptocurrency destination</strong><span>Send funds using the exact network shown below.</span></div></div>
        <div className="billing-crypto-choices" role="radiogroup" aria-label="Cryptocurrency destination">
          {crypto.map((item) => (
            <button key={item.id} type="button" role="radio" aria-checked={selectedCrypto?.id === item.id} className={`billing-crypto-choice ${selectedCrypto?.id === item.id ? "is-selected" : ""}`} onClick={() => onCryptoOptionChange(item.id)}>
              <span>{item.name}</span><small>{item.network}</small>
            </button>
          ))}
        </div>
        {selectedCrypto && <>
          <div className="billing-destination-box">
            <DetailRow label="Asset" value={selectedCrypto.name} />
            <DetailRow label="Network" value={selectedCrypto.network} />
            {selectedCrypto.instructions && <p className="billing-instructions">{selectedCrypto.instructions}</p>}
          </div>
          <CryptoQrCard crypto={selectedCrypto} />
          <p className="billing-warning"><ShieldAlert className="h-4 w-4" />Use only the <strong>{selectedCrypto.network}</strong> network for this address. A different network can permanently lose the transfer.</p>
        </>}
        <AmountBox option={option} />
      </div>
    );
  }

  return (
    <div className="billing-method-details">
      <div className="billing-detail-heading"><Landmark className="h-4 w-4" /><div><strong>Receiving bank details</strong><span>Transfer the exact amount, then upload your receipt below.</span></div></div>
      <div className="billing-destination-box">
        <DetailRow label="Bank name" value={bank?.bank_name} />
        <DetailRow label={option.id === "NIGERIA_BANK_TRANSFER" ? "Account name" : "Account holder"} value={bank?.account_name || bank?.account_holder_name} />
        <DetailRow label="Account number" value={bank?.account_number} copyable />
        <DetailRow label="Routing number" value={bank?.routing_number} copyable />
        <DetailRow label="Sort code" value={bank?.sort_code} />
        <DetailRow label="IBAN" value={bank?.iban} copyable />
        <DetailRow label="BIC / SWIFT" value={bank?.bic_swift} />
        <DetailRow label="Bank address" value={bank?.bank_address} />
        <DetailRow label="Account holder address" value={bank?.account_holder_address} />
        {bank?.instructions && <p className="billing-instructions">{bank.instructions}</p>}
      </div>
      <AmountBox option={option} />
    </div>
  );
}
