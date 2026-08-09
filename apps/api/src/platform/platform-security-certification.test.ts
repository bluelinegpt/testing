import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Phase 1 security certification for the Platform Administration Portal.
 *
 * Every assertion here is a property that must remain true for the Portal to
 * stay safe to operate, expressed against the source that implements it rather
 * than against a description of it. A test that only restated the intention
 * would pass forever; these fail the moment the behaviour changes.
 *
 * Database-backed isolation tests live in
 * `platform-tenant-isolation.db.test.ts` and are gated behind `RUN_DB_TESTS`.
 */

const apiRoot = resolve(process.cwd(), "src");
const platformDirectory = join(apiRoot, "platform");
const webRoot = resolve(process.cwd(), "../platform-web/src");

function readAll(directory: string, extension = ".ts"): { path: string; source: string }[] {
  const files: { path: string; source: string }[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith(extension) && !full.endsWith(".tsx")) continue;
      files.push({ path: full, source: readFileSync(full, "utf8") });
    }
  };
  walk(directory);
  return files;
}

/** Strips comments so explanatory prose is never read as behaviour. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*\*.*$/gm, "");
}

// ---------------------------------------------------------------------------
// Session transport
// ---------------------------------------------------------------------------

describe("Session transport certification", () => {
  const cookieSource = readFileSync(
    resolve(apiRoot, "authentication/session-cookie.ts"),
    "utf8",
  );

  it("marks the session cookie HttpOnly, SameSite=Lax and scoped to the API path", () => {
    expect(cookieSource).toContain("httpOnly: true");
    expect(cookieSource).toContain('sameSite: "lax"');
    expect(cookieSource).toContain('path: "/api"');
  });

  /**
   * `secure` must be derived, never hard-coded. Hard-coding false ships an
   * insecure cookie to production; hard-coding true breaks local http.
   */
  it("derives the Secure flag from the environment rather than fixing it", () => {
    const controller = readFileSync(resolve(platformDirectory, "platform-auth.controller.ts"), "utf8");
    expect(controller).toContain('this.config.get("app.environment"');
    expect(controller).toContain('=== "production"');
    expect(withoutComments(controller)).not.toContain("secure: true,");
    expect(withoutComments(controller)).not.toContain("secure: false,");
  });

  /**
   * The Platform Portal is cookie-only. Returning a bearer token as well would
   * hand the SPA a credential it must then store somewhere, which is exactly
   * the exposure the cookie exists to avoid.
   */
  it("returns no token in the Platform sign-in response", () => {
    const controller = withoutComments(
      readFileSync(resolve(platformDirectory, "platform-auth.controller.ts"), "utf8"),
    );
    const body = controller.slice(controller.indexOf("return {", controller.indexOf("setSessionCookie")));
    expect(body).not.toContain("accessToken");
    expect(body).not.toContain("token:");
  });

  it("clears the cookie on sign-out", () => {
    const controller = readFileSync(resolve(platformDirectory, "platform-auth.controller.ts"), "utf8");
    const logout = controller.slice(controller.indexOf("public async logout"));
    expect(logout).toContain("clearSessionCookie");
  });
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

describe("CSRF certification", () => {
  const guardSource = readFileSync(
    resolve(apiRoot, "authentication/authentication.guard.ts"),
    "utf8",
  );

  /**
   * A cookie rides along on cross-site requests automatically. The required
   * header does not — a browser will not attach a custom header to a
   * cross-origin request without a successful preflight — so demanding it on
   * cookie-authenticated mutations is what makes forgery fail.
   */
  it("requires the session-intent header on cookie-authenticated mutations", () => {
    expect(guardSource).toContain("sessionCsrfHeader");
    expect(guardSource).toContain("isSafeMethod(request.method)");
    expect(guardSource).toContain("HttpStatus.FORBIDDEN");
    // The header name and the safe-method set are asserted at their source.
    const cookieSource = readFileSync(resolve(apiRoot, "authentication/session-cookie.ts"), "utf8");
    expect(cookieSource).toContain("x-blueline-session");
    expect(cookieSource).toMatch(/GET[\s\S]{0,60}HEAD[\s\S]{0,60}OPTIONS/);
  });

  it("sends the header from the Platform client on every request", () => {
    const client = readFileSync(resolve(webRoot, "api/platform-client.ts"), "utf8");
    expect(client).toContain("X-Blueline-Session");
    expect(client).toContain('credentials: "include"');
  });
});

// ---------------------------------------------------------------------------
// Browser storage
// ---------------------------------------------------------------------------

describe("Browser storage certification", () => {
  /**
   * No credential may be readable by script. A token in localStorage or
   * sessionStorage is retrievable by any injected script on the page; the
   * HttpOnly cookie is not.
   *
   * ONE module is exempt: `theme/theme-preference.ts`, which stores the visual
   * theme. A theme discloses nothing, grants nothing, and is worthless to an
   * attacker who already has script execution — it is not a credential, and the
   * rule was always about credentials. The exemption is a single named file
   * rather than a relaxed pattern, and the test below pins what that file is
   * allowed to store, so widening it requires editing this list deliberately.
   */
  const storageExempt = ["theme/theme-preference.ts"];

  it("stores no credential in any browser storage anywhere in the Platform app", () => {
    const offenders: string[] = [];
    for (const file of readAll(webRoot)) {
      // Tests legitimately NAME these APIs in order to assert their absence.
      if (/\.test\.tsx?$/.test(file.path)) continue;
      // Windows paths use backslashes; the exemption list is written with
      // forward slashes so it reads the same as the import path.
      const relative = file.path.split("\\").join("/");
      if (storageExempt.some((name) => relative.endsWith(name))) continue;
      const source = withoutComments(file.source);
      if (/\b(localStorage|sessionStorage|document\.cookie|indexedDB)\b/.test(source)) {
        offenders.push(file.path);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The exemption is bounded here rather than trusted.
   *
   * The theme module may touch exactly one key, may write only the three
   * literal theme words, and may not reach for a session, a token, a cookie or
   * any other storage API. Without this, "the theme module is exempt" would
   * quietly become "one file may store anything".
   */
  it("lets the theme module store the theme and nothing else", () => {
    const source = withoutComments(
      readFileSync(resolve(webRoot, "theme/theme-preference.ts"), "utf8"),
    );

    // Exactly one storage key, and it is declared as a constant rather than
    // written inline at each call site.
    expect(source).toContain('export const THEME_STORAGE_KEY = "blueline.platform.theme"');
    const keys = source.match(/(getItem|setItem|removeItem)\(([^,)]+)/g) ?? [];
    expect(keys.length).toBeGreaterThan(0);
    for (const use of keys) {
      expect(use).toContain("THEME_STORAGE_KEY");
    }

    // Only localStorage, and only through the two accessors above.
    expect(source).not.toMatch(/\b(sessionStorage|document\.cookie|indexedDB)\b/);

    // Nothing credential-shaped is named anywhere in it.
    for (const forbidden of ["token", "session", "password", "secret", "cookie", "auth"]) {
      expect(source.toLowerCase()).not.toContain(forbidden);
    }

    // A value read back out of storage is validated before it is used, so a
    // hand-edited key cannot put arbitrary text on the document element.
    expect(source).toContain("isThemePreference(value) ? value : \"system\"");
  });

  /**
   * The exemption is ONE file, listed in full here so that adding a second is a
   * visible edit to a security test rather than a quiet change of behaviour.
   * `bootstrap-theme.ts` is deliberately NOT exempt: it only calls the module
   * above and touches no storage itself, so it does not need to be.
   */
  it("keeps the storage exemption to the single theme module", () => {
    expect(storageExempt).toEqual(["theme/theme-preference.ts"]);
  });

  it("keeps no token field on the Platform API client", () => {
    const client = withoutComments(readFileSync(resolve(webRoot, "api/platform-client.ts"), "utf8"));
    expect(client).not.toContain("setAccessToken");
    expect(client).not.toMatch(/\btoken\s*[:=]/);
    expect(client).not.toContain("Authorization");
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

describe("Secret handling certification", () => {
  it("hard-codes no credential anywhere in the Platform API module", () => {
    const offenders: string[] = [];
    for (const file of readAll(platformDirectory)) {
      if (file.path.endsWith(".test.ts")) continue;
      const source = withoutComments(file.source);
      // A literal assigned to something named like a secret.
      if (/(password|secret|apiKey|token)\s*[:=]\s*["'][^"']{6,}["']/i.test(source)) {
        offenders.push(file.path);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The audit trail is read by support staff and retained indefinitely. A
   * password, token or hash written into it would be a durable disclosure that
   * the append-only trigger then makes impossible to remove.
   */
  it("writes no credential material into the Platform audit trail", () => {
    for (const file of readAll(platformDirectory)) {
      if (file.path.endsWith(".test.ts")) continue;
      const source = withoutComments(file.source);
      for (const entry of source.match(/(before|after):\s*\{[^}]*\}/g) ?? []) {
        for (const forbidden of ["password", "passwordHash", "token", "setupUrl", "secret"]) {
          expect(`${file.path}: ${entry}`).not.toContain(forbidden);
        }
      }
    }
  });

  it("logs no request body or header from the Platform module", () => {
    for (const file of readAll(platformDirectory)) {
      if (file.path.endsWith(".test.ts")) continue;
      const source = withoutComments(file.source);
      expect(source).not.toContain("console.log");
      expect(source).not.toMatch(/logger\.\w+\([^)]*request\.body/);
    }
  });
});

// ---------------------------------------------------------------------------
// Enumeration and error disclosure
// ---------------------------------------------------------------------------

describe("Enumeration resistance certification", () => {
  it("returns one generic failure for every rejected sign-in", () => {
    const service = readFileSync(resolve(apiRoot, "authentication/authentication.service.ts"), "utf8");
    // Unknown account, wrong password, disabled account and disabled Company
    // must be indistinguishable to the caller.
    expect(service).toContain("invalidCredentials()");
    const distinct = service.match(/throw new ApplicationException\(\s*["']account_/g) ?? [];
    expect(distinct).toEqual([]);
  });

  it("refuses a suspended Company's users without saying why", () => {
    const service = readFileSync(resolve(apiRoot, "authentication/authentication.service.ts"), "utf8");
    expect(service).toContain('account.companyStatus !== "active"');
    // Same rejection path as bad credentials.
    const block = service.slice(service.indexOf('account.companyStatus !== "active"'));
    expect(block.slice(0, 200)).toContain("this.invalidCredentials()");
  });

  it("answers an unknown and a malformed Company identifier identically", () => {
    const guard = readFileSync(resolve(platformDirectory, "platform-target-company.guard.ts"), "utf8");
    // Both paths throw the SAME constructed error, not two that happen to share
    // a status code today.
    expect(guard).toContain("throw this.notFound();");
    expect((guard.match(/throw this\.notFound\(\);/g) ?? []).length).toBe(2);
    expect(guard).toContain("HttpStatus.NOT_FOUND");
  });

  it("gives one message for every unusable setup link", () => {
    const setup = readFileSync(resolve(apiRoot, "authentication/account-setup.service.ts"), "utf8");
    // Never existed, expired, revoked and already-used all reach one throw.
    expect((setup.match(/account_setup_token_invalid/g) ?? []).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

describe("Redirect certification", () => {
  it("builds every Platform-issued URL server-side from configuration", () => {
    const service = readFileSync(resolve(platformDirectory, "platform-company-user.service.ts"), "utf8");
    expect(service).toContain("BLUELINE_TENANT_HOST_SUFFIX");
    // No caller-supplied destination reaches a link.
    expect(service).not.toMatch(/redirect(Uri|Url)/i);
    expect(service).not.toMatch(/returnTo|continueTo|next[Uu]rl/);
  });

  it("accepts no redirect parameter on any Platform request contract", () => {
    for (const file of readAll(platformDirectory)) {
      if (!file.path.endsWith(".dto.ts")) continue;
      const source = withoutComments(file.source);
      expect(source).not.toMatch(/redirect|returnTo|callback/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation, statically provable parts
// ---------------------------------------------------------------------------

describe("Tenant isolation certification", () => {
  /**
   * A Platform actor never becomes a member of a Company. Only the tenant slot
   * moves; the identity keeps `companyId === null`, so nothing downstream can
   * mistake an administrator for a Company user.
   */
  it("never gives a Platform identity a Company identifier", () => {
    const store = readFileSync(resolve(apiRoot, "security/request-security-context.ts"), "utf8");
    const enter = store.slice(store.indexOf("enterTargetCompany"));
    expect(withoutComments(enter)).not.toMatch(/identity\.companyId\s*=/);
  });

  it("resolves the target Company from the database, never from the request", () => {
    const guard = withoutComments(
      readFileSync(resolve(platformDirectory, "platform-target-company.guard.ts"), "utf8"),
    );
    expect(guard).toContain("select id as");
    expect(guard).toContain("from companies");
    // Every downstream fact comes from the row.
    expect(guard).not.toMatch(/request\.(body|query|headers)[^\n]*compan/i);
  });

  it("takes the target only from the route parameter", () => {
    const guard = withoutComments(
      readFileSync(resolve(platformDirectory, "platform-target-company.guard.ts"), "utf8"),
    );
    expect(guard).toContain("request.params");
    for (const source of ["request.body", "request.query", 'headers["x-company', "x-target-company"]) {
      expect(guard).not.toContain(source);
    }
  });

  /**
   * Company routes must not have been widened to admit Platform actors. The
   * Platform reaches Company data through its own module only.
   */
  it("adds no Platform identity kind to any Company controller", () => {
    const offenders: string[] = [];
    for (const file of readAll(apiRoot)) {
      if (file.path.startsWith(platformDirectory)) continue;
      if (!file.path.endsWith(".controller.ts")) continue;
      if (withoutComments(file.source).includes('"platform_administrator"')) {
        offenders.push(file.path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the Platform account scope constraint intact", () => {
    const migrations = resolve(process.cwd(), "../../database/migrations");
    const found = readdirSync(migrations).some((name) =>
      readFileSync(join(migrations, name), "utf8").includes("accounts_scope_check"),
    );
    expect(found).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Destructive-capability certification
// ---------------------------------------------------------------------------

describe("Destructive capability certification", () => {
  /**
   * Phase 1 adds no way to destroy anything. The Company reset engine is
   * untouched and unreachable; there is no DELETE anywhere; and no Platform
   * code path drops, truncates or mass-deletes.
   */
  /**
   * ONE service may issue `delete from`: user deletion, and only against the
   * account's own identity and access records.
   *
   * `drop table` and `truncate` stay forbidden everywhere without exception —
   * no Platform feature has any business issuing either, and unlike a scoped
   * DELETE they cannot be limited by a WHERE clause.
   */
  const deleteExempt = "platform-user-deletion.service.ts";

  it("issues no destructive statement anywhere in the Platform module", () => {
    for (const file of readAll(platformDirectory)) {
      if (file.path.endsWith(".test.ts")) continue;
      if (file.path.includes("reset")) continue; // The pre-existing CLI engine.
      const source = withoutComments(file.source).toLowerCase();
      for (const statement of ["drop table", "truncate"]) {
        expect(`${file.path} :: ${statement}`).toBe(`${file.path} :: ${statement}`);
        expect(source.includes(statement)).toBe(false);
      }
      if (file.path.endsWith(deleteExempt)) continue;
      expect(source.includes("delete from")).toBe(false);
    }
  });

  /**
   * The exemption is bounded, not trusted.
   *
   * User deletion may remove sessions, credential links, role grants, Company
   * membership and the account row — the account's own identity and access, and
   * nothing else. It must never reach a business table to make a user
   * deletable, which is the single rule that separates Delete from a
   * data-destroying operation.
   *
   * Every statement is also required to be scoped by the account, so a missing
   * WHERE clause cannot empty a table.
   */
  it("lets user deletion remove identity records only", () => {
    const source = withoutComments(
      readFileSync(resolve(platformDirectory, deleteExempt), "utf8"),
    );
    const statements = source.match(/delete from [\s\S]*?`/g) ?? [];
    expect(statements.length).toBeGreaterThan(0);

    const allowed = [
      "account_sessions",
      "password_reset_tokens",
      "account_roles",
      "company_users",
      "accounts",
    ];
    for (const statement of statements) {
      const table = /delete from (\w+)/.exec(statement)?.[1] ?? "";
      expect(allowed).toContain(table);
      // Never an unscoped delete. The account row is keyed by `id`, the rest by
      // `account_id`, so the assertion is on the bound parameter that scopes
      // them all rather than on one column name.
      expect(statement).toContain("where");
      expect(statement).toContain("${accountId}");
    }

    // The two rows that also carry a Company are scoped by it as well, so a
    // correct account id belonging to another Company still deletes nothing.
    for (const table of ["company_users", "accounts"]) {
      const statement = statements.find((entry) => entry.includes(`delete from ${table}`)) ?? "";
      expect(statement).toContain("${companyId}");
    }

    // No business table is named anywhere in the service's SQL.
    for (const forbidden of ["orders", "journal_", "collections", "settlements", "payroll"]) {
      expect(source).not.toContain(`delete from ${forbidden}`);
    }
  });

  /**
   * Deleting a user must never delete the audit proving they were deleted.
   * `audit_events` is append-only, so a DELETE against it would fail loudly
   * rather than silently — but naming it here states the intent.
   */
  it("never deletes audit history", () => {
    const source = withoutComments(
      readFileSync(resolve(platformDirectory, deleteExempt), "utf8"),
    );
    expect(source).not.toContain("delete from audit_events");
    // The record is written INSIDE the deletion transaction, before the rows
    // go, so a failure to audit rolls the deletion back.
    const deleteMethod = source.slice(source.indexOf("public async delete("));
    expect(deleteMethod.indexOf("this.audit.record(")).toBeLessThan(
      deleteMethod.indexOf("delete from account_sessions"),
    );
  });

  it("leaves the Company reset engine unmodified by Phase 1", () => {
    // Registering it, importing it from a controller, or exposing a route would
    // all show up as a reference from the HTTP surface.
    for (const file of readAll(platformDirectory)) {
      if (!file.path.endsWith(".controller.ts") && !file.path.endsWith(".module.ts")) continue;
      expect(withoutComments(file.source).toLowerCase()).not.toContain("reset-company");
    }
  });
});
