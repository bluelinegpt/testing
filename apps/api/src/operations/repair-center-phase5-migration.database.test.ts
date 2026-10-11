import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * REPAIR CENTER PHASE 5 PROMPT 2 -- migration certification (matrix 72).
 *
 * The accepted, immutable migrations 20260989000000_accounting_mode_timeline
 * and 20260990000000_platform_repair_payroll are exercised up -> down -> up on
 * the disposable database, INSIDE ONE TRANSACTION THAT IS ALWAYS ROLLED BACK
 * (nothing outlives the test; parallel suites see the original schema).
 *
 * Certified:
 *   - the chain is recorded (both names in kysely_migration);
 *   - 20260990 up: both repair audit tables accept `payroll_period`, every
 *     earlier entity type, and nothing else;
 *   - 20260990 down is forward-only by design: it keeps `payroll_period`
 *     so preserved Payroll repair audit rows stay valid (append-only audit is
 *     never invalidated); up again is idempotent (identical definition);
 *   - 20260989 down restores the previous `accounting_enabled_at` body (an
 *     open-ended ON snapshot without a configuration row reads ON); up again
 *     restores the authoritative rule (reads OFF); signature unchanged.
 */

const disposableName = process.env.BLUELINE_DISPOSABLE_DB_NAME ?? "";
const databaseUrl = process.env.DATABASE_URL ?? "";
const runDatabaseTests =
  process.env.RUN_INTEGRITY_DATABASE === "true" &&
  disposableName.length > 0 &&
  databaseUrl.endsWith(`/${disposableName}`);

interface MigrationModule {
  up(database: Kysely<never>): Promise<void>;
  down(database: Kysely<never>): Promise<void>;
}

async function load(name: string): Promise<MigrationModule> {
  const file = resolve(process.cwd(), `../../database/migrations/${name}.ts`);
  return (await import(pathToFileURL(file).href)) as MigrationModule;
}

class Rollback extends Error {}

describe.skipIf(!runDatabaseTests)("Repair Center Phase 5 Prompt 2 -- migration certification (72)", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it("72: 20260989 + 20260990 -- recorded chain, up / down / up, schema, integrity and behaviour (rolled back)", async () => {
    const timeline = await load("20260989000000_accounting_mode_timeline");
    const payroll = await load("20260990000000_platform_repair_payroll");
    const recorded = (
      await sql<{ name: string }>`select name from kysely_migration
        where name in ('20260989000000_accounting_mode_timeline', '20260990000000_platform_repair_payroll') order by name`.execute(db)
    ).rows.map((row) => row.name);
    expect(recorded).toEqual(["20260989000000_accounting_mode_timeline", "20260990000000_platform_repair_payroll"]);
    const latest = (await sql<{ name: string }>`select max(name) as name from kysely_migration`.execute(db)).rows[0]!.name;
    expect(latest >= "20260990000000_platform_repair_payroll").toBe(true);

    await expect(
      db.transaction().execute(async (tx) => {
        const t = tx as unknown as Kysely<never>;
        const constraints = async () =>
          (
            await sql<{ table: string; def: string }>`select conrelid::regclass::text as table, pg_get_constraintdef(oid) as def
              from pg_constraint where conname in ('platform_repair_executions_entity_type_check', 'platform_repair_attempts_entity_type_check')
              order by 1`.execute(tx)
          ).rows;
        const fnBody = async () =>
          (
            await sql<{ body: string; args: string; volatility: string }>`select prosrc as body, pg_get_function_identity_arguments(oid) as args,
                provolatile as volatility from pg_proc where proname = 'accounting_enabled_at'`.execute(tx)
          ).rows;
        const enabledAt = async (companyId: string) =>
          (
            await sql<{ on: boolean }>`select accounting_enabled_at(${companyId}::uuid, now()) as on`.execute(tx)
          ).rows[0]!.on;

        // Fixture inside the transaction: a Company with ONE open-ended ON snapshot and NO configuration row,
        // and a preserved Payroll repair audit row.
        const companyId = randomUUID();
        const adminId = randomUUID();
        await sql`insert into companies(id, code, subdomain, name_en, status, activated_at)
          values (${companyId}::uuid, ${`MIG-${companyId.slice(0, 8)}`}, ${`mig-${companyId.slice(0, 8)}`}, 'Migration', 'active', now())`.execute(tx);
        await sql`insert into accounts (id, company_id, account_kind, username, password_hash, status)
          values (${adminId}::uuid, null, 'platform_administrator', ${`mig.${adminId}`}, 'x', 'disabled')`.execute(tx);
        await sql`set local session_replication_role = replica`.execute(tx);
        await sql`insert into accounting_configuration_history(company_id, configuration_version, configuration_snapshot, created_at)
          values (${companyId}::uuid, 1, '{"accounting_enabled": true}'::jsonb, now() - interval '1 day')`.execute(tx);
        await sql`set local session_replication_role = origin`.execute(tx);
        const auditId = randomUUID();
        await sql`insert into platform_repair_attempts (id, company_id, entity_type, entity_id, actor_account_id, actor_authority,
            result, error_code, correlation_id)
          values (${auditId}::uuid, ${companyId}::uuid, 'payroll_period', ${randomUUID()}::uuid, ${adminId}::uuid,
                  'platform.companies.repair_center.execute', 'REFUSED', 'repair_preview_stale', 'mig')`.execute(tx);

        // --- Current state (both up) ---------------------------------------------------------
        const upConstraints = await constraints();
        expect(upConstraints).toHaveLength(2);
        for (const row of upConstraints) {
          for (const value of ["order", "trader_receivable", "accounting_event", "payroll_period"]) {
            expect(row.def, row.table).toContain(`'${value}'`);
          }
        }
        const upBody = await fnBody();
        expect(upBody).toHaveLength(1);
        expect(upBody[0]!.args).toBe("target_company_id uuid, at_time timestamp with time zone");
        expect(upBody[0]!.volatility).toBe("s");
        expect(await enabledAt(companyId), "authoritative rule: ON snapshot without a configuration row reads OFF").toBe(false);
        // Integrity: an unknown entity type is refused.
        await sql`savepoint bad_type`.execute(tx);
        await expect(
          sql`insert into platform_repair_attempts (id, company_id, entity_type, entity_id, actor_account_id, actor_authority, result, correlation_id)
            values (${randomUUID()}::uuid, ${companyId}::uuid, 'driver_fee', ${randomUUID()}::uuid, ${adminId}::uuid, 'x', 'REFUSED', 'mig')`.execute(tx),
        ).rejects.toThrow(/entity_type_check/u);
        await sql`rollback to savepoint bad_type`.execute(tx);

        // --- 20260990 down: forward-only (preserved audit rows stay valid) ------------------
        await payroll.down(t);
        expect(await constraints()).toEqual(upConstraints);
        expect((await sql<{ n: number }>`select count(*)::int as n from platform_repair_attempts where id = ${auditId}::uuid`.execute(tx)).rows[0]!.n).toBe(1);
        // --- 20260989 down: the previous function body --------------------------------------
        await timeline.down(t);
        const downBody = await fnBody();
        expect(downBody[0]!.args).toBe(upBody[0]!.args);
        expect(downBody[0]!.body).not.toContain("later.configuration_version");
        expect(await enabledAt(companyId), "previous rule: the last ON snapshot reads ON for ever").toBe(true);
        // --- up again, in chain order ---------------------------------------------------------
        await timeline.up(t);
        expect(await fnBody()).toEqual(upBody);
        expect(await enabledAt(companyId)).toBe(false);
        await payroll.up(t);
        expect(await constraints()).toEqual(upConstraints);
        // Idempotent: up twice changes nothing.
        await payroll.up(t);
        expect(await constraints()).toEqual(upConstraints);
        throw new Rollback("certified; roll everything back");
      }),
    ).rejects.toBeInstanceOf(Rollback);

    // Nothing outlived the transaction.
    const after = (
      await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'platform_repair_attempts_entity_type_check'`.execute(db)
    ).rows[0]!.def;
    expect(after).toContain("'payroll_period'");
    const body = (await sql<{ body: string }>`select prosrc as body from pg_proc where proname = 'accounting_enabled_at'`.execute(db)).rows[0]!.body;
    expect(body).toContain("later.configuration_version");
  });
});
