const defaultStatus = {
  state: "idle",
  phase: "waiting",
  sourceLabel: "No capture yet",
  sourceDurationMs: 0,
  meaningfulAudioStartedMs: null,
  meaningfulAudioEndedMs: null,
  trailingSilenceMs: null,
  rms: 0,
  peak: 0,
  message: "Choose a supported tab, then start capture.",
};

const elements = {
  card: document.getElementById("status-card"),
  orb: document.getElementById("status-orb"),
  label: document.getElementById("status-label"),
  message: document.getElementById("status-message"),
  badge: document.getElementById("status-badge"),
  fill: document.getElementById("signal-fill"),
  meter: document.querySelector(".signal-track"),
  sourceDuration: document.getElementById("source-duration"),
  meaningfulStart: document.getElementById("meaningful-start"),
  meaningfulEnd: document.getElementById("meaningful-end"),
  trailingSilence: document.getElementById("trailing-silence"),
  tabLine: document.getElementById("tab-line"),
  tabTitle: document.getElementById("tab-title"),
  error: document.getElementById("error-panel"),
  start: document.getElementById("start-button"),
  stop: document.getElementById("stop-button"),
};

let status = { ...defaultStatus };

function extensionMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) resolve({ ok: false, error: lastError.message });
      else resolve(response || { ok: false, error: "The extension did not return a status." });
    });
  });
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatMilliseconds(value, empty = "Not detected") {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return empty;
  const milliseconds = Math.max(0, Number(value));
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const hundredths = Math.floor((milliseconds % 1000) / 10);
  return `${hours ? `${pad(hours)}:` : ""}${pad(minutes)}:${pad(seconds)}.${pad(hundredths)}`;
}

function labelFor(next) {
  if (next.state === "error") return ["Capture error", "ERROR"];
  if (next.phase === "ended") return ["Audio ended", "FINISHED"];
  if (next.state === "stopping") return ["Finishing capture", "STOPPING"];
  if (next.phase === "active") return ["Meaningful audio", "LIVE"];
  if (next.phase === "quiet") return ["Audio quiet", "MONITORING"];
  if (next.state === "requesting" || next.state === "recording") return ["Waiting for audio", "LISTENING"];
  return ["Idle", "READY"];
}

function render(next) {
  status = { ...defaultStatus, ...next };
  const [label, badge] = labelFor(status);
  const level = Math.round(Math.max(0, Math.min(1, Number(status.peak) || 0)) * 100);
  elements.label.textContent = label;
  elements.badge.textContent = badge;
  elements.message.textContent = status.message || "Capture status is ready.";
  elements.sourceDuration.textContent = formatMilliseconds(status.sourceDurationMs, "00:00.00");
  elements.meaningfulStart.textContent = formatMilliseconds(status.meaningfulAudioStartedMs);
  elements.meaningfulEnd.textContent = formatMilliseconds(status.meaningfulAudioEndedMs);
  elements.trailingSilence.textContent = formatMilliseconds(status.trailingSilenceMs, "Not available");
  elements.fill.style.width = `${level}%`;
  elements.meter.setAttribute("aria-valuenow", String(level));
  elements.tabTitle.textContent = status.sourceLabel || "Selected tab";
  elements.tabLine.hidden = !status.sourceLabel || status.sourceLabel === "No capture yet";
  elements.error.hidden = status.state !== "error";
  elements.error.textContent = status.state === "error" ? (status.message || "Capture could not start.") : "";
  elements.card.dataset.phase = status.state === "error" ? "error" : status.phase;
  elements.orb.dataset.phase = status.state === "error" ? "error" : status.phase;
  const active = ["requesting", "recording", "stopping"].includes(status.state);
  elements.start.disabled = active;
  elements.stop.disabled = status.state !== "recording";
}

async function refresh() {
  const response = await extensionMessage({ type: "GET_STATUS" });
  if (response.ok && response.status) render(response.status);
  else if (!response.ok) render({ ...status, state: "error", message: response.error || "The extension status is unavailable." });
}

async function start() {
  elements.start.disabled = true;
  const response = await extensionMessage({ type: "START_CAPTURE" });
  if (response.status) render(response.status);
  if (!response.ok && !response.status) render({ ...status, state: "error", message: response.error || "Capture could not start." });
}

async function stop() {
  elements.stop.disabled = true;
  const response = await extensionMessage({ type: "STOP_CAPTURE" });
  if (response.status) render(response.status);
  if (!response.ok && !response.status) render({ ...status, state: "error", message: response.error || "Capture could not stop." });
}

elements.start.addEventListener("click", () => { void start(); });
elements.stop.addEventListener("click", () => { void stop(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.captureStatus?.newValue) render(changes.captureStatus.newValue);
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "STATUS_UPDATED" && message.status) render(message.status);
});

render(defaultStatus);
void refresh();
