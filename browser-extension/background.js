const STATUS_KEY = "captureStatus";
const ACTIVE_RUN_KEY = "activeRun";
const OFFSCREEN_PATH = "offscreen.html";

const defaultStatus = {
  state: "idle",
  phase: "waiting",
  sourceLabel: "No capture yet",
  sourceDurationMs: 0,
  captureElapsedMs: 0,
  sourceElapsedMs: 0,
  meaningfulAudioStartedMs: null,
  meaningfulAudioEndedMs: null,
  leadingSilenceMs: null,
  trailingSilenceMs: null,
  rms: 0,
  peak: 0,
  message: "Choose a supported tab, then start capture.",
  updatedAt: 0,
};

let startTask = null;
let offscreenTask = Promise.resolve();
const finalizationTasks = new Map();

function errorText(error) {
  return String(error?.message || error || "Unknown error").replace(/^Error:\s*/i, "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendStatusUpdate(status) {
  chrome.runtime.sendMessage({ type: "STATUS_UPDATED", status }, () => void chrome.runtime.lastError);
}

async function readState() {
  const stored = await chrome.storage.local.get([STATUS_KEY, ACTIVE_RUN_KEY]);
  return { status: stored[STATUS_KEY] || { ...defaultStatus }, activeRun: stored[ACTIVE_RUN_KEY] || null };
}

async function saveStatus(status) {
  const next = { ...defaultStatus, ...status, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STATUS_KEY]: next });
  sendStatusUpdate(next);
  return next;
}

function supportedTab(tab) {
  const url = String(tab?.url || "");
  return /^https?:\/\//i.test(url);
}

async function currentTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] || null;
}

function tabLabel(tab) {
  const title = String(tab?.title || "Selected tab").trim();
  return title.slice(0, 160) || "Selected tab";
}

function baseRun(tab, runId) {
  return {
    runId,
    sourceTabId: tab.id,
    sourceWindowId: tab.windowId,
    previousTabId: tab.id,
    previousWindowId: tab.windowId,
    sourceLabel: tabLabel(tab),
    startedAt: new Date().toISOString(),
    lastRevision: 0,
    stopRequested: false,
  };
}

async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA"],
      justification: "Process authorized tab audio continuously while the popup is closed.",
    });
  } catch (error) {
    if (!/already exists|Only a single offscreen/i.test(errorText(error))) throw error;
  }
}

function sendToOffscreenOnce(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ target: "offscreen", ...message }, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) reject(new Error(lastError.message));
      else resolve(response || { ok: true });
    });
  });
}

async function sendToOffscreen(message) {
  try {
    return await sendToOffscreenOnce(message);
  } catch (error) {
    if (!/receiving end|message port closed|could not establish/i.test(errorText(error))) throw error;
    await delay(120);
    return sendToOffscreenOnce(message);
  }
}

async function closeOffscreen() {
  try {
    if (!chrome.offscreen.hasDocument || await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  } catch {
    // The document may already have closed after its media track ended.
  }
}

async function restorePrevious(run) {
  if (Number.isInteger(run.previousWindowId)) {
    try { await chrome.windows.update(run.previousWindowId, { focused: true }); } catch { /* best effort */ }
  }
  if (Number.isInteger(run.previousTabId)) {
    try { await chrome.tabs.update(run.previousTabId, { active: true }); } catch { /* best effort */ }
  }
}

function finalization(run, status) {
  const existing = finalizationTasks.get(run.runId);
  if (existing) return existing;
  const task = (async () => {
    const finalStatus = await saveStatus({ ...status, runId: run.runId, sourceLabel: run.sourceLabel || status.sourceLabel });
    const state = await readState();
    if (state.activeRun?.runId === run.runId) await chrome.storage.local.remove(ACTIVE_RUN_KEY);
    await restorePrevious(run);
    await closeOffscreen();
    return finalStatus;
  })();
  finalizationTasks.set(run.runId, task);
  void task.then(() => finalizationTasks.delete(run.runId), () => finalizationTasks.delete(run.runId));
  return task;
}

function captureErrorStatus(sourceLabel, message, runId) {
  return {
    state: "error",
    phase: "waiting",
    sourceLabel,
    sourceDurationMs: 0,
    captureElapsedMs: 0,
    sourceElapsedMs: 0,
    meaningfulAudioStartedMs: null,
    meaningfulAudioEndedMs: null,
    leadingSilenceMs: null,
    trailingSilenceMs: null,
    rms: 0,
    peak: 0,
    message,
    ...(runId ? { runId } : {}),
  };
}

function readableStartError(error) {
  const message = errorText(error);
  if (/permission|denied|not allowed/i.test(message)) return "Chrome did not grant tab-audio access. Click Start capture again and allow the tab prompt.";
  if (/not supported|unsupported|invalid/i.test(message)) return "This tab cannot be captured. Open a regular http or https page and try again.";
  return `Tab audio could not start. ${message}`;
}

async function startCapture() {
  const existing = await readState();
  if (existing.activeRun) return { ok: true, alreadyActive: true, status: existing.status };
  const tab = await currentTab();
  if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) {
    const status = await saveStatus(captureErrorStatus("No supported tab", "Chrome did not provide an active tab to capture."));
    return { ok: false, error: status.message, status };
  }
  if (!supportedTab(tab)) {
    const status = await saveStatus(captureErrorStatus(tabLabel(tab), "This tab cannot be captured. Open a regular http or https page and try again."));
    return { ok: false, error: status.message, status };
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (error) {
    const status = await saveStatus(captureErrorStatus(tabLabel(tab), readableStartError(error)));
    return { ok: false, error: status.message, status };
  }

  const run = baseRun(tab, crypto.randomUUID());
  await chrome.storage.local.set({ [ACTIVE_RUN_KEY]: run });
  await saveStatus({
    state: "requesting",
    phase: "waiting",
    sourceLabel: run.sourceLabel,
    sourceTabId: run.sourceTabId,
    sourceWindowId: run.sourceWindowId,
    sourceDurationMs: 0,
    captureElapsedMs: 0,
    sourceElapsedMs: 0,
    meaningfulAudioStartedMs: null,
    meaningfulAudioEndedMs: null,
    leadingSilenceMs: null,
    trailingSilenceMs: null,
    rms: 0,
    peak: 0,
    message: "Authorizing tab audio, then listening automatically.",
    runId: run.runId,
  });

  try {
    await ensureOffscreen();
    const pending = await readState();
    if (pending.activeRun?.runId === run.runId && pending.activeRun.stopRequested) {
      const stopped = { ...pending.status, state: "idle", phase: "ended", message: "Capture was cancelled before audio began." };
      await finalization(run, stopped);
      return { ok: true, status: stopped };
    }
    const reply = await sendToOffscreen({ type: "START_CAPTURE", runId: run.runId, streamId, sourceLabel: run.sourceLabel });
    if (reply?.ok === false) throw new Error(reply.error || "The audio capture page could not start.");
    return { ok: true, status: (await readState()).status };
  } catch (error) {
    const status = captureErrorStatus(run.sourceLabel, readableStartError(error), run.runId);
    await finalization(run, status);
    return { ok: false, error: status.message, status };
  }
}

function queuedStart() {
  if (startTask) return startTask;
  const task = startCapture();
  startTask = task;
  void task.then(() => { if (startTask === task) startTask = null; }, () => { if (startTask === task) startTask = null; });
  return task;
}

async function stopCapture() {
  const state = await readState();
  if (!state.activeRun) return { ok: true, status: state.status };
  if (state.activeRun.stopRequested) return { ok: true, status: state.status, alreadyStopping: true };
  const run = { ...state.activeRun, stopRequested: true };
  await chrome.storage.local.set({ [ACTIVE_RUN_KEY]: run });
  await saveStatus({ ...state.status, state: "stopping", message: "Finishing capture and preserving the source timing." });
  try {
    const reply = await sendToOffscreen({ type: "STOP_CAPTURE", runId: run.runId });
    if (reply?.ok === false) throw new Error(reply.error || "The capture page did not stop.");
  } catch (error) {
    const status = { ...state.status, state: "error", phase: "ended", message: `Capture could not finish cleanly. ${errorText(error)}` };
    await finalization(run, status);
    return { ok: false, error: status.message, status };
  }
  return { ok: true, status: (await readState()).status };
}

async function handleOffscreenStatus(message) {
  const state = await readState();
  const run = state.activeRun;
  if (!run || run.runId !== message.runId || !message.status) return;
  const revision = Number(message.status.revision || 0);
  if (revision && revision <= Number(run.lastRevision || 0)) return;
  const nextRun = { ...run, lastRevision: Math.max(Number(run.lastRevision || 0), revision) };
  await chrome.storage.local.set({ [ACTIVE_RUN_KEY]: nextRun });
  const nextStatus = { ...message.status, sourceLabel: message.status.sourceLabel || run.sourceLabel, runId: run.runId };
  if (run.stopRequested && nextStatus.state === "recording") nextStatus.state = "stopping";
  await saveStatus(nextStatus);
}

async function handleCaptureEnded(message) {
  const state = await readState();
  const run = state.activeRun;
  if (!run || run.runId !== message.runId) return;
  const incoming = message.status || state.status;
  const finalStatus = {
    ...incoming,
    state: incoming.state === "error" ? "error" : "idle",
    phase: "ended",
    message: incoming.message || "Audio capture ended.",
  };
  await finalization(run, finalStatus);
}

async function handleOffscreenError(message) {
  const state = await readState();
  const run = state.activeRun;
  if (!run || run.runId !== message.runId) return;
  const incoming = message.status || {};
  await finalization(run, {
    ...state.status,
    ...incoming,
    state: "error",
    phase: incoming.phase || "ended",
    message: message.error || incoming.message || "The audio capture stopped with an error.",
  });
}

function queueOffscreenMessage(message) {
  offscreenTask = offscreenTask.catch(() => undefined).then(() => {
    if (message.type === "OFFSCREEN_STATUS") return handleOffscreenStatus(message);
    if (message.type === "CAPTURE_ENDED") return handleCaptureEnded(message);
    if (message.type === "OFFSCREEN_ERROR") return handleOffscreenError(message);
    return undefined;
  });
  void offscreenTask.catch(() => undefined);
  return offscreenTask;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target === "offscreen") return false;
  if (message.type === "GET_STATUS") {
    readState().then((state) => sendResponse({ ok: true, status: state.status })).catch((error) => sendResponse({ ok: false, error: errorText(error) }));
    return true;
  }
  if (message.type === "START_CAPTURE") {
    queuedStart().then(sendResponse).catch((error) => sendResponse({ ok: false, error: readableStartError(error) }));
    return true;
  }
  if (message.type === "STOP_CAPTURE") {
    stopCapture().then(sendResponse).catch((error) => sendResponse({ ok: false, error: errorText(error) }));
    return true;
  }
  if (["OFFSCREEN_STATUS", "CAPTURE_ENDED", "OFFSCREEN_ERROR"].includes(message.type)) {
    queueOffscreenMessage(message).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(STATUS_KEY).then((stored) => {
    if (!stored[STATUS_KEY]) return chrome.storage.local.set({ [STATUS_KEY]: { ...defaultStatus } });
    return undefined;
  }).catch(() => undefined);
});
