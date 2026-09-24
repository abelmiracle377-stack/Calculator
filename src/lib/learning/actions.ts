import { approvedAiLearningContext, proposeAiLearning } from "@/functions";
import type { AiLearningProposalResponse, ApprovedAiLearningContextResponse } from "@/lib/learning/types";

export class LearningRequestError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "LearningRequestError";
    this.status = status;
  }
}

function responseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return responseObject(JSON.parse(value)); } catch { return {}; }
  }
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return record.result && typeof record.result === "object" ? record.result as Record<string, unknown> : record;
}

async function call<T>(request: Promise<unknown>): Promise<T> {
  try {
    const body = responseObject(await request);
    if (body.error) throw new LearningRequestError("The learning service could not complete this request.", Number(body.status) || undefined);
    return body as T;
  } catch (error) {
    if (error instanceof LearningRequestError) throw error;
    throw new LearningRequestError("The learning service could not be reached.");
  }
}

export function proposeLearningCandidate(sessionId: string, lineId: string): Promise<AiLearningProposalResponse> {
  return call<AiLearningProposalResponse>(proposeAiLearning({ session_id: sessionId, line_id: lineId }));
}

export async function requestApprovedLearningContext(sessionId: string): Promise<ApprovedAiLearningContextResponse> {
  try {
    return await call<ApprovedAiLearningContextResponse>(approvedAiLearningContext({ session_id: sessionId }));
  } catch (error) {
    console.warn("Approved learning context was unavailable; continuing without it.");
    return { ok: false, rules: [] };
  }
}
