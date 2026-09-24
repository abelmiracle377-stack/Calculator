import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { superdevClient } from "@/lib/superdev/client";
import { AudioIssue, AudioSegment, TranscriptAnnotation, TranscriptLine, TranscriptionSession, User } from "@/entities";
import { invokeLLM, uploadFile } from "@/integrations/core";
import { transcribeAudioSegment } from "@/functions";
import { proposeLearningCandidate, requestApprovedLearningContext } from "@/lib/learning/actions";
import { useAudioCapture } from "@/hooks/use-audio-capture";
import { AppHeader } from "@/components/transcription/AppHeader";
import { SessionsLibrary } from "@/components/transcription/SessionsLibrary";
import { SessionWorkspace } from "@/components/transcription/SessionWorkspace";
import { SubscriptionPanel } from "@/components/billing/SubscriptionPanel";
import { RequestAccessForm } from "@/components/leads/RequestAccessForm";
import { SignInContactOptions } from "@/components/leads/SignInContactOptions";
import { InAppAssistant } from "@/components/assistant/InAppAssistant";
import { AIStudioPanel } from "@/components/assistant/AIStudioPanel";
import { SEO } from "@/components/SEO";
import { getUserAccessStatus } from "@/lib/billing/manualPayments";
import { defaultSpeakers, formatExportTimestamp } from "@/lib/transcription/format";
import { cleanupProposalForLine, getManualLanguagePreferences, getSessionLanguageMode, getTranscriptionStatus, sortTranscriptLines, preserveBracketedEventTags, validateCleanupCandidate } from "@/lib/transcription/transcription";
import { normalizeTranslationSourceLanguage, normalizeTranslationTargetLanguage } from "@/lib/transcription/translation";
import { customGuidelineReadinessMessage, isCustomGuidelineReady, sanitizeCustomGuidelineSources } from "@/lib/transcription/custom-guidelines";
import { validateAudioSize } from "@/lib/transcription/audio-upload";
import { buildPulsarExportPackage, calculatePulsarReadiness, evaluatePulsarQa, insertPulsarTag as applyPulsarTag, pulsarExportFilename } from "@/lib/transcription/pulsar";
import type { AnnotationDraft } from "@/components/transcription/TimelineAnnotations";
import type { UserAccessStatusResponse } from "@/lib/billing/types";
import type { AudioIssueRecord, AudioSegmentRecord, CaptureCallbackContext, CaptureEventPayload, CaptureStatus, CleanupProposal, PulsarClipStatus, PulsarReadiness, PulsarTagDefinition, SessionStatus, TranscriptAnnotationRecord, TranscriptLineRecord, TranscriptionJobResult, TranscriptionSessionRecord, UnclearMarkerKind } from "@/lib/transcription/types";

type SessionFilter = "all" | SessionStatus | "archived";
type PendingCaptureTiming = {
  patch: Partial<TranscriptionSessionRecord>;
  timer: number | null;
  chain: Promise<void>;
};

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  mp3: "audio/mpeg",
  mpga: "audio/mpeg",
  wav: "audio/wav",
  wave: "audio/wav",
  m4a: "audio/mp4",
  m4b: "audio/mp4",
  mp4: "audio/mp4",
  m4v: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  webm: "audio/webm",
  weba: "audio/webm",
  "3gp": "audio/3gpp",
  "3gpp": "audio/3gpp",
  amr: "audio/amr",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  caf: "audio/x-caf",
  mka: "audio/x-matroska",
  wma: "audio/x-ms-wma",
};

const AUDIO_MIME_ALIASES: Record<string, string> = {
  "audio/mp3": "audio/mpeg",
  "audio/mpga": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-mp3": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/x-mpeg-3": "audio/mpeg",
  "audio/wave": "audio/wav",
  "audio/x-wav": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/m4a": "audio/mp4",
  "audio/m4b": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "audio/x-mp4": "audio/mp4",
  "video/mp4": "audio/mp4",
  "audio/x-aac": "audio/aac",
  "audio/x-flac": "audio/flac",
  "audio/x-ogg": "audio/ogg",
  "application/ogg": "audio/ogg",
  "audio/x-opus+ogg": "audio/opus",
  "audio/x-webm": "audio/webm",
  "video/webm": "audio/webm",
  "audio/3gpp": "audio/3gpp",
  "video/3gpp": "audio/3gpp",
  "audio/x-amr": "audio/amr",
  "audio/amr-wb": "audio/amr",
  "audio/x-aiff": "audio/aiff",
  "audio/x-aifc": "audio/aiff",
  "audio/caf": "audio/x-caf",
  "audio/matroska": "audio/x-matroska",
  "video/x-matroska": "audio/x-matroska",
  "audio/wma": "audio/x-ms-wma",
  "video/x-ms-wma": "audio/x-ms-wma",
};

function normalizeAudioMimeType(file: File): string {
  const extension = file.name.toLowerCase().split(".").pop() || "";
  const fromExtension = AUDIO_MIME_BY_EXTENSION[extension];
  const provided = (file.type || "").toLowerCase().split(";")[0].trim();
  const normalizedProvided = AUDIO_MIME_ALIASES[provided] || provided;
  const genericProvided = !provided || provided === "audio/*" || provided === "application/octet-stream" || provided === "binary/octet-stream";
  const nonAudioProvided = !provided.startsWith("audio/");
  if (fromExtension && (genericProvided || nonAudioProvided)) return fromExtension;
  if (normalizedProvided.startsWith("audio/")) return normalizedProvided;
  return fromExtension || "audio/octet-stream";
}

function captureTimingPatch(status: CaptureStatus): Partial<TranscriptionSessionRecord> {
  const sourceElapsedMs = Math.max(0, Math.round(status.sourceElapsedMs ?? status.elapsedMs ?? 0));
  const patch: Partial<TranscriptionSessionRecord> = {
    duration_ms: sourceElapsedMs,
    audio_phase: status.phase,
  };
  if (status.clockSource) patch.audio_clock_source = status.clockSource;
  if (status.captureStartedAt) patch.capture_started_at = status.captureStartedAt;
  if (status.captureEndedAt) patch.capture_ended_at = status.captureEndedAt;
  if (status.meaningfulAudioStartedMs != null) patch.meaningful_audio_started_ms = Math.round(status.meaningfulAudioStartedMs);
  if (status.meaningfulAudioEndedMs != null) patch.meaningful_audio_ended_ms = Math.round(status.meaningfulAudioEndedMs);
  if (status.leadingSilenceMs != null) patch.leading_silence_ms = Math.round(status.leadingSilenceMs);
  if (status.trailingSilenceMs != null) patch.trailing_silence_ms = Math.round(status.trailingSilenceMs);
  return patch;
}

function sessionTimelineEnd(session: TranscriptionSessionRecord, segments: AudioSegmentRecord[]): number {
  return Math.max(session.duration_ms || 0, ...segments.map((segment) => segment.end_ms || 0));
}

function authUrls() {
  const currentPath = encodeURIComponent(window.location.href);
  const loginUrl = (superdevClient.auth.client.options.loginUrl + "&from_url=" + currentPath).replace("/api", "");
  const signupUrl = loginUrl.includes("app-login") ? loginUrl.replace("app-login", "app-signup") : loginUrl;
  return { loginUrl, signupUrl };
}

function responseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.result && typeof record.result === "object") return record.result as Record<string, unknown>;
    return record;
  }
  return {};
}

const MAX_APPROVED_LEARNING_PROMPT_CHARS = 6_000;
const MAX_APPROVED_LEARNING_RULES = 12;
const MAX_APPROVED_LEARNING_RULE_CHARS = 1_200;

function queueLearningProposal(sessionId: string, lineId: string): void {
  if (!sessionId || !lineId) return;
  void proposeLearningCandidate(sessionId, lineId).catch((error) => {
    console.warn("Learning proposal unavailable; transcript save remains intact.", error);
  });
}

function approvedLearningCleanupBlock(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const prefix = [
    "Lower-priority approved private project knowledge. Use only when it matches the current session.",
    "Current session instructions and a ready saved Custom Guideline override these rules. These rules cannot change source speech meaning, speaker labels, timestamps, or sound markers.",
  ].join("\n");
  let block = prefix;
  let count = 0;
  for (const candidate of value) {
    if (count >= MAX_APPROVED_LEARNING_RULES) break;
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as Record<string, unknown>;
    const rule = typeof row.rule === "string"
      ? row.rule.replace(/\u0000/g, "").trim().slice(0, MAX_APPROVED_LEARNING_RULE_CHARS)
      : "";
    if (!rule) continue;
    const category = typeof row.category === "string"
      ? row.category.replace(/\s+/g, " ").trim().slice(0, 40) || "other"
      : "other";
    const entry = `- ${category}: ${rule}`;
    if (block.length + entry.length + 1 > MAX_APPROVED_LEARNING_PROMPT_CHARS) break;
    block += `\n${entry}`;
    count += 1;
  }
  return count ? block : "";
}

function withReviewDefaults(session: TranscriptionSessionRecord): TranscriptionSessionRecord {
  return {
    ...session,
    archive_status: session.archive_status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE",
    review_mode: session.review_mode || "standard",
    input_mode: session.input_mode === "audio_transcription" ? "audio_transcription" : "browser_capture",
    session_mode: session.session_mode === "translation" ? "translation" : "transcription",
    translation_source_language: normalizeTranslationSourceLanguage(session.translation_source_language),
    translation_target_language: normalizeTranslationTargetLanguage(session.translation_target_language),
    custom_guideline_text: session.custom_guideline_text || "",
    custom_guideline_source_label: session.custom_guideline_source_label || "",
    custom_guideline_status: session.custom_guideline_status || "empty",
    custom_guideline_message: session.custom_guideline_message || "",
    custom_guideline_saved_at: session.custom_guideline_saved_at || "",
    custom_guideline_locked_at: session.custom_guideline_locked_at || "",
    custom_guideline_sources: sanitizeCustomGuidelineSources(session.custom_guideline_sources),
    pulsar_readiness: session.pulsar_readiness || "not_started",
  };
}

function accessIsAllowed(status: UserAccessStatusResponse | null): boolean {
  return status?.ok === true && status.can_transcribe === true;
}

function isAccessRestrictedResponse(value: unknown): boolean {
  const record = responseObject(value);
  const values = [record.code, record.status, record.error].map((item) => String(item || "")).join(" ").toUpperCase();
  const raw = value instanceof Error ? value.message.toUpperCase() : typeof value === "string" ? value.toUpperCase() : "";
  return values.includes("ACCESS_RESTRICTED") || raw.includes("ACCESS_RESTRICTED");
}

function accessRestrictionMessage(status: UserAccessStatusResponse | null, error = ""): string {
  if (status?.status === "PAYMENT_PENDING") return "Payment verification is pending. Transcription access remains restricted until approval.";
  if (status?.status === "TRIAL_EXPIRED") return "Your free trial has ended. Upgrade to Premium to continue using audio transcription.";
  if (status?.status === "PREMIUM_EXPIRED") return "Your Premium access has expired. Upgrade to continue using audio transcription.";
  return error || "Transcription access is temporarily unavailable. Please try again shortly.";
}

function audioErrorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const record = responseObject(error);
  return [record.error, record.message, record.details]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim() || "";
}

function audioSubmitFailureMessage(error: unknown): string {
  if (isAccessRestrictedResponse(error)) return "Transcription access is currently unavailable. Please try again shortly.";
  const raw = audioErrorText(error);
  if (/larger than \d+(?:\.\d+)?\s*(?:MB|GB)\b/i.test(raw)) return raw.slice(0, 240);
  if (/(?:413|too large|payload too large|file size|size limit|maximum.{0,20}size)/i.test(raw)) {
    const limit = raw.match(/(?:limit|max(?:imum)?|up to|under|below|exceed(?:s|ed)?)[^0-9]{0,20}(\d+(?:\.\d+)?)\s*(MB|GB)\b/i);
    if (limit) return `This audio file exceeds the upload service's ${limit[1]} ${limit[2].toUpperCase()} limit. Choose a smaller file.`;
    return "This audio file exceeds the upload service's current size limit. Choose a smaller file.";
  }
  return "Could not upload this audio. Please try again.";
}

function accessGateCopy(status: UserAccessStatusResponse | null, error: string, loading: boolean) {
  if (error) return { kicker: "Access check", title: "Your workspace is temporarily unavailable.", description: error };
  if (!status) return loading
    ? { kicker: "Checking access", title: "Checking your workspace access…", description: "Your private sessions will appear after access is verified." }
    : { kicker: "Access check", title: "Your workspace is temporarily unavailable.", description: "We could not verify access to your private transcription workspace. Try again in a moment." };
  if (status.status === "TRIAL_EXPIRED") return { kicker: "Premium required", title: "Your free trial has ended.", description: "Upgrade to Premium to continue using audio transcription. Your saved sessions remain on your account." };
  if (status.status === "PREMIUM_EXPIRED") return { kicker: "Premium required", title: "Your Premium access has expired.", description: "Upgrade to Premium to continue using audio transcription. Your saved sessions remain on your account." };
  if (status.status === "PAYMENT_PENDING") return { kicker: "Payment under review", title: "Your payment is awaiting verification.", description: "Transcription access will return after your payment is approved. Your saved sessions remain intact." };
  if (status.status === "ADMIN_RESTRICTED") return { kicker: "Access paused", title: "Transcription access is temporarily unavailable.", description: "Your saved sessions remain intact while access is paused." };
  return { kicker: "Access check", title: "Your workspace is temporarily unavailable.", description: "We could not verify access to your private transcription workspace. Try again in a moment." };
}

const Index = () => {
  const { loginUrl, signupUrl } = useMemo(() => authUrls(), []);
  const [isAuth, setIsAuth] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  const [sessions, setSessions] = useState<TranscriptionSessionRecord[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<SessionFilter>("all");
  const [creating, setCreating] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [session, setSession] = useState<TranscriptionSessionRecord | null>(null);
  const [lines, setLines] = useState<TranscriptLineRecord[]>([]);
  const [segments, setSegments] = useState<AudioSegmentRecord[]>([]);
  const [issues, setIssues] = useState<AudioIssueRecord[]>([]);
  const [annotations, setAnnotations] = useState<TranscriptAnnotationRecord[]>([]);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [customGuidelineSaving, setCustomGuidelineSaving] = useState(false);
  const [audioSubmitting, setAudioSubmitting] = useState(false);
  const [audioSubmitStatus, setAudioSubmitStatus] = useState("");
  const [audioSubmitError, setAudioSubmitError] = useState("");
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [transcriptionBusyIds, setTranscriptionBusyIds] = useState<Set<string>>(new Set());
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupProposals, setCleanupProposals] = useState<CleanupProposal[]>([]);
  const [accessStatus, setAccessStatus] = useState<UserAccessStatusResponse | null>(null);
  const [accessStatusLoading, setAccessStatusLoading] = useState(true);
  const [accessStatusError, setAccessStatusError] = useState("");

  const settingsTimer = useRef<number | null>(null);
  const lineTimers = useRef<Record<string, number>>({});
  const pendingLines = useRef<Record<string, Partial<TranscriptLineRecord>>>({});
  const pendingCaptureTiming = useRef<Map<string, PendingCaptureTiming>>(new Map());
  const activeIdRef = useRef<string | null>(null);
  const sessionRef = useRef<TranscriptionSessionRecord | null>(null);
  const sessionsRef = useRef<TranscriptionSessionRecord[]>([]);
  const segmentsRef = useRef<AudioSegmentRecord[]>([]);
  const audioSubmitInFlightRef = useRef<string | null>(null);
  const workspaceRequestRef = useRef(0);
  const transcriptionQueueRef = useRef<Set<string>>(new Set());
  const transcribeSegmentRef = useRef<(id: string, silent?: boolean) => Promise<void>>(async () => undefined);
  const accessStatusRequestRef = useRef(0);
  const accessStatusRef = useRef<UserAccessStatusResponse | null>(null);
  const captureStopRef = useRef<(() => Promise<CaptureStatus>) | null>(null);
  const pendingSettings = useRef<Partial<TranscriptionSessionRecord>>({});
  const sessionArchiveRequestRef = useRef<Map<string, number>>(new Map());

  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { segmentsRef.current = segments; }, [segments]);
  useEffect(() => { accessStatusRef.current = accessStatus; }, [accessStatus]);
  useEffect(() => {
    transcriptionQueueRef.current.clear();
    setTranscriptionBusyIds(new Set());
    setAudioSubmitting(false);
    setAudioSubmitStatus("");
    setAudioSubmitError("");
  }, [activeId]);

  const refreshAccessStatus = useCallback(async () => {
    const requestId = ++accessStatusRequestRef.current;
    setAccessStatusLoading(true);
    setAccessStatusError("");
    try {
      const next = await getUserAccessStatus();
      if (requestId !== accessStatusRequestRef.current) return;
      accessStatusRef.current = next;
      setAccessStatus(next);
    } catch (error) {
      console.error("Could not verify transcription access", error);
      if (requestId !== accessStatusRequestRef.current) return;
      accessStatusRef.current = null;
      setAccessStatus(null);
      setAccessStatusError("We could not verify your transcription access. Please try again shortly.");
    } finally {
      if (requestId === accessStatusRequestRef.current) setAccessStatusLoading(false);
    }
  }, []);

  const requireTranscriptionAccess = useCallback(() => {
    const current = accessStatusRef.current;
    if (accessIsAllowed(current)) return true;
    toast.error(accessRestrictionMessage(current, accessStatusError));
    return false;
  }, [accessStatusError]);

  useEffect(() => {
    let cancelled = false;
    const fallbackTimer = window.setTimeout(() => {
      if (!cancelled) setAuthChecked(true);
    }, 4000);
    (async () => {
      try {
        const authed = await superdevClient.isAuthenticated();
        if (cancelled) return;
        setIsAuth(authed);
        if (authed) {
          try { const me = await User.me(); if (!cancelled) setUserEmail(me?.email || ""); }
          catch { if (!cancelled) setUserEmail(""); }
        }
      } catch { if (!cancelled) setIsAuth(false); }
      finally {
        if (!cancelled) {
          window.clearTimeout(fallbackTimer);
          setAuthChecked(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimer);
    };
  }, []);

  useEffect(() => {
    if (!isAuth) {
      accessStatusRequestRef.current += 1;
      accessStatusRef.current = null;
      setAccessStatus(null);
      setAccessStatusError("");
      setAccessStatusLoading(false);
      return;
    }
    void refreshAccessStatus();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshAccessStatus();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const interval = window.setInterval(refreshWhenVisible, 60_000);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(interval);
    };
  }, [isAuth, refreshAccessStatus]);

  const loadSessions = useCallback(async () => {
    if (!accessIsAllowed(accessStatusRef.current)) return;
    setLibraryLoading(true);
    try {
      const rows = (await TranscriptionSession.list("-updated_at", 100)) as TranscriptionSessionRecord[];
      if (!accessIsAllowed(accessStatusRef.current)) return;
      setSessions((rows || []).map(withReviewDefaults));
    } catch (error) {
      if (accessIsAllowed(accessStatusRef.current)) {
        console.error(error);
        toast.error("Could not load sessions.");
      }
    } finally { setLibraryLoading(false); }
  }, []);

  useEffect(() => {
    if (isAuth && accessIsAllowed(accessStatus)) void loadSessions();
  }, [isAuth, accessStatus?.can_transcribe, loadSessions]);

  const loadWorkspace = useCallback(async (id: string) => {
    if (!accessIsAllowed(accessStatusRef.current)) return;
    const requestId = ++workspaceRequestRef.current;
    setWorkspaceLoading(true);
    try {
      const allSessions = ((await TranscriptionSession.list("-updated_at", 100)) as TranscriptionSessionRecord[]).map(withReviewDefaults);
      if (!accessIsAllowed(accessStatusRef.current)) return;
      const found = allSessions.find((item) => item.id === id) || null;
      if (!found) {
        setSession(null); setLines([]); setSegments([]); setIssues([]); setAnnotations([]);
        toast.error("Session not found.");
        return;
      }
      const [lineRows, segmentRows, issueRows, annotationRows] = await Promise.all([
        TranscriptLine.filter({ session_id: id }, "sequence", 500),
        AudioSegment.filter({ session_id: id }, "sequence", 500),
        AudioIssue.filter({ session_id: id }, "-timestamp_ms", 200),
        TranscriptAnnotation.filter({ session_id: id }, "start_ms", 500),
      ]);
      if (!accessIsAllowed(accessStatusRef.current) || requestId !== workspaceRequestRef.current || activeIdRef.current !== id) return;
      setSessions(allSessions || []);
      setSession(found);
      setLines((lineRows || []) as TranscriptLineRecord[]);
      setSegments((segmentRows || []) as AudioSegmentRecord[]);
      setIssues((issueRows || []) as AudioIssueRecord[]);
      setAnnotations((annotationRows || []) as TranscriptAnnotationRecord[]);
    } catch (error) {
      if (accessIsAllowed(accessStatusRef.current)) {
        console.error(error);
        toast.error("Could not open session.");
      }
    } finally { if (requestId === workspaceRequestRef.current) setWorkspaceLoading(false); }
  }, []);

  useEffect(() => {
    if (activeId && accessIsAllowed(accessStatus)) void loadWorkspace(activeId);
    else { setSession(null); setLines([]); setSegments([]); setIssues([]); setAnnotations([]); setCleanupOpen(false); setCleanupProposals([]); }
  }, [activeId, accessStatus?.can_transcribe, loadWorkspace]);

  const patchSessionLocal = useCallback((
    patch: Partial<TranscriptionSessionRecord>,
    targetId = activeIdRef.current
  ) => {
    setSession((current) => current && current.id === targetId ? { ...current, ...patch } : current);
    setSessions((current) => current.map((item) => item.id === targetId ? { ...item, ...patch } : item));
  }, []);

  const persistSession = useCallback(async (id: string, patch: Partial<TranscriptionSessionRecord>) => {
    setSettingsSaving(true);
    try {
      const updated = (await TranscriptionSession.update(id, patch)) as TranscriptionSessionRecord;
      patchSessionLocal({ ...patch, ...updated }, id);
    } catch (error) { console.error(error); toast.error("Could not save session settings."); }
    finally { setSettingsSaving(false); }
  }, [patchSessionLocal]);

  const onSettingsChange = useCallback((patch: Partial<TranscriptionSessionRecord>) => {
    if (!session) return;
    patchSessionLocal(patch);
    pendingSettings.current = { ...pendingSettings.current, ...patch };
    if (settingsTimer.current) window.clearTimeout(settingsTimer.current);
    settingsTimer.current = window.setTimeout(() => {
      const payload = pendingSettings.current;
      pendingSettings.current = {};
      void persistSession(session.id, payload);
    }, 450);
  }, [patchSessionLocal, persistSession, session]);

  const persistCustomGuideline = useCallback(async (patch: Partial<TranscriptionSessionRecord>): Promise<boolean> => {
    const current = sessionRef.current;
    if (!current) return false;
    if (current.custom_guideline_locked_at || current.status === "recording") {
      toast.error("Custom guideline is locked for this capture.");
      return false;
    }
    const targetId = current.id;
    const previous: Partial<TranscriptionSessionRecord> = {
      custom_guideline_text: current.custom_guideline_text,
      custom_guideline_source_label: current.custom_guideline_source_label,
      custom_guideline_status: current.custom_guideline_status,
      custom_guideline_message: current.custom_guideline_message,
      custom_guideline_saved_at: current.custom_guideline_saved_at,
      custom_guideline_sources: current.custom_guideline_sources,
    };
    patchSessionLocal(patch, targetId);
    setCustomGuidelineSaving(true);
    try {
      const updated = (await TranscriptionSession.update(targetId, patch)) as Partial<TranscriptionSessionRecord>;
      patchSessionLocal({ ...patch, ...updated }, targetId);
      return true;
    } catch (error) {
      console.error("Could not save custom transcription guideline", error);
      patchSessionLocal(previous, targetId);
      toast.error("Could not save the custom guideline.");
      return false;
    } finally {
      setCustomGuidelineSaving(false);
    }
  }, [patchSessionLocal]);

  const handleIssue = useCallback((issue: AudioIssueRecord) => {
    if (issue.session_id !== activeIdRef.current) return;
    setIssues((current) => {
      const index = current.findIndex((item) => item.id === issue.id);
      if (index < 0) return [issue, ...current];
      const next = [...current];
      next[index] = { ...next[index], ...issue };
      return next;
    });
  }, []);

  const handleSegment = useCallback((segment: AudioSegmentRecord) => {
    if (!accessIsAllowed(accessStatusRef.current) || segment.session_id !== activeIdRef.current) return;
    setSegments((current) => {
      const index = current.findIndex((item) => item.id === segment.id);
      if (index >= 0) { const next = [...current]; next[index] = { ...next[index], ...segment }; return next; }
      return [...current, segment].sort((a, b) => a.sequence - b.sequence);
    });
    if (segment.upload_status === "uploaded" && !segment.transcription_status) {
      const owner = sessionRef.current?.id === segment.session_id
        ? sessionRef.current
        : sessionsRef.current.find((item) => item.id === segment.session_id);
      if (owner?.review_mode === "custom_guidelines" && !isCustomGuidelineReady(owner.custom_guideline_status, owner.custom_guideline_text)) return;
      window.setTimeout(() => {
        const latestOwner = sessionRef.current?.id === segment.session_id
          ? sessionRef.current
          : sessionsRef.current.find((item) => item.id === segment.session_id);
        if (latestOwner?.review_mode === "custom_guidelines" && !isCustomGuidelineReady(latestOwner.custom_guideline_status, latestOwner.custom_guideline_text)) return;
        if (accessIsAllowed(accessStatusRef.current) && segment.session_id === activeIdRef.current) void transcribeSegmentRef.current(segment.id, true);
      }, 0);
    }
  }, []);

  const submitAudioTranscription = useCallback(async (file: File, durationMs: number) => {
    const currentSession = sessionRef.current;
    if (!currentSession) {
      const message = "Open an audio transcription session before submitting audio.";
      setAudioSubmitError(message);
      throw new Error(message);
    }
    if (audioSubmitInFlightRef.current === currentSession.id) return;
    if (activeIdRef.current !== currentSession.id) {
      const message = "Open the active audio transcription session before submitting this file.";
      setAudioSubmitError(message);
      throw new Error(message);
    }
    if (!requireTranscriptionAccess()) {
      const message = accessRestrictionMessage(accessStatusRef.current, accessStatusError);
      setAudioSubmitError(message);
      throw new Error(message);
    }
    if (currentSession.input_mode !== "audio_transcription") {
      const message = "Choose an audio transcription session before submitting this file.";
      setAudioSubmitError(message);
      throw new Error(message);
    }
    if (currentSession.review_mode === "custom_guidelines" && !isCustomGuidelineReady(currentSession.custom_guideline_status, currentSession.custom_guideline_text)) {
      const message = customGuidelineReadinessMessage(currentSession.custom_guideline_status, currentSession.custom_guideline_text, currentSession.custom_guideline_message);
      setAudioSubmitError(message);
      toast.error(message);
      throw new Error(message);
    }
    const sizeError = validateAudioSize(file);
    if (sizeError) {
      setAudioSubmitStatus("");
      setAudioSubmitError(sizeError);
      throw new Error(sizeError);
    }

    const targetSessionId = currentSession.id;
    audioSubmitInFlightRef.current = targetSessionId;
    setAudioSubmitting(true);
    setAudioSubmitStatus("Uploading audio…");
    setAudioSubmitError("");

    const safeDurationMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    const sourceLabel = file.name || "Uploaded audio";
    const sessionPatch: Partial<TranscriptionSessionRecord> = {
      input_mode: "audio_transcription",
      review_mode: currentSession.review_mode || "standard",
      timestamp_cadence: currentSession.timestamp_cadence || "speaker_change",
      source_label: sourceLabel,
      duration_ms: safeDurationMs,
    };
    patchSessionLocal(sessionPatch, targetSessionId);

    let createdSegment: AudioSegmentRecord | null = null;
    try {
      try {
        const updatedSession = (await TranscriptionSession.update(targetSessionId, sessionPatch)) as Partial<TranscriptionSessionRecord>;
        patchSessionLocal({ ...sessionPatch, ...updatedSession }, targetSessionId);
      } catch (error) {
        console.error("Could not save audio session metadata", error);
      }

      const existingSegments = segmentsRef.current.filter((item) => item.session_id === targetSessionId);
      const sequence = existingSegments.reduce((max, item) => Math.max(max, item.sequence), -1) + 1;
      const segmentPayload: Omit<AudioSegmentRecord, "id"> = {
        session_id: targetSessionId,
        sequence,
        audio_url: "",
        mime_type: normalizeAudioMimeType(file),
        byte_size: file.size,
        start_ms: 0,
        end_ms: safeDurationMs,
        upload_status: "pending",
        error_message: "",
        is_final_segment: true,
      };
      const created = (await AudioSegment.create(segmentPayload)) as AudioSegmentRecord;
      createdSegment = { ...segmentPayload, ...created };
      const segmentToUpload = createdSegment;
      if (!segmentToUpload?.id) throw new Error("The audio segment could not be created.");
      if (activeIdRef.current === targetSessionId) {
        setSegments((current) => {
          if (current.some((item) => item.id === segmentToUpload.id)) return current;
          return [...current, segmentToUpload].sort((a, b) => a.sequence - b.sequence);
        });
      }

      const uploadResult = await uploadFile({ file });
      const uploadRecord = uploadResult as { file_url?: unknown };
      const audioUrl = typeof uploadRecord.file_url === "string" ? uploadRecord.file_url : "";
      if (!audioUrl) throw new Error("The audio upload did not return a usable file.");

      const updatedSegment = (await AudioSegment.update(segmentToUpload.id, {
        audio_url: audioUrl,
        upload_status: "uploaded",
        error_message: "",
      })) as Partial<AudioSegmentRecord>;
      const uploadedSegment: AudioSegmentRecord = {
        ...segmentToUpload,
        ...updatedSegment,
        audio_url: audioUrl,
        upload_status: "uploaded",
        error_message: "",
      };
      handleSegment(uploadedSegment);
      if (activeIdRef.current === targetSessionId) {
        setAudioSubmitStatus("Audio uploaded. Transcription is starting.");
        setAudioSubmitError("");
      }
    } catch (error) {
      console.error("Could not submit audio transcription", error);
      const segmentToFail = createdSegment;
      if (segmentToFail?.id) {
        try {
          const failedUpdate = (await AudioSegment.update(segmentToFail.id, {
            upload_status: "failed",
            error_message: "Audio upload failed.",
          })) as Partial<AudioSegmentRecord>;
          const failedSegment: AudioSegmentRecord = {
            ...segmentToFail,
            ...failedUpdate,
            upload_status: "failed",
            error_message: "Audio upload failed.",
          };
          if (activeIdRef.current === targetSessionId) {
            setSegments((current) => {
              const index = current.findIndex((item) => item.id === failedSegment.id);
              if (index < 0) return [...current, failedSegment].sort((a, b) => a.sequence - b.sequence);
              const next = [...current];
              next[index] = { ...next[index], ...failedSegment };
              return next;
            });
          }
        } catch (markError) {
          console.error("Could not mark the audio segment as failed", markError);
        }
      }
      const message = audioSubmitFailureMessage(error);
      if (activeIdRef.current === targetSessionId) {
        setAudioSubmitStatus("");
        setAudioSubmitError(message);
      }
      throw new Error(message);
    } finally {
      if (audioSubmitInFlightRef.current === targetSessionId) audioSubmitInFlightRef.current = null;
      if (activeIdRef.current === targetSessionId) setAudioSubmitting(false);
    }
  }, [accessStatusError, handleSegment, patchSessionLocal, requireTranscriptionAccess]);

  const flushCaptureTiming = useCallback((id: string): Promise<void> => {
    const entry = pendingCaptureTiming.current.get(id);
    if (!entry) return Promise.resolve();
    if (entry.timer != null) {
      window.clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (!Object.keys(entry.patch).length) return entry.chain;
    const patch = entry.patch;
    entry.patch = {};
    entry.chain = entry.chain.then(async () => {
      try {
        await TranscriptionSession.update(id, patch);
      } catch (error) {
        console.error("Could not save capture timing", error);
      }
    });
    return entry.chain;
  }, []);

  const queueCaptureTiming = useCallback((id: string, patch: Partial<TranscriptionSessionRecord>, immediate = false) => {
    if (!id) return;
    patchSessionLocal(patch, id);
    const entry = pendingCaptureTiming.current.get(id) || { patch: {}, timer: null, chain: Promise.resolve() };
    entry.patch = { ...entry.patch, ...patch };
    pendingCaptureTiming.current.set(id, entry);
    if (immediate) {
      void flushCaptureTiming(id);
      return;
    }
    if (entry.timer != null) window.clearTimeout(entry.timer);
    entry.timer = window.setTimeout(() => {
      entry.timer = null;
      void flushCaptureTiming(id);
    }, 900);
  }, [flushCaptureTiming, patchSessionLocal]);

  const handleDuration = useCallback((ms: number, context: CaptureCallbackContext) => {
    queueCaptureTiming(context.sessionId, { duration_ms: Math.round(ms) });
  }, [queueCaptureTiming]);

  const handleCaptureState = useCallback((next: CaptureStatus) => {
    const id = next.captureSessionId;
    if (!id || next.state === "requesting" || !next.captureStartedAt) return;
    const timing = captureTimingPatch(next);
    const patch: Partial<TranscriptionSessionRecord> = { ...timing };
    const finished = next.phase === "ended";
    const owner = sessionRef.current?.id === id
      ? sessionRef.current
      : sessionsRef.current.find((item) => item.id === id);
    if (next.state === "recording") {
      patch.status = "recording";
      patch.error_summary = "";
      patch.ended_at = "";
      if (!owner?.started_at) patch.started_at = next.captureStartedAt;
    } else if (finished) {
      const failed = next.state === "error";
      patch.status = failed ? "failed" : "completed";
      patch.ended_at = next.captureEndedAt || new Date().toISOString();
      if (failed) patch.error_summary = next.message || owner?.error_summary || "The shared audio capture ended unexpectedly.";
    }
    queueCaptureTiming(id, patch, finished || next.phase === "active" || next.phase === "quiet");
  }, [queueCaptureTiming]);

  const handleCaptureEvent = useCallback((event: CaptureEventPayload) => {
    if (event.type !== "vad_transition" || event.label !== "meaningful-audio-start") return;
    const id = event.captureSessionId;
    if (!id) return;
    const owner = sessionRef.current?.id === id
      ? sessionRef.current
      : sessionsRef.current.find((item) => item.id === id);
    if (owner?.meaningful_audio_started_ms != null) return;
    queueCaptureTiming(id, {
      meaningful_audio_started_ms: Math.round(event.start_ms),
      audio_phase: "active",
    }, true);
  }, [queueCaptureTiming]);

  const handleFatal = useCallback((message: string, context: CaptureCallbackContext) => {
    toast.error(message);
    const patch = { status: "failed" as SessionStatus, error_summary: message, ended_at: new Date().toISOString() };
    queueCaptureTiming(context.sessionId, patch, true);
  }, [queueCaptureTiming]);

  const clearProtectedWorkspace = useCallback(() => {
    workspaceRequestRef.current += 1;
    transcriptionQueueRef.current.clear();
    setTranscriptionBusyIds(new Set());
    setLibraryLoading(false);
    setWorkspaceLoading(false);
    setSessions([]);
    setActiveId(null);
    setSession(null);
    setLines([]);
    setSegments([]);
    setIssues([]);
    setAnnotations([]);
    setCleanupOpen(false);
    setCleanupProposals([]);
  }, []);

  const capture = useAudioCapture({ sessionId: activeId, onSegment: handleSegment, onIssue: handleIssue, onDuration: handleDuration, onCaptureState: handleCaptureState, onCaptureEvent: handleCaptureEvent, onFatal: handleFatal });
  captureStopRef.current = capture.stop;

  useEffect(() => {
    if (!isAuth || accessIsAllowed(accessStatus)) return;
    clearProtectedWorkspace();
    const state = capture.status.state;
    const hasActiveCapture = state === "requesting" || state === "recording" || state === "stopping";
    if (hasActiveCapture) {
      void captureStopRef.current?.().catch((error) => console.error("Could not stop restricted capture", error));
    }
  }, [isAuth, accessStatus?.can_transcribe, accessStatus?.status, clearProtectedWorkspace]);

  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    return sessions.filter((item) => {
      const archived = item.archive_status === "ARCHIVED";
      if (statusFilter === "archived") {
        if (!archived) return false;
      } else {
        if (archived) return false;
        if (statusFilter !== "all" && item.status !== statusFilter) return false;
      }
      if (!query) return true;
      return (item.title || "").toLowerCase().includes(query) || (item.source_label || "").toLowerCase().includes(query) || (item.language || "").toLowerCase().includes(query);
    });
  }, [sessions, search, statusFilter]);

  const changeSessionFilter = useCallback((next: SessionFilter) => {
    setStatusFilter(next);
    const current = activeIdRef.current ? sessionsRef.current.find((item) => item.id === activeIdRef.current) : null;
    const wantsArchived = next === "archived";
    if (current && (current.archive_status === "ARCHIVED") !== wantsArchived) setActiveId(null);
  }, []);

  const canArchiveSession = useCallback((candidate: TranscriptionSessionRecord): boolean => {
    if (!candidate.id || candidate.archive_status === "ARCHIVED") return false;
    const live = sessionsRef.current.find((item) => item.id === candidate.id) || candidate;
    if (live.status === "recording") return false;
    if (live.transcription_status === "processing" || (live.transcription_active_count || 0) > 0) return false;
    if (audioSubmitInFlightRef.current === candidate.id) return false;
    if (candidate.id !== activeIdRef.current) return true;
    const captureState = capture.status.state;
    const captureActive = ["requesting", "recording", "stopping"].includes(captureState)
      && (!capture.status.captureSessionId || capture.status.captureSessionId === candidate.id);
    const currentBusy = audioSubmitting || cleanupLoading || settingsSaving || customGuidelineSaving || workspaceLoading || transcriptionBusyIds.size > 0;
    return !captureActive && !currentBusy;
  }, [audioSubmitting, cleanupLoading, customGuidelineSaving, capture.status.captureSessionId, capture.status.state, settingsSaving, transcriptionBusyIds, workspaceLoading]);

  const archiveSession = useCallback(async (id: string): Promise<boolean> => {
    const candidate = sessionsRef.current.find((item) => item.id === id);
    if (!candidate || !canArchiveSession(candidate)) {
      toast.message("Finish capture or processing before archiving this session.");
      return false;
    }
    const requestId = (sessionArchiveRequestRef.current.get(id) || 0) + 1;
    sessionArchiveRequestRef.current.set(id, requestId);
    try {
      const fresh = (await TranscriptionSession.get(id)) as TranscriptionSessionRecord;
      if (!fresh?.id || sessionArchiveRequestRef.current.get(id) !== requestId) return false;
      const live = withReviewDefaults(fresh);
      if (!canArchiveSession(live)) {
        toast.message("This session changed and cannot be archived while capture or processing is active.");
        return false;
      }
      await TranscriptionSession.update(id, { archive_status: "ARCHIVED" });
      if (sessionArchiveRequestRef.current.get(id) !== requestId) return false;
      setSessions((current) => current.map((item) => item.id === id ? { ...item, archive_status: "ARCHIVED" } : item));
      setSession((current) => current?.id === id ? { ...current, archive_status: "ARCHIVED" } : current);
      if (activeIdRef.current === id) setActiveId(null);
      toast.success("Session archived. It remains available under Archived.");
      return true;
    } catch (error) {
      console.error("Could not archive session", error);
      toast.error("Could not archive this session. Nothing was removed.");
      return false;
    }
  }, [canArchiveSession]);

  const restoreSession = useCallback(async (id: string): Promise<boolean> => {
    const candidate = sessionsRef.current.find((item) => item.id === id);
    if (!candidate || candidate.archive_status !== "ARCHIVED") return false;
    const requestId = (sessionArchiveRequestRef.current.get(id) || 0) + 1;
    sessionArchiveRequestRef.current.set(id, requestId);
    try {
      const fresh = (await TranscriptionSession.get(id)) as TranscriptionSessionRecord;
      if (!fresh?.id || sessionArchiveRequestRef.current.get(id) !== requestId) return false;
      if (withReviewDefaults(fresh).archive_status !== "ARCHIVED") return false;
      await TranscriptionSession.update(id, { archive_status: "ACTIVE" });
      if (sessionArchiveRequestRef.current.get(id) !== requestId) return false;
      setSessions((current) => current.map((item) => item.id === id ? { ...item, archive_status: "ACTIVE" } : item));
      setSession((current) => current?.id === id ? { ...current, archive_status: "ACTIVE" } : current);
      setStatusFilter("all");
      toast.success("Session restored to the normal session views.");
      return true;
    } catch (error) {
      console.error("Could not restore session", error);
      toast.error("Could not restore this session. Nothing was removed.");
      return false;
    }
  }, []);

  const createSession = async () => {
    if (creating || !requireTranscriptionAccess()) return;
    setCreating(true);
    try {
      const stamp = new Date();
      const title = `Session ${stamp.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
      const created = withReviewDefaults((await TranscriptionSession.create({ title, status: "completed", source_label: "", language: "auto", language_mode: "auto", language_preferences: [], accent_hint: "", detected_languages: [], transcript_style: "full_verbatim", speaker_scheme: "numbered", timestamp_cadence: "speaker_change", archive_status: "ACTIVE", started_at: "", ended_at: "", duration_ms: 0, error_summary: "", last_speaker: "Speaker 1", custom_speakers: [], transcription_status: "idle", transcription_total_count: 0, transcription_pending_count: 0, transcription_active_count: 0, transcription_completed_count: 0, transcription_failed_count: 0, cleanup_status: "idle", session_mode: "transcription", translation_source_language: "auto", translation_target_language: "en", review_mode: "standard", custom_guideline_text: "", custom_guideline_source_label: "", custom_guideline_status: "empty", custom_guideline_message: "", custom_guideline_saved_at: "", custom_guideline_locked_at: "", custom_guideline_sources: [], pulsar_readiness: "not_started", pulsar_qa_ran_at: "", input_mode: "browser_capture" })) as TranscriptionSessionRecord);
      if (!accessIsAllowed(accessStatusRef.current)) {
        toast.error(accessRestrictionMessage(accessStatusRef.current, accessStatusError));
        return;
      }
      setSessions((current) => [created, ...current]); setActiveId(created.id); toast.success("Session created.");
    } catch (error) { console.error(error); toast.error("Could not create session. Sign in and try again."); }
    finally { setCreating(false); }
  };

  const startCapture = async () => {
    if (!session) return;
    if (session.input_mode === "audio_transcription") return;
    const captureInProgress = ["requesting", "recording", "stopping"].includes(capture.status.state);
    if (capture.isBusy || captureInProgress) {
      if (capture.status.captureSessionId && capture.status.captureSessionId !== session.id) toast.message("Finish the active browser capture before starting another session.");
      return;
    }
    if (!requireTranscriptionAccess()) return;
    if (session.review_mode === "custom_guidelines" && !isCustomGuidelineReady(session.custom_guideline_status, session.custom_guideline_text)) {
      toast.error(customGuidelineReadinessMessage(session.custom_guideline_status, session.custom_guideline_text, session.custom_guideline_message));
      return;
    }
    const orderedSegments = [...segments].sort((a, b) => a.sequence - b.sequence);
    const previousFinalSegment = [...orderedSegments].reverse().find((item) => item.is_final_segment) || orderedSegments[orderedSegments.length - 1];
    const leadingIssue = issues.find((item) => item.kind === "leading_silence");
    const trailingIssue = issues.find((item) => item.kind === "trailing_silence");
    const nextSequence = orderedSegments.reduce((max, item) => Math.max(max, item.sequence), -1) + 1;
    const elapsedOffsetMs = sessionTimelineEnd(session, orderedSegments);
    const result = await capture.start({
      nextSequence,
      elapsedOffsetMs,
      existingMeaningfulAudioStartedMs: session.meaningful_audio_started_ms,
      existingMeaningfulAudioEndedMs: session.meaningful_audio_ended_ms,
      existingLeadingSilenceMs: session.leading_silence_ms,
      existingTrailingSilenceMs: session.trailing_silence_ms,
      leadingSilenceAlreadyRecorded: session.leading_silence_ms != null,
      trailingSilenceAlreadyRecorded: session.trailing_silence_ms != null,
      leadingSilenceIssueId: leadingIssue?.id,
      trailingSilenceIssueId: trailingIssue?.id,
      previousFinalSegmentId: previousFinalSegment?.id,
    });
    if (!accessIsAllowed(accessStatusRef.current)) {
      if (result === "recording" || capture.status.state === "recording" || capture.status.state === "requesting") {
        await capture.stop();
      }
      toast.error(accessRestrictionMessage(accessStatusRef.current, accessStatusError));
      return;
    }
    if (session.review_mode === "custom_guidelines" && result === "recording" && !session.custom_guideline_locked_at) {
      const lockedAt = new Date().toISOString();
      patchSessionLocal({ custom_guideline_locked_at: lockedAt }, session.id);
      try {
        const updated = (await TranscriptionSession.update(session.id, { custom_guideline_locked_at: lockedAt })) as Partial<TranscriptionSessionRecord>;
        patchSessionLocal({ ...updated, custom_guideline_locked_at: lockedAt }, session.id);
      } catch (error) {
        console.error("Could not lock custom transcription guideline", error);
        try {
          await capture.stop();
          await flushCaptureTiming(session.id);
        } catch (stopError) {
          console.error("Could not stop capture after the custom guideline lock failed", stopError);
        }
        patchSessionLocal({ custom_guideline_locked_at: session.custom_guideline_locked_at || "" }, session.id);
        toast.error("Could not lock the custom guideline. Capture stopped. Update the guideline and try again.");
        return;
      }
    }
    if (result === "cancelled") toast.message("Capture cancelled. The session was not started.");
  };

  useEffect(() => {
    const ownerId = capture.status.captureSessionId;
    if (!ownerId || !capture.status.sourceLabel || capture.status.state !== "recording") return;
    const ownerSession = sessionRef.current?.id === ownerId
      ? sessionRef.current
      : sessionsRef.current.find((item) => item.id === ownerId);
    if (ownerSession?.source_label === capture.status.sourceLabel) return;
    patchSessionLocal({ source_label: capture.status.sourceLabel }, ownerId);
    void TranscriptionSession.update(ownerId, { source_label: capture.status.sourceLabel }).catch(console.error);
  }, [capture.status.captureSessionId, capture.status.sourceLabel, capture.status.state, patchSessionLocal]);

  const stopCapture = async () => {
    if (!session) return;
    if (capture.status.captureSessionId && capture.status.captureSessionId !== session.id) {
      toast.message("Open the session that owns the active capture before stopping it.");
      return;
    }
    const finalStatus = await capture.stop();
    const ownerId = finalStatus.captureSessionId || session.id;
    const ownerSession = sessionRef.current?.id === ownerId
      ? sessionRef.current
      : sessionsRef.current.find((item) => item.id === ownerId) || (session.id === ownerId ? session : undefined);
    const patch: Partial<TranscriptionSessionRecord> = {
      ...captureTimingPatch(finalStatus),
      status: finalStatus.state === "error" ? "failed" : "completed",
      ended_at: finalStatus.captureEndedAt || new Date().toISOString(),
      source_label: finalStatus.sourceLabel || ownerSession?.source_label || "",
    };
    if (!ownerSession?.started_at && finalStatus.captureStartedAt) patch.started_at = finalStatus.captureStartedAt;
    if (finalStatus.state === "error") patch.error_summary = finalStatus.message || ownerSession?.error_summary || "The shared audio capture ended unexpectedly.";
    queueCaptureTiming(ownerId, patch, true);
    await flushCaptureTiming(ownerId);
    if (finalStatus.state === "error") toast.error(finalStatus.message || "The shared audio capture ended unexpectedly.");
    else toast.success("Recording stopped. Clips will transcribe after upload.");
  };

  const applyTranscriptionResult = useCallback((segmentId: string, result: TranscriptionJobResult) => {
    if (result.segment) handleSegment(result.segment);
    if (result.issue) handleIssue(result.issue);
    if (result.session) patchSessionLocal(result.session);
    if (result.lines) {
      const incomingIds = new Set(result.lines.map((line) => line.id));
      setLines((current) => {
        const kept = current.filter((line) => !(line.source_segment_id === segmentId && line.origin === "generated" && line.edit_state !== "edited") && !incomingIds.has(line.id));
        return sortTranscriptLines([...kept, ...result.lines!]);
      });
    }
  }, [handleIssue, handleSegment, patchSessionLocal]);

  const transcribeSegment = useCallback(async (segmentId: string, silent = false) => {
    if (!requireTranscriptionAccess()) return;
    const currentSession = session;
    const segment = segments.find((item) => item.id === segmentId);
    if (!currentSession || activeIdRef.current !== currentSession.id || !segment || segment.upload_status !== "uploaded" || getTranscriptionStatus(segment) === "completed" || transcriptionQueueRef.current.has(segmentId)) return;
    transcriptionQueueRef.current.add(segmentId);
    setTranscriptionBusyIds((current) => new Set(current).add(segmentId));
    setSegments((current) => current.map((item) => item.id === segmentId ? { ...item, transcription_status: "transcribing", transcription_error: "" } : item));
    patchSessionLocal({ transcription_status: "processing" }, currentSession.id);
    try {
      const rawResult = await transcribeAudioSegment({ segment_id: segmentId, session_id: currentSession.id });
      const result = responseObject(rawResult) as unknown as TranscriptionJobResult;
      if (isAccessRestrictedResponse(rawResult) || isAccessRestrictedResponse(result)) {
        toast.error("Transcription access is currently unavailable.");
        void refreshAccessStatus();
        return;
      }
      if (!accessIsAllowed(accessStatusRef.current)) {
        toast.error(accessRestrictionMessage(accessStatusRef.current, accessStatusError));
        return;
      }
      if (activeIdRef.current !== currentSession.id) return;
      applyTranscriptionResult(segmentId, result);
      if (!result.ok && result.status === "failed") { if (!silent) toast.error(result.error || "Transcription failed. Retry the clip."); }
      else if (!silent && result.status === "completed") toast.success("Clip transcribed.");
    } catch (error) {
      if (isAccessRestrictedResponse(error)) {
        toast.error("Transcription access is currently unavailable.");
        void refreshAccessStatus();
      } else {
        console.error("Transcription request failed", error);
        if (!silent) toast.error(error instanceof Error ? error.message : "Transcription request failed. Retry the clip.");
      }
      if (activeIdRef.current === currentSession.id && accessIsAllowed(accessStatusRef.current)) void loadWorkspace(currentSession.id);
    } finally {
      transcriptionQueueRef.current.delete(segmentId);
      setTranscriptionBusyIds((current) => { const next = new Set(current); next.delete(segmentId); return next; });
    }
  }, [accessStatusError, applyTranscriptionResult, loadWorkspace, patchSessionLocal, refreshAccessStatus, requireTranscriptionAccess, segments, session]);

  useEffect(() => { transcribeSegmentRef.current = transcribeSegment; }, [transcribeSegment]);

  const transcribePending = async () => {
    if (!session || !requireTranscriptionAccess()) return;
    const ids = segments.filter((segment) => segment.upload_status === "uploaded" && getTranscriptionStatus(segment) === "pending").map((segment) => segment.id);
    if (!ids.length) { toast.message("There are no pending clips."); return; }
    await Promise.all(ids.map((id) => transcribeSegment(id)));
    if (accessIsAllowed(accessStatusRef.current)) await loadWorkspace(session.id);
  };

  const retryFailed = async () => {
    if (!session || !requireTranscriptionAccess()) return;
    const ids = segments.filter((segment) => segment.upload_status === "uploaded" && getTranscriptionStatus(segment) === "failed").map((segment) => segment.id);
    if (!ids.length) { toast.message("There are no failed clips to retry."); return; }
    await Promise.all(ids.map((id) => transcribeSegment(id)));
    if (accessIsAllowed(accessStatusRef.current)) await loadWorkspace(session.id);
  };

  const nextSequence = () => lines.reduce((max, line) => Math.max(max, line.sequence), -1) + 1;
  const addLine = async (kind: "speech" | "marker" | "timestamp") => {
    if (!session) return;
    const speakers = defaultSpeakers(session.speaker_scheme, session.custom_speakers);
    const time = Math.round(capture.status.elapsedMs || session.duration_ms || 0);
    try {
      const row = (await TranscriptLine.create({ session_id: session.id, sequence: nextSequence(), kind, speaker_label: kind === "speech" ? session.last_speaker || speakers[0] : "", text: kind === "marker" ? "Marker" : "", start_ms: time, end_ms: time, origin: "manual", edit_state: "edited", raw_text: "" })) as TranscriptLineRecord;
      setLines((current) => sortTranscriptLines([...current, row]));
    } catch (error) { console.error(error); toast.error(`Could not add ${kind} line.`); }
  };

  const addUnclearMarker = async (kind: UnclearMarkerKind) => {
    if (!session) return;
    const time = Math.round(capture.status.elapsedMs || session.duration_ms || 0);
    const tag = `[${kind} ${formatExportTimestamp(time)}]`;
    try {
      const row = (await TranscriptLine.create({
        session_id: session.id,
        sequence: nextSequence(),
        kind: "marker",
        speaker_label: "",
        text: tag,
        start_ms: time,
        end_ms: time,
        origin: "manual",
        edit_state: "edited",
        raw_text: tag,
      })) as TranscriptLineRecord;
      setLines((current) => sortTranscriptLines([...current, row]));
      toast.success(`${kind === "inaudible" ? "Inaudible" : "Unintelligible"} mark added at ${formatExportTimestamp(time)}.`);
    } catch (error) {
      console.error(error);
      toast.error("Could not add the unclear-audio mark.");
    }
  };

  const updateLine = (id: string, patch: Partial<TranscriptLineRecord>) => {
    const existing = lines.find((line) => line.id === id);
    const targetSessionId = existing?.session_id || session?.id || activeIdRef.current || "";
    const touchesContent = patch.text !== undefined || patch.speaker_label !== undefined || patch.start_ms !== undefined || patch.end_ms !== undefined;
    const enriched: Partial<TranscriptLineRecord> = { ...patch };
    if (existing?.origin === "generated" && existing.edit_state !== "edited" && touchesContent) {
      enriched.raw_text = existing.raw_text || existing.text || "";
      enriched.edit_state = "edited";
      enriched.edited_at = new Date().toISOString();
    }
    setLines((current) => current.map((line) => line.id === id ? { ...line, ...enriched } : line));
    pendingLines.current[id] = { ...(pendingLines.current[id] || {}), ...enriched };
    if (lineTimers.current[id]) window.clearTimeout(lineTimers.current[id]);
    lineTimers.current[id] = window.setTimeout(() => {
      const payload = pendingLines.current[id] || enriched;
      delete pendingLines.current[id];
      const canPropose = Boolean(targetSessionId && payload.text !== undefined && existing?.origin === "generated" && existing.kind === "speech");
      void TranscriptLine.update(id, payload)
        .then(() => { if (canPropose) queueLearningProposal(targetSessionId, id); })
        .catch((error) => { console.error(error); toast.error("Could not save line."); });
    }, 400);
  };

  const insertPulsarTag = (lineId: string, tag: PulsarTagDefinition) => {
    const line = lines.find((item) => item.id === lineId);
    if (!line) {
      toast.message("Choose an existing transcript line first.");
      return;
    }
    const result = applyPulsarTag(line.text || "", tag);
    if (!result.ok) {
      toast.message(result.reason);
      return;
    }
    updateLine(lineId, { text: result.text });
    toast.success(`${tag.displayLabel} added to line ${line.sequence + 1}.`);
  };

  const updatePulsarClipStatus = async (segmentId: string, status: PulsarClipStatus) => {
    const currentSession = sessionRef.current;
    const currentSegment = segments.find((segment) => segment.id === segmentId);
    if (!currentSession || !currentSegment || currentSegment.upload_status !== "uploaded") return;
    const previousStatus = currentSegment.pulsar_review_status;
    setSegments((current) => current.map((segment) => segment.id === segmentId ? { ...segment, pulsar_review_status: status } : segment));
    try {
      const updated = (await AudioSegment.update(segmentId, { pulsar_review_status: status })) as Partial<AudioSegmentRecord>;
      if (activeIdRef.current === currentSession.id) {
        setSegments((current) => current.map((segment) => segment.id === segmentId ? { ...segment, ...updated, pulsar_review_status: status } : segment));
      }
    } catch (error) {
      console.error("Could not save Pulsar clip review status", error);
      if (activeIdRef.current === currentSession.id) {
        setSegments((current) => current.map((segment) => segment.id === segmentId ? { ...segment, pulsar_review_status: previousStatus } : segment));
      }
      toast.error("Could not save this clip's review status.");
    }
  };

  const runPulsarQA = async () => {
    const currentSession = sessionRef.current;
    if (!currentSession) return;
    const previous = { pulsar_qa_ran_at: currentSession.pulsar_qa_ran_at, pulsar_readiness: currentSession.pulsar_readiness };
    const ranAt = new Date().toISOString();
    const patch: Partial<TranscriptionSessionRecord> = { pulsar_qa_ran_at: ranAt };
    if (currentSession.pulsar_readiness !== "ready") patch.pulsar_readiness = "in_progress";
    patchSessionLocal(patch, currentSession.id);
    try {
      const updated = (await TranscriptionSession.update(currentSession.id, patch)) as TranscriptionSessionRecord;
      patchSessionLocal({ ...patch, ...updated }, currentSession.id);
      toast.success("Local Pulsar QA finished.");
    } catch (error) {
      console.error("Could not save Pulsar QA timestamp", error);
      patchSessionLocal(previous, currentSession.id);
      toast.error("Could not save the local QA run.");
    }
  };

  const exportPulsar = async () => {
    const currentSession = sessionRef.current;
    if (!currentSession) return;
    try {
      const qa = evaluatePulsarQa({ session: currentSession, lines, segments, issues, annotations }, currentSession.pulsar_qa_ran_at);
      const readiness = calculatePulsarReadiness({ session: currentSession, lines, segments, qa });
      const packageData = buildPulsarExportPackage({ session: currentSession, lines, segments, issues, annotations, qa, readiness });
      const blob = new Blob([JSON.stringify(packageData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = pulsarExportFilename(currentSession.title, currentSession.id);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      toast.success("Local Pulsar JSON downloaded.");
    } catch (error) {
      console.error("Could not export Pulsar review", error);
      toast.error("Could not prepare the local Pulsar JSON.");
    }
  };

  const setPulsarReadiness = async (state: PulsarReadiness) => {
    const currentSession = sessionRef.current;
    if (!currentSession) return;
    if (state === "ready") {
      const qa = evaluatePulsarQa({ session: currentSession, lines, segments, issues, annotations }, currentSession.pulsar_qa_ran_at);
      const readiness = calculatePulsarReadiness({ session: currentSession, lines, segments, qa });
      if (!readiness.eligible) {
        toast.message(readiness.blockers[0]?.message || "Finish the local Pulsar prerequisites first.");
        return;
      }
    }
    const previous = currentSession.pulsar_readiness;
    const patch = { pulsar_readiness: state };
    patchSessionLocal(patch, currentSession.id);
    try {
      const updated = (await TranscriptionSession.update(currentSession.id, patch)) as TranscriptionSessionRecord;
      patchSessionLocal({ ...patch, ...updated }, currentSession.id);
      toast.success(state === "ready" ? "Session marked ready locally." : "Pulsar readiness reopened.");
    } catch (error) {
      console.error("Could not save Pulsar readiness", error);
      patchSessionLocal({ pulsar_readiness: previous }, currentSession.id);
      toast.error("Could not save the local readiness state.");
    }
  };

  const invalidatePulsarReadiness = () => {
    const currentSession = sessionRef.current;
    if (!currentSession || currentSession.review_mode !== "pulsar_review" || currentSession.pulsar_readiness !== "ready") return;
    const patch = { pulsar_readiness: "in_progress" as PulsarReadiness };
    patchSessionLocal(patch, currentSession.id);
    void TranscriptionSession.update(currentSession.id, patch).catch((error) => console.error("Could not downgrade Pulsar readiness", error));
  };

  const resequence = async (ordered: TranscriptLineRecord[]) => {
    const withSequence = ordered.map((line, index) => ({ ...line, sequence: index }));
    setLines(withSequence);
    await Promise.all(withSequence.map((line) => TranscriptLine.update(line.id, { sequence: line.sequence }).catch((error) => console.error(error))));
  };

  const splitLine = async (id: string, cursor: number) => {
    const line = lines.find((item) => item.id === id);
    if (!line || line.kind !== "speech") return;
    const text = line.text || "";
    const cut = Math.max(0, Math.min(cursor, text.length));
    if (cut <= 0 || cut >= text.length) { toast.message("Place the cursor inside the line text to split."); return; }
    const left = text.slice(0, cut).trimEnd();
    const right = text.slice(cut).trimStart();
    try {
      const now = new Date().toISOString();
      await TranscriptLine.update(id, { text: left, raw_text: line.raw_text || text, edit_state: "edited", edited_at: now });
      const created = (await TranscriptLine.create({ session_id: line.session_id, sequence: line.sequence + 0.5, kind: "speech", speaker_label: line.speaker_label || session?.last_speaker || "Speaker 1", text: right, raw_text: right, start_ms: line.start_ms ?? 0, end_ms: line.end_ms ?? 0, origin: line.origin || "manual", source_segment_id: line.source_segment_id || "", provider_speaker_id: line.provider_speaker_id || "", edit_state: "edited", edited_at: now, audio_event_tags: line.audio_event_tags || [] })) as TranscriptLineRecord;
      const ordered = sortTranscriptLines([...lines.map((item) => item.id === id ? { ...item, text: left, raw_text: line.raw_text || text, edit_state: "edited" as const } : item), created]);
      await resequence(ordered);
    } catch (error) { console.error(error); toast.error("Could not split line."); }
  };

  const deleteLine = async (id: string) => {
    try { await TranscriptLine.delete(id); await resequence(lines.filter((line) => line.id !== id)); }
    catch (error) { console.error(error); toast.error("Could not delete line."); }
  };

  const onSpeakerUsed = (label: string) => { if (session && label && session.last_speaker !== label) onSettingsChange({ last_speaker: label }); };
  const onAddCustomSpeaker = (label: string) => {
    if (!session || !label) return;
    const existing = session.custom_speakers || [];
    if (existing.includes(label)) { onSpeakerUsed(label); return; }
    onSettingsChange({ custom_speakers: [...existing, label], last_speaker: label, speaker_scheme: "custom" });
  };

  const createAnnotation = async (draft: AnnotationDraft) => {
    if (!session) return;
    try {
      const row = (await TranscriptAnnotation.create({ ...draft, session_id: session.id, start_ms: Math.max(0, Math.round(draft.start_ms)), end_ms: Math.max(Math.round(draft.start_ms), Math.round(draft.end_ms)), sequence: annotations.length })) as TranscriptAnnotationRecord;
      setAnnotations((current) => [...current, row].sort((a, b) => a.start_ms - b.start_ms));
      toast.success("Timeline section saved.");
    } catch (error) { console.error(error); toast.error("Could not save timeline section."); }
  };

  const updateAnnotation = async (id: string, patch: Partial<AnnotationDraft>) => {
    const current = annotations.find((annotation) => annotation.id === id);
    const safePatch = { ...patch };
    if (safePatch.start_ms != null) safePatch.start_ms = Math.max(0, Math.round(safePatch.start_ms));
    if (safePatch.end_ms != null) safePatch.end_ms = Math.max(safePatch.start_ms ?? current?.start_ms ?? 0, Math.round(safePatch.end_ms));
    setAnnotations((items) => items.map((item) => item.id === id ? { ...item, ...safePatch } : item));
    try { await TranscriptAnnotation.update(id, safePatch); }
    catch (error) { console.error(error); toast.error("Could not save timeline change."); if (session) void loadWorkspace(session.id); }
  };

  const deleteAnnotation = async (id: string) => {
    try { await TranscriptAnnotation.delete(id); setAnnotations((current) => current.filter((annotation) => annotation.id !== id)); }
    catch (error) { console.error(error); toast.error("Could not delete timeline section."); }
  };

  const cleanupTranscript = async () => {
    if (!session) return;
    const cleanupLanguageMode = getSessionLanguageMode(session);
    const cleanupLanguagePreferences = getManualLanguagePreferences(session);
    const cleanupAccentHint = session.accent_hint?.trim() || "";
    const speech = sortTranscriptLines(lines).filter((line) => line.kind === "speech" && line.text?.trim());
    if (!speech.length) { toast.message("Add or transcribe a speech line before cleanup."); return; }
    setCleanupLoading(true);
    try {
      let approvedLearningBlock = "";
      try {
        const approvedContext = await requestApprovedLearningContext(session.id);
        approvedLearningBlock = approvedLearningCleanupBlock(approvedContext.rules);
      } catch (error) {
        console.warn("Approved learning context unavailable; cleanup continues without it.", error);
      }
      const savedCustomGuideline = session.review_mode === "custom_guidelines" &&
        isCustomGuidelineReady(session.custom_guideline_status, session.custom_guideline_text)
        ? session.custom_guideline_text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim().slice(0, 12_000)
        : "";
      const currentSessionContext = [
        `Language context: ${cleanupLanguageMode === "manual" ? `Manual language hints${cleanupLanguagePreferences.length ? ` (${cleanupLanguagePreferences.join(", ")})` : ""}` : "Auto detect"}. Preserve every spoken language and code switch in its original language. Do not translate, transliterate, or normalize non-English speech into English.`,
        `Accent or dialect review context: ${cleanupAccentHint || "None provided"}. This is user-provided context only. Do not infer or label an accent, dialect, nationality, identity, or speaker role, and never let this hint change spelling.`,
        `Transcript style: ${session.transcript_style === "clean_verbatim" ? "Clean verbatim" : "Full verbatim"}. Only suggest a conservative change that follows that style. Speaker labels and timestamps are immutable and are not part of corrected_text.`,
      ];
      const customGuidelineBlock = savedCustomGuideline
        ? [
            "Ready saved Custom Guideline for this session. It has higher priority than approved private project knowledge.",
            savedCustomGuideline,
          ]
        : ["Custom Guidelines: no ready saved guideline applies to this session."];
      const proposals: CleanupProposal[] = [];
      const batches: TranscriptLineRecord[][] = [];
      let batch: TranscriptLineRecord[] = [];
      let chars = 0;
      speech.forEach((line) => {
        const size = (line.text || "").length;
        if (batch.length && chars + size > 8_000) { batches.push(batch); batch = []; chars = 0; }
        batch.push(line); chars += size;
      });
      if (batch.length) batches.push(batch);
      for (const currentBatch of batches) {
        const promptLines = currentBatch.map((line) => ({ line_id: line.id, speaker: line.speaker_label || "Speaker 1", timestamp: line.start_ms != null ? `[${line.start_ms}ms]` : "", text: line.text || "" }));
        const cleanupPrompt = [
          "Instruction priority: follow current session settings first, then a ready saved Custom Guideline, then lower-priority approved private project knowledge. The immutable source-truth rules in the base review behavior always apply.",
          ...currentSessionContext,
          ...customGuidelineBlock,
          ...(approvedLearningBlock ? [approvedLearningBlock] : []),
          "Base transcript review behavior:",
          "You are a careful reviewer of an audio transcript. Work only from the supplied spoken text.",
          "This is an audio transcription and transcript review workflow, not a meeting summary or call report.",
          "Use US English spelling when reviewing English words. Preserve the spelling, diacritics, grammar, and word order of non-English speech. Use another English spelling only when a client explicitly requests it in a comment. Do not claim or call an external Grammarly service.",
          "Never paraphrase, summarize, reconstruct, or improve a speaker's meaning. Never add missing words, infer unclear words, identify a speaker, or infer a sound event.",
          "Never correct a speaker's grammar as though the speaker said the corrected grammar. Preserve spoken contractions, expressions such as Oh my God, Oh dear, Oh my, Oh boy, and et cetera. Use the correct spelling for a misspoken word only when the intended word is clear.",
          "For Full verbatim, preserve fillers, false starts, speech errors, stutters, repetitions, slang, partial words, spoken grammar, and provider sound-event tags. When an obvious affirmative or negative variant is being normalized, use only Mm-hmm or Mm, Mm-mm, Uh-huh, or Uh-uh, without changing meaning.",
          "For Clean verbatim, remove only true fillers, non-informative false starts, stutters, and non-emphatic repetitions. Keep meaning-changing words, emphasis repetitions such as No, no, no. and very, very happy., expressions, contractions, and sound-event tags. Expand gotcha to got you, gonna to going to, wanna to want to, 'cause to because, and alright to all right. Use Okay, never Ok or OK. Normalize yeah, yep, yap, yup, mm-hmm, or uh-huh to yes only when they are meaningful answers, and omit yes or yeah reactions only when they are not answers.",
          "In Clean verbatim, avoid starting a sentence with an unnecessary and, so, or but, while keeping the original meaning. Do not remove a filler when it changes meaning.",
          "Capitalize sentence beginnings. End sentences with punctuation, but never use exclamation marks. Use -- for false starts, speech errors, changes of thought, or incomplete thoughts, and a single - for an interruption where the speaker continues. Use double quotation marks for direct quotations, square brackets for tags, and never use [sic] or parentheses for audio tags.",
          "Keep US number and link conventions when a safe formatting change is needed: spell out single-digit numbers, use numerals for 10 and above, capitalize AM and PM, and keep normal web links such as www.facebook.com/groups/gotranscript.",
          "Every existing bracketed tag must be preserved byte-for-byte, in the same position and order. Never add, remove, rename, move, timestamp, or infer a sound-event tag. Never create [inaudible ...] or [unintelligible ...] markings. If one already exists, it must use exactly [inaudible HH:MM:SS] or [unintelligible HH:MM:SS]. Do not turn a confidence concern into an unclear-audio mark.",
          "Return JSON only. Include a line only when corrected_text is a safe review suggestion. Otherwise return an empty changes array.",
          `Input lines:\n${JSON.stringify(promptLines)}`,
        ].join("\n");
        const result = await invokeLLM({ mode: "standard", prompt: cleanupPrompt, response_json_schema: { type: "object", properties: { changes: { type: "array", items: { type: "object", properties: { line_id: { type: "string" }, corrected_text: { type: "string" } }, required: ["line_id", "corrected_text"] } } }, required: ["changes"] } });
        const parsed = responseObject(result);
        const changes = Array.isArray(parsed.changes) ? parsed.changes : [];
        changes.forEach((change) => {
          if (!change || typeof change !== "object") return;
          const item = change as Record<string, unknown>;
          const line = currentBatch.find((candidate) => candidate.id === item.line_id);
          if (!line || typeof item.corrected_text !== "string") return;
          const validation = validateCleanupCandidate(line.text || "", item.corrected_text);
          if (!validation.valid) return;
          const proposal = cleanupProposalForLine(line, item.corrected_text);
          if (proposal && !proposals.some((existing) => existing.line_id === proposal.line_id)) proposals.push(proposal);
        });
      }
      if (!proposals.length) { toast.message("No wording changes need review."); return; }
      setCleanupProposals(proposals); setCleanupOpen(true); patchSessionLocal({ cleanup_status: "reviewing" });
      void TranscriptionSession.update(session.id, { cleanup_status: "reviewing" }).catch(console.error);
    } catch (error) { console.error(error); toast.error("Could not prepare cleanup review."); }
    finally { setCleanupLoading(false); }
  };

  const applyCleanup = async (proposals: CleanupProposal[]) => {
    if (!session || !proposals.length) return;
    const targetSessionId = session.id;
    const safeProposals = proposals.filter((proposal) => {
      const line = lines.find((item) => item.id === proposal.line_id);
      return Boolean(line && validateCleanupCandidate(line.text || "", proposal.proposed_text).valid);
    });
    if (!safeProposals.length) {
      toast.message("No selected changes passed the transcript rules.");
      return;
    }
    if (safeProposals.length !== proposals.length) toast.message("Some suggestions were skipped because they did not pass the transcript rules.");
    setCleanupLoading(true);
    try {
      const now = new Date().toISOString();
      await Promise.all(safeProposals.map((proposal) => {
        const line = lines.find((item) => item.id === proposal.line_id);
        if (!line || !validateCleanupCandidate(line.text || "", proposal.proposed_text).valid) return Promise.resolve();
        const safeText = preserveBracketedEventTags(line.text || "", proposal.proposed_text.trim());
        const canPropose = line.origin === "generated" && line.kind === "speech";
        return TranscriptLine.update(line.id, { text: safeText, raw_text: line.raw_text || line.text || "", cleanup_text: safeText, cleanup_applied: true, edit_state: "edited", edited_at: now })
          .then(() => { if (canPropose) queueLearningProposal(targetSessionId, line.id); });
      }));
      setLines((current) => current.map((line) => {
        const proposal = safeProposals.find((item) => item.line_id === line.id);
        if (!proposal || !validateCleanupCandidate(line.text || "", proposal.proposed_text).valid) return line;
        const safeText = preserveBracketedEventTags(line.text || "", proposal.proposed_text.trim());
        return { ...line, text: safeText, raw_text: line.raw_text || line.text || "", cleanup_text: safeText, cleanup_applied: true, edit_state: "edited", edited_at: now };
      }));
      const patch = { cleanup_status: "applied" as const, cleanup_at: now, cleanup_summary: `${safeProposals.length} reviewed line${safeProposals.length === 1 ? "" : "s"} updated.` };
      patchSessionLocal(patch); await TranscriptionSession.update(session.id, patch); setCleanupProposals([]); setCleanupOpen(false); toast.success("Reviewed cleanup applied.");
    } catch (error) { console.error(error); toast.error("Could not apply cleanup changes."); }
    finally { setCleanupLoading(false); }
  };

  const discardSession = async () => {
    if (!session) return;
    if (capture.status.state === "recording" && capture.status.captureSessionId === session.id) await capture.stop();
    const patch = { status: "discarded" as SessionStatus, ended_at: new Date().toISOString() };
    try { await TranscriptionSession.update(session.id, patch); patchSessionLocal(patch); toast.message("Session discarded."); }
    catch (error) { console.error(error); toast.error("Could not discard session."); }
  };

  const accessGate = accessGateCopy(accessStatus, accessStatusError, accessStatusLoading);

  const logout = async () => {
    try { await User.logout(); } catch { try { await superdevClient.auth.logout(); } catch (error) { console.error(error); } }
    accessStatusRequestRef.current += 1;
    accessStatusRef.current = null;
    setIsAuth(false);
    setUserEmail("");
    setAccessStatus(null);
    setAccessStatusError("");
    setAccessStatusLoading(false);
    clearProtectedWorkspace();
  };

  return <div className="tx-app"><SEO title="Verbatim Desk | Private Audio Transcription" description="Capture browser or uploaded audio, transcribe multilingual conversations, and edit speaker-labeled timestamps in a private workspace built for accurate review." url="/" siteName="Verbatim Desk" /><div className="tx-atmosphere" aria-hidden /><AppHeader isAuth={isAuth} userEmail={userEmail} loginUrl={loginUrl} signupUrl={signupUrl} onLogout={() => void logout()} />
    {isAuth && <SubscriptionPanel accessStatus={accessStatus} accessStatusLoading={accessStatusLoading} accessStatusError={accessStatusError} onAccessStatusRefresh={refreshAccessStatus} />}
    {authChecked && isAuth && accessIsAllowed(accessStatus) && <><AIStudioPanel /><InAppAssistant /></>}
    {!authChecked ? <div className="tx-gate"><div className="tx-gate-card" role="status" aria-live="polite"><p className="tx-kicker">Private workspace</p><h2>Checking your workspace access…</h2><p>New accounts include a <strong>7-day free trial</strong>. Sign-in status is checked before private sessions can open.</p></div></div> : !isAuth ? <div className="tx-gate"><div className="grid w-full max-w-5xl items-stretch gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]"><div className="tx-gate-card self-center p-6 sm:p-8"><p className="tx-kicker">Staff access</p><h2>Sign in to open Verbatim Desk</h2><p>Sessions, audio segments, annotations, and transcript lines are private to your account. Sign in to capture Chrome tab audio and edit transcripts.</p><p className="tx-kicker">New accounts include a 7-day free trial.</p><div className="tx-gate-actions"><a href={loginUrl} className="tx-link-btn tx-link-btn-solid">Sign in</a><a href={signupUrl} className="tx-link-btn tx-link-btn-ghost">Create account</a></div><SignInContactOptions /></div><RequestAccessForm /></div></div> : !accessIsAllowed(accessStatus) ? <div className="tx-gate"><div className="tx-gate-card" role="status" aria-live="polite"><p className="tx-kicker">{accessGate.kicker}</p><h2>{accessGate.title}</h2><p>{accessGate.description}</p>{accessStatus?.status === "TRIAL_EXPIRED" && <p className="tx-kicker">Access is restricted after the seven-day free trial ends.</p>}{(!accessStatus || accessStatusError) && <button type="button" className="tx-link-btn tx-link-btn-solid" onClick={() => void refreshAccessStatus()} disabled={accessStatusLoading}>{accessStatusLoading ? "Checking…" : "Try again"}</button>}</div></div> : <div className="tx-shell">
      <SessionsLibrary sessions={filteredSessions} activeId={activeId} search={search} statusFilter={statusFilter} loading={libraryLoading} onSearch={setSearch} onFilter={changeSessionFilter} onSelect={setActiveId} onNew={() => void createSession()} creating={creating} canArchive={canArchiveSession} onArchive={archiveSession} onRestore={restoreSession} />
      <main className="tx-main">{!activeId || !session ? <div className="tx-empty-main"><p className="tx-kicker">Ready when you are</p><h2>Open a session or start a new capture</h2><p>Share a Chrome tab with tab audio enabled, watch the live meters, and stop into independently playable clips. Each uploaded clip can become an editable, timestamped transcript with best-effort speaker labels.</p><button type="button" className="tx-link-btn tx-link-btn-solid" onClick={() => void createSession()} disabled={creating}>New session</button></div> : workspaceLoading ? <div className="tx-empty-main"><p>Opening session…</p></div> : <SessionWorkspace session={session} lines={lines} segments={segments} issues={issues} annotations={annotations} captureStatus={capture.status} levels={capture.levels} captureBusy={capture.isBusy} settingsSaving={settingsSaving} customGuidelineSaving={customGuidelineSaving} transcriptionBusyIds={transcriptionBusyIds} cleanupOpen={cleanupOpen} cleanupLoading={cleanupLoading} cleanupProposals={cleanupProposals} canvasRef={capture.canvasRef} onStartCapture={() => void startCapture()} onStopCapture={() => void stopCapture()} onSettingsChange={onSettingsChange} onCustomGuidelineChange={persistCustomGuideline} onAudioSubmit={submitAudioTranscription} audioSubmitting={audioSubmitting} audioSubmitStatus={audioSubmitStatus} audioSubmitError={audioSubmitError} onAddSpeech={() => void addLine("speech")} onAddMarker={() => void addLine("marker")} onAddTimestamp={() => void addLine("timestamp")} onAddUnclear={(kind) => void addUnclearMarker(kind)} onUpdateLine={updateLine} onSplitLine={(id, cursor) => void splitLine(id, cursor)} onDeleteLine={(id) => void deleteLine(id)} onSpeakerUsed={onSpeakerUsed} onAddCustomSpeaker={onAddCustomSpeaker} onTranscribeSegment={(id) => void transcribeSegment(id)} onTranscribePending={() => void transcribePending()} onRetryFailed={() => void retryFailed()} onCleanTranscript={() => void cleanupTranscript()} onCreateAnnotation={createAnnotation} onUpdateAnnotation={updateAnnotation} onDeleteAnnotation={deleteAnnotation} onCleanupOpenChange={(open) => { setCleanupOpen(open); if (!open) { setCleanupProposals([]); const cleanupSessionId = session.id; patchSessionLocal({ cleanup_status: "idle" }, cleanupSessionId); if (session.cleanup_status === "reviewing") void TranscriptionSession.update(cleanupSessionId, { cleanup_status: "idle" }).catch(console.error); } }} onApplyCleanup={applyCleanup} onDiscard={() => void discardSession()} onPulsarStatusChange={(segmentId, status) => void updatePulsarClipStatus(segmentId, status)} onInsertPulsarTag={(lineId, tag) => void insertPulsarTag(lineId, tag)} onRunPulsarQA={() => void runPulsarQA()} onExportPulsar={() => void exportPulsar()} onSetPulsarReadiness={(state) => void setPulsarReadiness(state)} onReadinessInvalid={invalidatePulsarReadiness} />}</main>
    </div>}
  </div>;
};

export default Index;
