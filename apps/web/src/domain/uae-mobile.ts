/**
 * Single UAE mobile-number normalisation used by every screen.
 *
 * Operators type the number the way they read it off a card or a phone, so all
 * three common forms are accepted and stored identically:
 *
 *   0506468442      local
 *   9715XXXXXXXX    international, no plus
 *   +9715XXXXXXXX   international
 *
 * The canonical stored form is `9715XXXXXXXX`, which is what the database
 * constraint enforces. Formatting characters people paste from contact apps
 * (spaces, dashes, brackets) are stripped before validation rather than being
 * rejected, because refusing "050 646 8442" is a pointless obstacle.
 */
const canonical = /^9715[0-9]{8}$/;

/** Returns the canonical `9715XXXXXXXX` form, or undefined if not a UAE mobile. */
export function normalizeUaeMobile(input: string | null | undefined): string | undefined {
  if (input === null || input === undefined) return undefined;
  // Keep a leading plus only long enough to recognise the international form.
  const cleaned = input.trim().replace(/[\s()\-.]/g, "");
  const digits = cleaned.startsWith("+") ? cleaned.slice(1) : cleaned;
  if (!/^[0-9]+$/.test(digits)) return undefined;

  // 05XXXXXXXX -> 9715XXXXXXXX
  if (/^05[0-9]{8}$/.test(digits)) return `971${digits.slice(1)}`;
  // 5XXXXXXXX (no trunk zero) -> 9715XXXXXXXX
  if (/^5[0-9]{8}$/.test(digits)) return `971${digits}`;
  if (canonical.test(digits)) return digits;
  return undefined;
}

/** True when the input is a recognisable UAE mobile in any accepted form. */
export function isUaeMobile(input: string | null | undefined): boolean {
  return normalizeUaeMobile(input) !== undefined;
}

/** Groups the canonical form for display: 971 50 646 8442. */
export function formatUaeMobile(input: string | null | undefined): string {
  const normalized = normalizeUaeMobile(input);
  if (normalized === undefined) return input ?? "";
  return `${normalized.slice(0, 3)} ${normalized.slice(3, 5)} ${normalized.slice(5, 8)} ${normalized.slice(8)}`;
}
