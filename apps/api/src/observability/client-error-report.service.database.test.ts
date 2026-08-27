import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { IdentityContextAccessor } from "../security/identity-context.js";
import type { RequestSecurityContextStore } from "../security/request-security-context.js";

import { ClientErrorReportService } from "./client-error-report.service.js";

/**
 * The centralized Platform Error Handler (System-Wide Error Handler Audit
 * prompt, §56/§58/§59/§73) -- this is the FIRST test file
 * `ClientErrorReportService` has ever had. `api-exception.filter.test.ts`
 * covers the filter's own contract with a mocked service; this file proves
 * what actually lands in `client_error_reports` end to end: redaction,
 * correlation id, tenant context, and the anonymous/authenticated split.
 */
const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const rollback = Symbol("rollback client error report test");
  try {
    await database.transaction().execute(async (transaction) => {
      await work(transaction);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await database.destroy();
  }
}

function buildService(
  transaction: Transaction<DatabaseSchema>,
  identity?: { readonly companyId: string | null; readonly identityId: string; readonly kind: string },
): ClientErrorReportService {
  const identityAccessor = {
    current: () => {
      throw new Error("not used by report paths");
    },
  } as unknown as IdentityContextAccessor;
  const securityContext = {
    current: () => {
      if (identity === undefined) throw new Error("no session");
      return {
        identity: {
          companyId: identity.companyId,
          identityId: identity.identityId,
          kind: identity.kind,
        },
      };
    },
  } as unknown as RequestSecurityContextStore;
  return new ClientErrorReportService(
    transaction as unknown as Kysely<DatabaseSchema>,
    identityAccessor,
    securityContext,
  );
}

async function seedCompany(transaction: Transaction<DatabaseSchema>) {
  const companyId = randomUUID();
  await sql`insert into companies(id, code, subdomain, name_en, status, activated_at)
    values(${companyId}::uuid, ${`ERR-${companyId.slice(0, 8)}`}, ${`err-${companyId.slice(0, 8)}`},
           'Error Report Test', 'active', now())`.execute(transaction);
  return companyId;
}

async function readReport(transaction: Transaction<DatabaseSchema>, id: string) {
  const result = await sql<{
    companyId: string | null;
    correlationId: string | null;
    message: string;
    path: string | null;
    severity: string;
    sourceApp: string;
    stack: string | null;
    status: string;
    accountId: string | null;
    accountKind: string | null;
  }>`
    select company_id as "companyId", correlation_id as "correlationId", message, path,
           severity, source_app as "sourceApp", stack, status,
           account_id as "accountId", account_kind as "accountKind"
      from client_error_reports where id = ${id}::uuid
  `.execute(transaction);
  return result.rows[0]!;
}

describe.skipIf(!runDatabaseTests)("Client error report capture", () => {
  it("stores an anonymous public report with no identity attached", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const service = buildService(transaction); // no session at all
      const { id } = await service.reportFromRequest({
        appCommit: "abc1234",
        correlationId: "corr-anon-1",
        message: "TypeError: Cannot read properties of undefined (reading 'slug')",
        path: "/en/ajman-store/products/embroidered-abaya",
        sourceApp: "store",
        stack: "TypeError: ...\n  at ProductPage",
      } as never);

      const row = await readReport(transaction, id);
      expect(row.sourceApp).toBe("store");
      expect(row.severity).toBe("high");
      expect(row.status).toBe("open");
      expect(row.companyId).toBeNull();
      expect(row.accountId).toBeNull();
      expect(row.correlationId).toBe("corr-anon-1");
    });
  });

  it("stores a public-web report (Error Handler follow-up: this source app used to be rejected)", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const service = buildService(transaction);
      const { id } = await service.reportFromRequest({
        appCommit: "def5678",
        message: "Uncaught client error",
        path: "/pricing",
        sourceApp: "public-web",
        stack: "TypeError: ...\n  at Pricing",
      } as never);

      const row = await readReport(transaction, id);
      expect(row.sourceApp).toBe("public-web");
      expect(row.companyId).toBeNull();
      expect(row.accountId).toBeNull();
    });
  });

  it("stores an authenticated report with the caller's Company and identity attached", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const companyId = await seedCompany(transaction);
      const accountId = randomUUID();
      const service = buildService(transaction, { companyId, identityId: accountId, kind: "trader" });

      const { id } = await service.reportFromRequest({
        correlationId: "corr-auth-1",
        message: "Failed to load Trader Orders",
        sourceApp: "web",
      } as never);

      const row = await readReport(transaction, id);
      expect(row.companyId).toBe(companyId);
      expect(row.accountId).toBe(accountId);
      expect(row.accountKind).toBe("trader");
    });
  });

  it("redacts a secret embedded in the message and stack before the row is ever written", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const service = buildService(transaction);
      const { id } = await service.reportFromRequest({
        message: "Login retry failed with password: hunter2",
        sourceApp: "web",
        stack: "Error: request failed\nheaders: { authorization: 'Bearer supersecrettoken' }",
      } as never);

      const row = await readReport(transaction, id);
      expect(row.message).not.toContain("hunter2");
      expect(row.message).toContain("[redacted]");
      expect(row.stack).not.toContain("supersecrettoken");
      expect(row.stack).toContain("[redacted]");
    });
  });

  it("captures a backend 500 via reportServerError with the real (unsanitized-for-client) message", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const companyId = await seedCompany(transaction);
      const accountId = randomUUID();
      const service = buildService(transaction);

      await service.reportServerError({
        correlationId: "corr-500-1",
        identity: { companyId, identityId: accountId, kind: "company_user" } as never,
        message: "connect ECONNREFUSED 127.0.0.1:5432",
        path: "/orders",
        stack: null,
      });

      const rows = await sql<{ id: string; message: string; sourceApp: string }>`
        select id, message, source_app as "sourceApp" from client_error_reports
         where correlation_id = 'corr-500-1'
      `.execute(transaction);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.sourceApp).toBe("api");
      expect(rows.rows[0]?.message).toContain("ECONNREFUSED");
    });
  });

  it("never throws when the underlying insert fails -- a broken capture cannot become a second failure", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const service = buildService(transaction);
      // A blank message violates `client_error_reports`'s own
      // `btrim(message) <> ''` CHECK constraint, so the insert itself fails --
      // `reportServerError` must swallow that, not propagate it (§35).
      await expect(
        service.reportServerError({
          correlationId: "corr-recursion-1",
          identity: undefined,
          message: "   ",
          path: null,
          stack: null,
        }),
      ).resolves.toBeUndefined();
    });
  });
});
