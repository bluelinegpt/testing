import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { sql } from "kysely";

import type { AppConfiguration } from "../configuration/environment.js";
import { FileStoragePort } from "../files/file-storage.port.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { Kysely } from "kysely";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import {
  COMPANY_DELETION_APPROVED_GUARDS,
  COMPANY_DELETION_CYCLE_BREAKS,
  COMPANY_DELETION_DIRECT_TABLES,
  COMPANY_DELETION_MANIFEST_HASH,
  COMPANY_DELETION_MANIFEST_VERSION,
} from "./platform-company-deletion.manifest.js";
import { calculateCompanyDeletionEligibility } from "./platform-company-deletion.service.js";
import { checksumFileSha256 } from "./platform-company-deletion-backup.service.js";
import { dependencyOrder, type ForeignKey } from "./reset-company-test-data.manifest.js";

export type CompanyDeletionStage =
  | "guards_disabled"
  | "cycles_prepared"
  | "operational_deleted"
  | "accounting_deleted"
  | "journals_deleted"
  | "financial_deleted"
  | "identities_deleted"
  | "storefront_deleted"
  | "communications_deleted"
  | "references_verified"
  | "guards_restored"
  | "company_deleted";
export type CompanyDeletionFailureInjector = (stage: CompanyDeletionStage) => void | Promise<void>;
export const COMPANY_DELETION_FAILURE_INJECTOR = Symbol("COMPANY_DELETION_FAILURE_INJECTOR");
export const noCompanyDeletionFailure: CompanyDeletionFailureInjector = () => undefined;

const identifier = /^[a-z_][a-z0-9_]*$/;
const quote = (value: string): string => {
  if (!identifier.test(value)) throw new Error("Unsafe manifest identifier");
  return `"${value}"`;
};

interface DeleteInput {
  operationId: string;
  previewId: string;
  confirmation: string;
  idempotencyKey: string;
}

@Injectable()
export class PlatformCompanyDeletionExecutionService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(ConfigService) private readonly config: ConfigService<AppConfiguration, true>,
    @Inject(FileStoragePort) private readonly storage: FileStoragePort,
    @Inject(COMPANY_DELETION_FAILURE_INJECTOR) private readonly injectFailure: CompanyDeletionFailureInjector,
  ) {}

  public async execute(companyId: string, input: DeleteInput): Promise<Record<string, unknown>> {
    const prior = (
      await sql<{ companyId: string; key: string; state: string; result: Record<string, unknown> | null }>`
        select company_id_snapshot as "companyId", idempotency_key as key, state, result
          from platform_company_deletion_operations where id=${input.operationId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (prior !== undefined && (prior.companyId !== companyId || prior.key !== input.idempotencyKey)) {
      throw this.conflict("Deletion operation does not match the requested Company or idempotency key");
    }
    if (prior?.state === "completed" || prior?.state === "completed_cleanup_pending") {
      return { operationId: input.operationId, state: prior.state, alreadyCompleted: true, result: prior.result };
    }
    try {
      const result = await this.database.transaction().execute(async (transaction) => {
        // Trigger state is table-global even though row deletion is Company-scoped.
        // Serialize permanent deletions so two Companies cannot deadlock while
        // acquiring the reviewed ALTER TABLE trigger locks in different sessions.
        await sql`select pg_advisory_xact_lock(hashtextextended('platform-company-deletion-global', 0))`.execute(transaction);
        await sql`select pg_advisory_xact_lock(hashtextextended(${companyId}, 0))`.execute(transaction);
        const row = (
          await sql<{
            code: string; name: string; status: string; environment: string; closedAt: Date | null; now: Date;
            operationState: string; operationKey: string; previewId: string | null; manifestVersion: string | null;
            manifestHash: string | null; generatedAt: Date; previewCounts: Record<string, number>; previewBlockers: unknown[];
            previewReady: boolean; previewClosedAt: Date | null; previewEnvironment: string;
            backupReference: string | null; backupChecksum: string | null; backupSize: string | null;
            backupCompanyId: string;
          }>`
            select company.code, company.name_en as name, company.status, company.environment,
                   company.closed_at as "closedAt", clock_timestamp() as now,
                   operation.state as "operationState", operation.idempotency_key as "operationKey",
                   operation.preview_id as "previewId", operation.manifest_version as "manifestVersion",
                   operation.manifest_hash as "manifestHash", preview.generated_at as "generatedAt",
                   preview.row_counts as "previewCounts", preview.blockers as "previewBlockers",
                   preview.ready_for_delete as "previewReady", preview.closed_at_snapshot as "previewClosedAt",
                   preview.environment_snapshot as "previewEnvironment",
                   backup.storage_reference as "backupReference", backup.checksum_sha256 as "backupChecksum",
                   backup.size_bytes as "backupSize", backup.company_id_snapshot as "backupCompanyId"
              from companies company
              join platform_company_deletion_operations operation on operation.company_id_snapshot = company.id
              join platform_company_deletion_previews preview on preview.id = operation.preview_id
              join platform_company_deletion_backups backup on backup.operation_id = operation.id and backup.status = 'verified'
             where company.id = ${companyId}::uuid and operation.id = ${input.operationId}::uuid
             for update of company, operation
          `.execute(transaction)
        ).rows[0];
        if (row === undefined) throw this.conflict("Deletion operation, preview, or verified backup is missing");
        if (row.operationState === "completed" || row.operationState === "completed_cleanup_pending") {
          return { operationId: input.operationId, state: row.operationState, alreadyCompleted: true };
        }
        if (row.operationState === "deleting") throw this.conflict("Company deletion is already running");
        if (row.operationState !== "ready" || row.operationKey !== input.idempotencyKey) throw this.conflict("Deletion operation is not ready");
        if (row.previewId !== input.previewId || !row.previewReady || row.previewBlockers.length > 0) throw this.conflict("Deletion preview is not ready");
        if (row.backupCompanyId !== companyId) throw this.conflict("Verified backup belongs to another Company");
        if (input.confirmation !== `DELETE ${row.code}`) throw this.conflict(`Type DELETE ${row.code} exactly`);
        const eligibility = calculateCompanyDeletionEligibility(row);
        if (!eligibility.eligible) throw this.conflict(eligibility.blockers.join("; "));
        if (row.manifestVersion !== COMPANY_DELETION_MANIFEST_VERSION || row.manifestHash !== COMPANY_DELETION_MANIFEST_HASH) throw this.conflict("Deletion preview uses a stale manifest");
        if (row.previewEnvironment !== row.environment || row.previewClosedAt?.getTime() !== row.closedAt?.getTime()) throw this.conflict("Company lifecycle changed after preview");
        if (row.now.getTime() - row.generatedAt.getTime() > 15 * 60_000) throw this.conflict("Deletion preview expired; run it again");
        await this.verifyBackupArtifact(row.backupReference, row.backupChecksum, row.backupSize);

        const liveTables = (
          await sql<{ tableName: string }>`select table_name as "tableName" from information_schema.columns where table_schema='public' and column_name='company_id' order by table_name`.execute(transaction)
        ).rows.map((entry) => entry.tableName);
        const expected = [...COMPANY_DELETION_DIRECT_TABLES].sort();
        if (JSON.stringify(liveTables) !== JSON.stringify(expected)) throw this.conflict("Company table catalog changed; a new preview and manifest review are required");

        const currentCounts: Record<string, number> = {};
        for (const table of expected) {
          currentCounts[table] = Number((await sql<{ n: string }>`select count(*)::bigint n from ${sql.table(table)} where company_id=${companyId}::uuid`.execute(transaction)).rows[0]?.n ?? 0);
        }
        if (
          Object.keys(currentCounts).length !== Object.keys(row.previewCounts).length ||
          Object.entries(currentCounts).some(([table, count]) => row.previewCounts[table] !== count)
        ) throw this.conflict("Company data changed after preview; run it again");

        const guards = (
          await sql<{ tableName: string; triggerName: string }>`
            select target.relname as "tableName", trigger_row.tgname as "triggerName"
              from pg_trigger trigger_row join pg_class target on target.oid=trigger_row.tgrelid
              join pg_namespace namespace_row on namespace_row.oid=target.relnamespace
             where namespace_row.nspname='public' and not trigger_row.tgisinternal
               and (trigger_row.tgtype & 8)=8 and target.relname=any(${[...expected, "role_permissions"]}::text[])
             order by target.relname, trigger_row.tgname
          `.execute(transaction)
        ).rows;
        if (guards.some((entry) => !COMPANY_DELETION_APPROVED_GUARDS.has(entry.triggerName))) throw this.conflict("An unapproved delete guard was discovered");

        const files = (
          await sql<{ storageKey: string; provider: string }>`select storage_key as "storageKey", storage_provider as provider from file_objects where company_id=${companyId}::uuid`.execute(transaction)
        ).rows;
        const globalFingerprintBefore = (
          await sql<Record<string, string>>`
            select
              (select count(*)::text from accounts where company_id is null) as platform_accounts,
              (select count(*)::text from roles where company_id is null) as platform_roles,
              (select count(*)::text from permissions) as permissions,
              (select count(*)::text from kysely_migration) as migrations,
              (select count(*)::text from emirates) as emirates,
              (select count(*)::text from trader_commerce_profiles) as commerce_profiles,
              (select count(*)::text from marketplace_categories) as marketplace_categories,
              (select count(*)::text from marketplace_subcategories) as marketplace_subcategories
          `.execute(transaction)
        ).rows[0];
        for (const file of files) {
          await sql`insert into platform_company_deletion_cleanup_items(operation_id,object_reference,storage_provider,ownership_category,status) values(${input.operationId}::uuid,${file.storageKey},${file.provider},'company_file_object','pending') on conflict do nothing`.execute(transaction);
        }

        await sql`update platform_company_deletion_operations set state='deleting',started_at=now(),updated_at=now() where id=${input.operationId}::uuid`.execute(transaction);
        const disabled = [...guards];
        for (const extra of [
          { tableName: "journal_entries", triggerName: "journal_entries_accounting_state_guard" },
          { tableName: "journal_entries", triggerName: "journal_entries_balance_before_post" },
        ]) {
          const exists = (await sql<{ n: string }>`select count(*)::text n from pg_trigger trigger_row join pg_class target on target.oid=trigger_row.tgrelid where target.relname=${extra.tableName} and trigger_row.tgname=${extra.triggerName} and trigger_row.tgenabled='O'`.execute(transaction)).rows[0]?.n === "1";
          if (exists) disabled.push(extra);
        }
        for (const guard of disabled) await sql.raw(`alter table ${quote(guard.tableName)} disable trigger ${quote(guard.triggerName)}`).execute(transaction);
        await this.injectFailure("guards_disabled");

        await sql`delete from role_permissions using roles where role_permissions.role_id=roles.id and roles.company_id=${companyId}::uuid`.execute(transaction);
        await sql`delete from storefront_marketplace_categories using trader_storefronts where storefront_marketplace_categories.storefront_id=trader_storefronts.id and trader_storefronts.company_id=${companyId}::uuid`.execute(transaction);
        for (const cycle of COMPANY_DELETION_CYCLE_BREAKS) {
          const assignments = cycle.columns.map((column) => `${quote(column)}=null`).join(",");
          await sql`update ${sql.table(cycle.table)} set ${sql.raw(assignments)} where company_id=${companyId}::uuid`.execute(transaction);
        }
        await this.injectFailure("cycles_prepared");

        const keys = (
          await sql<{ child: string; parent: string }>`select child.relname child,parent.relname parent from pg_constraint constraint_row join pg_class child on child.oid=constraint_row.conrelid join pg_class parent on parent.oid=constraint_row.confrelid where constraint_row.contype='f' and child.relname=any(${expected}::text[]) and parent.relname=any(${expected}::text[])`.execute(transaction)
        ).rows.filter((key) => !(key.child === "journal_entries" && key.parent === "accounting_events") && !(key.child === "conversations" && key.parent === "messages"));
        const ordering = dependencyOrder(expected, keys.map<ForeignKey>((key) => ({ ...key, childColumns: [], parentColumns: [] })));
        if (ordering.cycle.length > 0) throw this.conflict(`Unapproved foreign-key cycle: ${ordering.cycle.join(", ")}`);
        const actualRows: Record<string, number> = {};
        for (const table of ordering.order) {
          const deleted = await sql`delete from ${sql.table(table)} where company_id=${companyId}::uuid`.execute(transaction);
          actualRows[table] = Number(deleted.numAffectedRows ?? 0);
          if (table === "orders") await this.injectFailure("operational_deleted");
          if (table === "accounting_event_components") await this.injectFailure("accounting_deleted");
          if (table === "journal_entries") await this.injectFailure("journals_deleted");
          if (table === "trader_settlements") await this.injectFailure("financial_deleted");
          if (table === "accounts") await this.injectFailure("identities_deleted");
          if (table === "trader_storefronts") await this.injectFailure("storefront_deleted");
          if (table === "conversations") await this.injectFailure("communications_deleted");
        }
        await this.injectFailure("references_verified");
        for (const table of expected) {
          const remaining = Number((await sql<{ n: string }>`select count(*)::bigint n from ${sql.table(table)} where company_id=${companyId}::uuid`.execute(transaction)).rows[0]?.n ?? 0);
          if (remaining !== 0) throw new Error(`Company reference verification failed for ${table}`);
        }
        for (const guard of [...disabled].reverse()) await sql.raw(`alter table ${quote(guard.tableName)} enable trigger ${quote(guard.triggerName)}`).execute(transaction);
        const stillDisabled = Number((await sql<{ n: string }>`select count(*)::text n from pg_trigger where tgname=any(${disabled.map((entry) => entry.triggerName)}::text[]) and tgenabled<>'O'`.execute(transaction)).rows[0]?.n ?? 0);
        if (stillDisabled > 0) throw new Error("Deletion guard restoration verification failed");
        await this.injectFailure("guards_restored");
        const globalFingerprintAfter = (
          await sql<Record<string, string>>`
            select
              (select count(*)::text from accounts where company_id is null) as platform_accounts,
              (select count(*)::text from roles where company_id is null) as platform_roles,
              (select count(*)::text from permissions) as permissions,
              (select count(*)::text from kysely_migration) as migrations,
              (select count(*)::text from emirates) as emirates,
              (select count(*)::text from trader_commerce_profiles) as commerce_profiles,
              (select count(*)::text from marketplace_categories) as marketplace_categories,
              (select count(*)::text from marketplace_subcategories) as marketplace_subcategories
          `.execute(transaction)
        ).rows[0];
        if (JSON.stringify(globalFingerprintAfter) !== JSON.stringify(globalFingerprintBefore)) throw new Error("Global preservation verification failed");
        const companyDelete = await sql`delete from companies where id=${companyId}::uuid`.execute(transaction);
        if (Number(companyDelete.numAffectedRows) !== 1) throw new Error("Company-last deletion verification failed");
        await this.injectFailure("company_deleted");
        const state = files.length === 0 ? "completed" : "completed_cleanup_pending";
        await sql`update platform_company_deletion_operations set state=${state},completed_at=now(),updated_at=now(),result=${JSON.stringify({ databaseCommitted: true, actualRows, externalObjects: files.length })}::jsonb where id=${input.operationId}::uuid`.execute(transaction);
        return { operationId: input.operationId, company: { id: companyId, code: row.code, name: row.name }, state, actualRows, externalObjects: files.length };
      });
      if (result.alreadyCompleted !== true) await this.retryCleanup(input.operationId);
      return result;
    } catch (error) {
      await sql`update platform_company_deletion_operations set state='rolled_back',failure_reason='Company deletion transaction was rolled back',updated_at=now() where id=${input.operationId}::uuid and company_id_snapshot=${companyId}::uuid and state in ('ready','deleting')`.execute(this.database);
      throw error;
    }
  }

  public async retryCleanup(operationId: string): Promise<Record<string, unknown>> {
    const items = (await sql<{ id: string; objectReference: string }>`select id,object_reference as "objectReference" from platform_company_deletion_cleanup_items where operation_id=${operationId}::uuid and status in ('pending','failed') order by created_at`.execute(this.database)).rows;
    let failed = 0;
    for (const item of items) {
      try {
        if (item.objectReference.startsWith("commerce/")) await this.storage.deleteCommerce(item.objectReference);
        else {
          const companyId = (await sql<{ id: string }>`select company_id_snapshot id from platform_company_deletion_operations where id=${operationId}::uuid`.execute(this.database)).rows[0]?.id;
          if (companyId === undefined) throw new Error("operation_missing");
          await this.storage.deletePrivate(companyId, item.objectReference);
        }
        await sql`update platform_company_deletion_cleanup_items set status='completed',attempts=attempts+1,last_failure=null,completed_at=now() where id=${item.id}::uuid`.execute(this.database);
      } catch {
        failed += 1;
        await sql`update platform_company_deletion_cleanup_items set status='failed',attempts=attempts+1,last_failure='External object deletion failed' where id=${item.id}::uuid`.execute(this.database);
      }
    }
    const state = failed === 0 ? "completed" : "completed_cleanup_pending";
    await sql`update platform_company_deletion_operations set state=${state},updated_at=now() where id=${operationId}::uuid and state in ('completed','completed_cleanup_pending')`.execute(this.database);
    return { operationId, state, attempted: items.length, failed };
  }

  private async verifyBackupArtifact(reference: string | null, checksum: string | null, size: string | null): Promise<void> {
    if (reference === null || checksum === null || Number(size) <= 0 || reference !== resolve(reference).split(sep).at(-1)) throw this.conflict("Verified backup metadata is invalid");
    const root = this.config.get("companyDeletion.backupRoot", { infer: true });
    const artifact = await stat(resolve(root, reference)).catch(() => null);
    if (artifact === null || !artifact.isFile() || artifact.size !== Number(size)) throw this.conflict("Verified backup artifact is missing or changed");
    if ((await checksumFileSha256(resolve(root, reference))) !== checksum) throw this.conflict("Verified backup checksum no longer matches the artifact");
  }

  private conflict(message: string): ApplicationException {
    return new ApplicationException("company_deletion_not_ready", message, HttpStatus.CONFLICT);
  }
}
