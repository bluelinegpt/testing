// Server-side image validation for Company logo uploads.
//
// The frontend-declared MIME type is never trusted. We inspect the raw bytes
// and only accept files whose real signature is PNG or JPEG. Everything else —
// SVG, HTML, scripts, polyglots, renamed executables — is rejected. This is a
// pure function so it is fully unit-testable without a server or filesystem.

export type LogoImageType = "png" | "jpeg";

export interface LogoValidationSuccess {
  readonly ok: true;
  readonly mediaType: "image/png" | "image/jpeg";
  readonly type: LogoImageType;
}

export interface LogoValidationFailure {
  readonly ok: false;
  readonly reason: string;
}

export type LogoValidationResult = LogoValidationSuccess | LogoValidationFailure;

/** Maximum accepted logo size, in bytes (2 MB). */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SOI = [0xff, 0xd8, 0xff] as const;

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * Scan the leading bytes for the textual markers of markup / script payloads.
 * A polyglot that hides `<script>` or `<svg` after a bogus header is caught
 * here even if it somehow slipped a magic-byte check.
 */
function looksLikeMarkupOrScript(bytes: Uint8Array): boolean {
  const prefix = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 1024)))
    .toString("latin1")
    .toLowerCase()
    .trimStart();
  const markers = ["<svg", "<?xml", "<!doctype", "<html", "<script", "<?php", "<%"];
  return markers.some((marker) => prefix.includes(marker));
}

/**
 * Validate raw uploaded bytes. Returns the detected type/media on success, or a
 * machine-readable reason on rejection. `declaredMediaType` (from the client)
 * is only used as a secondary cross-check — the byte signature is authoritative.
 */
export function validateLogoImage(
  bytes: Uint8Array,
  declaredMediaType?: string | undefined,
): LogoValidationResult {
  if (bytes.length === 0) {
    return { ok: false, reason: "empty_file" };
  }
  if (bytes.length > MAX_LOGO_BYTES) {
    return { ok: false, reason: "file_too_large" };
  }
  if (looksLikeMarkupOrScript(bytes)) {
    return { ok: false, reason: "markup_or_script_rejected" };
  }

  let detected: LogoValidationSuccess | undefined;
  if (startsWith(bytes, PNG_SIGNATURE)) {
    detected = { mediaType: "image/png", ok: true, type: "png" };
  } else if (startsWith(bytes, JPEG_SOI)) {
    detected = { mediaType: "image/jpeg", ok: true, type: "jpeg" };
  }

  if (detected === undefined) {
    return { ok: false, reason: "unsupported_image_signature" };
  }

  // If the client declared a type, it must agree with the real bytes. A JPEG
  // renamed/declared as PNG (or vice versa) is rejected rather than silently
  // corrected, so the stored media type always matches the content.
  if (declaredMediaType !== undefined) {
    const normalized = declaredMediaType.trim().toLowerCase();
    const declaredAllowed =
      normalized === detected.mediaType || (detected.type === "jpeg" && normalized === "image/jpg");
    if (!declaredAllowed) {
      return { ok: false, reason: "declared_media_type_mismatch" };
    }
  }

  return detected;
}
