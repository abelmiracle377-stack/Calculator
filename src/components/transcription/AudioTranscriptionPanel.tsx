import { useEffect, useRef, useState } from "react";
import { CheckCircle2, FileAudio, FileUp, LoaderCircle, Mic, Pause, RefreshCw, Square, Trash2, Upload, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAudioInput } from "@/hooks/use-audio-input";
import { MAX_AUDIO_SIZE_MB, validateAudioSize } from "@/lib/transcription/audio-upload";
import type { ReviewMode, TranscriptionSessionRecord } from "@/lib/transcription/types";
const AUDIO_EXTENSIONS = new Set([
  "mp3", "mpga", "wav", "wave", "m4a", "m4b", "mp4", "m4v", "aac", "flac", "ogg", "oga", "opus",
  "webm", "weba", "3gp", "3gpp", "amr", "aiff", "aif", "caf", "mka", "wma",
]);
const AUDIO_FORMAT_HINT = "MP3/MPGA, WAV/WAVE, M4A/M4B/MP4/M4V, AAC, FLAC, OGG/OGA/OPUS, WebM/WEBA, 3GP/3GPP, AMR, AIFF/AIF, CAF, MKA, or WMA";
const AUDIO_ACCEPT = ["audio/*", ...Array.from(AUDIO_EXTENSIONS, (extension) => `.${extension}`)].join(",");
const METHOD_CHOICES: Array<{ value: ReviewMode; title: string; description: string }> = [
  { value: "standard", title: "Standard Workflow", description: "Transcribe the source with the session settings you selected." },
  { value: "pulsar_review", title: "Pulsar Review", description: "Prepare the audio for detailed clip review and quality checks." },
  { value: "custom_guidelines", title: "Custom Guidelines", description: "Follow the saved instructions in this session's guideline editor." },
];

type SourceKind = "upload" | "microphone";
type LocalSubmitState = "idle" | "submitting" | "completed" | "failed";

export interface AudioTranscriptionPanelProps {
  session: TranscriptionSessionRecord;
  onMethodChange: (reviewMode: ReviewMode) => void;
  onSubmit: (file: File, durationMs: number) => void | Promise<unknown>;
  submitting: boolean;
  submitStatus?: string;
  submitError?: string;
}

function extensionOf(name: string): string { return name.toLowerCase().split(".").pop() || ""; }
function formatBytes(bytes: number): string { return `${(bytes / (1024 * 1024)).toFixed(bytes >= 1024 * 1024 ? 1 : 2)} MB`; }
function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}
function validateAudio(file: File): string | null {
  const sizeError = validateAudioSize(file);
  if (sizeError) return sizeError;
  const mime = (file.type || "").toLowerCase().split(";", 1)[0].trim();
  const knownExtension = AUDIO_EXTENSIONS.has(extensionOf(file.name));
  if (!mime.startsWith("audio/") && !knownExtension) return `Choose a supported audio file: ${AUDIO_FORMAT_HINT}.`;
  return null;
}
function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const finish = (value: number | null) => { URL.revokeObjectURL(url); audio.removeAttribute("src"); audio.load(); resolve(value); };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null);
    audio.onerror = () => finish(null);
    audio.src = url;
  });
}
function friendlyError(value: unknown): string { return value instanceof Error && value.message ? value.message : "The transcription could not be started. Try again."; }

export function AudioTranscriptionPanel({ session, onMethodChange, onSubmit, submitting, submitStatus, submitError }: AudioTranscriptionPanelProps) {
  const microphone = useAudioInput();
  const [sourceKind, setSourceKind] = useState<SourceKind>("upload");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadDurationMs, setUploadDurationMs] = useState<number | null>(null);
  const [uploadDurationRead, setUploadDurationRead] = useState(false);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState("");
  const [localSubmitState, setLocalSubmitState] = useState<LocalSubmitState>("idle");
  const [localSubmitError, setLocalSubmitError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectionIdRef = useRef(0);
  const selectedMethod = session.review_mode || "standard";

  useEffect(() => {
    if (!selectedFile) { setUploadPreviewUrl(null); return; }
    const url = URL.createObjectURL(selectedFile);
    setUploadPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);

  const chooseSource = (kind: SourceKind) => {
    if (kind === sourceKind) return;
    if (["requesting", "recording", "paused", "stopping"].includes(microphone.status)) {
      setSourceError("Finish or remove the microphone recording before changing audio sources.");
      return;
    }
    setSourceKind(kind); setSourceError(""); setLocalSubmitState("idle"); setLocalSubmitError("");
  };
  const handleFile = (file: File | undefined) => {
    if (!file) return;
    const error = validateAudio(file);
    if (error) {
      selectionIdRef.current += 1;
      setSelectedFile(null);
      setUploadDurationMs(null);
      setSourceError(error);
      return;
    }
    const selectionId = ++selectionIdRef.current;
    setSelectedFile(file); setUploadDurationMs(null); setUploadDurationRead(false); setSourceKind("upload"); setSourceError(""); setLocalSubmitState("idle"); setLocalSubmitError("");
    void readDuration(file).then((duration) => {
      if (selectionId === selectionIdRef.current) {
        setUploadDurationMs(duration);
        setUploadDurationRead(true);
      }
    });
  };
  const clearUpload = () => { selectionIdRef.current += 1; setSelectedFile(null); setUploadDurationMs(null); setUploadDurationRead(false); setSourceError(""); setLocalSubmitState("idle"); setLocalSubmitError(""); };
  const resetMicrophone = () => { microphone.reset(); setSourceError(""); setLocalSubmitState("idle"); setLocalSubmitError(""); };
  const startMicrophone = () => { setSourceKind("microphone"); setSourceError(""); setLocalSubmitState("idle"); setLocalSubmitError(""); void microphone.start(); };
  const stopMicrophone = async () => { const result = await microphone.stop(); if (!result && microphone.error) setSourceError(microphone.error); };

  const activeFile = sourceKind === "upload" ? selectedFile : microphone.file;
  const activeDurationMs = sourceKind === "upload" ? (uploadDurationMs || 0) : microphone.durationMs;
  const sourceReady = Boolean(activeFile) && (sourceKind === "upload" || microphone.status === "ready");
  const submitPhase = submitting || localSubmitState === "submitting" ? "submitting" : submitError || localSubmitError || localSubmitState === "failed" ? "failed" : submitStatus || localSubmitState === "completed" ? "completed" : "idle";
  const errorMessage = sourceError || (sourceKind === "microphone" ? microphone.error : "");
  const submitFailure = submitError || localSubmitError;

  const handleSubmit = async () => {
    if (!activeFile || !sourceReady || submitting || localSubmitState === "submitting" || localSubmitState === "completed" || submitPhase === "completed") return;
    const sizeError = validateAudioSize(activeFile, sourceKind === "microphone" ? "recording" : "file");
    if (sizeError) {
      setLocalSubmitState("failed");
      setLocalSubmitError(sizeError);
      return;
    }
    setLocalSubmitState("submitting"); setLocalSubmitError("");
    try { await onSubmit(activeFile, activeDurationMs); setLocalSubmitState("completed"); }
    catch (error) { setLocalSubmitState("failed"); setLocalSubmitError(friendlyError(error)); }
  };

  return <section className="tx-panel space-y-6" aria-labelledby={`audio-source-title-${session.id}`}>
    <div className="tx-field space-y-3">
      <div><h2 id={`audio-source-title-${session.id}`} className="text-base font-semibold">Choose an audio source</h2><p className="tx-help">Upload a finished recording or capture a fresh microphone recording. Your source stays on this screen until you start transcription.</p></div>
      <div className="tx-review-mode" role="tablist" aria-label="Audio source">
        <button type="button" role="tab" aria-selected={sourceKind === "upload"} className={`tx-review-choice ${sourceKind === "upload" ? "is-active" : ""}`} onClick={() => chooseSource("upload")}><Upload aria-hidden="true" /><span><strong>Upload audio</strong><small>{AUDIO_FORMAT_HINT}</small></span></button>
        <button type="button" role="tab" aria-selected={sourceKind === "microphone"} className={`tx-review-choice ${sourceKind === "microphone" ? "is-active" : ""}`} onClick={() => chooseSource("microphone")}><Mic aria-hidden="true" /><span><strong>Record with microphone</strong><small>Use your browser microphone, then review the take</small></span></button>
      </div>
    </div>

    {sourceKind === "upload" && <div className="tx-field space-y-4" aria-label="Upload an audio file">
      <input ref={fileInputRef} type="file" accept={AUDIO_ACCEPT} className="sr-only" onChange={(event) => { const input = event.currentTarget; const file = input.files?.[0]; input.value = ""; handleFile(file); }} />
      {!selectedFile ? <div className="space-y-3"><FileAudio aria-hidden="true" /><div><strong>Choose an audio file</strong><p className="tx-help">Files up to {MAX_AUDIO_SIZE_MB} MB. Supported audio files include {AUDIO_FORMAT_HINT}. Some browsers may not preview every format.</p></div><Button type="button" className="tx-btn-primary" onClick={() => fileInputRef.current?.click()}><FileUp aria-hidden="true" />Choose file</Button></div> : <div className="space-y-3">
        <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-2"><FileAudio className="mt-0.5 shrink-0" aria-hidden="true" /><div className="min-w-0"><strong className="break-all">{selectedFile.name}</strong><p className="tx-help">{formatBytes(selectedFile.size)} · {uploadDurationMs === null ? (uploadDurationRead ? "Duration unavailable in this browser" : "Reading duration…") : formatDuration(uploadDurationMs)}</p></div></div><span className="tx-help">Upload ready</span></div>
        {uploadPreviewUrl && <audio controls src={uploadPreviewUrl} className="w-full" aria-label={`Preview ${selectedFile.name}`} />}
        <div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={() => fileInputRef.current?.click()}><RefreshCw aria-hidden="true" />Replace file</Button><Button type="button" size="sm" variant="outline" className="tx-btn-ghost" onClick={clearUpload}><Trash2 aria-hidden="true" />Remove</Button></div>
      </div>}
    </div>}

    {sourceKind === "microphone" && <div className="tx-field space-y-4" aria-label="Record audio with your microphone">
      <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Mic aria-hidden="true" /><strong>{microphone.status === "recording" ? "Recording in progress" : microphone.status === "paused" ? "Recording paused" : microphone.status === "ready" ? "Recording ready" : "Microphone recorder"}</strong></div>{microphone.status === "recording" && <span className="tx-help" role="status">{formatDuration(microphone.durationMs)}</span>}</div>
      {microphone.status === "requesting" && <p className="tx-help" role="status"><LoaderCircle className="mr-1 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />Requesting microphone access…</p>}
      {(microphone.status === "idle" || microphone.status === "error") && <><p className="tx-help">Press Start recording, speak normally, then stop when the take is complete. You can listen before submitting.</p><Button type="button" className="tx-btn-primary" onClick={startMicrophone}><Mic aria-hidden="true" />Start recording</Button></>}
      {microphone.status === "recording" && <div className="flex flex-wrap gap-2"><Button type="button" className="tx-btn-ghost" variant="outline" onClick={microphone.pause}><Pause aria-hidden="true" />Pause</Button><Button type="button" className="tx-btn-primary" onClick={() => void stopMicrophone()}><Square aria-hidden="true" />Stop recording</Button></div>}
      {microphone.status === "paused" && <div className="flex flex-wrap gap-2"><Button type="button" className="tx-btn-primary" onClick={microphone.resume}><Mic aria-hidden="true" />Resume</Button><Button type="button" className="tx-btn-ghost" variant="outline" onClick={() => void stopMicrophone()}><Square aria-hidden="true" />Stop recording</Button></div>}
      {microphone.status === "stopping" && <p className="tx-help" role="status"><LoaderCircle className="mr-1 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />Finishing your recording…</p>}
      {microphone.status === "ready" && microphone.file && <div className="space-y-3"><div className="flex items-start justify-between gap-3"><div><strong>{microphone.file.name}</strong><p className="tx-help">{formatBytes(microphone.file.size)} · {formatDuration(microphone.durationMs)}</p></div><span className="tx-help">Recording ready</span></div>{microphone.previewUrl && <audio controls src={microphone.previewUrl} className="w-full" aria-label="Preview microphone recording" />}<div className="flex flex-wrap gap-2"><Button type="button" size="sm" className="tx-btn-ghost" variant="outline" onClick={resetMicrophone}><RefreshCw aria-hidden="true" />Re-record</Button><Button type="button" size="sm" className="tx-btn-ghost" variant="outline" onClick={resetMicrophone}><Trash2 aria-hidden="true" />Remove</Button></div></div>}
    </div>}

    {errorMessage && <div className="tx-error-banner" role="alert"><XCircle aria-hidden="true" /><span>{errorMessage}</span></div>}

    {sourceReady && <>
      <fieldset className="tx-field space-y-3"><legend className="text-base font-semibold">Choose a transcription method</legend><p className="tx-help">Select how this audio should be handled before you start transcription.</p><div className="tx-review-mode" role="radiogroup" aria-label="Transcription method">{METHOD_CHOICES.map((choice) => <button key={choice.value} type="button" role="radio" aria-checked={selectedMethod === choice.value} className={`tx-review-choice ${selectedMethod === choice.value ? "is-active" : ""}`} onClick={() => onMethodChange(choice.value)}><span><strong>{choice.title}</strong><small>{choice.description}</small></span></button>)}</div></fieldset>
      <div className="tx-field space-y-3"><div className="flex flex-wrap items-center gap-3"><Button type="button" className="tx-btn-primary" onClick={() => void handleSubmit()} disabled={submitting || localSubmitState === "submitting" || localSubmitState === "completed" || submitPhase === "completed"}>{submitPhase === "submitting" ? <><LoaderCircle className="animate-spin" aria-hidden="true" />Starting transcription…</> : submitPhase === "completed" ? <><CheckCircle2 aria-hidden="true" />Transcription started</> : "Start transcription"}</Button><span className="tx-help">{activeFile?.name} · {activeDurationMs ? formatDuration(activeDurationMs) : "Duration unavailable"}</span></div>
        {submitPhase === "submitting" && <p className="tx-help" role="status">Preparing this source for the selected workflow. Keep this screen open.</p>}
        {submitPhase === "completed" && <p className="tx-help" role="status"><CheckCircle2 className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />{submitStatus || "Your audio was sent to the transcription workflow."}</p>}
        {submitPhase === "failed" && <div className="tx-error-banner" role="alert"><XCircle aria-hidden="true" /><span>{submitFailure || "The transcription could not be started. Try again."}</span></div>}
      </div>
    </>}
  </section>;
}
