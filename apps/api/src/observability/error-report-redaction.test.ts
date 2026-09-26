import { describe, expect, it } from "vitest";

import { redactSensitiveText } from "./error-report-redaction.js";

/**
 * System-Wide Error Handler Audit prompt, §58: prove secrets are removed
 * before a crash report is ever written, using the exact representative key
 * set the prompt names.
 */
describe("redactSensitiveText", () => {
  it("returns null for null/undefined, matching the nullable stack/path columns", () => {
    expect(redactSensitiveText(null)).toBeNull();
    expect(redactSensitiveText(undefined)).toBeNull();
  });

  it("leaves ordinary error text completely untouched", () => {
    const message = "Cannot read properties of undefined (reading 'slug')";
    expect(redactSensitiveText(message)).toBe(message);
  });

  const cases: readonly [string, string][] = [
    ["password: hunter2", "password"],
    ["password=hunter2", "password"],
    ['"password":"hunter2"', "password"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def", "authorization"],
    ["cookie: session=abc123; other=1", "cookie"],
    ["accessToken: eyJhbGciOi.xyz", "accessToken"],
    ["refreshToken=rt_1a2b3c4d5e", "refreshToken"],
    ["resetToken: rst_9f8e7d6c", "resetToken"],
  ];

  for (const [input, key] of cases) {
    it(`redacts a ${key} value while keeping the key name`, () => {
      const result = redactSensitiveText(input);
      expect(result).toContain("[redacted]");
      expect(result?.toLowerCase()).toContain(key.toLowerCase());
      // The actual secret value must not survive.
      expect(result).not.toMatch(/hunter2|eyJhbGciOiJIUzI1NiJ9\.abc\.def|session=abc123|eyJhbGciOi\.xyz|rt_1a2b3c4d5e|rst_9f8e7d6c/);
    });
  }

  it("redacts a bare Bearer token even without a labelled key", () => {
    const result = redactSensitiveText("fetch failed: Authorization header was Bearer abc.def.ghi123");
    expect(result).toContain("Bearer [redacted]");
    expect(result).not.toContain("abc.def.ghi123");
  });

  it("redacts every sensitive field in a JSON-stringified request body embedded in a stack/message", () => {
    const stack = JSON.stringify({
      body: { email: "a@b.com", password: "hunter2" },
      headers: { authorization: "Bearer supersecrettoken", cookie: "sid=deadbeef" },
    });
    const result = redactSensitiveText(stack);
    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("supersecrettoken");
    expect(result).not.toContain("deadbeef");
    // Non-sensitive fields survive.
    expect(result).toContain("a@b.com");
  });

  it("does not over-match key names that merely contain a sensitive word as a substring", () => {
    const message = "passwordPolicy violated: minimum 8 characters";
    expect(redactSensitiveText(message)).toBe(message);
  });

  /**
   * Customer Commerce C3 corrective, Part L/M: the guest Store Order
   * tracking token must never survive sanitization in `message`/`stack`/
   * `path` if it is ever accidentally included in a thrown error (it
   * shouldn't be -- the raw token is generated after all validation
   * succeeds and never reaches an exception path today -- but this proves
   * the redactor itself would catch it if that ever changed, rather than
   * relying on "it never happens" as the only guarantee).
   *
   * Regression note: the bare `token` catch-all key alone does NOT catch
   * this -- `\btoken\b`'s word boundary does not match "Token" inside
   * "trackingToken" (no non-word character precedes it). `trackingToken`
   * is now listed explicitly in `SENSITIVE_KEYS` for exactly this reason.
   */
  const syntheticTrackingToken = "tk_c3_synthetic_raw_value_do_not_log";

  it("redacts a synthetic tracking token in an error message", () => {
    const result = redactSensitiveText(`Unexpected failure: trackingToken=${syntheticTrackingToken} was rejected`);
    expect(result).toContain("[redacted]");
    expect(result).not.toContain(syntheticTrackingToken);
  });

  it("redacts a synthetic tracking token inside a JSON-stringified stack frame", () => {
    const stack = JSON.stringify({ trackingToken: syntheticTrackingToken, storeOrderNumber: "SO-000003" });
    const result = redactSensitiveText(stack);
    expect(result).not.toContain(syntheticTrackingToken);
    expect(result).toContain("SO-000003"); // non-sensitive fields survive
  });

  it("redacts a synthetic tracking token embedded in a path-like string", () => {
    const result = redactSensitiveText(`/api/v1/debug?trackingToken=${syntheticTrackingToken}`);
    expect(result).not.toContain(syntheticTrackingToken);
  });
});
