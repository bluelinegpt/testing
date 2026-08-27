/**
 * Sanitizes text before it is written to `client_error_reports` (System-Wide
 * Error Handler Audit prompt, §6/§58).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DIDN'T ALREADY EXIST
 * ---------------------------------------------------------------------------
 *
 * `ClientErrorReportService.insert()` wrote `message`/`stack`/`path` straight
 * from whatever the caller supplied (a frontend error boundary, or the
 * unhandled-exception message/stack itself) with no scrubbing at all. Most
 * exception messages never mention a secret, but a naively-written validator
 * ("Invalid password: hunter2"), a thrown error that echoes a request header,
 * or a stack frame that happens to print an object containing a token would
 * have landed here verbatim and stayed there — visible to every Platform
 * Administrator with `platform.errors.read`, indefinitely, with no redaction
 * pass ever applied after the fact.
 *
 * This does NOT try to be a general-purpose secret scanner. It targets the
 * concrete key names this repository actually uses for credentials
 * (`password`, `authorization`, `cookie`, `accessToken`, `refreshToken`,
 * `resetToken`, plus `apiKey`/`secret`/`token` as a catch-all), in the shapes
 * an error message or a `JSON.stringify`'d object/stack frame would actually
 * produce: `key: value`, `key=value`, `key" : "value` (from stringified
 * JSON), and a bare `Bearer <token>`. A key name surviving with its value
 * redacted is deliberately more useful to Platform support than deleting the
 * whole line would be — the diagnostic value of "a password was rejected
 * here" doesn't require knowing what the password was.
 */

const REDACTED = "[redacted]";

/** Key names treated as sensitive, matched case-insensitively. Word-ish
 * boundaries only (`\b`), so this doesn't also eat `passwordPolicy` or
 * `cookieConsent` as a side effect -- only the key itself, followed by the
 * usual `:`/`=`/quote-colon separators a real value would use. */
const SENSITIVE_KEYS = [
  "password",
  "authorization",
  "cookie",
  "set-cookie",
  "accessToken",
  "refreshToken",
  "resetToken",
  // Customer Commerce C3 corrective, Part L/M: the Store Order guest
  // tracking credential. Listed explicitly, not left to the bare "token"
  // catch-all below -- `\btoken\b`'s word boundary does NOT match "Token"
  // inside "trackingToken" (no non-word character precedes it), so without
  // this entry a stray `trackingToken: <raw value>` in a thrown error's
  // message would have reached `client_error_reports` unredacted.
  "trackingToken",
  "tracking_token",
  "apiKey",
  "api_key",
  "secret",
  "token",
];

function buildKeyValuePattern(): RegExp {
  const keys = SENSITIVE_KEYS.map((key) => key.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  // Matches: `key: value`, `key=value`, `"key":"value"`, `key" : "value` —
  // captures the key exactly as written so it survives redaction, and
  // consumes the value up to the next quote/comma/whitespace-run/line-end.
  return new RegExp(
    `("?\\b(?:${keys})\\b"?\\s*[:=]\\s*"?)([^"\\n,}]+)`,
    "giu",
  );
}

const KEY_VALUE_PATTERN = buildKeyValuePattern();
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/giu;

/** Applied to `message`, `stack` and `path` before every insert. Never
 * throws -- an input this can't process (non-string, etc.) is returned as
 * `null` rather than risking a capture failure over a redaction bug. */
export function redactSensitiveText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  return value
    .replaceAll(KEY_VALUE_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replaceAll(BEARER_PATTERN, `Bearer ${REDACTED}`);
}
