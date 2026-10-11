import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { evaluateManualAccountingReadiness } from "./accounting-management.service.js";
import {
  accountingOperationalAreas,
  type AccountingOperationalArea,
} from "./accounting-ownership.matrix.js";
import { AutomaticPostingService } from "./automatic-posting.service.js";

/**
 * Company Accounting Mode: switching TawseelHub GL Accounting ON or OFF for
 * ONE Company, named by UUID.
 *
 * ---------------------------------------------------------------------------
 * THE SWITCH IS THE EXISTING ONE
 * ---------------------------------------------------------------------------
 *
 * `accounting_configurations.accounting_enabled` already is the per-Company
 * mode: the capture function `enqueue_operational_accounting_event` returns
 * without writing anything when it is false or when the Company has no
 * configuration row at all. No second "mode" column exists or is introduced,
 * so no Company's stored value is reinterpreted by deploying this service --
 * it only reads that flag until an administrator deliberately executes an
 * enable or disable below.
 *
 * ---------------------------------------------------------------------------
 * VERIFY -> PREVIEW -> CONFIRM -> EXECUTE -> VERIFY AGAIN
 * ---------------------------------------------------------------------------
 *
 *   - `status` and both previews are READ ONLY, enforced by PostgreSQL
 *     (`set transaction read only`), not by convention.
 *   - Execution requires the typed confirmation the preview returned AND the
 *     configuration version the preview was computed against, so a change made
 *     after the preview (by the Company, another administrator or the posting
 *     worker) is refused instead of executed blind.
 *   - Execution re-runs every check inside its own transaction, with the
 *     configuration row locked, and refuses rather than partially applying.
 *   - Disable returns a post-commit re-count so the caller sees immediately if
 *     anything arrived in the instant before the switch took effect.
 *
 * ---------------------------------------------------------------------------
 * WHAT ENABLE / DISABLE NEVER DO
 * ---------------------------------------------------------------------------
 *
 * Neither operation writes, repairs, deletes, reverses or re-statuses any
 * Accounting Event, Journal, fiscal period, Order, Receivable, Collection,
 * Settlement or Payroll row. The only rows written are the one
 * `accounting_configurations` row, the history row its own trigger appends,
 * and one `audit_events` row. Re-enabling does not backfill the period
 * Accounting was OFF: historical recovery is a separate, explicit operation.
 */

/** Delivery areas whose events every delivery Company produces from day one. */
export const CORE_DELIVERY_ACCOUNTING_AREAS: readonly AccountingOperationalArea[] = [
  "orders",
  "trader_receivables",
  "trader_settlements",
  "driver_collections",
];

/** Accounting Event statuses that are not yet a final outcome. */
const PENDING_EVENT_STATUSES = ["received", "retry_pending"] as const;
const FAILED_EVENT_STATUSES = ["failed", "blocked_configuration"] as const;
const IN_FLIGHT_EVENT_STATUSES = ["processing", "validated"] as const;
const UNRESOLVED_EVENT_STATUSES = [
  ...PENDING_EVENT_STATUSES,
  ...FAILED_EVENT_STATUSES,
  ...IN_FLIGHT_EVENT_STATUSES,
];
/** Journals that exist but have not reached a final status. */
const UNFINISHED_JOURNAL_STATUSES = ["draft", "balanced", "approved"];
/** Accounting batch jobs that are actively running. */
const RUNNING_BATCH_STATUSES = ["validating", "processing"];

const SAMPLE_EVENT_LIMIT = 50;

export interface AccountingModeActor {
  /** The Platform administrator's account id (audit only; never a Company FK). */
  readonly accountId: string;
  readonly correlationId: string;
}

export interface AccountingModeChangeInput {
  readonly reason: string;
  readonly confirmation: string;
  /** The `configurationVersion` the preview returned (null when no row existed). */
  readonly expectedConfigurationVersion: string | null;
}

interface CompanyIdentity {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

interface ConfigurationState {
  readonly configurationExists: boolean;
  readonly accountingEnabled: boolean;
  readonly automaticPostingEnabled: boolean;
  readonly automaticPostingAreas: readonly string[];
  readonly manualAccountingActivationDate: string | null;
  readonly manualAccountingEnabledAt: string | null;
  readonly configurationVersion: string | null;
}

export interface UnresolvedAccountingWork {
  readonly pending: number;
  readonly failed: number;
  readonly otherUnresolved: number;
  readonly eventsByStatus: readonly { status: string; eventType: string; count: number }[];
  readonly sampleEventIds: readonly string[];
  readonly unfinishedJournals: readonly { status: string; count: number }[];
  readonly runningBatches: readonly { status: string; count: number }[];
}

export interface AccountingModeBlocker {
  readonly code: string;
  readonly detail?: string;
}

/** Enable readiness for one accounting area, grouped as the preview shows it. */
export interface AreaReadinessFindings {
  readonly missing_mapping: readonly string[];
  readonly invalid_mapping: readonly string[];
  readonly other: readonly string[];
}

/** Area blockers the per-area readiness reports that are not mapping-specific. */
const AREA_MAPPING_CODES = new Set([
  "manual_accounting_disabled",
  "required_mapping_missing",
  "required_mapping_invalid",
  "open_fiscal_period_missing",
]);

export function enableConfirmationFor(companyCode: string): string {
  return `ENABLE ACCOUNTING ${companyCode}`;
}

export function disableConfirmationFor(companyCode: string): string {
  return `DISABLE ACCOUNTING ${companyCode}`;
}

/** `code:detail` strings for `ApplicationException.validationDetails`. */
function blockerDetails(blockers: readonly AccountingModeBlocker[]): string[] {
  return blockers.map((blocker) =>
    blocker.detail === undefined ? blocker.code : `${blocker.code}:${blocker.detail}`,
  );
}

/**
 * Pure: turns unresolved accounting work into the disable blockers. A Company
 * with ANY of these is refused -- nothing is repaired, deleted or marked done.
 */
export function disableBlockers(work: UnresolvedAccountingWork): AccountingModeBlocker[] {
  const blockers: AccountingModeBlocker[] = [];
  if (work.pending > 0)
    blockers.push({ code: "pending_accounting_events", detail: `${work.pending}` });
  if (work.failed > 0)
    blockers.push({ code: "failed_accounting_events", detail: `${work.failed}` });
  if (work.otherUnresolved > 0) {
    blockers.push({ code: "in_flight_accounting_events", detail: `${work.otherUnresolved}` });
  }
  for (const journal of work.unfinishedJournals) {
    blockers.push({
      code: "unfinished_journal_entries",
      detail: `${journal.status}:${journal.count}`,
    });
  }
  for (const batch of work.runningBatches) {
    blockers.push({ code: "running_accounting_batches", detail: `${batch.status}:${batch.count}` });
  }
  return blockers;
}

@Injectable()
export class CompanyAccountingModeService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(AutomaticPostingService)
    private readonly automaticPosting: AutomaticPostingService,
  ) {}

  // -------------------------------------------------------------------------
  // READ
  // -------------------------------------------------------------------------

  public status(companyId: string) {
    return this.readOnly(async (db) => {
      const company = await this.company(db, companyId);
      const state = await this.configuration(db, companyId, false);
      const unresolved = await this.unresolvedWork(db, companyId);
      return {
        company,
        ...state,
        // No configuration row is OFF: that is what the capture function does.
        accountingMode: state.accountingEnabled ? "enabled" : "disabled",
        unresolved,
      };
    });
  }

  public previewEnable(companyId: string) {
    return this.readOnly(async (db) => {
      const company = await this.company(db, companyId);
      const state = await this.configuration(db, companyId, false);
      const evaluation = await this.enableEvaluation(db, companyId, state.automaticPostingAreas);
      return {
        action: "enable" as const,
        company,
        current: state,
        alreadyEnabled: state.accountingEnabled,
        blockers: evaluation.blockers,
        blockersByArea: evaluation.blockersByArea,
        enabledAreas: evaluation.enabledAreas,
        enabledAreasSource: evaluation.enabledAreasSource,
        executable: !state.accountingEnabled && evaluation.blockers.length === 0,
        manualReadiness: evaluation.manual,
        areaReadiness: evaluation.areas,
        warnings: evaluation.warnings,
        warningsByArea: evaluation.warningsByArea,
        effects: {
          automaticPostingAfterEnable: false,
          backfillOfDisabledPeriod: "none",
          historicalRecordsChanged: false,
        },
        confirmation: enableConfirmationFor(company.code),
        expectedConfigurationVersion: state.configurationVersion,
      };
    });
  }

  public previewDisable(companyId: string) {
    return this.readOnly(async (db) => {
      const company = await this.company(db, companyId);
      const state = await this.configuration(db, companyId, false);
      const unresolved = await this.unresolvedWork(db, companyId);
      const blockers = state.accountingEnabled ? disableBlockers(unresolved) : [];
      const history = await this.historicalCounts(db, companyId);
      return {
        action: "disable" as const,
        company,
        current: state,
        alreadyDisabled: !state.accountingEnabled,
        attentionRequired: blockers.length > 0,
        blockers,
        unresolved,
        executable: state.accountingEnabled && blockers.length === 0,
        effects: {
          automaticPostingWillBeDisabled: state.automaticPostingEnabled,
          historicalRecordsPreserved: history,
          historicalRecordsChanged: false,
        },
        confirmation: disableConfirmationFor(company.code),
        expectedConfigurationVersion: state.configurationVersion,
      };
    });
  }

  // -------------------------------------------------------------------------
  // EXECUTE
  // -------------------------------------------------------------------------

  public async enable(
    companyId: string,
    input: AccountingModeChangeInput,
    actor: AccountingModeActor,
  ) {
    const reason = this.requireReason(input.reason);
    return this.transactions.execute(async (transaction) => {
      const company = await this.company(transaction, companyId);
      this.requireConfirmation(input.confirmation, enableConfirmationFor(company.code));
      await this.lockConfigurationScope(transaction, companyId);
      const before = await this.configuration(transaction, companyId, true);
      this.requireCurrentVersion(before, input.expectedConfigurationVersion);
      if (before.accountingEnabled) {
        return { changed: false as const, company, state: before };
      }
      const evaluation = await this.enableEvaluation(
        transaction,
        companyId,
        before.automaticPostingAreas,
      );
      if (evaluation.blockers.length > 0) {
        throw new ApplicationException(
          "accounting_enable_blocked",
          "Accounting cannot be enabled until the required setup is complete",
          HttpStatus.CONFLICT,
          blockerDetails(evaluation.blockers),
        );
      }
      // Platform administrators are not Company accounts, and every actor
      // column on this table is a composite FK to accounts(id, company_id).
      // They stay NULL; the actor is recorded in audit_events below.
      await sql`
        update accounting_configurations
           set accounting_enabled = true,
               automatic_posting_enabled = false,
               manual_accounting_activation_date = current_date,
               manual_accounting_enabled_by_account_id = null,
               manual_accounting_enabled_at = now(),
               updated_by_account_id = null,
               updated_at = now(),
               version = version + 1
         where company_id = ${companyId}::uuid
      `.execute(transaction);
      const after = await this.configuration(transaction, companyId, false);
      await this.annotateHistory(transaction, companyId, after, "enabled", reason);
      await this.audit(transaction, {
        action: "platform.company.accounting_enabled",
        actor,
        after,
        before,
        companyId,
        reason,
      });
      return { changed: true as const, company, before, after };
    });
  }

  public async disable(
    companyId: string,
    input: AccountingModeChangeInput,
    actor: AccountingModeActor,
  ) {
    const reason = this.requireReason(input.reason);
    const result = await this.transactions.execute(async (transaction) => {
      const company = await this.company(transaction, companyId);
      this.requireConfirmation(input.confirmation, disableConfirmationFor(company.code));
      await this.lockConfigurationScope(transaction, companyId);
      const before = await this.configuration(transaction, companyId, true);
      this.requireCurrentVersion(before, input.expectedConfigurationVersion);
      if (!before.accountingEnabled) {
        return { changed: false as const, company, state: before };
      }
      const unresolved = await this.unresolvedWork(transaction, companyId);
      const blockers = disableBlockers(unresolved);
      if (blockers.length > 0) {
        throw new ApplicationException(
          "accounting_disable_requires_attention",
          `Accounting has unresolved work: pending ${unresolved.pending}, failed ${unresolved.failed}, other unresolved ${unresolved.otherUnresolved}`,
          HttpStatus.CONFLICT,
          blockerDetails(blockers),
        );
      }
      // Automatic posting cannot stay on with Accounting off (the table's
      // automatic_shape_check), so it is switched off in the same statement.
      // The chosen areas are kept so a later re-enable starts from the same
      // configuration. Nothing else on the row changes.
      await sql`
        update accounting_configurations
           set accounting_enabled = false,
               automatic_posting_disabled_at = case when automatic_posting_enabled
                 then now() else automatic_posting_disabled_at end,
               automatic_posting_disabled_by_account_id = case when automatic_posting_enabled
                 then null else automatic_posting_disabled_by_account_id end,
               automatic_posting_change_reason = case when automatic_posting_enabled
                 then ${`Accounting disabled by Platform: ${reason}`}
                 else automatic_posting_change_reason end,
               automatic_posting_enabled = false,
               updated_by_account_id = null,
               updated_at = now(),
               version = version + 1
         where company_id = ${companyId}::uuid
      `.execute(transaction);
      const after = await this.configuration(transaction, companyId, false);
      await this.annotateHistory(transaction, companyId, after, "disabled", reason);
      await this.audit(transaction, {
        action: "platform.company.accounting_disabled",
        actor,
        after,
        before,
        companyId,
        reason,
      });
      return { changed: true as const, company, before, after };
    });
    if (!result.changed) return result;
    // VERIFY AGAIN, after commit. The capture gate takes FOR KEY SHARE on the
    // configuration row and the disable above took FOR UPDATE on it, so the
    // disable waited for every operation that had already captured an Event
    // to finish, and its unresolved-work check saw their Events; operations
    // after it see Accounting OFF. Nothing can therefore be stranded -- but if
    // this re-count ever finds unresolved work, the result says so and is
    // NOT reported as a clean success. Nothing is modified here.
    const postDisableVerification = await this.readOnly((db) => this.unresolvedWork(db, companyId));
    const clean = disableBlockers(postDisableVerification).length === 0;
    return {
      ...result,
      outcome: clean ? ("disabled" as const) : ("disabled_requires_attention" as const),
      postDisableVerification,
    };
  }

  // -------------------------------------------------------------------------
  // INTERNALS
  // -------------------------------------------------------------------------

  /**
   * Enable readiness.
   *
   * General requirements (configuration, fiscal year and period, posting
   * accounts, valid system accounts) always block. Per-area mapping and setup
   * findings block only for the areas that are ENABLED -- the Company's
   * configured `automatic_posting_areas`, or, when none are configured, the
   * core delivery areas every delivery Company produces Events for. A
   * disabled area's findings are returned as warnings. Nothing is created.
   */
  private async enableEvaluation(
    db: Kysely<DatabaseSchema>,
    companyId: string,
    configuredAreas: readonly string[],
  ) {
    const manual = await evaluateManualAccountingReadiness(db, companyId);
    const blockers: AccountingModeBlocker[] = manual.missingRequirements.map((code) => ({ code }));
    const warnings: AccountingModeBlocker[] = [];
    const configured = configuredAreas.filter((area): area is AccountingOperationalArea =>
      (accountingOperationalAreas as readonly string[]).includes(area),
    );
    const enabledAreas = configured.length > 0 ? configured : [...CORE_DELIVERY_ACCOUNTING_AREAS];
    const readiness = await this.automaticPosting.readinessForCompany(
      companyId,
      accountingOperationalAreas,
      undefined,
      db,
    );
    const blockersByArea: Record<string, AreaReadinessFindings> = {};
    const warningsByArea: Record<string, AreaReadinessFindings> = {};
    let periodReported = false;
    for (const area of readiness.areas) {
      const enabled = enabledAreas.includes(area.area);
      const findings: AreaReadinessFindings = {
        invalid_mapping: area.invalidMappings.map((invalid) => invalid.mappingKey),
        missing_mapping: [...area.missingMappings],
        other: area.activationBlockers.filter((code) => !AREA_MAPPING_CODES.has(code)),
      };
      const empty =
        findings.missing_mapping.length === 0 &&
        findings.invalid_mapping.length === 0 &&
        findings.other.length === 0;
      if (!enabled) {
        if (!empty) warningsByArea[area.area] = findings;
        for (const key of findings.missing_mapping) {
          warnings.push({ code: "required_mapping_missing", detail: `${area.area}:${key}` });
        }
        continue;
      }
      if (!periodReported && area.activationBlockers.includes("open_fiscal_period_missing")) {
        // `manual` only proves SOME period is open; Events are dated today.
        blockers.push({
          code: "open_fiscal_period_for_activation_date",
          detail: readiness.activationDate,
        });
        periodReported = true;
      }
      if (empty) continue;
      blockersByArea[area.area] = findings;
      for (const key of findings.missing_mapping) {
        blockers.push({ code: "required_mapping_missing", detail: `${area.area}:${key}` });
      }
      for (const key of findings.invalid_mapping) {
        blockers.push({ code: "required_mapping_invalid", detail: `${area.area}:${key}` });
      }
      for (const code of findings.other) {
        blockers.push({ code, detail: area.area });
      }
    }
    // A drawer created while Accounting was OFF may have no GL account. Every
    // cash movement it funds would then fail to post, so it must be linked
    // before Accounting can be turned on -- whichever areas are enabled.
    const glLess = await sql<{ code: string }>`
      select cash_account_code as code from company_cash_accounts
       where company_id = ${companyId}::uuid and is_active and linked_gl_account_id is null
       order by cash_account_code
    `.execute(db);
    for (const row of glLess.rows) {
      blockers.push({ code: "cash_account_without_gl", detail: row.code });
    }
    // The same for a bank account created while Accounting was OFF. It is
    // never auto-mapped: someone must choose its GL account.
    const glLessBanks = await sql<{ code: string }>`
      select coalesce(bank_account_code, account_name) as code from company_bank_accounts
       where company_id = ${companyId}::uuid and is_active and linked_gl_account_id is null
       order by 1
    `.execute(db);
    for (const row of glLessBanks.rows) {
      blockers.push({ code: "bank_account_without_gl", detail: row.code });
    }
    return {
      areas: readiness.areas,
      blockers,
      blockersByArea,
      enabledAreas,
      enabledAreasSource:
        configured.length > 0 ? ("configured" as const) : ("core_default" as const),
      manual,
      warnings,
      warningsByArea,
    };
  }

  private async unresolvedWork(
    db: Kysely<DatabaseSchema>,
    companyId: string,
  ): Promise<UnresolvedAccountingWork> {
    const grouped = await sql<{ status: string; eventType: string; count: number }>`
      select processing_status as status, event_type as "eventType", count(*)::int as count
        from accounting_events
       where company_id = ${companyId}::uuid
         and processing_status = any(${UNRESOLVED_EVENT_STATUSES}::text[])
       group by processing_status, event_type
       order by processing_status, event_type
    `.execute(db);
    const samples = await sql<{ id: string }>`
      select id from accounting_events
       where company_id = ${companyId}::uuid
         and processing_status = any(${UNRESOLVED_EVENT_STATUSES}::text[])
       order by created_at, id
       limit ${SAMPLE_EVENT_LIMIT}
    `.execute(db);
    const journals = await sql<{ status: string; count: number }>`
      select status, count(*)::int as count from journal_entries
       where company_id = ${companyId}::uuid
         and status = any(${UNFINISHED_JOURNAL_STATUSES}::text[])
       group by status order by status
    `.execute(db);
    const batches = await sql<{ status: string; count: number }>`
      select status, count(*)::int as count from accounting_batch_jobs
       where company_id = ${companyId}::uuid
         and status = any(${RUNNING_BATCH_STATUSES}::text[])
       group by status order by status
    `.execute(db);
    const total = (statuses: readonly string[]) =>
      grouped.rows
        .filter((row) => statuses.includes(row.status))
        .reduce((sum, row) => sum + row.count, 0);
    return {
      eventsByStatus: grouped.rows,
      failed: total(FAILED_EVENT_STATUSES),
      otherUnresolved: total(IN_FLIGHT_EVENT_STATUSES),
      pending: total(PENDING_EVENT_STATUSES),
      runningBatches: batches.rows,
      sampleEventIds: samples.rows.map((row) => row.id),
      unfinishedJournals: journals.rows,
    };
  }

  private async historicalCounts(db: Kysely<DatabaseSchema>, companyId: string) {
    const counts = await sql<{ accountingEvents: number; journalEntries: number }>`
      select
        (select count(*)::int from accounting_events where company_id = ${companyId}::uuid)
          as "accountingEvents",
        (select count(*)::int from journal_entries where company_id = ${companyId}::uuid)
          as "journalEntries"
    `.execute(db);
    return counts.rows[0]!;
  }

  private async company(db: Kysely<DatabaseSchema>, companyId: string): Promise<CompanyIdentity> {
    const row = await sql<CompanyIdentity>`
      select id, code, name_en as name from companies
       where id = ${companyId}::uuid
    `.execute(db);
    const company = row.rows[0];
    if (company === undefined) {
      throw new ApplicationException(
        "company_not_found",
        "The requested Company does not exist",
        HttpStatus.NOT_FOUND,
      );
    }
    return company;
  }

  private async configuration(
    db: Kysely<DatabaseSchema>,
    companyId: string,
    lock: boolean,
  ): Promise<ConfigurationState> {
    const row = await sql<Omit<ConfigurationState, "configurationExists">>`
      select accounting_enabled as "accountingEnabled",
             automatic_posting_enabled as "automaticPostingEnabled",
             automatic_posting_areas as "automaticPostingAreas",
             manual_accounting_activation_date::text as "manualAccountingActivationDate",
             manual_accounting_enabled_at as "manualAccountingEnabledAt",
             version::text as "configurationVersion"
        from accounting_configurations
       where company_id = ${companyId}::uuid
       ${lock ? sql`for update` : sql``}
    `.execute(db);
    const state = row.rows[0];
    if (state === undefined) {
      return {
        accountingEnabled: false,
        automaticPostingAreas: [],
        automaticPostingEnabled: false,
        configurationExists: false,
        configurationVersion: null,
        manualAccountingActivationDate: null,
        manualAccountingEnabledAt: null,
      };
    }
    return { ...state, configurationExists: true };
  }

  /** Same advisory key the Company-side configuration operations take. */
  private async lockConfigurationScope(db: Kysely<DatabaseSchema>, companyId: string) {
    await sql`
      select pg_advisory_xact_lock(
        hashtextextended('accounting_account_configuration:' || ${companyId}::text, 0)
      )
    `.execute(db);
  }

  /**
   * The configuration history trigger attributes a change to
   * `coalesce(updated_by, created_by)`. A Platform change leaves
   * `updated_by` NULL, which would silently credit the change to whoever
   * CREATED the configuration. The row the trigger just wrote, in this same
   * transaction, is therefore annotated: no Company actor, and the reason.
   * Only that one version row is touched; earlier history is never rewritten.
   */
  private async annotateHistory(
    db: Kysely<DatabaseSchema>,
    companyId: string,
    after: ConfigurationState,
    change: "disabled" | "enabled",
    reason: string,
  ) {
    await sql`
      update accounting_configuration_history
         set changed_by_account_id = null,
             change_reason = ${`Platform: Accounting ${change}. ${reason}`}
       where company_id = ${companyId}::uuid
         and configuration_version = ${after.configurationVersion}::bigint
    `.execute(db);
  }

  /** In-transaction Platform audit row, same markers as PlatformAuditService. */
  private async audit(
    db: Kysely<DatabaseSchema>,
    input: {
      action: string;
      actor: AccountingModeActor;
      after: ConfigurationState;
      before: ConfigurationState;
      companyId: string;
      reason: string;
    },
  ) {
    const snapshot = (state: ConfigurationState) => ({
      accountingEnabled: state.accountingEnabled,
      automaticPostingEnabled: state.automaticPostingEnabled,
      configurationExists: state.configurationExists,
      configurationVersion: state.configurationVersion,
    });
    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id, reason,
        before_data, after_data, correlation_id, actor_role, source, result, source_application
      ) values (
        ${input.companyId}::uuid, ${input.actor.accountId}::uuid, ${input.action},
        'accounting_configuration', ${input.companyId}, ${input.reason},
        ${JSON.stringify(snapshot(input.before))}::jsonb,
        ${JSON.stringify(snapshot(input.after))}::jsonb,
        ${input.actor.correlationId}, 'platform_administrator', 'platform_portal',
        'success', 'platform-web'
      )
    `.execute(db);
  }

  private async readOnly<T>(work: (db: Kysely<DatabaseSchema>) => Promise<T>): Promise<T> {
    return this.transactions.execute(async (transaction) => {
      await sql`set transaction read only`.execute(transaction);
      return work(transaction);
    });
  }

  private requireReason(reason: string): string {
    const trimmed = typeof reason === "string" ? reason.trim() : "";
    if (trimmed.length === 0) {
      throw new ApplicationException(
        "accounting_mode_reason_required",
        "A reason is required to change a Company's Accounting mode",
        HttpStatus.BAD_REQUEST,
      );
    }
    return trimmed;
  }

  private requireConfirmation(given: string, expected: string): void {
    if (given.trim() !== expected) {
      throw new ApplicationException(
        "accounting_mode_confirmation_mismatch",
        `Type ${expected} to confirm`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private requireCurrentVersion(state: ConfigurationState, expected: string | null): void {
    if (state.configurationVersion !== expected) {
      throw new ApplicationException(
        "accounting_mode_preview_stale",
        "The Company's Accounting configuration changed after the preview; preview again",
        HttpStatus.CONFLICT,
      );
    }
  }
}
