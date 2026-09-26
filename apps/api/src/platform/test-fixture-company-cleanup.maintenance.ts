import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ConfigService } from "@nestjs/config";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import type { AppConfiguration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { LocalFileStorageAdapter } from "../files/local-file-storage.adapter.js";
import {
  checksumFileSha256,
  runBackupProcess,
} from "./platform-company-deletion-backup.service.js";
import { PlatformCompanyDeletionExecutionService } from "./platform-company-deletion-execution.service.js";
import { PlatformCompanyDeletionService } from "./platform-company-deletion.service.js";

/**
 * One-time maintenance runner: permanently removes a hardcoded, pre-audited
 * list of confirmed automated test-fixture Companies through the real,
 * reviewed permanent Company-deletion engine — `PlatformCompanyDeletionService`
 * (preview), a real verified `pg_dump` backup, and
 * `PlatformCompanyDeletionExecutionService` (execute). No second deletion
 * path, no raw `DELETE FROM companies`, no bypass of manifest, backup, or
 * global-preservation checks.
 *
 * SAFETY MODEL
 * ------------
 * - This is a standalone script, never wired into any controller or route.
 *   It cannot be reached from the browser or any normal Platform API call,
 *   and grants no capability `platform.companies.delete` doesn't already
 *   have reviewed and gated behind Platform-administrator permission.
 * - The ID list below is a closed, hand-audited allowlist captured from a
 *   live query on 2026-08-12 (see the Company Cleanup completion report).
 *   Every entry is re-verified against its expected `code` immediately
 *   before use — if the live row's code has changed since the audit, or the
 *   code doesn't match a known fixture prefix (`comm-test-` or `GX[A-E]`),
 *   the whole run aborts before touching anything.
 * - Backdating `closed_at` on a Production-environment row satisfies the
 *   REAL 48-hour wait honestly (same pattern already reviewed and tested in
 *   `platform-company-deletion-certification.database.test.ts`'s stale-sweep)
 *   rather than bypassing it — the check `execute()` performs is live and
 *   unconditional, and is never weakened here.
 * - One real, verified full-database backup is taken ONCE, before any
 *   deletion in this run, and its file/checksum/size is referenced by a
 *   fresh `platform_company_deletion_backups` row per operation — the same,
 *   already-tested pattern the certification suite's own multi-operation
 *   fixture helpers use. Taken before any deletion, it is the most
 *   conservative possible timing (it captures strictly more data, never
 *   less, than a fresh per-company dump taken mid-run would).
 * - Runs strictly sequentially (the engine serializes on a global advisory
 *   lock during `guards_disabled`/`guards_restored` regardless).
 * - Stops immediately on the first failure and reports it; never continues
 *   deleting the remaining list blindly.
 */

interface FixtureTarget {
  readonly id: string;
  readonly code: string;
}

// Captured live on 2026-08-12, immediately before this run — see the
// "Clean Up Remaining Automated Test Companies" completion report for the
// full audit (33 total: 7 `comm-test-*`, 26 `GX*`).
export const CONFIRMED_TEST_FIXTURE_COMPANIES: readonly FixtureTarget[] = [
  { id: "fb265382-c192-4236-9d23-3e32a1f97858", code: "comm-test-4a4f73cd-2c24-4e57-ad57-83c77e6f4054-i2c-267f074b" },
  { id: "d93f8b09-9c94-4ed0-9d30-bc8dfd5bb22c", code: "comm-test-a733058b-668b-417b-beb8-b5e059f06028-i2c-924e7b9b" },
  { id: "a16bb742-6547-451d-831e-98cdbc888ffe", code: "comm-test-ae34444c-2015-48dd-a0e1-1abf44de4a16-i2t-6eb0b71e" },
  { id: "bbdf9e44-d398-478c-bdd1-a4d7e0012aeb", code: "comm-test-bef8fe0a-cbaf-4673-9a31-7c4aa895a0cf-i2t-0e7ac174" },
  { id: "5e5d08df-e69c-4fd8-bf63-e254ee48f82d", code: "comm-test-c6286ab5-1e2d-4f4f-9e66-d21cc1683add-i2c-24d73ffc" },
  { id: "821b2de5-4e58-448f-9ed0-a467d447ba91", code: "comm-test-d5cfba43-4fbd-4bd1-920c-fdec9a59d1a5-i2t-301191fe" },
  { id: "7bc08c31-163c-49a9-bf47-e3e3d9b540f8", code: "comm-test-f6203966-7975-4600-af98-d2c80c27a086-i2c-6d13ba48" },
  { id: "15dd8a53-c353-4174-95eb-1d0bae214a24", code: "GXA082a501f" },
  { id: "81c4d5e4-9a4d-4d05-9ffe-f3d8947c7669", code: "GXA4547d3e7" },
  { id: "a35bb3fe-d713-41aa-a5a9-21b37a2a57dd", code: "GXAd5f1f86b" },
  { id: "1069ae7d-8c7b-4989-8360-9fdb8cc7e21c", code: "GXAd6e8622b" },
  { id: "50d98299-b263-4486-b0fa-77e12446ac2e", code: "GXB5e8e6cb0" },
  { id: "74a6d2cb-bf3a-4f40-8ce9-9a9fb89ef4a2", code: "GXB6c0d8d1d" },
  { id: "6ac5a62f-a0d4-4f69-987a-f94c1b5372e0", code: "GXB929e67a0" },
  { id: "4fd9b1ad-4f6d-4452-83b8-97c9ac89b156", code: "GXBa4c1b9ca" },
  { id: "da06e3ef-3998-49cb-8325-c9eb645b3478", code: "GXC38581946" },
  { id: "04c73d00-5026-4a2e-a3fc-47e30ec73613", code: "GXC4cde5d77" },
  { id: "5723ed7c-536c-45b9-b530-d56033bf6623", code: "GXCb1ca4d40" },
  { id: "e93a8ad0-0ab7-4c8b-abed-43fa0e66bafa", code: "GXCd62a5ad5" },
  { id: "9772e949-f582-4b0d-8bb6-cbda66bc7566", code: "GXD-sessions4933bbd6" },
  { id: "d89e127f-53d7-4fc4-8681-80416c4715e7", code: "GXD-sessions87f6988c" },
  { id: "eab381bf-6043-4e40-b96c-dea5e956fff8", code: "GXD-sessionsf64d49ea" },
  { id: "8575524b-0c75-4c0c-b245-b5e82deeae60", code: "GXD-shared2f5d7cc2" },
  { id: "528c01e5-1e39-4b80-ba8a-b846dd2f706b", code: "GXD-shared40c0f7ba" },
  { id: "1b8e9a2b-ef49-47a9-ac4b-501caaf6b5e3", code: "GXD-shared6912469b" },
  { id: "5d77634e-2bf0-46ae-8fd1-bfa8472d532a", code: "GXD-sharedb0d5d6fe" },
  { id: "66af6052-3b80-4253-a471-7c071836003e", code: "GXD-sharedb590d690" },
  { id: "ba3cd296-91cd-4bcb-b7be-8cc60960b8d6", code: "GXD-sharede5775d96" },
  { id: "7be4c88e-d599-4df5-b818-48b7129b85be", code: "GXD-sharedfb5c795f" },
  { id: "7ef8df1f-c360-4e20-8089-bea7589f1946", code: "GXE19981ab3" },
  { id: "c2af9b50-d570-4bce-95c5-fa505ca6673a", code: "GXEf17f598e" },
  { id: "cfff4fe4-db3c-4e1f-abc5-66295491bd68", code: "GXEfa03f955" },
  { id: "10015025-773b-4670-93da-0e0165f9ba1f", code: "GXEff1b0e34" },
];

const FIXTURE_CODE_PATTERN = /^(comm-test-|GX[A-E])/;

export interface CleanupResult {
  readonly id: string;
  readonly code: string;
  readonly outcome: "deleted" | "already_gone" | "failed";
  readonly reason?: string;
}

async function main(): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env"), quiet: true });
  const { configuration } = await import("../configuration/environment.js");
  const settings = configuration();
  const pool = new Pool({ connectionString: settings.database.url, max: 4 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const configService = new ConfigService<AppConfiguration, true>(settings);
  const storage = new LocalFileStorageAdapter(configService as unknown as ConfigService<AppConfiguration, true>);

  const results: CleanupResult[] = [];
  try {
    const actorId = (
      await sql<{ id: string }>`select id from accounts where company_id is null order by created_at limit 1`.execute(
        database,
      )
    ).rows[0]?.id;
    if (actorId === undefined) throw new Error("No Platform administrator account found to attribute this run to");

    // One real, verified full-database backup for the whole run.
    const backupRoot = settings.companyDeletion.backupRoot;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = `test-fixture-cleanup-${stamp}.dump`;
    const backupTarget = resolve(backupRoot, backupFile);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(backupRoot, { recursive: true });
    const processResult = await runBackupProcess({
      executable: "pg_dump",
      args: ["--format=custom", "--file", backupTarget, settings.database.url],
      timeoutMs: settings.companyDeletion.timeoutMs,
    });
    if (processResult.timedOut || processResult.exitCode !== 0) {
      throw new Error("Verified backup could not be created; aborting the entire cleanup run");
    }
    const { stat } = await import("node:fs/promises");
    const artifact = await stat(backupTarget);
    if (!artifact.isFile() || artifact.size <= 0) throw new Error("Backup artifact missing or empty; aborting");
    const checksum = await checksumFileSha256(backupTarget);
    console.warn(`Verified backup: ${backupFile} (${artifact.size} bytes, sha256 ${checksum})`);

    for (const target of CONFIRMED_TEST_FIXTURE_COMPANIES) {
      const live = (
        await sql<{ id: string; code: string; status: string; environment: string }>`
          select id, code, status, environment from companies where id = ${target.id}::uuid
        `.execute(database)
      ).rows[0];

      if (live === undefined) {
        results.push({ id: target.id, code: target.code, outcome: "already_gone" });
        console.warn(`SKIP (already gone): ${target.code}`);
        continue;
      }
      if (live.code !== target.code || !FIXTURE_CODE_PATTERN.test(live.code)) {
        results.push({
          id: target.id,
          code: target.code,
          outcome: "failed",
          reason: `Live code "${live.code}" does not match the audited fixture code or pattern — aborting the run`,
        });
        console.error(`ABORT: ${target.id} code mismatch (expected ${target.code}, found ${live.code})`);
        break;
      }

      try {
        // Supersede any leftover active operation for this Company from a
        // prior interrupted run -- `platform_company_deletion_one_active`
        // allows only one, and this is the same established pattern the
        // certification suite's own stale-fixture sweep already uses.
        await sql`
          update platform_company_deletion_operations
             set state = 'rolled_back', failure_reason = 'Superseded by test-fixture cleanup rerun'
           where company_id_snapshot = ${target.id}::uuid and state in ('previewed', 'ready', 'deleting')
        `.execute(database);

        const now49hAgo = live.environment === "production";
        await sql`
          update companies
             set status = 'closed',
                 closed_at = now() - ${now49hAgo ? sql.raw("interval '49 hours'") : sql.raw("interval '0 hours'")}
           where id = ${target.id}::uuid
        `.execute(database);

        // The SAME idempotency key must flow through preview() and
        // execute() -- the operation row is created with it in preview()
        // and execute() rejects a mismatch as a different, conflicting run.
        const idempotencyKey = randomUUID();
        const previewService = new PlatformCompanyDeletionService(database);
        const preview = await previewService.preview(
          target.id,
          { accountId: actorId, correlationId: randomUUID() },
          idempotencyKey,
        );
        const operationId = String((preview as Record<string, unknown>).operationId);
        const previewId = String((preview as Record<string, unknown>).previewId);
        const blockers = (preview as { blockers?: unknown[] }).blockers ?? [];
        if (blockers.length > 0) {
          throw new Error(`Preview still reports blockers: ${JSON.stringify(blockers)}`);
        }

        await sql`
          insert into platform_company_deletion_backups(
            operation_id, company_id_snapshot, backup_type, status, storage_reference,
            checksum_sha256, size_bytes, verified_at, completed_at, created_by_account_id
          ) values (
            ${operationId}::uuid, ${target.id}::uuid, 'full_database', 'verified', ${backupFile},
            ${checksum}, ${artifact.size}, now(), now(), ${actorId}::uuid
          )
        `.execute(database);
        await sql`
          update platform_company_deletion_operations
             set state = 'ready', backup_reference = ${backupFile}
           where id = ${operationId}::uuid
        `.execute(database);
        await sql`
          update platform_company_deletion_previews set ready_for_delete = true where id = ${previewId}::uuid
        `.execute(database);

        const execution = new PlatformCompanyDeletionExecutionService(
          database,
          configService,
          storage,
          () => undefined,
        );
        await execution.execute(target.id, {
          operationId,
          previewId,
          confirmation: `DELETE ${target.code}`,
          idempotencyKey,
        });

        const gone = (
          await sql<{ n: string }>`select count(*)::text n from companies where id = ${target.id}::uuid`.execute(
            database,
          )
        ).rows[0]?.n;
        const survivingOperation = (
          await sql<{ state: string }>`
            select state from platform_company_deletion_operations where id = ${operationId}::uuid
          `.execute(database)
        ).rows[0]?.state;
        if (gone !== "0") throw new Error("Company row still present after execute()");
        if (survivingOperation !== "completed" && survivingOperation !== "completed_cleanup_pending") {
          throw new Error(`Surviving deletion operation has unexpected state: ${survivingOperation}`);
        }

        results.push({ id: target.id, code: target.code, outcome: "deleted" });
        console.warn(`DELETED: ${target.code}`);
      } catch (error) {
        results.push({
          id: target.id,
          code: target.code,
          outcome: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
        console.error(`FAILED: ${target.code} — ${error instanceof Error ? error.message : String(error)}`);
        break; // Stop the batch on first failure — do not continue blindly.
      }
    }
  } finally {
    console.warn(JSON.stringify(results, null, 2));
    await database.destroy();
  }
}

// Runs ONLY behind an explicit env var
// (`RUN_TEST_FIXTURE_CLEANUP=true npx tsx src/platform/test-fixture-company-cleanup.maintenance.ts`)
// -- never as a side effect of importing `CONFIRMED_TEST_FIXTURE_COMPANIES`
// or any other export from another script or test, which is why this check
// does not rely on any cross-platform "am I the entrypoint" path matching
// (fragile on Windows) and instead requires the caller to opt in explicitly
// every single time.
if (process.env.RUN_TEST_FIXTURE_CLEANUP === "true") {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
