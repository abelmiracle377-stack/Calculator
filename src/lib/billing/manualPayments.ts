import * as QRCode from "qrcode";
import { accessStatus, manualPaymentAdmin, manualPayments } from "@/functions";
import type {
  AdminOverview,
  AdminPaymentRow,
  AdminSettings,
  CryptoOption,
  NotificationOutcome,
  PaymentMethodOption,
  PaymentOptionsResponse,
  ProtectedReceiptPayload,
  SubmitPaymentResponse,
  UserAccessStatusResponse,
  UserBillingStatusResponse,
} from "@/lib/billing/types";

const ACCEPTED_RECEIPT_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const MAX_CLIENT_RECEIPT_BYTES = 8 * 1024 * 1024;
const MAX_PREPARED_RECEIPT_CHARS = 4_800_000;

export class BillingRequestError extends Error {
  status?: number;
  constructor(message: string, status?: number) { super(message); this.name = "BillingRequestError"; this.status = status; }
}
function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
  if (value && typeof value === "object") { const record = value as Record<string, unknown>; return record.result && typeof record.result === "object" ? record.result as Record<string, unknown> : record; }
  return {};
}
async function call<T>(fn: (payload: Record<string, unknown>) => Promise<unknown>, payload: Record<string, unknown>): Promise<T> {
  try { const body = objectValue(await fn(payload)); if (body.error) throw new BillingRequestError(String(body.error), Number(body.status) || undefined); return body as T; }
  catch (error) { if (error instanceof BillingRequestError) throw error; const record = error && typeof error === "object" ? error as Record<string, unknown> : {}; throw new BillingRequestError(error instanceof Error ? error.message : "The billing service could not be reached.", Number(record.status) || undefined); }
}
export function getPaymentOptions() { return call<PaymentOptionsResponse>(manualPayments, { action: "options" }); }
export function getUserBillingStatus() { return call<UserBillingStatusResponse>(manualPayments, { action: "status" }); }
export function getUserAccessStatus() { return call<UserAccessStatusResponse>(accessStatus, {}); }
export function submitManualPayment(payload: Record<string, unknown>) { return call<SubmitPaymentResponse>(manualPayments, { action: "submit", ...payload }); }
export function adminBillingAction<T = Record<string, unknown>>(payload: Record<string, unknown>) { return call<T>(manualPaymentAdmin, payload); }
export function isBillingAccessDenied(error: unknown): boolean { const status = error instanceof BillingRequestError ? error.status : undefined; const message = error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase(); return status === 401 || status === 403 || status === 404 || message.includes("401") || message.includes("403") || message.includes("404") || message.includes("not found") || message.includes("forbidden") || message.includes("authentication required"); }
export function formatBillingDate(value?: string): string { if (!value) return "Not recorded"; const date = new Date(value); if (!Number.isFinite(date.getTime())) return "Not recorded"; return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date); }
export function formatBillingMoney(amount: number, currency: string): string { const code = currency.toUpperCase(); if (["USD", "NGN", "GBP"].includes(code)) return new Intl.NumberFormat(undefined, { style: "currency", currency: code, maximumFractionDigits: code === "NGN" ? 0 : 2 }).format(amount); return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(amount)} ${code}`; }
export function formatExchangeRate(rate: number, currency: string): string { if (!Number.isFinite(rate) || rate <= 0) return "Rate unavailable"; return `$1 USD = ${new Intl.NumberFormat(undefined, { maximumFractionDigits: currency === "NGN" ? 0 : 4 }).format(rate)} ${currency}`; }
export function methodLabel(method: string): string { return ({ NIGERIA_BANK_TRANSFER: "Nigeria Bank Transfer", UK_BANK_TRANSFER: "UK Bank Transfer", USA_BANK_TRANSFER: "USA Bank Transfer", CRYPTO: "Cryptocurrency" } as Record<string, string>)[method] || method.replaceAll("_", " "); }

export async function createLocalQrDataUrl(walletAddress: string): Promise<string> {
  const value = walletAddress.trim();
  if (!value) return "";
  return QRCode.toDataURL(value, { errorCorrectionLevel: "M", margin: 2, width: 240, color: { dark: "#07141d", light: "#ffffff" } });
}

export function validateReceiptFile(file: File | null): string | null { if (!file) return "A payment receipt image is required."; const extension = file.name.split(".").pop()?.toLowerCase() || ""; const type = file.type || (extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : ""); if (!ACCEPTED_RECEIPT_TYPES.has(type)) return "Use a JPG, JPEG, PNG, or WEBP image."; if (file.size <= 0 || file.size > MAX_CLIENT_RECEIPT_BYTES) return "Receipt images must be smaller than 8 MB."; return null; }
function readAsDataUrl(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || "")); reader.onerror = () => reject(new Error("The receipt image could not be read.")); reader.readAsDataURL(file); }); }
function loadImage(dataUrl: string): Promise<HTMLImageElement> { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("The receipt image could not be prepared.")); image.src = dataUrl; }); }
export async function prepareReceiptImage(file: File): Promise<{ data: string; mimeType: "image/jpeg"; originalFilename: string; byteSize: number }> { const validation = validateReceiptFile(file); if (validation) throw new Error(validation); const source = await readAsDataUrl(file); const image = await loadImage(source); const maxDimension = 1600; const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height)); const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale)); canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale)); const context = canvas.getContext("2d"); if (!context) throw new Error("Your browser could not prepare the receipt image."); context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height); let data = canvas.toDataURL("image/jpeg", 0.78); if (data.length > MAX_PREPARED_RECEIPT_CHARS) data = canvas.toDataURL("image/jpeg", 0.62); if (data.length > MAX_PREPARED_RECEIPT_CHARS) throw new Error("This receipt image is still too large after compression."); const encoded = data.split(",")[1] || ""; return { data, mimeType: "image/jpeg", originalFilename: file.name.slice(0, 120), byteSize: Math.floor(encoded.length * 0.75) }; }

export type { AdminOverview, AdminPaymentRow, AdminSettings, CryptoOption, NotificationOutcome, PaymentMethodOption, ProtectedReceiptPayload, SubmitPaymentResponse, UserAccessStatusResponse };
