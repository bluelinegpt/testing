import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { ResolvedOperationalLine } from "./account-mapping.resolver.js";
import { AccountMappingResolver } from "./account-mapping.resolver.js";
import type {
  OperationalAccountingEventRecord,
  OperationalJournalFacts,
} from "./operational-source.loader.js";
import { OperationalSourceLoader } from "./operational-source.loader.js";

interface FiscalContext {
  readonly fiscalPeriodId: string;
  readonly fiscalPeriodStatus: string;
  readonly fiscalYearId: string;
  readonly fiscalYearStatus: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

@Injectable()
export class OperationalJournalPostingService {
  public constructor(
    @Inject(AccountMappingResolver) private readonly mappings: AccountMappingResolver,
    @Inject(OperationalSourceLoader) private readonly sources: OperationalSourceLoader,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
  ) {}

  public async process(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
  ): Promise<{ readonly journalId: string; readonly journalNumber: string }> {
    if (event.reversalOfEventId !== null) return this.reverse(database, event);
    if (event.eventType.endsWith("_reversed") || event.eventType === "order_recognition_reversed") {
      throw new ApplicationException(
        "accounting_event_original_not_posted",
        "No Posted original Accounting Event exists for this operational reversal",
        HttpStatus.CONFLICT,
      );
    }
    const facts = await this.sources.load(database, event);
    this.assertAccountingDate(event, facts);
    const hash = this.eventHash(event, facts);
    await this.persistCanonicalEvent(database, event, facts, hash);
    const period = await this.fiscalContext(database, event.companyId, facts.accountingDate);
    const lines = await this.mappings.resolve(
      database,
      event.companyId,
      facts.accountingDate,
      facts.components,
    );
    this.assertBalanced(lines);
    const actorId = this.actor(event);
    const journalId = randomUUID();
    const journalNumber = await this.nextJournalNumber(database, event.companyId);
    await sql`
      insert into journal_entries (
        id,company_id,journal_number,accounting_period_id,fiscal_year_id,
        business_date,journal_type,source_type,source_id,description,currency,
        exchange_rate,status,source_entity_type,source_entity_id,source_reference,
        correlation_id,idempotency_key,accounting_event_id,
        created_by_account_id,updated_by_account_id
      ) values (
        ${journalId}::uuid,${event.companyId}::uuid,${journalNumber},
        ${period.fiscalPeriodId}::uuid,${period.fiscalYearId}::uuid,
        ${facts.accountingDate}::date,'operational',${facts.journalSource},
        ${event.sourceEntityId}::uuid,${facts.description},'AED',1,'draft',
        ${event.sourceEntityType},${event.sourceEntityId}::uuid,
        ${facts.sourceReference},${event.correlationId},${event.id},
        ${event.id}::uuid,${actorId}::uuid,${actorId}::uuid
      )
    `.execute(database);
    await this.insertLines(database, event, journalId, lines, actorId);
    await sql`
      update journal_entries set status='balanced',version=version+1
       where id=${journalId}::uuid and company_id=${event.companyId}::uuid
    `.execute(database);
    await sql`
      update journal_entries
         set status='approved',approved_by_account_id=${actorId}::uuid,
             approved_at=now(),approval_note='Automatically approved from validated operational Event',
             version=version+1
       where id=${journalId}::uuid and company_id=${event.companyId}::uuid
    `.execute(database);
    await sql`
      update journal_entries
         set status='posted',posted_by_account_id=${actorId}::uuid,posted_at=now(),
             posting_note='Automatically posted from Accounting Event',
             updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
       where id=${journalId}::uuid and company_id=${event.companyId}::uuid
    `.execute(database);
    await sql`
      update accounting_events
         set processing_status='posted',journal_id=${journalId}::uuid,
             processed_at=now(),processing_locked_at=null,processing_locked_by=null,
             supplementary_metadata=supplementary_metadata ||
               ${JSON.stringify({ facts: facts.metadata })}::jsonb
       where id=${event.id}::uuid and company_id=${event.companyId}::uuid
    `.execute(database);
    await this.history.audit(database, {
      action: "accounting.operational_event.posted",
      actorId,
      after: { eventId: event.id, eventType: event.eventType, journalId, journalNumber },
      companyId: event.companyId,
      correlationId: event.correlationId,
      subjectId: journalId,
      subjectType: "journal",
    });
    return { journalId, journalNumber };
  }

  private async reverse(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
  ): Promise<{ readonly journalId: string; readonly journalNumber: string }> {
    const actorId = this.actor(event);
    const originalResult = await sql<{
      businessDate: string;
      description: string;
      journalId: string;
      sourceType: string;
      status: string;
    }>`
      select j.id as "journalId",j.business_date::text as "businessDate",
             j.description,j.source_type as "sourceType",j.status
        from accounting_events original
        join journal_entries j
          on j.id=original.journal_id and j.company_id=original.company_id
       where original.id=${event.reversalOfEventId}::uuid
         and original.company_id=${event.companyId}::uuid
       for update of original,j
    `.execute(database);
    const original = originalResult.rows[0];
    if (original === undefined) {
      throw new ApplicationException(
        "accounting_event_original_not_posted",
        "The original operational Event has no Posted Journal to reverse",
        HttpStatus.CONFLICT,
      );
    }
    if (original.status !== "posted") {
      throw new ApplicationException(
        "accounting_event_already_reversed",
        "The original operational Journal is not available for reversal",
        HttpStatus.CONFLICT,
      );
    }
    const period = await this.fiscalContext(
      database,
      event.companyId,
      event.effectiveAccountingDate,
    );
    const journalId = randomUUID();
    const journalNumber = await this.nextJournalNumber(database, event.companyId);
    await sql`
      insert into journal_entries (
        id,company_id,journal_number,accounting_period_id,fiscal_year_id,
        business_date,journal_type,source_type,source_id,description,currency,
        exchange_rate,status,source_entity_type,source_entity_id,source_reference,
        correlation_id,idempotency_key,reversal_of_id,accounting_event_id,
        created_by_account_id,updated_by_account_id
      ) values (
        ${journalId}::uuid,${event.companyId}::uuid,${journalNumber},
        ${period.fiscalPeriodId}::uuid,${period.fiscalYearId}::uuid,
        ${event.effectiveAccountingDate}::date,'reversal','reversal',
        ${event.sourceEntityId}::uuid,${`Reversal: ${original.description}`},'AED',
        1,'draft',${event.sourceEntityType},${event.sourceEntityId}::uuid,
        ${event.sourceReference},${event.correlationId},${event.id},
        ${original.journalId}::uuid,${event.id}::uuid,
        ${actorId}::uuid,${actorId}::uuid
      )
    `.execute(database);
    await sql`
      insert into journal_lines (
        company_id,journal_entry_id,line_number,account_id,debit,credit,description,
        subledger_type,subledger_id,trader_id,driver_id,employee_id,order_id,
        trader_settlement_id,driver_collection_id,payroll_period_id,payroll_payment_id,
        outsourced_driver_fee_accrual_id,outsourced_driver_fee_payment_id,
        general_expense_id,general_expense_payment_id,
        company_bank_account_id,company_cash_account_id,cash_bank_movement_id,source_entity_type,
        source_entity_id,created_by_account_id,updated_by_account_id
      )
      select company_id,${journalId}::uuid,line_number,account_id,credit,debit,
             'Reversal: '||coalesce(description,''),subledger_type,subledger_id,
             trader_id,driver_id,employee_id,order_id,trader_settlement_id,
             driver_collection_id,payroll_period_id,payroll_payment_id,
             outsourced_driver_fee_accrual_id,outsourced_driver_fee_payment_id,
             general_expense_id,general_expense_payment_id,
             company_bank_account_id,company_cash_account_id,cash_bank_movement_id,source_entity_type,
             source_entity_id,${actorId}::uuid,${actorId}::uuid
        from journal_lines
       where company_id=${event.companyId}::uuid
         and journal_entry_id=${original.journalId}::uuid
       order by line_number
    `.execute(database);
    await sql`update journal_entries set status='balanced',version=version+1
               where id=${journalId}::uuid and company_id=${event.companyId}::uuid`.execute(
      database,
    );
    await sql`
      update journal_entries
         set status='approved',approved_by_account_id=${actorId}::uuid,
             approved_at=now(),approval_note='Automatic operational reversal',
             version=version+1
       where id=${journalId}::uuid and company_id=${event.companyId}::uuid
    `.execute(database);
    await sql`
      update journal_entries
         set status='posted',posted_by_account_id=${actorId}::uuid,posted_at=now(),
             posting_note='Posted from approved operational reversal',
             updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
       where id=${journalId}::uuid and company_id=${event.companyId}::uuid
    `.execute(database);
    await sql`
      update journal_entries
         set status='reversed',reversed_by_journal_id=${journalId}::uuid,
             reversed_by_account_id=${actorId}::uuid,reversed_at=now(),
             reversal_reason='Approved operational reversal',
             updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
       where id=${original.journalId}::uuid and company_id=${event.companyId}::uuid
    `.execute(database);
    // Two separate executions, not one semicolon-joined template: a `sql`
    // template that carries bound parameters is sent through the extended
    // query protocol, which accepts exactly ONE command per statement.
    // Combining both updates raised `42601 — cannot insert multiple commands
    // into a prepared statement`, which rolled back the whole reversal after
    // the Journal, its inverted lines and the original Journal update had all
    // succeeded. Both statements still run inside the caller's transaction, so
    // atomicity is unchanged.
    await sql`
      update accounting_events
         set processing_status='reversed',reversal_journal_id=${journalId}::uuid
       where id=${event.reversalOfEventId}::uuid and company_id=${event.companyId}::uuid
    `.execute(database);
    await sql`
      update accounting_events
         set processing_status='posted',journal_id=${journalId}::uuid,
             validated_at=coalesce(validated_at,now()),processed_at=now(),
             processing_locked_at=null,processing_locked_by=null
       where id=${event.id}::uuid and company_id=${event.companyId}::uuid
    `.execute(database);
    await this.history.audit(database, {
      action: "accounting.operational_event.reversed",
      actorId,
      after: {
        eventId: event.id,
        journalId,
        journalNumber,
        originalEventId: event.reversalOfEventId,
        originalJournalId: original.journalId,
      },
      companyId: event.companyId,
      correlationId: event.correlationId,
      subjectId: journalId,
      subjectType: "journal",
    });
    return { journalId, journalNumber };
  }

  private async fiscalContext(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    accountingDate: string,
  ): Promise<FiscalContext> {
    const result = await sql<FiscalContext>`
      select p.id as "fiscalPeriodId",p.status as "fiscalPeriodStatus",
             y.id as "fiscalYearId",y.status as "fiscalYearStatus"
        from accounting_periods p
        join fiscal_years y on y.id=p.fiscal_year_id and y.company_id=p.company_id
       where p.company_id=${companyId}::uuid
         and ${accountingDate}::date between p.period_start and p.period_end
       for update of p,y
    `.execute(database);
    if (result.rows.length !== 1) {
      throw new ApplicationException(
        "accounting_event_fiscal_period_not_found",
        "The Accounting Date does not resolve to one Fiscal Period",
        HttpStatus.CONFLICT,
      );
    }
    const period = result.rows[0]!;
    if (!["open", "reopened"].includes(period.fiscalYearStatus)) {
      throw new ApplicationException(
        "accounting_event_fiscal_year_closed",
        "The Fiscal Year is not open for automatic posting",
        HttpStatus.CONFLICT,
      );
    }
    if (!["open", "reopened"].includes(period.fiscalPeriodStatus)) {
      throw new ApplicationException(
        period.fiscalPeriodStatus === "soft_closed"
          ? "accounting_event_period_soft_closed"
          : "accounting_event_period_closed",
        "The Fiscal Period is not open for automatic posting",
        HttpStatus.CONFLICT,
      );
    }
    return period;
  }

  private async persistCanonicalEvent(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
    facts: OperationalJournalFacts,
    hash: string,
  ): Promise<void> {
    const existing = await sql<{ eventHash: string; validatedAt: Date | null }>`
      select event_hash as "eventHash",validated_at as "validatedAt"
        from accounting_events where id=${event.id}::uuid
         and company_id=${event.companyId}::uuid for update
    `.execute(database);
    const row = existing.rows[0]!;
    if (row.validatedAt !== null && row.eventHash !== hash) {
      throw new ApplicationException(
        "accounting_event_payload_mismatch",
        "The operational payload differs from the previously validated Event",
        HttpStatus.CONFLICT,
      );
    }
    await sql`
      update accounting_events
         set event_hash=${hash},effective_accounting_date=${facts.accountingDate}::date,
             description=${facts.description},source_reference=${facts.sourceReference},
             validated_at=coalesce(validated_at,now()),processing_status='validated'
       where id=${event.id}::uuid and company_id=${event.companyId}::uuid
    `.execute(database);
    await sql`
      delete from accounting_event_components
       where accounting_event_id=${event.id}::uuid and company_id=${event.companyId}::uuid
    `.execute(database);
    for (const [index, current] of facts.components.entries()) {
      await sql`
        insert into accounting_event_components (
          company_id,accounting_event_id,component_number,component_type,amount,
          entry_intent,mapping_key,subledger_type,subledger_id,source_reference,
          vat_treatment,description,metadata
        ) values (
          ${event.companyId}::uuid,${event.id}::uuid,${index + 1},
          ${current.componentType},${current.amount},${current.entryIntent},
          ${current.mappingKey},${current.subledgerType ?? null},
          ${current.subledgerId ?? null}::uuid,${current.sourceReference ?? null},
          ${current.vatTreatment ?? null},${current.description ?? null},
          ${JSON.stringify(current.metadata ?? {})}::jsonb
        )
      `.execute(database);
    }
  }

  private async insertLines(
    database: Kysely<DatabaseSchema>,
    event: OperationalAccountingEventRecord,
    journalId: string,
    lines: readonly ResolvedOperationalLine[],
    actorId: string,
  ): Promise<void> {
    for (const [index, line] of lines.entries()) {
      const metadata = line.component.metadata ?? {};
      await sql`
        insert into journal_lines (
          company_id,journal_entry_id,line_number,account_id,debit,credit,description,
          subledger_type,subledger_id,trader_id,driver_id,employee_id,order_id,
          trader_settlement_id,driver_collection_id,payroll_period_id,payroll_payment_id,
          outsourced_driver_fee_accrual_id,outsourced_driver_fee_payment_id,
          general_expense_id,general_expense_payment_id,
          company_bank_account_id,company_cash_account_id,cash_bank_movement_id,
          source_entity_type,source_entity_id,
          created_by_account_id,updated_by_account_id
        ) values (
          ${event.companyId}::uuid,${journalId}::uuid,${index + 1},${line.accountId}::uuid,
          ${line.component.entryIntent === "debit" ? line.amount : "0"},
          ${line.component.entryIntent === "credit" ? line.amount : "0"},
          ${line.component.description ?? null},
          ${line.component.subledgerType ?? null},${line.component.subledgerId ?? null}::uuid,
          ${typeof metadata.traderId === "string" ? metadata.traderId : null}::uuid,
          ${typeof metadata.driverId === "string" ? metadata.driverId : null}::uuid,
          ${typeof metadata.employeeId === "string" ? metadata.employeeId : null}::uuid,
          ${typeof metadata.orderId === "string" ? metadata.orderId : null}::uuid,
          ${typeof metadata.traderSettlementId === "string" ? metadata.traderSettlementId : null}::uuid,
          ${typeof metadata.driverCollectionId === "string" ? metadata.driverCollectionId : null}::uuid,
          ${typeof metadata.payrollPeriodId === "string" ? metadata.payrollPeriodId : null}::uuid,
          ${typeof metadata.payrollPaymentId === "string" ? metadata.payrollPaymentId : null}::uuid,
          ${typeof metadata.outsourcedDriverFeeAccrualId === "string" ? metadata.outsourcedDriverFeeAccrualId : null}::uuid,
          ${typeof metadata.outsourcedDriverFeePaymentId === "string" ? metadata.outsourcedDriverFeePaymentId : null}::uuid,
          ${typeof metadata.generalExpenseId === "string" ? metadata.generalExpenseId : null}::uuid,
          ${typeof metadata.generalExpensePaymentId === "string" ? metadata.generalExpensePaymentId : null}::uuid,
          ${typeof metadata.companyBankAccountId === "string" ? metadata.companyBankAccountId : null}::uuid,
          ${typeof metadata.companyCashAccountId === "string" ? metadata.companyCashAccountId : null}::uuid,
          ${typeof metadata.cashBankMovementId === "string" ? metadata.cashBankMovementId : null}::uuid,
          ${event.sourceEntityType},${event.sourceEntityId}::uuid,
          ${actorId}::uuid,${actorId}::uuid
        )
      `.execute(database);
    }
  }

  private assertBalanced(lines: readonly ResolvedOperationalLine[]): void {
    const debit = lines
      .filter((line) => line.component.entryIntent === "debit")
      .reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
    const credit = lines
      .filter((line) => line.component.entryIntent === "credit")
      .reduce((sum, line) => sum.plus(line.amount), new Decimal(0));
    // greaterThan(0): an all-zero Journal is not "balanced" in any useful
    // sense, but Decimal.isPositive() accepts zero and would let it through.
    if (lines.length < 2 || !debit.greaterThan(0) || !debit.equals(credit)) {
      throw new ApplicationException(
        "accounting_event_not_balanced",
        "The authoritative operational components do not form a balanced Journal",
        HttpStatus.CONFLICT,
      );
    }
  }

  private assertAccountingDate(
    event: OperationalAccountingEventRecord,
    facts: OperationalJournalFacts,
  ): void {
    if (facts.accountingDate.length !== 10) {
      throw new ApplicationException(
        "accounting_event_accounting_date_missing",
        "The operational source has no valid Accounting Date",
        HttpStatus.CONFLICT,
      );
    }
    if (event.effectiveAccountingDate !== facts.accountingDate) {
      // The source date is authoritative. The persisted Event is corrected before
      // validation, never shifted into another Fiscal Period.
    }
  }

  private eventHash(
    event: OperationalAccountingEventRecord,
    facts: OperationalJournalFacts,
  ): string {
    return createHash("sha256")
      .update(
        canonicalJson({
          accountingDate: facts.accountingDate,
          companyId: event.companyId,
          components: facts.components,
          eventType: event.eventType,
          eventVersion: event.eventVersion,
          sourceEntityId: event.sourceEntityId,
          sourceEntityType: event.sourceEntityType,
          sourceReference: facts.sourceReference,
        }),
      )
      .digest("hex");
  }

  private actor(event: OperationalAccountingEventRecord): string {
    if (event.actorId === null) {
      throw new ApplicationException(
        "accounting_event_actor_missing",
        "The operational Event has no accountable actor",
        HttpStatus.CONFLICT,
      );
    }
    return event.actorId;
  }

  private async nextJournalNumber(
    database: Kysely<DatabaseSchema>,
    companyId: string,
  ): Promise<string> {
    const result = await sql<{ nextValue: string; prefix: string }>`
      insert into company_reference_counters(company_id,reference_type,next_value,prefix)
      values(${companyId}::uuid,'journal',2,'JRN')
      on conflict(company_id,reference_type)
      do update set next_value=company_reference_counters.next_value+1,updated_at=now()
      returning (next_value-1)::text as "nextValue",prefix
    `.execute(database);
    const row = result.rows[0]!;
    return `${row.prefix}-${row.nextValue.padStart(6, "0")}`;
  }
}
