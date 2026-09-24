const BYTES_PER_MEGABYTE = 1024 * 1024;

export const MAX_AUDIO_SIZE_MB = 100;
export const MAX_AUDIO_BYTES = MAX_AUDIO_SIZE_MB * BYTES_PER_MEGABYTE;

export type AudioSizeSubject = "file" | "recording";

export function audioSizeError(subject: AudioSizeSubject = "file"): string {
  return subject === "recording"
    ? `This audio recording is larger than ${MAX_AUDIO_SIZE_MB} MB. Record a shorter take.`
    : `This audio file is larger than ${MAX_AUDIO_SIZE_MB} MB. Choose a smaller file.`;
}

export function validateAudioSize(
  value: Pick<Blob, "size">,
  subject: AudioSizeSubject = "file",
): string | null {
  return value.size > MAX_AUDIO_BYTES ? audioSizeError(subject) : null;
}
