import { adminAccess, reengagementReminder } from "@/functions";
import type { AdminAccessActionResponse, AdminHistoryResponse, AdminOverviewResponse, AdminUserDetailResponse, AdminUsersResponse } from "@/lib/billing/types";

export class AdminAccessRequestError extends Error {
  status?: number;
  constructor(message: string, status?: number) { super(message); this.name = "AdminAccessRequestError"; this.status = status; }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
  if (value && typeof value === "object") { const record = value as Record<string, unknown>; return record.result && typeof record.result === "object" ? record.result as Record<string, unknown> : record; }
  return {};
}
async function call<T>(payload: Record<string, unknown>): Promise<T> {
  try {
    const body = objectValue(await adminAccess(payload));
    if (body.error) throw new AdminAccessRequestError(String(body.error), Number(body.status) || undefined);
    return body as T;
  } catch (error) {
    if (error instanceof AdminAccessRequestError) throw error;
    const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
    throw new AdminAccessRequestError(error instanceof Error ? error.message : "The administrator service could not be reached.", Number(record.status) || undefined);
  }
}

export function adminAccessAction<T = Record<string, unknown>>(payload: Record<string, unknown>) { return call<T>(payload); }

async function callReengagement<T>(payload: Record<string, unknown>): Promise<T> {
  try {
    const body = objectValue(await reengagementReminder(payload));
    if (body.error) throw new AdminAccessRequestError(String(body.error), Number(body.status) || undefined);
    return body as T;
  } catch (error) {
    if (error instanceof AdminAccessRequestError) throw error;
    const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
    throw new AdminAccessRequestError(error instanceof Error ? error.message : "The reminder settings service could not be reached.", Number(record.status) || undefined);
  }
}

export function reengagementAction<T = Record<string, unknown>>(payload: Record<string, unknown>) { return callReengagement<T>(payload); }
export function isAdminAccessDenied(error: unknown): boolean {
  const status = error instanceof AdminAccessRequestError ? error.status : undefined;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase();
  return status === 401 || status === 403 || status === 404 || message.includes("not found") || message.includes("authentication required") || message.includes("unauthorized") || message.includes("forbidden");
}

export type AdminActionResult = AdminAccessActionResponse;
export type AdminOverviewResult = AdminOverviewResponse;
export type AdminUsersResult = AdminUsersResponse;
export type AdminUserDetailResult = AdminUserDetailResponse;
export type AdminHistoryResult = AdminHistoryResponse;
