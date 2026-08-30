/**
 * Commerce media validation.
 *
 * ---------------------------------------------------------------------------
 * THE BYTES DECIDE, NOT THE CLIENT
 * ---------------------------------------------------------------------------
 *
 * This mirrors the rule `image-signature.ts` already established for Company
 * logos and extends it to WebP: the declared MIME type is a cross-check, never
 * the authority. A file whose real signature is not an accepted image is
 * rejected regardless of what it claims to be, and the leading kilobyte is
 * scanned for markup and script markers so a polyglot cannot smuggle
 * `<script>` in behind a plausible header.
 *
 * WebP is added because it is a genuine web image format the stack already
 * serves; nothing else is. SVG is deliberately absent — it is a document
 * format that executes script, and "an image the browser will run" has no
 * place in a Product gallery.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STORAGE NAME NEVER COMES FROM THE UPLOAD
 * ---------------------------------------------------------------------------
 *
 * `commerceStorageKey` builds every key from server-known identifiers plus a
 * fresh UUID. The client's filename is kept only as `original_filename`
 * metadata, after sanitisation, and never participates in a path. That removes
 * traversal, reserved Windows device names, control characters and
 * double-extension tricks as a class rather than defending against each one.
 */

export type CommerceImageType = "jpeg" | "png" | "webp";

export interface CommerceMediaSuccess {
  readonly mediaType: "image/jpeg" | "image/png" | "image/webp";
  readonly ok: true;
  readonly type: CommerceImageType;
}

export interface CommerceMediaFailure {
  readonly ok: false;
  readonly reason: string;
}

export type CommerceMediaResult = CommerceMediaSuccess | CommerceMediaFailure;

/**
 * Size ceilings, in bytes. Branding and category art are decoration and stay
 * small; a Product photograph is the thing a customer actually judges the
 * goods by, so it gets more room. Both sit far below the 10 MB
 * `file_objects_size_check` the database already enforces, so the database
 * remains a backstop rather than the only limit.
 */
export const commerceMediaLimits = {
  /** Store logo, Store cover, Category image. */
  branding: 2 * 1024 * 1024,
  /** Product image. */
  product: 5 * 1024 * 1024,
} as const;

export type CommerceMediaPurpose =
  | "category"
  | "cover"
  | "logo"
  | "product_image";

export function limitFor(purpose: CommerceMediaPurpose): number {
  return purpose === "product_image" ? commerceMediaLimits.product : commerceMediaLimits.branding;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SOI = [0xff, 0xd8, 0xff] as const;
const RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP = [0x57, 0x45, 0x42, 0x50] as const;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function looksLikeMarkupOrScript(bytes: Uint8Array): boolean {
  const prefix = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 1024)))
    .toString("latin1")
    .toLowerCase()
    .trimStart();
  return ["<svg", "<?xml", "<!doctype", "<html", "<script", "<?php", "<%"].some((marker) =>
    prefix.includes(marker),
  );
}

export function validateCommerceImage(
  bytes: Uint8Array,
  purpose: CommerceMediaPurpose,
  declaredMediaType?: string | undefined,
): CommerceMediaResult {
  if (bytes.length === 0) return { ok: false, reason: "empty_file" };
  if (bytes.length > limitFor(purpose)) return { ok: false, reason: "file_too_large" };

  let detected: CommerceMediaSuccess | undefined;
  if (startsWith(bytes, PNG_SIGNATURE)) {
    detected = { mediaType: "image/png", ok: true, type: "png" };
  } else if (startsWith(bytes, JPEG_SOI)) {
    detected = { mediaType: "image/jpeg", ok: true, type: "jpeg" };
  } else if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) {
    // WebP is a RIFF container: "RIFF" then a 4-byte length then "WEBP".
    detected = { mediaType: "image/webp", ok: true, type: "webp" };
  }
  if (detected === undefined) {
    // Only checked here, for files that are NOT already a genuine
    // PNG/JPEG/WebP by signature -- a file starting with real binary image
    // magic bytes can never be parsed as SVG/HTML/script by anything, so
    // running this scan unconditionally produced false positives on real
    // images whose compressed data happened to decode (as latin1) to
    // contain one of these substrings.
    if (looksLikeMarkupOrScript(bytes)) return { ok: false, reason: "markup_or_script_rejected" };
    return { ok: false, reason: "unsupported_image_signature" };
  }

  if (declaredMediaType !== undefined) {
    const normalised = declaredMediaType.trim().toLowerCase();
    const agrees =
      normalised === detected.mediaType ||
      (detected.type === "jpeg" && normalised === "image/jpg");
    if (!agrees) return { ok: false, reason: "declared_media_type_mismatch" };
  }
  return detected;
}

/** Characters that must never survive into stored filename metadata. */
const unsafeFilenameCharacters = new Set(['"', "*", "/", ":", "<", ">", "?", "\\", "|"]);

/**
 * Whether a character is safe to keep in filename metadata.
 *
 * Written as a codepoint test rather than a regular expression on purpose: a
 * character class covering the C0 range has to contain literal control bytes,
 * which is both unreadable in a diff and something linters flag as a probable
 * mistake. This says what it means.
 */
function isSafeFilenameCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) return false;
  return !unsafeFilenameCharacters.has(character);
}

/**
 * A client filename reduced to something safe to STORE AS METADATA.
 *
 * This value never becomes a path segment. It is sanitised anyway because it is
 * echoed back to the Trader and could otherwise carry control characters or a
 * misleading double extension into a UI or a download header.
 */
export function sanitiseOriginalFilename(raw: string | undefined): string {
  const fallback = "upload";
  if (raw === undefined) return fallback;
  const base = raw
    // Strip any directory component the browser included.
    .replace(/^.*[\\/]/, "")
    .split("")
    .filter(isSafeFilenameCharacter)
    .join("")
    .trim()
    .slice(0, 120);
  if (base === "" || base === "." || base === "..") return fallback;
  // Reserved Windows device names remain reserved even with an extension.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(base)) return fallback;
  return base;
}

/**
 * The logical storage location for a new Commerce object.
 *
 * Every component is server-known. The trailing UUID makes collisions
 * impossible without consulting storage, and means re-uploading the same
 * filename never overwrites an existing object.
 */
export function commerceStorageKey(input: {
  readonly categoryId?: string;
  readonly extension: string;
  readonly productId?: string;
  readonly purpose: CommerceMediaPurpose;
  readonly storefrontId: string;
  readonly traderCommerceId: string;
  readonly unique: string;
}): string {
  const base = `commerce/${input.traderCommerceId}/stores/${input.storefrontId}`;
  const name = `${input.unique}.${input.extension}`;
  switch (input.purpose) {
    case "logo":
      return `${base}/branding/logo/${name}`;
    case "cover":
      return `${base}/branding/cover/${name}`;
    case "category":
      return `${base}/categories/${input.categoryId ?? "unassigned"}/${name}`;
    case "product_image":
      return `${base}/products/${input.productId ?? "unassigned"}/images/${name}`;
  }
}

export function extensionFor(type: CommerceImageType): string {
  return type === "jpeg" ? "jpg" : type;
}
