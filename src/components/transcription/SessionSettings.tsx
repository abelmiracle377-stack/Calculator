import { ArrowLeftRight, ClipboardCheck, Languages, MapPinned } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getManualLanguagePreferences,
  getSessionLanguageMode,
  isAutomaticLanguageValue,
  normalizeTimestampCadence,
  parseLanguagePreferences,
  timestampCadenceLabel,
} from "@/lib/transcription/transcription";
import {
  ensureDistinctTranslationTarget,
  isSameExplicitTranslationLanguage,
  normalizeTranslationSourceLanguage,
  normalizeTranslationTargetLanguage,
  swapTranslationLanguages,
  TRANSLATION_SOURCE_LANGUAGES,
  TRANSLATION_TARGET_LANGUAGES,
} from "@/lib/transcription/translation";
import { CustomGuidelinesEditor } from "./CustomGuidelinesEditor";
import type {
  InputMode,
  LanguageMode,
  ReviewMode,
  SessionMode,
  SpeakerScheme,
  TimestampCadence,
  TranscriptStyle,
  TranscriptionSessionRecord,
} from "@/lib/transcription/types";
type SessionSettingsProps = { session: TranscriptionSessionRecord; saving: boolean; customGuidelineSaving: boolean; onChange: (patch: Partial<TranscriptionSessionRecord>) => void; onCustomGuidelineChange: (patch: Partial<TranscriptionSessionRecord>) => void | Promise<boolean | void>; };
export function SessionSettings({ session, saving, customGuidelineSaving, onChange, onCustomGuidelineChange }: SessionSettingsProps) {
  const customJoined = (session.custom_speakers || []).join(", ");
  const cadence = normalizeTimestampCadence(session.timestamp_cadence || "speaker_change");
  const hasLegacyCadence = session.timestamp_cadence === "30s" || session.timestamp_cadence === "60s";
  const languageMode = getSessionLanguageMode(session);
  const languagePreferences = getManualLanguagePreferences(session);
  const inputMode: InputMode = session.input_mode || "browser_capture";
  const reviewMode = session.review_mode || "standard";
  const sessionMode: SessionMode = session.session_mode === "translation" ? "translation" : "transcription";
  const translationSource = normalizeTranslationSourceLanguage(session.translation_source_language);
  const translationTarget = normalizeTranslationTargetLanguage(session.translation_target_language);
  const sameTranslationLanguage = isSameExplicitTranslationLanguage(translationSource, translationTarget);
  const changeInputMode = (nextMode: InputMode) => {
    onChange({ input_mode: nextMode });
  };
  const changeReviewMode = (nextMode: ReviewMode) => {
    onChange({ review_mode: nextMode });
  };
  const changeSessionMode = (nextMode: SessionMode) => {
    onChange({ session_mode: nextMode, translation_source_language: translationSource, translation_target_language: ensureDistinctTranslationTarget(translationSource, translationTarget) });
  };
  const changeTranslationSource = (value: string) => {
    const nextSource = normalizeTranslationSourceLanguage(value);
    onChange({ session_mode: "translation", translation_source_language: nextSource, translation_target_language: ensureDistinctTranslationTarget(nextSource, translationTarget) });
  };
  const changeTranslationTarget = (value: string) => {
    const nextTarget = normalizeTranslationTargetLanguage(value);
    if (isSameExplicitTranslationLanguage(translationSource, nextTarget)) return;
    onChange({ session_mode: "translation", translation_target_language: nextTarget });
  };
  const swapLanguages = () => {
    if (translationSource === "auto" || sameTranslationLanguage) return;
    const next = swapTranslationLanguages(translationSource, translationTarget);
    onChange({ session_mode: "translation", translation_source_language: next.source_language, translation_target_language: next.target_language });
  };
  const languageInput = languageMode === "manual" && session.language && !isAutomaticLanguageValue(session.language)
    ? session.language
    : languagePreferences.join(", ");
  const changeLanguageMode = (nextMode: LanguageMode) => {
    const legacyLanguage = session.language?.trim() || "";
    const nextLegacyLanguage = nextMode === "auto"
      ? legacyLanguage || "auto"
      : isAutomaticLanguageValue(legacyLanguage) ? languagePreferences.join(", ") : legacyLanguage;
    onChange({ language_mode: nextMode, language_preferences: languagePreferences, language: nextLegacyLanguage });
  };
  return (
    <section className="tx-panel" aria-label="Audio transcript settings">
      <div className="tx-panel-head">
        <div><p className="tx-kicker">Audio transcript rules</p><h3>Session settings</h3></div>
        <span className={`tx-save-chip ${saving ? "is-saving" : ""}`}>
          {saving ? "Saving…" : "Autosaved"}
        </span>
      </div>
      <div className="tx-settings-grid">
        <div className="tx-field tx-field-wide">
          <Label htmlFor="session-title">Title</Label>
          <Input id="session-title" value={session.title || ""} onChange={(e) => onChange({ title: e.target.value })} className="tx-input" />
        </div>
        <div className="tx-field tx-field-wide tx-input-source-field">
          <div className="tx-field-label-row"><Label>Session purpose</Label><span className="tx-inline-status">Saved independently from input and review</span></div>
          <div className="tx-input-source" role="radiogroup" aria-label="Session purpose">
            <button type="button" role="radio" aria-checked={sessionMode === "transcription"} className={`tx-review-choice ${sessionMode === "transcription" ? "is-selected" : ""}`} onClick={() => changeSessionMode("transcription")}>
              <span className="tx-review-choice-title">Transcription</span><span>Keep the existing Verbatim Desk transcript workflow.</span>
            </button>
            <button type="button" role="radio" aria-checked={sessionMode === "translation"} className={`tx-review-choice ${sessionMode === "translation" ? "is-selected" : ""}`} onClick={() => changeSessionMode("translation")}>
              <span className="tx-review-choice-title">Translation</span><span>Translate completed source segments in this session workspace.</span>
            </button>
          </div>
          <p className="tx-help">{sessionMode === "translation" ? "Settings are saved. Completed source segments appear in the Translation panel as they become ready." : "Transcription keeps the existing Verbatim Desk transcript workflow."}</p>
        </div>
        {sessionMode === "translation" && <div className="tx-field tx-field-wide tx-input-source-field">
          <div className="tx-field-label-row"><Label>Translation languages</Label><span className="tx-inline-status"><Languages className="h-3 w-3" />Used by Translation panel</span></div>
          <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <div className="tx-field">
              <Label htmlFor="translation-source-language">Source language</Label>
              <Select value={translationSource} onValueChange={changeTranslationSource}>
                <SelectTrigger id="translation-source-language" className="tx-input"><SelectValue /></SelectTrigger>
                <SelectContent>{TRANSLATION_SOURCE_LANGUAGES.map((option) => <SelectItem key={option.code} value={option.code}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <button type="button" className="tx-link-btn tx-link-btn-ghost whitespace-nowrap text-xs disabled:cursor-not-allowed disabled:opacity-50" onClick={swapLanguages} disabled={translationSource === "auto" || sameTranslationLanguage} aria-label="Swap source and target languages">
              <ArrowLeftRight className="h-3.5 w-3.5" />Swap languages
            </button>
            <div className="tx-field">
              <Label htmlFor="translation-target-language">Target language <span className="tx-inline-status">Required</span></Label>
              <Select value={translationTarget} onValueChange={changeTranslationTarget}>
                <SelectTrigger id="translation-target-language" className="tx-input" aria-invalid={sameTranslationLanguage}><SelectValue /></SelectTrigger>
                <SelectContent>{TRANSLATION_TARGET_LANGUAGES.map((option) => <SelectItem key={option.code} value={option.code} disabled={option.code === translationSource}>{option.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <p className="tx-help">{translationSource === "auto" ? "Settings are saved. Completed source segments will be translated in the Translation panel. Auto Detect keeps the source flexible; choose a source language to enable swapping." : sameTranslationLanguage ? "Choose a target language different from the source language." : "Settings are saved. Completed source segments will be translated in the Translation panel."}</p>
        </div>}
        <div className="tx-field tx-field-wide tx-input-source-field">
          <div className="tx-field-label-row">
            <Label>Input source</Label>
            <span className="tx-inline-status">Choose how audio enters this session</span>
          </div>
          <div className="tx-input-source" role="radiogroup" aria-label="Audio input source">
            <button type="button" role="radio" aria-checked={inputMode === "browser_capture"} className={`tx-review-choice ${inputMode === "browser_capture" ? "is-selected" : ""}`} onClick={() => changeInputMode("browser_capture")}>
              <span className="tx-review-choice-title">Browser capture</span>
              <span>Capture audio from a Chrome tab with Share tab audio enabled.</span>
            </button>
            <button type="button" role="radio" aria-checked={inputMode === "audio_transcription"} className={`tx-review-choice ${inputMode === "audio_transcription" ? "is-selected" : ""}`} onClick={() => changeInputMode("audio_transcription")}>
              <span className="tx-review-choice-title">Audio Transcription</span>
              <span>Upload a file or record with your microphone before transcription.</span>
            </button>
          </div>
        </div>
        <div className="tx-field tx-field-wide tx-review-mode-field">
          <div className="tx-field-label-row">
            <Label>Review workflow</Label>
            <span className="tx-inline-status"><ClipboardCheck className="h-3 w-3" />Additive review mode</span>
          </div>
          <div className="tx-review-mode" role="radiogroup" aria-label="Session review workflow">
            <button type="button" role="radio" aria-checked={reviewMode === "standard"} className={`tx-review-choice ${reviewMode === "standard" ? "is-selected" : ""}`} onClick={() => changeReviewMode("standard")}>
              <span className="tx-review-choice-title">Standard workflow</span>
              <span>Use the existing Verbatim Desk capture, editor, cleanup, and export flow.</span>
            </button>
            <button type="button" role="radio" aria-checked={reviewMode === "pulsar_review"} className={`tx-review-choice ${reviewMode === "pulsar_review" ? "is-selected" : ""}`} onClick={() => changeReviewMode("pulsar_review")}>
              <span className="tx-review-choice-title">Pulsar Review</span>
              <span>Add grouped-line tags, local QA, clip review, and readiness checks alongside the existing tools.</span>
            </button>
            <button type="button" role="radio" aria-checked={reviewMode === "custom_guidelines"} className={`tx-review-choice ${reviewMode === "custom_guidelines" ? "is-selected" : ""}`} onClick={() => changeReviewMode("custom_guidelines")}>
              <span className="tx-review-choice-title">Custom Guidelines</span>
              <span>Apply your saved transcription rules to this session after the audio provider finishes.</span>
            </button>
          </div>
          <p className="tx-help">Pulsar Review is an additional local workflow. It never replaces Full Verbatim or Clean Verbatim and does not submit an external task.</p>
        </div>
        {reviewMode === "custom_guidelines" && <CustomGuidelinesEditor session={session} saving={customGuidelineSaving} onChange={onCustomGuidelineChange} />}
        <div className="tx-field tx-field-wide tx-language-field">
          <div className="tx-field-label-row">
            <Label>Language detection</Label>
            <span className="tx-inline-status"><Languages className="h-3 w-3" />Multilingual audio supported</span>
          </div>
          <div className="tx-language-mode" role="radiogroup" aria-label="Language detection mode">
            <button type="button" role="radio" aria-checked={languageMode === "auto"} className={`tx-language-choice ${languageMode === "auto" ? "is-selected" : ""}`} onClick={() => changeLanguageMode("auto")}>
              <span className="tx-language-choice-title">Auto detect</span>
              <span>Let the provider identify languages as each clip is transcribed.</span>
            </button>
            <button type="button" role="radio" aria-checked={languageMode === "manual"} className={`tx-language-choice ${languageMode === "manual" ? "is-selected" : ""}`} onClick={() => changeLanguageMode("manual")}>
              <span className="tx-language-choice-title">Manual hints</span>
              <span>Keep one or more language preferences with this session.</span>
            </button>
          </div>
          <p className="tx-help">Auto detect is recommended for multilingual or code-switched audio. The transcript stays in every language spoken.</p>
        </div>
        {languageMode === "manual" && <div className="tx-field tx-field-wide tx-language-input-field">
          <Label htmlFor="session-language-preferences">Manual language hints</Label>
          <Input id="session-language-preferences" value={languageInput} onChange={(e) => onChange({ language_mode: "manual", language_preferences: parseLanguagePreferences(e.target.value), language: e.target.value })} placeholder="English, Spanish, es" className="tx-input" aria-describedby="session-language-help" />
          <p id="session-language-help" className="tx-help">Enter one or more names or ISO codes, separated by commas. A single recognized language can guide the provider. Multiple languages keep multilingual detection on.</p>
        </div>}
        <div className="tx-field tx-field-wide tx-accent-field">
          <div className="tx-field-label-row">
            <Label htmlFor="session-accent-hint">Accent or dialect hint <span className="tx-label-optional">Optional</span></Label>
            <span className="tx-inline-status"><MapPinned className="h-3 w-3" />Review context only</span>
          </div>
          <Input id="session-accent-hint" value={session.accent_hint || ""} onChange={(e) => onChange({ accent_hint: e.target.value })} placeholder="For example, Southern US English or Québec French" className="tx-input" aria-describedby="session-accent-help" />
          <p id="session-accent-help" className="tx-help">This is context you provide for review. The transcription service does not return a reliable automatic accent label. It never identifies a speaker or changes spelling.</p>
        </div>
        <div className="tx-field">
          <Label>Transcript style</Label>
          <Select value={session.transcript_style || "full_verbatim"} onValueChange={(v) => onChange({ transcript_style: v as TranscriptStyle })}>
            <SelectTrigger className="tx-input"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="full_verbatim">Full verbatim</SelectItem>
              <SelectItem value="clean_verbatim">Clean verbatim</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="tx-field">
          <Label>Speaker scheme</Label>
          <Select value={session.speaker_scheme || "numbered"} onValueChange={(v) => onChange({ speaker_scheme: v as SpeakerScheme })}>
            <SelectTrigger className="tx-input"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="numbered">Speaker 1, 2, 3…</SelectItem>
              <SelectItem value="letters">A, B, C…</SelectItem>
              <SelectItem value="custom">Custom labels</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="tx-field tx-field-wide">
          <Label htmlFor="custom-speakers">Custom speakers</Label>
          <Input id="custom-speakers" value={customJoined} disabled={session.speaker_scheme !== "custom"} onChange={(e) => onChange({ custom_speakers: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} placeholder="Interviewer, Interviewee, ?Speaker 3" className="tx-input" />
          <p className="tx-help">Comma-separated. Use a leading ? when a speaker identity is uncertain.</p>
        </div>
        <div className="tx-field tx-field-wide">
          <Label>Timestamp cadence</Label>
          <Select value={cadence} onValueChange={(v) => onChange({ timestamp_cadence: v as TimestampCadence })}>
            <SelectTrigger className="tx-input"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="speaker_change">Every speaker change</SelectItem>
              <SelectItem value="two_minutes">Every two minutes</SelectItem>
              <SelectItem value="both">Speaker changes and every two minutes</SelectItem>
              <SelectItem value="manual">Manual marks only</SelectItem>
              <SelectItem value="none">No automatic marks</SelectItem>
            </SelectContent>
          </Select>
          <p className="tx-help">{hasLegacyCadence ? "An older cadence was mapped to manual marks." : timestampCadenceLabel(cadence)}. Speech ranges always use the full recording, never an individual 20-second clip.</p>
        </div>
      </div>
      <p className="tx-settings-note">US spelling is the default for English. A client comment can request another spelling. Changing these settings never rewrites the stored full-verbatim text.</p>
    </section>
  );
}
