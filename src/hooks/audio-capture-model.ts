import type { AudioAnalysisHandle, AudioAnalysisFrame } from "@/lib/transcription/audio-vad";
import type {
  AudioIssueRecord,
  AudioSegmentRecord,
  AudioClockSource,
  CaptureCallbackContext,
  CaptureEventPayload,
  CaptureStatus,
  MeterLevels,
} from "@/lib/transcription/types";

export const SEGMENT_MS = 20_000;
export const MIN_INTERVAL_MS = 120;

export type FinalizeReason = "user" | "track" | "error";

export type StartCaptureOptions = {
  nextSequence?: number;
  elapsedOffsetMs?: number;
  existingMeaningfulAudioStartedMs?: number;
  existingMeaningfulAudioEndedMs?: number;
  existingLeadingSilenceMs?: number;
  existingTrailingSilenceMs?: number;
  leadingSilenceAlreadyRecorded?: boolean;
  trailingSilenceAlreadyRecorded?: boolean;
  leadingSilenceIssueId?: string;
  trailingSilenceIssueId?: string;
  previousFinalSegmentId?: string;
};

export type SegmentTiming = {
  sourceElapsedMs: number;
  meaningfulStartMs?: number;
  meaningfulEndMs?: number;
  leadingSilenceMs: number;
  trailingSilenceMs: number;
};

export type CycleResult = {
  blob: Blob;
  startMs: number;
  endMs: number;
  sequence: number;
};

export interface RecorderCycle {
  recorder: MediaRecorder;
  sequence: number;
  startMs: number;
  chunks: BlobPart[];
  completion: Promise<CycleResult>;
  resolve: (result: CycleResult) => void;
  result?: CycleResult;
  settled: boolean;
  uploadEnqueued: boolean;
  stopRequested: boolean;
  timeout: number | null;
}

export interface CaptureRun {
  captureRunId: string;
  sessionId: string;
  offsetMs: number;
  nextSequence: number;
  sourceElapsedMs: number;
  analysis: AudioAnalysisHandle;
  stream: MediaStream;
  displayStream: MediaStream;
  track: MediaStreamTrack;
  trackEndedHandler: () => void;
  sourceLabel: string;
  captureStartedAt: string;
  clockSource: AudioClockSource;
  clockSourceNote: string;
  captureEpochStarted: boolean;
  phase: CaptureStatus["phase"];
  meaningfulStartMs?: number;
  meaningfulEndMs?: number;
  leadingSilenceMs?: number;
  trailingSilenceMs?: number;
  leadingIssueId?: string;
  trailingIssueId?: string;
  leadingIssueRecorded: boolean;
  trailingIssueRecorded: boolean;
  leadingIssuePending: boolean;
  trailingIssuePending: boolean;
  previousFinalSegmentId?: string;
  lastFinalSegmentId?: string;
  currentCycle: RecorderCycle | null;
  rolloverPromise: Promise<CycleResult | null> | null;
  uploadTasks: Promise<void>[];
  lastNonEmptySegment?: AudioSegmentRecord;
  recorderError?: string;
  uploadError?: string;
  fatalNotified: boolean;
  sharingEndedRecorded: boolean;
  stopRequested: boolean;
  finalizationRequested: boolean;
  analysisFrozen: boolean;
  connected: boolean;
  closed: boolean;
  finalizationPromise: Promise<CaptureStatus> | null;
  lastMeterSourceMs: number;
  lastStatusSourceMs: number;
  lastDurationSourceMs: number;
}

export interface CaptureControllerCallbacks {
  onStatus: (status: CaptureStatus) => void;
  onLevels: (levels: MeterLevels) => void;
  onDuration: (ms: number, context: CaptureCallbackContext) => void;
  onEvent: (event: CaptureEventPayload) => void;
  onIssue: (issue: AudioIssueRecord) => void;
  onSegment: (segment: AudioSegmentRecord) => void;
  onFatal: (message: string, context: CaptureCallbackContext) => void;
  onConnected?: (analyser: AnalyserNode) => void;
  isDisposed: () => boolean;
}

export type AnalysisFrameHandler = (run: CaptureRun, frame: AudioAnalysisFrame) => void;
