import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { Kysely } from "kysely";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { dependencyOrder, type ForeignKey } from "./reset-company-test-data.manifest.js";
import {
  COMPANY_DELETION_APPROVED_GUARDS,
  COMPANY_DELETION_DIRECT_TABLES,
  COMPANY_DELETION_GLOBAL_PRESERVE,
  COMPANY_DELETION_MANIFEST_HASH,
  COMPANY_DELETION_MANIFEST_VERSION,
  COMPANY_DELETION_PLATFORM_PRESERVE,
} from "./platform-company-deletion.manifest.js";

const nonProduction = new Set(["development", "demo", "sandbox", "trial"]);

const moduleFor = (table: string): string => {
  if (table.includes("order")) return "Orders";
  if (table.includes("customer")) return "Customers";
  if (table.includes("trader_settlement")) return "Trader Settlements";
  if (table.includes("trader")) return "Traders";
  if (table.includes("driver_reconciliation")) return "Reconciliation";
  if (table.includes("driver_collection") || table.includes("collection")) return "Collections";
  if (table.includes("driver") || table.includes("commission")) return "Drivers / earnings";
  if (table.includes("employee")) return "Employees";
  if (table.includes("payroll")) return "Payroll";
  if (table.includes("expense") || table.includes("cash_bank")) return "Expenses";
  if (table.includes("journal_lines")) return "Journal Lines";
  if (table.includes("journal")) return "Journals";
  if (table.includes("accounting_event")) return "Accounting Events";
  if (table.includes("opening_balance")) return "Opening Balances";
  if (table.includes("fiscal") || table.includes("period")) return "Fiscal Data";
  if (table.includes("conversation") || table === "messages") return "Communications";
  if (table.includes("notification") || table.includes("realtime")) return "Notifications";
  if (table.includes("storefront")) return "Storefront";
  if (table.includes("commerce") || table.includes("marketplace")) return "Marketplace Company relationships";
  if (table.includes("file") || table.includes("attachment") || table.includes("document")) return "Files / media";
  if (table.includes("account") || table.includes("role") || table.includes("user") || table.includes("session") || table.includes("token")) return "Users";
  if (table.includes("config") || table.includes("settings") || table.includes("reference") || table.includes("area") || table.includes("allowance_type")) return "Company configuration";
  return "Other Company-owned rows";
};

export interface CompanyDeletionEligibility {
  readonly eligible: boolean;
  readonly status: string;
  readonly environment: string;
  readonly closedAt: string | null;
  readonly eligibleAt: string | null;
  readonly requiresWaitingPeriod: boolean;
  readonly waitingPeriodHours: number;
  readonly remainingSeconds: number;
  readonly blockers: readonly string[];
  readonly previewRequired: true;
  readonly backupRequired: true;
}

export function calculateCompanyDeletionEligibility(input: {
  status: string;
  environment: string;
  closedAt: Date | null;
  now: Date;
}): CompanyDeletionEligibility {
  const blockers: string[] = [];
  const knownEnvironment = nonProduction.has(input.environment) || input.environment === "production";
  if (!knownEnvironment) blockers.push("Unsupported or missing Company environment");
  if (input.status !== "closed") blockers.push("Company must be closed");
  if (input.closedAt === null) blockers.push("Company closure timestamp is missing");
  const requiresWaitingPeriod = input.environment === "production";
  const eligibleAt =
    input.closedAt === null
      ? null
      : new Date(input.closedAt.getTime() + (requiresWaitingPeriod ? 48 * 60 * 60 * 1000 : 0));
  const remainingSeconds =
    eligibleAt === null ? 0 : Math.max(0, Math.ceil((eligibleAt.getTime() - input.now.getTime()) / 1000));
  if (requiresWaitingPeriod && remainingSeconds > 0) {
    blockers.push("Production Companies require 48 continuous hours of closure");
  }
  return {
    eligible: blockers.length === 0,
    status: input.status,
    environment: input.environment,
    closedAt: input.closedAt?.toISOString() ?? null,
    eligibleAt: eligibleAt?.toISOString() ?? null,
    requiresWaitingPeriod,
    waitingPeriodHours: requiresWaitingPeriod ? 48 : 0,
    remainingSeconds,
    blockers,
    previewRequired: true,
    backupRequired: true,
  };
}

interface CompanySnapshot {
  id: string;
  code: string;
  name: string;
  status: string;
  environment: string;
  closedAt: Date | null;
  now: Date;
}

@Injectable()
export class PlatformCompanyDeletionService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  private async snapshot(companyId: string): Promise<CompanySnapshot> {
    const row = (
      await sql<CompanySnapshot>`
        select id, code, name_en as name, status, environment, closed_at as "closedAt",
               clock_timestamp() as now
          from companies where id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (row === undefined) {
      throw new ApplicationException("company_not_found", "The requested Company does not exist", HttpStatus.NOT_FOUND);
    }
    return row;
  }

  public async eligibility(companyId: string): Promise<CompanyDeletionEligibility> {
    const company = await this.snapshot(companyId);
    return calculateCompanyDeletionEligibility(company);
  }

  public async preview(
    companyId: string,
    actor: { accountId: string; correlationId: string },
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const company = await this.snapshot(companyId);
    const eligibility = calculateCompanyDeletionEligibility(company);
    if (company.closedAt === null || eligibility.eligibleAt === null) {
      throw new ApplicationException(
        "company_deletion_preview_not_eligible",
        "Close the Company before running a deletion preview",
        HttpStatus.CONFLICT,
      );
    }

    const liveDirectTables = (
      await sql<{ tableName: string }>`
        select table_name as "tableName" from information_schema.columns
         where table_schema = 'public' and column_name = 'company_id'
         order by table_name
      `.execute(this.database)
    ).rows.map((row) => row.tableName);
    const directTables = [...COMPANY_DELETION_DIRECT_TABLES].sort();
    const rowCounts: Record<string, number> = {};
    for (const table of directTables) {
      rowCounts[table] = Number(
        (
          await sql<{ n: string }>`select count(*)::bigint n from ${sql.table(table)} where company_id = ${companyId}::uuid`.execute(
            this.database,
          )
        ).rows[0]?.n ?? 0,
      );
    }

    const unknownReferences = liveDirectTables
      .filter((table) => !COMPANY_DELETION_DIRECT_TABLES.has(table))
      .map((table) => `Unclassified Company table: ${table}`);
    for (const table of directTables.filter((entry) => !liveDirectTables.includes(entry))) {
      unknownReferences.push(`Manifest table missing from schema: ${table}`);
    }

    const liveGlobalTables = (
      await sql<{ tableName: string }>`
        select table_name as "tableName" from information_schema.tables
         where table_schema = 'public' and table_type = 'BASE TABLE'
           and table_name not in (
             select table_name from information_schema.columns
              where table_schema = 'public' and column_name = 'company_id'
           ) order by table_name
      `.execute(this.database)
    ).rows.map((row) => row.tableName);
    const approvedGlobal = new Set([
      ...COMPANY_DELETION_GLOBAL_PRESERVE,
      ...COMPANY_DELETION_PLATFORM_PRESERVE,
    ]);
    for (const table of liveGlobalTables.filter((entry) => !approvedGlobal.has(entry))) {
      unknownReferences.push(`Unclassified global table: ${table}`);
    }

    const guardedTriggers = (
      await sql<{ tableName: string; triggerName: string }>`
        select target.relname as "tableName", trigger_row.tgname as "triggerName"
          from pg_trigger trigger_row join pg_class target on target.oid = trigger_row.tgrelid
          join pg_namespace namespace_row on namespace_row.oid = target.relnamespace
         where namespace_row.nspname = 'public' and not trigger_row.tgisinternal
           and (trigger_row.tgtype & 8) = 8
           and target.relname = any(${[...directTables, "role_permissions"]}::text[])
         order by target.relname, trigger_row.tgname
      `.execute(this.database)
    ).rows;
    const unapprovedGuards = guardedTriggers.filter(
      (entry) => !COMPANY_DELETION_APPROVED_GUARDS.has(entry.triggerName),
    );

    const foreignKeys = (
      await sql<{ child: string; parent: string }>`
        select child.relname as child, parent.relname as parent
          from pg_constraint constraint_row
          join pg_class child on child.oid = constraint_row.conrelid
          join pg_class parent on parent.oid = constraint_row.confrelid
         where constraint_row.contype = 'f'
           and child.relname = any(${directTables}::text[])
           and parent.relname = any(${directTables}::text[])
      `.execute(this.database)
    ).rows
      .filter(
        (row) =>
          !(row.child === "journal_entries" && row.parent === "accounting_events") &&
          !(row.child === "conversations" && row.parent === "messages"),
      )
      .map<ForeignKey>((row) => ({ child: row.child, parent: row.parent, childColumns: [], parentColumns: [] }));
    const { cycle: fkCycles } = dependencyOrder(directTables, foreignKeys);

    const totalRows = Object.values(rowCounts).reduce((sum, count) => sum + count, 0);
    const blockers = [...eligibility.blockers];
    if (unknownReferences.length > 0) blockers.push("UNSAFE / UNKNOWN DEPENDENCY");
    if (fkCycles.length > 0) blockers.push("Foreign-key cycle requires a reviewed deletion procedure");
    if (unapprovedGuards.length > 0) blockers.push("UNAPPROVED DELETE GUARD");
    const moduleCounts: Record<string, number> = {};
    for (const [table, count] of Object.entries(rowCounts)) {
      const module = moduleFor(table);
      moduleCounts[module] = (moduleCounts[module] ?? 0) + count;
    }
    const readyForDelete = false;

    // `platform_company_deletion_one_active` allows at most one operation in
    // `previewed`/`ready`/`deleting` per Company at a time -- correct, since
    // two concurrent deletion attempts on the same Company must never race.
    // But a Platform administrator re-running "Run Deletion Preview" (a new
    // browser tab, a retry after closing the page, simply clicking it again)
    // is not a second concurrent attempt at all -- it is the normal way to
    // refresh a preview, and previously hit this same constraint as a raw,
    // unmapped Postgres error surfaced to the user as a generic integrity
    // conflict. A prior active operation for THIS Company is superseded here
    // -- marked `rolled_back` with a clear reason, never overwritten in
    // place -- before the fresh preview is recorded, so every prior attempt
    // remains in the table as permanent evidence and a fresh preview always
    // succeeds. `completed`/`completed_cleanup_pending` operations are never
    // touched: the partial index this guards does not even include them, so
    // they can never conflict with a new preview in the first place.
    await sql`
      update platform_company_deletion_operations
         set state = 'rolled_back',
             failure_reason = 'Superseded by a newer deletion preview for the same Company',
             updated_at = now()
       where company_id_snapshot = ${company.id}::uuid
         and state in ('previewed', 'ready', 'deleting')
    `.execute(this.database);

    let operation: { id: string } | undefined;
    try {
      operation = (
        await sql<{ id: string }>`
          insert into platform_company_deletion_operations (
            company_id_snapshot, company_code_snapshot, company_name_snapshot, environment,
            closed_at, eligible_at, requested_by_account_id, state, correlation_id, idempotency_key
          ) values (
            ${company.id}::uuid, ${company.code}, ${company.name}, ${company.environment},
            ${company.closedAt}::timestamptz, ${eligibility.eligibleAt}::timestamptz,
            ${actor.accountId}::uuid, ${blockers.length === 0 ? "previewed" : "blocked"}, ${actor.correlationId}, ${idempotencyKey}
          )
          on conflict (idempotency_key) do update set updated_at = now()
          returning id
        `.execute(this.database)
      ).rows[0];
    } catch (error) {
      // The supersede step above eliminates the ordinary "stale operation"
      // case. What can still reach here is a genuine race -- two preview
      // requests for the same Company landing within the same instant --
      // and a caller should see a clear, safe, retryable reason, not a raw
      // Postgres constraint name surfaced as a generic conflict.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "23505"
      ) {
        throw new ApplicationException(
          "company_deletion_preview_in_progress",
          "Another deletion preview for this Company started at the same moment. Retry the preview.",
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
    if (operation === undefined) throw new Error("Deletion preview operation was not recorded");

    const preview = (
      await sql<{ id: string }>`
        insert into platform_company_deletion_previews (
          operation_id, company_id_snapshot, manifest_version, manifest_hash, closed_at_snapshot,
          environment_snapshot, row_counts, module_counts, guarded_triggers, blockers,
          unknown_references, fk_cycles, external_files, global_preserved,
          total_company_rows, ready_for_delete
        ) values (
          ${operation.id}::uuid, ${company.id}::uuid, ${COMPANY_DELETION_MANIFEST_VERSION},
          ${COMPANY_DELETION_MANIFEST_HASH}, ${company.closedAt}::timestamptz, ${company.environment},
          ${JSON.stringify(rowCounts)}::jsonb, ${JSON.stringify(moduleCounts)}::jsonb,
          ${JSON.stringify(guardedTriggers)}::jsonb, ${JSON.stringify(blockers)}::jsonb,
          ${JSON.stringify(unknownReferences)}::jsonb, ${JSON.stringify(fkCycles)}::jsonb,
          ${JSON.stringify({ fileObjects: rowCounts.file_objects ?? 0, strategy: "staged-after-database-commit" })}::jsonb,
          ${JSON.stringify(["platform accounts", "platform roles", "permissions", "migrations", "global reference data"])}::jsonb,
          ${totalRows}, ${readyForDelete}
        ) returning id
      `.execute(this.database)
    ).rows[0];
    await sql`update platform_company_deletion_operations set preview_id = ${preview?.id ?? null}::uuid,
      manifest_version = ${COMPANY_DELETION_MANIFEST_VERSION}, manifest_hash = ${COMPANY_DELETION_MANIFEST_HASH}
      where id = ${operation.id}::uuid`.execute(
      this.database,
    );

    return {
      previewId: preview?.id,
      operationId: operation.id,
      company: { id: company.id, code: company.code, name: company.name },
      ...eligibility,
      manifestVersion: COMPANY_DELETION_MANIFEST_VERSION,
      manifestHash: COMPANY_DELETION_MANIFEST_HASH,
      rowCounts,
      moduleCounts,
      totalCompanyRows: totalRows,
      unknownReferences,
      fkCycles,
      guardedTriggers,
      externalFiles: { fileObjects: rowCounts.file_objects ?? 0, strategy: "staged-after-database-commit" },
      globalPreserved: ["platform accounts", "platform roles", "permissions", "migrations", "global reference data"],
      backup: { required: true, status: "missing" },
      blockers,
      readyForDelete,
    };
  }
}
