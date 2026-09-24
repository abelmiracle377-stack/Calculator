// Server-owned, non-personal product guidance for the signed-in assistant.
// Keep this map focused on visible labels and locations. It must never contain user data.
export const APP_HELP_KNOWLEDGE = `
VERBATIM DESK APP HELP MAP
Use only this map for app-help answers. Name the visible label and its location. Do not invent user-specific screen state.

HEADER AND ACCOUNT
- The Verbatim Desk identity is at the top of the main desk. Signed-in users see their account chip, the Admin panel link, and Sign out. Signed-out visitors see Sign in and Create account.
- Admin panel is in the top-right header for signed-in users. It opens the protected administrator workspace. Sign out is beside it.

ACCESS AND BILLING
- The access and billing area is near the top of the signed-in desk. Open its payment options with the expand control.
- Copy copies payment details. The wallet preview opens a QR view. Refresh retries an access check. Submit for verification sends manual payment evidence for review.
- Payment approval remains manual. The access area shows whether payment evidence is waiting, approved, or rejected.

SESSIONS LIBRARY
- The sessions library is the left rail of the main desk. New starts a session, Search filters the library, status tabs filter by session state, and selecting a session card opens it.
- When no session is open, use New session in the workspace to begin.

ACTIVE SESSION AND CAPTURE
- In an active session toolbar, Start capture begins browser-tab capture. After a capture, Record again starts another take. Stop ends the current capture. Discard opens a confirmation before removing the take.
- The live capture area shows the waveform, elapsed time, activity, and peak meters. Voice activity detection is automatic, so there is no manual VAD button.
- A shared screen is not recorded as video. The workspace captures audio for transcription and displays the live audio monitor.

TRANSCRIPTION STRIP
- The strip below the session summary shows Transcribe pending when audio is ready. Retry appears for a failed attempt. Review cleanup opens the cleanup review for transcript lines.

AUDIO INPUT AND SEGMENTS
- In Audio Transcription, Upload audio chooses an audio file. Record with microphone records a new clip. Replace selects a different file, Remove clears the current file, and Start transcription begins processing.
- Audio segments show Waiting, Transcribing, Transcribed, or Needs retry. Transcribe starts a waiting segment and Retry runs a failed segment again.

TRANSCRIPT EDITOR
- The transcript editor is the main text area after transcription. Line adds a line, Marker adds a review marker, and Timestamp inserts a time reference.
- A diarization note records a speaker-label review note. Inaudible and Unintelligible mark unclear audio. Split divides a line, and Delete line removes it after confirmation.

TIMELINE ANNOTATIONS
- Timeline annotations sit with the transcript timeline. Drag across the timeline to select a range, then Add range creates an annotation.
- Resize handles change a range, the left and right move controls nudge it, the resize control expands or shortens it, and Delete removes it.

EXPORT AND ISSUES
- Download .txt is in Formatted preview and Output check. It saves the formatted transcript as a text file.
- The Issues area uses a warning indicator and count chip. Issue cards explain review items; they are information for the editor rather than direct actions.

SESSION SETTINGS
- Session settings are the autosave area for purpose, translation mode, input, workflow, languages, speakers, timestamps, and transcript style.
- The language swap control exchanges the translation source and target languages.

TRANSLATION
- Translation controls are in the translation panel. Translate all ready starts translation for ready lines. Retry reruns a failed line, and Refresh reloads translation status.
- Status labels show Ready, Translating, Failed, or Waiting. Audio controls play or save an available translated clip.

CUSTOM GUIDELINES
- Custom Guidelines is in the session workspace settings area. Add guideline files opens the file picker. Replace changes the current source, Remove clears one source, and Remove all clears every source.
- Processing, Ready, conflict, and failure messages appear beside the guideline source. Guidelines lock after capture starts so the captured session keeps consistent instructions.

PULSAR REVIEW
- Pulsar Review is a local, additive review panel. Run QA checks the current transcript package. Errors, warnings, and notes appear as findings.
- Reopen runs the review again. Download saves the local JSON package, and Locate finding jumps to the related transcript location. Pulsar does not replace the transcript or send the review to an external service.

SIGNED-OUT ACCESS AND SUPPORT
- Request access is on the signed-out access area. Enter a name and email, then use the submit control. A saving message and success message confirm the request.
- Contact options include optional Slack or email contact, the signed-out AI Help Desk, Send for a message, and Request human help.
- Signed-out support cannot see private sessions, audio, billing records, transcripts, or other private workspace data.

SIGNED-IN ASSISTANT
- Ask Verbatim Desk is on the signed-in main desk. The answer source selector offers General assistant, App help, and Public web. The uploaded document selector chooses a private document for a Document answer.
- Add file uploads a supported PDF, TXT, CSV, or common image. Forget this document removes its extracted text and linked assistant context without changing transcription sessions.
- Public web search runs only when Public web is selected. It does not receive private sessions, audio, documents, conversation history, billing, support notes, administrator data, secrets, or other users' records.

PROTECTED ADMINISTRATION
- The administrator workspace is protected and separate from the main desk. Open transcription desk returns to the normal workspace. Refresh reloads the administrator view and Sign out ends the session.
- Administrator tabs include Overview, User management, Access requests, Support, App settings, Billing, Settings, Access history, and AI Learning.
- AI Learning promotion, pending edits, approval, and rejection are administrator-only. Approved assistant guidance is private to its owner and affects future assistant answers only.
`;

// This file is also deployable on its own; direct requests never receive the map.
if (import.meta.main) {
  Deno.serve(() => new Response("ok", { status: 200 }));
}

