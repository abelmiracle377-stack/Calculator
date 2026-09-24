# Verbatim Desk Capture extension

This folder is a self-contained Manifest V3 Chrome extension for the first browser-capture slice of Verbatim Desk.

## Load it in Chrome

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `browser-extension` folder.
5. Pin **Verbatim Desk Capture** from the extensions menu so the action stays easy to reach.

The extension uses `tabCapture`, `offscreen`, `storage`, and temporary `activeTab` access. It has no broad host permissions, content scripts, remote code, custom icon, or provider credentials.

## Capture a tab

1. Open the supported tab you want to monitor. A normal `http` or `https` page works. Chrome internal pages cannot be captured.
2. Open the pinned extension action and choose **Start capture**.
3. Complete Chrome's tab-audio authorization if Chrome shows a prompt. This click is the one required browser permission gesture.
4. Return to the shared tab and play audio. The extension starts its source clock and local recorder as soon as the authorized audio stream connects.
5. Leave the popup open or close it. Capture continues in the hidden audio document.
6. Pause the source audio to see **Audio quiet**. The extension keeps recording and monitoring. Play audio again to see **Meaningful audio** return without resetting the clock.
7. Choose **Stop capture**, or end the tab's captured audio. The final state becomes **Audio ended**, the local recording is released, and the previously active tab/window is restored on a best-effort basis.

The popup reports source duration, the first sustained meaningful-audio start, the latest meaningful boundary, and trailing silence when those values are available. VAD measures signal activity only. It does not identify people, classify accents, or infer laughter or crying. The extension reports **Audio ended** for an explicit stop or captured-track termination, not for every media element on every website.

## Current boundary

The existing Verbatim Desk web app remains the normal full workflow and is unchanged. It continues to provide sessions, transcription, review, and export through its existing interface.

This extension slice proves Chrome tab-audio authorization, audible passthrough, automatic source-timed VAD, quiet/resume monitoring, captured-track end handling, local MediaRecorder cleanup, and lightweight status storage. It does not sign in, create sessions, upload audio, call transcription services, or write app entities yet. A secure one-time account handoff and session-sync phase can be added later as a separate change.

Chrome requires one user gesture to authorize tab capture. After authorization, meaningful-audio start, silence, resume, timing, and track-end detection happen automatically. No keyboard shortcut, source-page click, spoken command, or manual audio-start control is required.
