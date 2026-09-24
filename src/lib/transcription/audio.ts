const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

export function pickSupportedMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

export function extensionForMime(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  return "webm";
}

export function computeRmsAndPeak(data: Uint8Array): { rms: number; peak: number } {
  if (!data.length) return { rms: 0, peak: 0 };
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < data.length; i += 1) {
    const centered = (data[i] - 128) / 128;
    const abs = Math.abs(centered);
    if (abs > peak) peak = abs;
    sumSquares += centered * centered;
  }
  const rms = Math.sqrt(sumSquares / data.length);
  return { rms, peak };
}

export function drawWaveform(
  canvas: HTMLCanvasElement,
  analyser: AnalyserNode,
  color: string,
  dimColor: string
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return;

  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const bufferLength = analyser.fftSize;
  const data = new Uint8Array(bufferLength);
  analyser.getByteTimeDomainData(data);

  ctx.beginPath();
  ctx.strokeStyle = dimColor;
  ctx.lineWidth = 1;
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  const slice = width / bufferLength;
  for (let i = 0; i < bufferLength; i += 1) {
    const v = data[i] / 128.0;
    const y = (v * height) / 2;
    const x = i * slice;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

export async function requestTabAudioStream(): Promise<{
  audioStream: MediaStream;
  displayStream: MediaStream;
  sourceLabel: string;
}> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error(
      "Screen and tab capture is not available in this browser. Use Chrome on desktop."
    );
  }

  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });

  displayStream.getVideoTracks().forEach((track) => {
    track.stop();
    displayStream.removeTrack(track);
  });

  const audioTracks = displayStream.getAudioTracks();
  if (!audioTracks.length) {
    displayStream.getTracks().forEach((t) => t.stop());
    throw new Error(
      "No audio track was shared. Choose a Chrome tab and enable Share tab audio."
    );
  }

  const track = audioTracks[0];
  const sourceLabel =
    track.label?.trim() ||
    // Some browsers expose the shared surface name here
    (track.getSettings() as MediaTrackSettings & { displaySurface?: string })
      .displaySurface ||
    "Shared tab audio";

  const audioStream = new MediaStream([track]);
  return { audioStream, displayStream, sourceLabel };
}
