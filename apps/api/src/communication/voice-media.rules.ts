/**
 * Server-authoritative limits for voice messages (Prompt 14). The client
 * (mobile recorder / browser `MediaRecorder`) enforces the same limits for a
 * responsive UX, but none of it is trusted — every value here is re-checked
 * against the uploaded bytes/declared metadata before a Voice message can be
 * created, and the database repeats the size/duration bounds independently
 * (`messages_voice_media_bounds_check`).
 */
export const VOICE_MAX_DURATION_SECONDS = 300;
/** Matches the pre-existing `file_objects_size_check` ceiling exactly, so a
 *  Voice upload can never be accepted here and rejected at the DB layer. */
export const VOICE_MAX_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * MIME types this feature accepts, normalized (lowercase, no `;codecs=...`
 * parameter). Covers `MediaRecorder`-produced WebM/Opus and Ogg/Opus from
 * Office web, and AAC-in-M4A from the mobile recorder (Android and iOS both
 * default to AAC/M4A) — nothing else. Both a browser and Flutter can produce
 * exactly one of these without any additional client-side transcoding.
 */
const ALLOWED_VOICE_MIME_TYPES: ReadonlySet<string> = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
]);

const EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
};

/** Strips a `;codecs=opus`-style parameter and lowercases, so
 *  `audio/webm;codecs=opus` and `audio/webm` are treated identically. */
export function normalizeVoiceMimeType(rawMimeType: string | undefined): string {
  return (rawMimeType ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

export function isAllowedVoiceMimeType(mimeType: string): boolean {
  return ALLOWED_VOICE_MIME_TYPES.has(mimeType);
}

export function voiceFileExtension(mimeType: string): string {
  return EXTENSION_BY_MIME_TYPE[mimeType] ?? "bin";
}

export type VoiceMediaValidation =
  | { readonly ok: true; readonly mimeType: string }
  | {
      readonly ok: false;
      readonly reason: "empty" | "too_large" | "unsupported_type" | "duration_invalid";
    };

/** Single point of truth for whether a voice upload is acceptable — used by
 *  both the Office/Trader/Driver route and the Customer session route so the
 *  two can never silently drift apart. */
export function validateVoiceMedia(input: {
  readonly sizeBytes: number;
  readonly mimeType: string | undefined;
  readonly durationSeconds: number;
}): VoiceMediaValidation {
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds < 1) {
    return { ok: false, reason: "duration_invalid" };
  }
  if (input.durationSeconds > VOICE_MAX_DURATION_SECONDS) {
    return { ok: false, reason: "duration_invalid" };
  }
  if (input.sizeBytes <= 0) return { ok: false, reason: "empty" };
  if (input.sizeBytes > VOICE_MAX_SIZE_BYTES) return { ok: false, reason: "too_large" };
  const mimeType = normalizeVoiceMimeType(input.mimeType);
  if (!isAllowedVoiceMimeType(mimeType)) return { ok: false, reason: "unsupported_type" };
  return { ok: true, mimeType };
}
