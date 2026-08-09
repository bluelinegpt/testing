import type { Request, Response } from "express";

import {
  clearSessionCookie,
  isSafeMethod,
  readSessionCookie,
  sessionCookieName,
  sessionCookieOptions,
  sessionCsrfHeader,
  sessionCsrfValue,
  setSessionCookie,
} from "./session-cookie.js";

/**
 * Session cookie transport.
 *
 * The cookie carries a live credential, so the properties asserted here are the
 * ones whose absence would be a vulnerability: it must never be readable by
 * page scripts, it must not travel on cross-site mutations, and it must be
 * cleared with the same attributes it was set with — a mismatch leaves a
 * signed-out user holding a cookie.
 */

const requestWith = (cookie: string | undefined): Request =>
  ({ headers: cookie === undefined ? {} : { cookie } }) as unknown as Request;

const token = "a".repeat(43);

describe("readSessionCookie", () => {
  it("reads the session cookie", () => {
    expect(readSessionCookie(requestWith(`${sessionCookieName}=${token}`))).toBe(token);
  });

  it("finds it among other cookies", () => {
    expect(
      readSessionCookie(requestWith(`theme=dark; ${sessionCookieName}=${token}; locale=ar`)),
    ).toBe(token);
  });

  it("returns nothing when there is no cookie header", () => {
    expect(readSessionCookie(requestWith(undefined))).toBeUndefined();
  });

  it("returns nothing when the session cookie is absent", () => {
    expect(readSessionCookie(requestWith("theme=dark; locale=ar"))).toBeUndefined();
  });

  it("refuses a value that is not a session token", () => {
    // Only the exact token shape is accepted, so nothing else in the header
    // can be mistaken for a credential.
    for (const bad of ["", "short", `${token}extra`, "a".repeat(43) + "!"]) {
      expect(readSessionCookie(requestWith(`${sessionCookieName}=${bad}`))).toBeUndefined();
    }
  });

  it("is not confused by a cookie whose name merely ends the same way", () => {
    expect(
      readSessionCookie(requestWith(`not_${sessionCookieName}=${token}`)),
    ).toBeUndefined();
  });
});

describe("sessionCookieOptions", () => {
  const expiresAt = new Date("2026-08-07T00:00:00.000Z");

  it("is HttpOnly so page scripts can never read the token", () => {
    expect(sessionCookieOptions({ expiresAt, secure: true }).httpOnly).toBe(true);
  });

  it("uses SameSite=Lax so a cross-site mutation cannot carry it", () => {
    // Lax still allows a top-level navigation, which is the new-tab and
    // pasted-link case this whole change exists to support.
    expect(sessionCookieOptions({ expiresAt, secure: true }).sameSite).toBe("lax");
  });

  it("scopes the cookie to the API path", () => {
    expect(sessionCookieOptions({ expiresAt, secure: true }).path).toBe("/api");
  });

  it("follows the deployment for Secure", () => {
    // Forcing Secure in local HTTP development would make the browser drop the
    // cookie and reproduce the very defect this fixes.
    expect(sessionCookieOptions({ expiresAt, secure: true }).secure).toBe(true);
    expect(sessionCookieOptions({ expiresAt, secure: false }).secure).toBe(false);
  });

  it("expires with the session rather than outliving it", () => {
    expect(sessionCookieOptions({ expiresAt, secure: true }).expires).toBe(expiresAt);
  });
});

describe("setSessionCookie and clearSessionCookie", () => {
  it("sets the cookie with the session token", () => {
    const calls: unknown[][] = [];
    const response = { cookie: (...args: unknown[]) => calls.push(args) } as unknown as Response;
    setSessionCookie(response, { expiresAt: new Date(), secure: true, token });
    expect(calls[0]![0]).toBe(sessionCookieName);
    expect(calls[0]![1]).toBe(token);
  });

  it("clears using the same attributes it was set with", () => {
    const calls: unknown[][] = [];
    const response = {
      clearCookie: (...args: unknown[]) => calls.push(args),
    } as unknown as Response;
    clearSessionCookie(response, true);
    const options = calls[0]![1] as Record<string, unknown>;
    // A mismatch here leaves the browser holding the original cookie.
    expect(options.path).toBe("/api");
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.secure).toBe(true);
  });
});

describe("isSafeMethod", () => {
  it("treats reads as safe", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(isSafeMethod(method)).toBe(true);
    }
  });

  it("treats every state-changing method as unsafe", () => {
    // These are the ones that must carry the CSRF header when cookie-authenticated.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isSafeMethod(method)).toBe(false);
    }
  });
});

describe("CSRF header contract", () => {
  it("names a header a cross-site form cannot set", () => {
    expect(sessionCsrfHeader).toBe("x-blueline-session");
    expect(sessionCsrfValue).toBe("cookie");
  });
});
