const WORKLET_URL = chrome.runtime.getURL("verbatim-vad-worklet.js");
let capture = null;
let requestSequence = 0;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function errorText(error) {
  return String(error?.message || error || "Unknown error").replace(/^Error:\s*/i, "");
}

function sendBackground(message) {
  chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
}

function readableError(error) {
  const message = errorText(error);
  if (/NotAllowed|permission|denied|not allowed/i.test(message)) return "Chrome denied tab-audio access. Close this panel, click Start capture again, and allow tab audio.";
  if (/AudioWorklet|addModule/i.test(message)) return "Audio analysis could not load. Reload the extension and try again.";
  if (/MediaRecorder|record/i.test(message)) return "Chrome could not record this tab audio format.";
  if (/audio track|NotFound|no audio/i.test(message)) return "The selected tab did not provide an audio track. Start audio on the tab and try again.";
  return `Audio capture could not start. ${message}`;
}

function chooseMimeType() {
  if (!globalThis.MediaRecorder?.isTypeSupported) return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function sourceNow(run) {
  const contextMs = run.context && finite(run.epochContextMs)
    ? Math.max(0, run.context.currentTime * 1000 - run.epochContextMs)
    : 0;
  return Math.max(run.lastSourceMs, contextMs);
}

function statusFor(run, overrides = {}) {
  const duration = Math.max(0, sourceNow(run), run.lastSourceMs);
  const meaningfulEnd = finite(run.meaningfulEndMs) ? run.meaningfulEndMs : null;
  const meaningfulStart = finite(run.meaningfulStartMs) ? run.meaningfulStartMs : null;
  return {
    runId: run.runId,
    revision: run.revision,
    state: run.finishing ? "stopping" : "recording",
    phase: run.phase,
    sourceLabel: run.sourceLabel,
    sourceDurationMs: duration,
    captureElapsedMs: duration,
    sourceElapsedMs: duration,
    meaningfulAudioStartedMs: meaningfulStart,
    meaningfulAudioEndedMs: meaningfulEnd,
    leadingSilenceMs: meaningfulStart === null ? null : meaningfulStart,
    trailingSilenceMs: meaningfulEnd === null ? null : Math.max(0, duration - meaningfulEnd),
    rms: run.rms,
    peak: run.peak,
    lastEvent: run.lastEvent || null,
    message: run.message,
    ...overrides,
  };
}

function postStatus(run, force = false) {
  if (!capture || capture !== run) return;
  const now = performance.now();
  if (!force && now - run.lastStatusAt < 700) return;
  run.lastStatusAt = now;
  run.revision += 1;
  sendBackground({ type: "OFFSCREEN_STATUS", runId: run.runId, status: statusFor(run) });
}

function handleEvent(run, event) {
  if (!event || capture !== run || run.finishing) return;
  const start = finite(event.start_ms) ? Math.max(0, event.start_ms) : null;
  const end = finite(event.end_ms) ? Math.max(start ?? 0, event.end_ms) : null;
  run.lastEvent = { label: String(event.label || "signal"), startMs: start, endMs: end, phase: event.phase || null };
  if (event.type === "vad_transition") {
    if (event.label === "meaningful-audio-start" && run.meaningfulStartMs === null && start !== null) {
      run.meaningfulStartMs = start;
      run.message = "Meaningful audio detected. Capture continues through quiet periods.";
    } else if (event.label === "meaningful-audio-resumed") {
      run.message = "Meaningful audio returned. The source clock kept its position.";
    } else if (event.label === "audio-quiet") {
      run.message = "Audio is quiet. Monitoring for it to return.";
    }
    if (event.phase === "active") run.phase = "active";
    if (event.phase === "quiet") {
      run.phase = "quiet";
      if (start !== null) run.meaningfulEndMs = Math.max(run.meaningfulEndMs ?? 0, start);
    }
    postStatus(run, true);
  }
}

function handleWorkletMessage(run, data) {
  if (!capture || capture !== run) return;
  if (data.kind === "snapshot") {
    const pending = run.pendingSnapshots.get(data.request_id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    run.pendingSnapshots.delete(data.request_id);
    pending.resolve(data);
    return;
  }
  if (run.finishing) return;
  if (data.kind === "frame") {
    if (finite(data.end_ms)) run.lastSourceMs = Math.max(run.lastSourceMs, data.end_ms);
    if (finite(data.rms)) run.rms = data.rms;
    if (finite(data.peak)) run.peak = data.peak;
    if (data.phase) run.phase = data.phase;
    if (finite(data.meaningful_end_ms)) run.meaningfulEndMs = Math.max(run.meaningfulEndMs ?? 0, data.meaningful_end_ms);
    postStatus(run);
  } else if (data.kind === "event") {
    handleEvent(run, data.event);
  }
}

function requestSnapshot(run) {
  if (!run.vadNode) return Promise.resolve(null);
  const requestId = ++requestSequence;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      run.pendingSnapshots.delete(requestId);
      resolve(null);
    }, 350);
    run.pendingSnapshots.set(requestId, { resolve, timeout });
    try { run.vadNode.port.postMessage({ kind: "snapshot", request_id: requestId }); } catch { clearTimeout(timeout); run.pendingSnapshots.delete(requestId); resolve(null); }
  });
}

function stopRecorder(run) {
  if (!run.recorder || !run.recorderStarted || run.recorder.state === "inactive") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      run.recorderStopResolve = null;
      resolve();
    };
    run.recorderStopResolve = done;
    try { run.recorder.stop(); } catch { done(); }
    setTimeout(done, 1200);
  });
}

function disconnect(node) {
  try { node?.disconnect(); } catch { /* already disconnected */ }
}

async function releaseRun(run) {
  run.pendingSnapshots.forEach((pending) => { clearTimeout(pending.timeout); pending.resolve(null); });
  run.pendingSnapshots.clear();
  if (run.track && run.track.readyState !== "ended") { try { run.track.stop(); } catch { /* ended */ } }
  run.stream?.getTracks().forEach((track) => { try { if (track.readyState !== "ended") track.stop(); } catch { /* ended */ } });
  disconnect(run.sourceNode);
  disconnect(run.passthroughGain);
  disconnect(run.analyser);
  disconnect(run.vadNode);
  disconnect(run.analysisGain);
  try { run.vadNode?.port.close(); } catch { /* closed */ }
  if (run.context && run.context.state !== "closed") { try { await run.context.close(); } catch { /* closed */ } }
  run.chunks.length = 0;
}

function recordedBytes(run) {
  if (!run.chunks.length) return 0;
  try {
    const blob = new Blob(run.chunks, { type: run.recorder?.mimeType || "audio/webm" });
    const size = blob.size;
    run.chunks.length = 0;
    return size;
  } catch {
    return run.chunks.reduce((total, chunk) => total + (chunk?.size || 0), 0);
  }
}

async function finishCapture(run, reason) {
  if (run.finishPromise) return run.finishPromise;
  run.finishing = true;
  run.finishPromise = (async () => {
    const frozenSource = sourceNow(run);
    const snapshot = await requestSnapshot(run);
    if (snapshot) {
      if (finite(snapshot.source_time_ms)) run.lastSourceMs = Math.max(run.lastSourceMs, snapshot.source_time_ms);
      if (finite(snapshot.meaningful_end_ms)) run.meaningfulEndMs = Math.max(run.meaningfulEndMs ?? 0, snapshot.meaningful_end_ms);
      if (snapshot.phase === "active" || snapshot.phase === "quiet") run.phase = snapshot.phase;
      if (finite(snapshot.rms)) run.rms = snapshot.rms;
      if (finite(snapshot.peak)) run.peak = snapshot.peak;
    }
    const sourceDuration = Math.max(frozenSource, run.lastSourceMs);
    await stopRecorder(run);
    const bytes = recordedBytes(run);
    const trailing = finite(run.meaningfulEndMs) ? Math.max(0, sourceDuration - run.meaningfulEndMs) : null;
    const finalState = run.failureMessage ? "error" : "idle";
    const finalMessage = run.failureMessage || (reason === "user-stop" ? "Capture stopped. The selected tab is ready to use." : "The shared tab audio ended.");
    const finalStatus = statusFor(run, {
      state: finalState,
      phase: "ended",
      sourceDurationMs: sourceDuration,
      captureElapsedMs: sourceDuration,
      sourceElapsedMs: sourceDuration,
      meaningfulAudioEndedMs: finite(run.meaningfulEndMs) ? run.meaningfulEndMs : null,
      trailingSilenceMs: trailing,
      recordedBytes: bytes,
      message: finalMessage,
    });
    await releaseRun(run);
    if (capture === run) capture = null;
    if (run.failureMessage) sendBackground({ type: "OFFSCREEN_ERROR", runId: run.runId, error: run.failureMessage, status: finalStatus });
    else sendBackground({ type: "CAPTURE_ENDED", runId: run.runId, reason, status: finalStatus });
    return finalStatus;
  })();
  return run.finishPromise;
}

async function startCapture(message) {
  if (capture) {
    if (capture.runId === message.runId) { postStatus(capture, true); return { ok: true, starting: !capture.recorderStarted }; }
    return { ok: false, error: "Another tab capture is already running." };
  }
  const run = {
    runId: message.runId,
    sourceLabel: String(message.sourceLabel || "Selected tab"),
    stream: null,
    track: null,
    context: null,
    sourceNode: null,
    passthroughGain: null,
    analyser: null,
    vadNode: null,
    analysisGain: null,
    recorder: null,
    recorderStarted: false,
    recorderStopResolve: null,
    chunks: [],
    pendingSnapshots: new Map(),
    epochContextMs: null,
    lastSourceMs: 0,
    phase: "waiting",
    meaningfulStartMs: null,
    meaningfulEndMs: null,
    rms: 0,
    peak: 0,
    message: "Listening for meaningful audio automatically.",
    lastEvent: null,
    lastStatusAt: -Infinity,
    revision: 0,
    finishing: false,
    finishPromise: null,
    failureMessage: null,
  };
  capture = run;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Tab media capture is not available in this browser.");
    run.stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: message.streamId } }, video: false });
    run.track = run.stream.getAudioTracks()[0];
    if (!run.track) throw new Error("No audio track returned by the selected tab.");
    run.track.addEventListener("ended", () => { if (!run.finishing) void finishCapture(run, "track-ended"); });
    run.stream.addEventListener("inactive", () => { if (!run.finishing) void finishCapture(run, "track-ended"); });

    const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextCtor) throw new Error("AudioContext is not available for tab monitoring.");
    run.context = new AudioContextCtor();
    await run.context.resume();
    if (!run.context.audioWorklet?.addModule) throw new Error("AudioWorklet is not available for tab monitoring.");
    await run.context.audioWorklet.addModule(WORKLET_URL);
    run.sourceNode = run.context.createMediaStreamSource(run.stream);
    run.passthroughGain = run.context.createGain();
    run.passthroughGain.gain.value = 1;
    run.analyser = run.context.createAnalyser();
    run.analyser.fftSize = 2048;
    run.analyser.smoothingTimeConstant = 0;
    run.vadNode = new AudioWorkletNode(run.context, "verbatim-vad");
    run.analysisGain = run.context.createGain();
    run.analysisGain.gain.value = 0;
    run.vadNode.port.onmessage = (event) => handleWorkletMessage(run, event.data || {});
    run.sourceNode.connect(run.passthroughGain);
    run.passthroughGain.connect(run.context.destination);
    run.sourceNode.connect(run.analyser);
    run.analyser.connect(run.vadNode);
    run.vadNode.connect(run.analysisGain);
    run.analysisGain.connect(run.context.destination);

    if (!globalThis.MediaRecorder) throw new Error("MediaRecorder is not available for local audio capture.");
    const mimeType = chooseMimeType();
    run.recorder = mimeType ? new MediaRecorder(run.stream, { mimeType }) : new MediaRecorder(run.stream);
    run.recorder.ondataavailable = (event) => { if (event.data?.size) run.chunks.push(event.data); };
    run.recorder.onerror = (event) => {
      run.failureMessage = readableError(new Error(`MediaRecorder failure. ${errorText(event.error || "The local recorder stopped.")}`));
      if (!run.finishing) void finishCapture(run, "recorder-error");
    };
    run.recorder.onstop = () => { const resolve = run.recorderStopResolve; run.recorderStopResolve = null; resolve?.(); };
    run.epochContextMs = run.context.currentTime * 1000;
    run.recorder.start(1000);
    run.recorderStarted = true;
    run.vadNode.port.postMessage({ kind: "capture-epoch", context_time_ms: run.epochContextMs });
    postStatus(run, true);
    return { ok: true };
  } catch (error) {
    if (!run.failureMessage) run.failureMessage = readableError(error);
    await finishCapture(run, "startup-error");
    return { ok: false, error: run.failureMessage };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return false;
  if (message.type === "START_CAPTURE") {
    startCapture(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }
  if (message.type === "STOP_CAPTURE") {
    if (!capture || capture.runId !== message.runId) { sendResponse({ ok: true, alreadyStopped: true }); return false; }
    finishCapture(capture, "user-stop").then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: errorText(error) }));
    return true;
  }
  return false;
});
