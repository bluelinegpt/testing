import type { CookieOptions, Request, Response } from "express";

/**
 * Session cookie transport.
 *
 * ---------------------------------------------------------------------------
 * THE COOKIE CARRIES THE SAME TOKEN THE HEADER ALWAYS DID
 * ---------------------------------------------------------------------------
 *
 * Sessions were already server-managed: `account_sessions` stores a SHA-256
 * hash of the token with an expiry and a revocation column, and every request
 * re-resolves the Company and permissions from it. The only weakness was
 * transport — the token existed solely in a JavaScript variable, so a reload,
 * a pasted URL or a new tab lost it.
 *
 * This adds a second, `HttpOnly` transport for that same token. Nothing about
 * session issuance, validation, expiry or revocation changes, so a session
 * revoked server-side is dead on both paths at once. The token is never
 * readable by page scripts, which is the property `localStorage` could not
 * offer.
 *
 * ---------------------------------------------------------------------------
 * WHY A CUSTOM HEADER IS REQUIRED ALONGSIDE THE COOKIE
 * ---------------------------------------------------------------------------
 *
 * A cookie is attached by the browser automatically, which is exactly what
 * makes CSRF possible. Two independent controls apply:
 *
 *  - `SameSite=Lax`, so the cookie is not sent on cross-site POST/PUT/PATCH/
 *    DELETE at all; and
 *  - a required `X-Blueline-Session` header on every cookie-authenticated
 *    state-changing request. A cross-site HTML form cannot set a custom
 *    header, and a cross-origin fetch that tries triggers a CORS preflight
 *    that this API does not answer for foreign origins.
 *
 * Requests authenticated by the `Authorization` header are unaffected: a
 * bearer token is never attached automatically, so it cannot be forged this
 * way and needs no second control.
 */

export const sessionCookieName = "blueline_session";

/** Header a cookie-authenticated mutating request must carry. */
export const sessionCsrfHeader = "x-blueline-session";
export const sessionCsrfValue = "cookie";

/** Methods that cannot change state and therefore need no CSRF control. */
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeMethod(method: string): boolean {
  return safeMethods.has(method.toUpperCase());
}

/**
 * Reads the session cookie without a parser dependency.
 *
 * Express does not populate `req.cookies` unless `cookie-parser` is installed,
 * and one cookie does not justify a new dependency in an authentication path.
 * Only the exact token shape is accepted, so nothing else in the header can be
 * mistaken for one.
 */
export function readSessionCookie(request: Request): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== sessionCookieName) continue;
    const value = part.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
  }
  return undefined;
}

/**
 * Cookie attributes.
 *
 * `Secure` follows the deployment rather than being hardcoded: forcing it in
 * local HTTP development would make the browser silently drop the cookie and
 * produce exactly the "reload logs me out" behaviour this change exists to
 * fix. `SameSite=Lax` lets a top-level navigation to a protected URL carry the
 * session — which is the new-tab and pasted-link case — while withholding it
 * from cross-site form submissions.
 *
 * The path is scoped to the API prefix so the cookie is not attached to static
 * asset requests.
 */
export function sessionCookieOptions(input: {
  readonly expiresAt: Date;
  readonly secure: boolean;
}): CookieOptions {
  return {
    expires: input.expiresAt,
    httpOnly: true,
    path: "/api",
    sameSite: "lax",
    secure: input.secure,
  };
}

export function setSessionCookie(
  response: Response,
  input: { readonly expiresAt: Date; readonly secure: boolean; readonly token: string },
): void {
  response.cookie(sessionCookieName, input.token, sessionCookieOptions(input));
}

/**
 * Clears the cookie.
 *
 * The attributes must match those it was set with or the browser keeps the
 * original, leaving a signed-out user holding a cookie whose session is
 * already revoked server-side.
 */
export function clearSessionCookie(response: Response, secure: boolean): void {
  response.clearCookie(sessionCookieName, {
    httpOnly: true,
    path: "/api",
    sameSite: "lax",
    secure,
  });
}
