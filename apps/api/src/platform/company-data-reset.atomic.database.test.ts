import pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { normalizeResetRequest, type ResetPlanRequest } from "./company-data-reset.domains.js";
import { executeCompanyDataReset } from "./company-data-reset.executor.js";
import {
  assertDisposableDatabase,
  AUDIT_TABLES,
  CONFIGURATION_TABLES,
  fingerprint,
  MASTER_TABLES,
  seedResetCompany,
  USER_TABLES,
  WORKFORCE_TABLES,
} from "./company-data-reset.fixture.js";
import { buildCompanyDataResetPlan } from "./company-data-reset.planner.js";

/**
 * ATOMIC EXECUTION: a failure at the LAST step (identity deletion), after the
 * table-level removals and the user / Employee / Driver steps already ran,
 * leaves no half-reset Company once the transaction rolls back. Guards are
 * transactional too, so they come back with the rollback.
 */
vi.mock("./platform-user-deletion.service.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  deleteResetCompanyUserAccount: vi.fn(async () => {
    throw new Error("Injected failure while deleting an identity");
  }),
}));

const runDatabase = process.env.RUN_RESET_DATABASE === "true";

describe.skipIf(!runDatabase)("Company Data Reset -- atomic execution (disposable, rolled back)", () => {
  it("a failure after data and user steps rolls everything back: no half-reset Company, guards restored", async () => {
    assertDisposableDatabase(process.env.DATABASE_URL);
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const a = await seedResetCompany(client, "ATOM");
      const tables = [...USER_TABLES, ...WORKFORCE_TABLES, ...MASTER_TABLES, ...CONFIGURATION_TABLES, ...AUDIT_TABLES, "orders", "journal_entries"];
      const before = await fingerprint(client, a.company, tables);
      const request: ResetPlanRequest = { domains: ["OPERATIONAL"], preset: "CUSTOM", userMode: "DELETE_ALL_ELIGIBLE_USERS" };
      const preview = await buildCompanyDataResetPlan(client, a.company, normalizeResetRequest(request));
      expect(preview.executable).toBe(true);
      // The service runs execution as BEGIN ... COMMIT / ROLLBACK; a savepoint models that boundary here.
      await client.query("savepoint reset_execution");
      await expect(executeCompanyDataReset(client, a.company, normalizeResetRequest(request), preview.planVersion)).rejects.toThrow(
        /Injected failure/u,
      );
      await client.query("rollback to savepoint reset_execution");
      expect(await fingerprint(client, a.company, tables)).toEqual(before);
      const disabledGuards = await client.query(
        "select t.tgname from pg_trigger t where not t.tgisinternal and t.tgenabled <> 'O' and t.tgname like any(array['%immutable%', '%append_only%', '%guard%'])",
      );
      expect(disabledGuards.rows).toEqual([]);
    } finally {
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  });
});
