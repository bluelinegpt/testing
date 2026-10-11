import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEVELOPMENT_RESET_REQUEST,
  disposableEnvironmentRefusal,
  executeForCli,
  normalizeCliRequest,
  previewForCli,
} from "./company-data-reset.cli-support.js";
import { ResetPlanStaleError } from "./company-data-reset.executor.js";
import {
  assertDisposableDatabase,
  CONFIGURATION_TABLES,
  fingerprint,
  MASTER_TABLES,
  type ResetFixture,
  seedResetCompany,
  USER_TABLES,
  WORKFORCE_TABLES,
} from "./company-data-reset.fixture.js";

/**
 * Company Data Reset, Prompt 2 -- CASES 8 and 9: the CLIs execute the SAME
 * plan-based planner + executor. COMMITS on a local DISPOSABLE database only.
 * Enable with RUN_RESET_DATABASE=true.
 */

const runDatabase = process.env.RUN_RESET_DATABASE === "true";

describe.skipIf(!runDatabase)("Company Data Reset CLI -- plan-based execution (disposable, committed)", () => {
  let pool: pg.Pool;
  const count = async (text: string, values: unknown[]) =>
    Number(Object.values((await pool.query<Record<string, string>>(text, values)).rows[0] ?? {})[0] ?? 0);

  async function seed(label: string): Promise<ResetFixture> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const fixture = await seedResetCompany(client, label, { driverHistory: false });
      await client.query("commit");
      return fixture;
    } finally {
      client.release();
    }
  }

  beforeAll(() => {
    assertDisposableDatabase(process.env.DATABASE_URL);
    expect(disposableEnvironmentRefusal("test", process.env.DATABASE_URL)).toBeNull();
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("CASE 9 (in process): db:reset:dev's fixed intent = Full + KEEP_ALL_USERS through the single executor; users / workforce / masters / config / audit kept; fiscal calendar reopened", async () => {
    const a = await seed("CLIA");
    const b = await seed("CLIB");
    await pool.query("update accounting_periods set status = 'closed' where company_id = $1", [a.company]);
    const client = await pool.connect();
    try {
      const kept = [...USER_TABLES, ...WORKFORCE_TABLES, ...MASTER_TABLES, ...CONFIGURATION_TABLES.filter((t) => t !== "accounting_periods"), "platform_repair_executions", "platform_repair_attempts"];
      const before = await fingerprint(client, a.company, kept);
      const bBefore = await fingerprint(client, b.company, [...kept, "orders", "journal_entries", "audit_events", "accounting_periods"]);
      const plan = await previewForCli(client, a.company, DEVELOPMENT_RESET_REQUEST);
      expect(plan).toMatchObject({ effectiveDomains: ["OPERATIONAL", "FINANCIAL"], executable: true, fiscalCalendar: { periodsToOpen: 1 } });
      expect(plan.users.every((user) => !user.remove)).toBe(true);
      const outcome = await executeForCli(client, a.company, DEVELOPMENT_RESET_REQUEST, plan.planVersion, null);
      expect(outcome).toMatchObject({ identitiesDeleted: 0, periodsOpened: 1 });
      expect(await count("select count(*) from orders where company_id = $1", [a.company])).toBe(0);
      expect(await count("select count(*) from journal_entries where company_id = $1", [a.company])).toBe(0);
      expect(await count("select count(*) from accounting_periods where company_id = $1 and status <> 'open'", [a.company])).toBe(0);
      expect(await fingerprint(client, a.company, kept)).toEqual(before);
      expect(
        await count(
          "select count(*) from audit_events where company_id = $1 and action = 'platform.company.data_reset.planned' and source = 'reset_cli' and actor_account_id is null",
          [a.company],
        ),
      ).toBe(1);
      expect(await fingerprint(client, b.company, [...kept, "orders", "journal_entries", "audit_events", "accounting_periods"])).toEqual(bBefore);
    } finally {
      client.release();
    }
  }, 180_000);

  it("CASE 8 (in process): reset:test-data intent FULL + all-eligible (explicit) runs the same executor; protected admin kept", async () => {
    const a = await seed("CLIC");
    const client = await pool.connect();
    try {
      const request = normalizeCliRequest({
        allowUserDeletion: true,
        request: { preset: "FULL_COMPANY_DATA_KEEP_COMPANY", userMode: "DELETE_ALL_ELIGIBLE_USERS" },
      });
      const plan = await previewForCli(client, a.company, request);
      const outcome = await executeForCli(client, a.company, request, plan.planVersion, null);
      expect(outcome.identitiesDeleted).toBeGreaterThan(0);
      expect(await count("select count(*) from accounts where id = $1 and status = 'active'", [a.admin])).toBe(1);
      expect(await count("select count(*) from accounts where id = $1", [a.employeeUser])).toBe(0);
      expect(await count("select count(*) from traders where company_id = $1", [a.company])).toBe(1);
    } finally {
      client.release();
    }
  }, 180_000);

  it("CASE 10 (CLI): a plan made stale after preview is refused; nothing changes", async () => {
    const a = await seed("CLID");
    const client = await pool.connect();
    try {
      const plan = await previewForCli(client, a.company, DEVELOPMENT_RESET_REQUEST);
      await pool.query("update accounts set version = version + 1 where id = $1", [a.ordinaryUser]);
      await expect(executeForCli(client, a.company, DEVELOPMENT_RESET_REQUEST, plan.planVersion, null)).rejects.toBeInstanceOf(ResetPlanStaleError);
      expect(await count("select count(*) from orders where company_id = $1", [a.company])).toBe(1);
    } finally {
      client.release();
    }
  }, 180_000);

  it("CASE 9 (end to end): `db:reset:dev` prints the plan, refuses without --plan-version, executes the exact plan with it", async () => {
    const a = await seed("CLIE");
    const subdomain = (await pool.query<{ subdomain: string }>("select subdomain from companies where id = $1", [a.company])).rows[0]!.subdomain;
    const run = (...args: string[]) =>
      spawnSync("npx", ["tsx", "src/platform/run-development-data-reset.ts", subdomain, ...args], {
        cwd: resolve(process.cwd()),
        encoding: "utf8",
        env: { ...process.env, BLUELINE_DISABLE_DOTENV: "1", NODE_ENV: "development" },
        timeout: 120_000,
      });
    const dry = run();
    expect(dry.status, dry.stderr).toBe(0);
    const version = /planVersion: (crp1:[0-9a-f]{64})/u.exec(dry.stdout)?.[1];
    expect(version).toBeDefined();
    expect(await count("select count(*) from orders where company_id = $1", [a.company])).toBe(1);
    const refused = run("--confirm");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/--plan-version is required/u);
    const executed = run("--confirm", "--plan-version", version!);
    expect(executed.status, executed.stderr).toBe(0);
    expect(await count("select count(*) from orders where company_id = $1", [a.company])).toBe(0);
    expect(await count("select count(*) from accounts where company_id = $1", [a.company])).toBe(5);
  }, 300_000);

  it("CASE 9 guard (end to end): `db:reset:dev` refuses a non-development environment", () => {
    const refused = spawnSync("npx", ["tsx", "src/platform/run-development-data-reset.ts", "anything"], {
      cwd: resolve(process.cwd()),
      encoding: "utf8",
      env: { ...process.env, BLUELINE_DISABLE_DOTENV: "1", NODE_ENV: "production" },
      timeout: 120_000,
    });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/not 'development'/u);
  }, 180_000);
});
