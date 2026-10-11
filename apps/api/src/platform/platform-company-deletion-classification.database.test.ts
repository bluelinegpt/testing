import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ConfigService } from "@nestjs/config";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { configuration, type AppConfiguration } from "../configuration/environment.js";
import { FileStoragePort } from "../files/file-storage.port.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import {
  PlatformCompanyDeletionBackupService,
  runBackupProcess,
} from "./platform-company-deletion-backup.service.js";
import { PlatformCompanyDeletionExecutionService } from "./platform-company-deletion-execution.service.js";
import { COMPANY_DELETION_DIRECT_TABLES } from "./platform-company-deletion.manifest.js";
import { PlatformCompanyDeletionService } from "./platform-company-deletion.service.js";

/**
 * 2026-10-05 -- permanent Company deletion against the CURRENT schema.
 *
 * The deletion preview crashed with "column company_id does not exist" (it
 * counted `platform_workflow_test_steps`, which has no `company_id`), and once
 * past that it would have blocked on `destination_countries` (unclassified) and
 * on the Repair Center audit's append-only triggers (unapproved guards).
 *
 * This proves, on a disposable database at the latest migration:
 *  - the direct-table manifest equals the live `company_id` table inventory;
 *  - a closed Development Company holding Repair Center audit, a Destination
 *    Country and a workflow-test run/scenario/step previews with no blockers
 *    and deletes completely, leaving another Company's rows untouched.
 */

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
const enabled = process.env.RUN_COMPANY_DELETION_DATABASE === "true";

class EmptyStorage extends FileStoragePort {
  public async storePrivate(): Promise<{ storageKey: string }> { throw new Error("unused"); }
  public async readPrivate(): Promise<Uint8Array> { throw new Error("unused"); }
  public async deletePrivate(): Promise<void> {}
  public async storeCommerce(): Promise<{ storageKey: string }> { throw new Error("unused"); }
  public async readCommerce(): Promise<Uint8Array> { throw new Error("unused"); }
  public async deleteCommerce(): Promise<void> {}
}

async function seed(database: Kysely<DatabaseSchema>, companyId: string, actorId: string, closed: boolean) {
  const short = companyId.slice(0, 8);
  const code = `DEV-CLS-${short.toUpperCase()}`;
  await sql`insert into companies(id,code,subdomain,name_en,status,environment,closed_at)
    values(${companyId}::uuid,${code},${`dev-cls-${short}`},'Deletion classification fixture',
           ${closed ? "closed" : "active"},'development',${closed ? sql`now()` : sql`null`})`.execute(database);
  await sql`insert into destination_countries(company_id,name,normalized_name)
    values(${companyId}::uuid,'Oman','oman')`.execute(database);
  const execution = randomUUID();
  await sql`insert into platform_repair_executions(
      id,company_id,entity_type,entity_id,entity_number,finding_id,reason_code,capability_code,preview_version,
      actor_account_id,actor_authority,reason,before_state_fingerprint,after_state_fingerprint,before_health,after_health,
      before_classification,after_classification,result,idempotency_key,request_hash)
    values(${execution}::uuid,${companyId}::uuid,'order',${randomUUID()}::uuid,'ORD-000001','f1','r1','REPAIR_TRADER_RECEIVABLE','v1',
      ${actorId}::uuid,'platform_super_admin','fixture','a','b','ISSUE','HEALTHY','X','Y','succeeded',${`fixture-key-${randomUUID()}`},'h')`.execute(database);
  await sql`insert into platform_repair_attempts(company_id,entity_type,entity_id,actor_account_id,actor_authority,result,repair_execution_id)
    values(${companyId}::uuid,'order',${randomUUID()}::uuid,${actorId}::uuid,'platform_super_admin','REPLAYED',${execution}::uuid)`.execute(database);
  await sql`insert into platform_repair_attempts(company_id,entity_type,entity_id,actor_account_id,actor_authority,result)
    values(${companyId}::uuid,'payroll_period',${randomUUID()}::uuid,${actorId}::uuid,'platform_super_admin','REFUSED')`.execute(database);
  const run = randomUUID();
  const scenario = randomUUID();
  await sql`insert into platform_workflow_test_runs(id,company_id,mode,orders_per_day,duration_days,concurrency,side_effects_suppressed,created_by_account_id)
    values(${run}::uuid,${companyId}::uuid,'smoke',1,1,1,true,${actorId}::uuid)`.execute(database);
  await sql`insert into platform_workflow_test_scenarios(id,run_id,company_id,channel,outcome,language,viewport)
    values(${scenario}::uuid,${run}::uuid,${companyId}::uuid,'portal','delivered','en','desktop')`.execute(database);
  await sql`insert into platform_workflow_test_steps(id,scenario_id,step_key,status)
    values(${randomUUID()}::uuid,${scenario}::uuid,'create_order','passed')`.execute(database);
  return { code, scenario };
}

const fingerprint = async (database: Kysely<DatabaseSchema>, companyId: string) =>
  (
    await sql<Record<string, string>>`select
      (select count(*)::text from destination_countries where company_id=${companyId}::uuid) as countries,
      (select count(*)::text from platform_repair_executions where company_id=${companyId}::uuid) as executions,
      (select count(*)::text from platform_repair_attempts where company_id=${companyId}::uuid) as attempts,
      (select count(*)::text from platform_workflow_test_runs where company_id=${companyId}::uuid) as runs,
      (select count(*)::text from platform_workflow_test_steps s join platform_workflow_test_scenarios c on c.id=s.scenario_id
        where c.company_id=${companyId}::uuid) as steps`.execute(database)
  ).rows[0]!;

describe.skipIf(!enabled)("permanent Company deletion -- live-schema classification", () => {
  it("the direct-table manifest equals every live company_id table", async () => {
    const pool = new pg.Pool({ connectionString: configuration().database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    try {
      const live = (
        await sql<{ t: string }>`select table_name as t from information_schema.columns
          where table_schema='public' and column_name='company_id' order by 1`.execute(database)
      ).rows.map((row) => row.t);
      expect([...COMPANY_DELETION_DIRECT_TABLES].sort()).toEqual(live);
    } finally {
      await database.destroy();
    }
  });

  it("previews with no blockers and deletes Repair audit, Destination Countries and workflow tests; another Company is untouched", async () => {
    const settings = configuration();
    const pool = new pg.Pool({ connectionString: settings.database.url, max: 2 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const target = randomUUID();
    const other = randomUUID();
    const operationKey = randomUUID();
    try {
      const actor = (await sql<{ id: string }>`select id from accounts where company_id is null order by created_at limit 1`.execute(database)).rows[0]!;
      const { code } = await seed(database, target, actor.id, true);
      await seed(database, other, actor.id, false);
      const otherBefore = await fingerprint(database, other);
      expect(await fingerprint(database, target)).toEqual({ countries: "1", executions: "1", attempts: "2", runs: "1", steps: "1" });

      const preview = await new PlatformCompanyDeletionService(database).preview(
        target,
        { accountId: actor.id, correlationId: randomUUID() },
        operationKey,
      );
      expect(preview.blockers).toEqual([]);

      const configService = new ConfigService<AppConfiguration, true>(settings);
      const backup = await new PlatformCompanyDeletionBackupService(database, configService, runBackupProcess)
        .createVerifiedBackup(target, String(preview.operationId), actor.id);
      expect(backup.status).toBe("verified");
      const result = await new PlatformCompanyDeletionExecutionService(database, configService, new EmptyStorage(), () => undefined)
        .execute(target, {
          operationId: String(preview.operationId),
          previewId: String(preview.previewId),
          confirmation: `DELETE ${code}`,
          idempotencyKey: operationKey,
        });
      expect(result.state).toBe("completed");

      expect((await sql`select 1 from companies where id=${target}::uuid`.execute(database)).rows).toHaveLength(0);
      expect(await fingerprint(database, target)).toEqual({ countries: "0", executions: "0", attempts: "0", runs: "0", steps: "0" });
      expect(await fingerprint(database, other)).toEqual(otherBefore);
      // The append-only guards are restored after the deletion transaction.
      await expect(sql`delete from platform_repair_attempts where company_id=${other}::uuid`.execute(database)).rejects.toThrow();
    } finally {
      await database.destroy();
    }
  }, 360_000);
});
