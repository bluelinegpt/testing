import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountMappingResolver, type ResolvedOperationalLine } from "./account-mapping.resolver.js";
import { AccountingEventQueryService } from "./accounting-event-query.service.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import type { AccountingEventType } from "./accounting.constants.js";
import {
  OperationalSourceLoader,
  type OperationalAccountingEventRecord,
  type OperationalJournalFacts,
} from "./operational-source.loader.js";

/**
 * Reprocess precheck — a dry run of the posting pipeline, without the posting.
 *
 * ===========================================================================
 * THE SAME PIPELINE, STOPPED BEFORE THE FIRST WRITE
 * ===========================================================================
 *
 * `OperationalJournalPostingService.process()` runs: load source facts ->
 * resolve fiscal period -> resolve mappings -> assert balanced -> write. This
 * precheck runs the SAME first four steps with the SAME services -- the
 * operational source loader, the account-mapping resolver, the same period
 * join and the same balance test -- and then stops. Nothing is restated: a
 * blocker reported here is the exact refusal posting would raise, carrying
 * the posting pipeline's own error code.
 *
 * Two deliberate differences from the real pipeline, both read-only:
 *
 *  - the fiscal-period lookup takes no `for update` lock -- a precheck must
 *    not queue behind or block a real posting;
 *  - loader/resolver failures are CAUGHT and returned as blockers instead of
 *    thrown, because "would this work" is the question, and the answer "no,
 *    because X" is a result, not an error.
 *
 * It writes nothing, changes no Event status, creates no Journal, and is safe
 * to rerun any number of times. Prechecking cannot make posting more likely to
 * succeed -- the pipeline re-checks everything itself -- it only makes the
 * refusal visible before a person commits to the attempt.
 *
 * ===========================================================================
 * WHAT IT ADDS BEYOND `reprocessingReadiness`
 * ===========================================================================
 *
 * Readiness answers "may this Event be re-queued" from stored state. The
 * precheck additionally answers "would the posting SUCCEED": source facts
 * still load, mappings resolve to postable accounts today, the period is open,
 * the expected Journal balances, and the source's financial values still agree
 * with what the Event recorded when it last validated. Readiness blockers are
 * included wholesale, so one call gives the full answer.
 */

interface EventRow {
  readonly correlationId: string;
  readonly effectiveAccountingDate: string | null;
  readonly eventHash: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly id: string;
  readonly journalId: string | null;
  readonly journalNumber: string | null;
  readonly operationalArea: string | null;
  readonly processingStatus: string;
  readonly reversalOfEventId: string | null;
  readonly sourceEntityId: string;
  readonly sourceEntityType: string;
  readonly sourceReference: string | null;
}

/**
 * Exported for the same reason as the dashboard's row types: the precheck's
 * inferred return type reaches a controller method, and declaration emit
 * cannot name a module-private interface (TS4053).
 */
export interface Blocking {
  readonly code: string;
  readonly message: string;
}

@Injectable()
export class AccountingReprocessPrecheckService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(AccountingOperationSupport) private readonly support: AccountingOperationSupport,
    @Inject(AccountingEventQueryService) private readonly events: AccountingEventQueryService,
    @Inject(OperationalSourceLoader) private readonly sources: OperationalSourceLoader,
    @Inject(AccountMappingResolver) private readonly mappings: AccountMappingResolver,
  ) {}

  /**
   * Controlled execution: the existing single-Event reprocess, with the FULL
   * precheck re-run as a revalidation hook inside that method's flow — after
   * its idempotency replay check (an exact replay still returns the stored
   * result) and before any write. The frontend's precheck outcome is never
   * trusted; the one that matters is the one run here, now.
   *
   * Financial-drift is the one precheck WARNING that does not refuse: posting
   * re-derives everything from the source, and the processor's own hash guard
   * refuses a validated Event whose source changed. Every blocker refuses.
   *
   * Reprocess itself only re-queues the Event for the normal processor —
   * mapping resolution, period locks, balancing and the Journal write all
   * happen there, exactly once, under the pipeline's own guards. That is why
   * this method can add a revalidation without duplicating any posting logic,
   * and why a Journal reference in the response appears only when one already
   * exists: Journal creation stays asynchronous.
   */
  public async execute(
    eventId: string,
    input: { readonly expectedStatus?: string; readonly reason: string },
    idempotencyKey: string | undefined,
  ) {
    this.support.assertAnyPermission("accounting.post", "accounting.manage");
    return this.events.reprocess(eventId, input, idempotencyKey, async () => {
      const result = await this.precheck(eventId);
      if (!result.allowed) {
        throw new ApplicationException(
          "accounting_event_precheck_blocked",
          "Conditions changed since the precheck; reprocessing was refused",
          HttpStatus.CONFLICT,
          result.blockers.map((blocker) => blocker.code),
        );
      }
    });
  }

  public async precheck(eventId: string) {
    this.support.assertAnyPermission("accounting.post", "accounting.manage");
    const { companyId } = this.support.context();

    const eventResult = await sql<EventRow>`
      select e.id, e.event_type as "eventType", e.event_version as "eventVersion",
             e.processing_status as "processingStatus",
             e.source_entity_type as "sourceEntityType",
             e.source_entity_id as "sourceEntityId",
             e.source_reference as "sourceReference",
             e.effective_accounting_date::text as "effectiveAccountingDate",
             e.operational_area as "operationalArea",
             e.reversal_of_event_id as "reversalOfEventId",
             e.event_hash as "eventHash", e.correlation_id::text as "correlationId",
             e.journal_id as "journalId", j.journal_number as "journalNumber"
        from accounting_events e
        left join journal_entries j on j.id = e.journal_id and j.company_id = e.company_id
       where e.id = ${eventId}::uuid and e.company_id = ${companyId}::uuid
    `.execute(this.database);
    const event = eventResult.rows[0];
    // Another Company's Event and a nonexistent one give the same answer.
    if (event === undefined) {
      throw new ApplicationException(
        "accounting_event_not_found",
        "The Accounting Event was not found",
        HttpStatus.NOT_FOUND,
      );
    }

    const blockers: Blocking[] = [];
    const warnings: Blocking[] = [];

    // Stored-state eligibility — the existing readiness service, wholesale.
    const readiness = await this.events.reprocessingReadiness(eventId);
    for (const code of readiness.blockers) {
      blockers.push({ code, message: this.describe(code) });
    }

    // A SECOND posted claim on the same source, beyond this Event. Readiness
    // looks at this Event's own state; a duplicate is a fact about the source.
    const duplicate = await sql<{ id: string; reference: string | null }>`
      select id, source_reference as reference from accounting_events
       where company_id = ${companyId}::uuid and id <> ${eventId}::uuid
         and source_entity_type = ${event.sourceEntityType}
         and source_entity_id = ${event.sourceEntityId}::uuid
         and event_type = ${event.eventType}
         and processing_status = 'posted'
       limit 1
    `.execute(this.database);
    if (duplicate.rows[0] !== undefined) {
      blockers.push({
        code: "accounting_event_duplicate_posted",
        message: "Another posted Accounting Event already covers this source record",
      });
    }
    // A posted Journal for the source that this Event does not own.
    const sourceJournal = await sql<{ id: string; journalNumber: string }>`
      select id, journal_number as "journalNumber" from journal_entries
       where company_id = ${companyId}::uuid
         and source_entity_type = ${event.sourceEntityType}
         and source_entity_id = ${event.sourceEntityId}::uuid
         and status = 'posted'
         and (${event.journalId}::uuid is null or id <> ${event.journalId}::uuid)
       limit 1
    `.execute(this.database);
    if (sourceJournal.rows[0] !== undefined) {
      blockers.push({
        code: "accounting_journal_exists_for_source",
        message: "A posted Journal already exists for this source record",
      });
    }

    // Reversal Events replay a stored original rather than loading a source;
    // their dry run is a different question and is not answered here.
    if (event.reversalOfEventId !== null || event.eventType.endsWith("_reversed")) {
      blockers.push({
        code: "accounting_event_reversal_not_precheckable",
        message: "Reversal Events replay their original Journal and have no forward precheck",
      });
    }

    // The posting pipeline's own first steps, stopped before the first write.
    let facts: OperationalJournalFacts | undefined;
    let lines: readonly ResolvedOperationalLine[] = [];
    let period: { fiscalPeriodId: string; fiscalPeriodStatus: string } | undefined;
    if (event.reversalOfEventId === null && !event.eventType.endsWith("_reversed")) {
      const record: OperationalAccountingEventRecord = {
        actorId: null,
        companyId,
        correlationId: event.correlationId,
        effectiveAccountingDate: event.effectiveAccountingDate ?? "",
        eventHash: event.eventHash,
        eventType: event.eventType as AccountingEventType,
        eventVersion: event.eventVersion,
        id: event.id,
        operationalArea: event.operationalArea ?? "",
        reversalOfEventId: null,
        sourceEntityId: event.sourceEntityId,
        sourceEntityType: event.sourceEntityType,
        sourceReference: event.sourceReference,
      };
      facts = await this.attempt(blockers, () => this.sources.load(this.database, record));
      if (facts !== undefined) {
        if (facts.components.length === 0) {
          // The loader dropped every component as zero: nothing to post. For
          // an Order this IS the No Accounting Required answer, and no
          // zero-value Journal may ever be manufactured to fill the gap.
          blockers.push({
            code: "accounting_no_posting_required",
            message: "The source has no financial components to post",
          });
        }
        if (facts.accountingDate.length !== 10) {
          blockers.push({
            code: "accounting_event_accounting_date_missing",
            message: "The operational source has no valid Accounting Date",
          });
        } else {
          if (
            event.effectiveAccountingDate !== null &&
            event.effectiveAccountingDate !== facts.accountingDate
          ) {
            // The source date is authoritative; posting corrects the Event to
            // it rather than shifting the posting. Worth knowing, not fatal.
            warnings.push({
              code: "accounting_date_differs_from_source",
              message:
                "The Event's stored Accounting Date differs from the source; posting uses the source date",
            });
          }
          period = await this.periodFor(companyId, facts.accountingDate, blockers);
          if (facts.components.length > 0) {
            lines = (await this.attempt(blockers, () =>
              this.mappings.resolve(this.database, companyId, facts!.accountingDate, facts!.components),
            )) ?? [];
          }
        }
        await this.compareStoredComponents(companyId, eventId, facts, warnings);
      }
    }

    // The pipeline's balance test, on the pipeline's own resolved lines.
    const debit = lines
      .filter((line) => line.component.entryIntent === "debit")
      .reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
    const credit = lines
      .filter((line) => line.component.entryIntent === "credit")
      .reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
    if (lines.length > 0 && (lines.length < 2 || !debit.greaterThan(0) || !debit.equals(credit))) {
      blockers.push({
        code: "accounting_event_not_balanced",
        message: "The authoritative operational components do not form a balanced Journal",
      });
    }

    const allowed = blockers.length === 0;
    return {
      accountingDate: facts?.accountingDate ?? event.effectiveAccountingDate,
      allowed,
      event: {
        id: event.id,
        reference: event.sourceReference,
        status: event.processingStatus,
      },
      existing: {
        journalId: event.journalId,
        journalNumber: event.journalNumber,
        otherPostedEventId: duplicate.rows[0]?.id ?? null,
        otherPostedJournalId: sourceJournal.rows[0]?.id ?? null,
      },
      expectedCreditTotal: credit.toFixed(2),
      expectedDebitTotal: debit.toFixed(2),
      expectedPostingType: event.eventType,
      fiscalPeriod: {
        id: period?.fiscalPeriodId ?? null,
        status: period?.fiscalPeriodStatus ?? null,
      },
      blockers,
      // Account codes and names only — how they were resolved is the mapping
      // module's business, not the caller's.
      resolvedMappings: lines.map((line) => ({
        accountCode: line.accountCode,
        accountName: line.accountNameEn,
        accountNameAr: line.accountNameAr,
        amount: line.amount,
        entryIntent: line.component.entryIntent,
        mappingKey: line.component.mappingKey,
      })),
      recommendedAction: allowed
        ? "reprocess"
        : readiness.blockers.includes("event_already_posted") ||
            blockers.some((blocker) => blocker.code === "accounting_journal_exists_for_source")
          ? "none"
          : "resolve_blockers",
      source: {
        id: event.sourceEntityId,
        reference: facts?.sourceReference ?? event.sourceReference,
        type: event.sourceEntityType,
      },
      warnings,
    };
  }

  /** Runs a pipeline step, converting its refusal into a blocker. */
  private async attempt<T>(blockers: Blocking[], step: () => Promise<T>): Promise<T | undefined> {
    try {
      return await step();
    } catch (error) {
      if (error instanceof ApplicationException) {
        // The pipeline's own public code and message — already written to be
        // shown, never a constraint name or a stack.
        blockers.push({ code: error.errorCode, message: error.message });
        return undefined;
      }
      blockers.push({
        code: "accounting_precheck_failed",
        message: "The posting precheck could not evaluate this step",
      });
      return undefined;
    }
  }

  /** The posting pipeline's period test, without its locks. */
  private async periodFor(
    companyId: string,
    accountingDate: string,
    blockers: Blocking[],
  ): Promise<{ fiscalPeriodId: string; fiscalPeriodStatus: string } | undefined> {
    const result = await sql<{
      fiscalPeriodId: string;
      fiscalPeriodStatus: string;
      fiscalYearStatus: string;
    }>`
      select p.id as "fiscalPeriodId", p.status as "fiscalPeriodStatus",
             y.status as "fiscalYearStatus"
        from accounting_periods p
        join fiscal_years y on y.id = p.fiscal_year_id and y.company_id = p.company_id
       where p.company_id = ${companyId}::uuid
         and ${accountingDate}::date between p.period_start and p.period_end
    `.execute(this.database);
    if (result.rows.length !== 1) {
      blockers.push({
        code: "accounting_event_fiscal_period_not_found",
        message: "The Accounting Date does not resolve to one Fiscal Period",
      });
      return undefined;
    }
    const period = result.rows[0]!;
    if (!["open", "reopened"].includes(period.fiscalYearStatus)) {
      blockers.push({
        code: "accounting_event_fiscal_year_closed",
        message: "The Fiscal Year is not open for automatic posting",
      });
    }
    if (!["open", "reopened"].includes(period.fiscalPeriodStatus)) {
      blockers.push({
        code:
          period.fiscalPeriodStatus === "soft_closed"
            ? "accounting_event_period_soft_closed"
            : "accounting_event_period_closed",
        message: "The Fiscal Period is not open for automatic posting",
      });
    }
    return period;
  }

  /**
   * Financial-drift check: the components the Event recorded when it last
   * validated versus the components the source produces NOW, compared as
   * per-(mapping key, intent) sums. A drifted source is a warning rather than
   * a blocker — posting itself re-derives from the source and refuses a hash
   * mismatch on a validated Event — but a person should know the figures they
   * reviewed are not the figures that would post.
   */
  private async compareStoredComponents(
    companyId: string,
    eventId: string,
    facts: OperationalJournalFacts,
    warnings: Blocking[],
  ): Promise<void> {
    const stored = await sql<{ amount: string; entryIntent: string; mappingKey: string }>`
      select mapping_key as "mappingKey", entry_intent as "entryIntent",
             sum(amount)::numeric(18,2)::text as amount
        from accounting_event_components
       where company_id = ${companyId}::uuid and accounting_event_id = ${eventId}::uuid
       group by mapping_key, entry_intent
    `.execute(this.database);
    // An Event that never validated stored no components; there is nothing to
    // have drifted from.
    if (stored.rows.length === 0) return;
    const current = new Map<string, Decimal>();
    for (const component of facts.components) {
      const key = `${component.mappingKey}:${component.entryIntent}`;
      current.set(key, (current.get(key) ?? new Decimal(0)).plus(component.amount));
    }
    const drifted =
      stored.rows.length !== current.size ||
      stored.rows.some((row) => {
        const now = current.get(`${row.mappingKey}:${row.entryIntent}`);
        return now === undefined || !now.equals(row.amount);
      });
    if (drifted) {
      warnings.push({
        code: "source_financial_values_changed",
        message:
          "The source's financial values no longer match what this Event recorded when it validated",
      });
    }
  }

  /** Human-facing text for the readiness service's blocker codes. */
  private describe(code: string): string {
    const messages: Readonly<Record<string, string>> = {
      accounting_disabled: "Accounting is disabled for this Company",
      automatic_posting_disabled: "Automatic Posting is disabled",
      event_already_posted: "The Accounting Event is already posted",
      event_currently_processing: "The Accounting Event is currently processing",
      event_ignored_duplicate: "The Accounting Event was ignored as a duplicate",
      event_journal_already_exists: "A Journal already exists for this Accounting Event",
      event_reversed: "The Accounting Event was reversed",
      event_status_not_reprocessable: "This Accounting Event status cannot be reprocessed",
      operational_area_disabled: "The operational area is disabled",
      source_record_missing: "The underlying source record no longer exists",
    };
    return messages[code] ?? "This Accounting Event cannot be reprocessed";
  }
}
