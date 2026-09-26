import { createHash, randomBytes } from "node:crypto";

/**
 * Store Order guest/Customer tracking credentials -- Shared Commerce
 * Foundation Prompt 3C (§23-24).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DUPLICATES `SessionTokenService`'S ALGORITHM INSTEAD OF IMPORTING IT
 * ---------------------------------------------------------------------------
 *
 * `SessionTokenService` (`authentication/session-token.service.ts`) already
 * does exactly this -- 32 random bytes -> base64url raw token, sha256 hex
 * digest stored at rest -- for session and password-reset tokens. The
 * algorithm is intentionally copied rather than the class imported: the
 * Store Order domain has no other dependency on the Authentication module,
 * and a tracking token is a distinct credential (no expiry-by-default, no
 * account binding) that happens to want the identical crypto shape. Sharing
 * the constant instead of the class keeps that boundary honest while still
 * giving the next reader zero new crypto to review.
 */
export function generateTrackingToken(): { readonly hash: string; readonly token: string } {
  const token = randomBytes(32).toString("base64url");
  return { hash: hashTrackingToken(token), token };
}

export function hashTrackingToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
