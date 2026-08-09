import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { redactSensitive } from "./platform-audit.service.js";

/**
 * Redaction is the last line before an unfixable disclosure.
 *
 * `audit_events` is append-only — `reject_audit_mutation` refuses every UPDATE
 * and DELETE — so a secret written into it cannot afterwards be edited, deleted
 * or redacted by anyone. That is why redaction is central rather than left to
 * each call site: a call site that forgets is permanent.
 */
describe("Audit redaction", () => {
  it("removes the value of anything that looks like a credential", () => {
    const redacted = redactSensitive({
      username: "ali",
      password: "hunter2",
      newPassword: "hunter3",
      password_hash: "$argon2id$...",
      apiKey: "sk-live-123",
      setupUrl: "https://x/account-setup?token=abc",
      Authorization: "Bearer abc",
      cookie: "blueline_session=abc",
    }) as Record<string, unknown>;

    expect(redacted.username).toBe("ali");
    for (const key of [
      "password",
      "newPassword",
      "password_hash",
      "apiKey",
      "setupUrl",
      "Authorization",
      "cookie",
    ]) {
      expect(redacted[key]).toBe("[redacted]");
    }
  });

  it("reaches nested objects and arrays, not just the top level", () => {
    const redacted = redactSensitive({
      identity: { username: "ali", credentials: { token: "abc" } },
      attempts: [{ password: "a" }, { password: "b" }],
    }) as { identity: { username: string; credentials: unknown }; attempts: unknown[] };

    expect(redacted.identity.username).toBe("ali");
    expect(redacted.identity.credentials).toBe("[redacted]");
    expect(redacted.attempts).toEqual([{ password: "[redacted]" }, { password: "[redacted]" }]);
  });

  /** A cycle must not hang an audit write. */
  it("stops at a bounded depth", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => redactSensitive(cyclic)).not.toThrow();
  });

  it("leaves ordinary values untouched", () => {
    expect(redactSensitive({ status: "active", count: 3, at: null })).toEqual({
      status: "active",
      count: 3,
      at: null,
    });
  });
});

describe("Audit outcome recording", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/platform/platform-audit.service.ts"),
    "utf8",
  );

  it("defaults to success and requires a reason for anything else", () => {
    expect(source).toContain('const result = input.result ?? "success"');
    expect(source).toContain('result === "success" ? null :');
    expect(source).toContain("must carry a failure reason");
  });

  it("redacts before and after payloads on the way into the table", () => {
    expect(source).toContain("JSON.stringify(redactSensitive(input.before))");
    expect(source).toContain("JSON.stringify(redactSensitive(input.after))");
  });

  it("stamps the originating application", () => {
    expect(source).toContain("'platform-web'");
  });

  /**
   * A failed sign-in must not record WHICH check failed. The service refuses
   * unknown account, wrong password, disabled account and suspended Company
   * identically; naming the cause in a table that audit readers can query would
   * rebuild the enumeration oracle the generic response exists to prevent.
   */
  it("records a failed sign-in without saying why it failed", () => {
    const controller = readFileSync(
      resolve(process.cwd(), "src/platform/platform-auth.controller.ts"),
      "utf8",
    );
    expect(controller).toContain('failureReason: "invalid_credentials"');
    for (const leak of ["account_not_found", "wrong_password", "company_suspended"]) {
      expect(controller).not.toContain(leak);
    }
  });

  /**
   * A refused lifecycle change is an event worth investigating and is invisible
   * if only successes are written. It must be recorded OUTSIDE the operation's
   * transaction, which is about to be rolled back by the exception.
   */
  it("records denied lifecycle transitions outside the failing transaction", () => {
    const service = readFileSync(
      resolve(process.cwd(), "src/platform/platform-company.service.ts"),
      "utf8",
    );
    expect(service).toContain("platform.company.transition_denied");
    expect(service).toContain('result: "denied"');
    // `recordBestEffort` uses the service's own connection, not the transaction.
    const refuse = service.slice(service.indexOf("const refuse = async"));
    expect(refuse.slice(0, 900)).toContain("this.audit.recordBestEffort");
  });
});

describe("Audit browser query", () => {
  const query = readFileSync(
    resolve(process.cwd(), "src/platform/platform-audit.query.ts"),
    "utf8",
  );

  it("filters to the Platform namespace unconditionally", () => {
    // Not a default the caller can widen: `audit_events` also holds Company
    // operational history, which this permission does not grant.
    expect(query).toContain("where e.action like 'platform.%'");
    expect(query).not.toMatch(/query\.includeCompanyActions|allActions/);
  });

  it("escapes wildcards in the caller-supplied action filter", () => {
    expect(query).toContain('replace(/[\\\\%_]/g, "\\\\$&")');
    expect(query).toContain("escape '\\\\'");
  });

  it("pages and counts in the database, not in the API", () => {
    expect(query).toContain("count(*) over () as total");
    expect(query).toContain("limit ${pageSize} offset");
    expect(query).toContain("Math.min(Math.max(Math.trunc(query.pageSize), 1), 100)");
  });

  it("reports zero rather than reading a total that is not there", () => {
    expect(query).toContain("rows.length === 0 ? 0 :");
  });

  it("returns the structured outcome now that the column exists", () => {
    expect(query).toContain("e.result");
    expect(query).toContain('e.failure_reason as "failureReason"');
  });
});
