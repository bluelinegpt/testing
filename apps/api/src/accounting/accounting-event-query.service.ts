import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type {
  AccountingBackfillPreviewDto,
  AccountingEventBulkReprocessDto,
  AccountingEventListQueryDto,
  AccountingEventReprocessDto,
  AccountingReconciliationQueryDto,
} from "./accounting-integration.dto.js";
import { AccountingEventProcessor } from "./accounting-event.processor.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";

@Injectable()
export class AccountingEventQueryService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(AccountingOperationSupport)
    private readonly support: AccountingOperationSupport,
    @Inject(AccountingEventProcessor)
    private readonly processor: AccountingEventProcessor,
  ) {}

  public async summary() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select operational_area as area,processing_status as status,count(*)::int as count,
             coalesce(sum(attempt_count),0)::int as "totalAttempts",
             min(created_at) as "oldestEventAt",max(created_at) as "newestEventAt"
        from accounting_events where company_id=${companyId}::uuid
       group by operational_area,processing_status
       order by operational_area,processing_status
    `.execute(this.database);
    return { items: result.rows };
  }

  public async list(query: AccountingEventListQueryDto) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const pagination = this.support.pagination(query);
    const result = await sql<Record<string, unknown>>`
      select e.id,e.operational_area as area,e.event_type as "eventType",
             e.event_version as "eventVersion",e.source_entity_type as "sourceEntityType",
             e.source_entity_id as "sourceEntityId",e.source_reference as "sourceReference",
             e.effective_accounting_date::text as "accountingDate",
             e.processing_status as status,e.failure_category as "failureCategory",
             e.error_code as "errorCode",e.safe_error_summary as "errorSummary",
             e.attempt_count as "attemptCount",e.max_attempts as "maxAttempts",
             e.next_attempt_at as "nextAttemptAt",e.journal_id as "journalId",
             j.journal_number as "journalNumber",e.reversal_of_event_id as "reversalOfEventId",
             e.correlation_id as "correlationId",e.created_at as "createdAt",
             e.processed_at as "processedAt",count(*) over()::int as "totalRows"
        from accounting_events e
        left join journal_entries j on j.id=e.journal_id and j.company_id=e.company_id
       where e.company_id=${companyId}::uuid
         and (${query.status ?? null}::text is null or e.processing_status=${query.status ?? null})
         and (${query.area ?? null}::text is null or e.operational_area=${query.area ?? null})
         and (${query.eventType ?? null}::text is null or e.event_type=${query.eventType ?? null})
         and (${query.dateFrom ?? null}::date is null or e.effective_accounting_date>=${query.dateFrom ?? null}::date)
         and (${query.dateTo ?? null}::date is null or e.effective_accounting_date<=${query.dateTo ?? null}::date)
       order by e.created_at desc,e.id
       limit ${pagination.limit} offset ${pagination.offset}
    `.execute(this.database);
    const total = Number(result.rows[0]?.totalRows ?? 0);
    return {
      items: result.rows.map(({ totalRows: _totalRows, ...row }) => row),
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      totalPages: Math.ceil(total / pagination.pageSize),
    };
  }

  public async detail(eventId: string) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const header = await sql<Record<string, unknown>>`
      select e.*,j.journal_number as "journalNumber",r.journal_number as "reversalJournalNumber"
        from accounting_events e
        left join journal_entries j on j.id=e.journal_id and j.company_id=e.company_id
        left join journal_entries r on r.id=e.reversal_journal_id and r.company_id=e.company_id
       where e.id=${eventId}::uuid and e.company_id=${companyId}::uuid
    `.execute(this.database);
    if (header.rows[0] === undefined) {
      throw new ApplicationException(
        "accounting_event_not_found",
        "The Accounting Event was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const components = await sql<Record<string, unknown>>`
      select component_number as "componentNumber",component_type as "componentType",
             amount::text,entry_intent as "entryIntent",mapping_key as "mappingKey",
             subledger_type as "subledgerType",subledger_id as "subledgerId",
             source_reference as "sourceReference",description,metadata
        from accounting_event_components
       where accounting_event_id=${eventId}::uuid and company_id=${companyId}::uuid
       order by component_number
    `.execute(this.database);
    return { ...header.rows[0], components: components.rows };
  }

  public async reprocessingReadiness(eventId: string) {
    const event = await this.detail(eventId) as Record<string, unknown>;
    const status = String(event.processing_status ?? event.status ?? "");
    const eligible = ["failed","blocked_configuration","retry_pending"].includes(status);
    return {
      blockers: eligible ? [] : ["event_status_not_reprocessable"],
      eligible,
      eventId,
      requiresManualIntervention: event.failure_category !== "transient",
    };
  }

  public async reprocess(
    eventId: string,
    input: AccountingEventReprocessDto,
    idempotencyKey?: string,
  ) {
    this.support.assertAnyPermission("accounting.post", "accounting.manage");
    const response = await this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.event.reprocess",
        payload: { eventId, reason: input.reason.trim() },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const { actorId, companyId } = this.support.context();
      const result = await sql<Record<string, unknown>>`
        update accounting_events
           set processing_status='received',next_attempt_at=now(),
               max_attempts=greatest(max_attempts,attempt_count+5),
               reprocessed_at=now(),reviewed_by_account_id=${actorId}::uuid,
               reviewed_at=now(),review_note=${input.reason.trim()},
               failure_category=null,error_code=null,error_metadata=null,
               safe_error_summary=null
         where id=${eventId}::uuid and company_id=${companyId}::uuid
           and processing_status in ('failed','blocked_configuration','retry_pending')
         returning id,processing_status as status,attempt_count as "attemptCount",
                   max_attempts as "maxAttempts"
      `.execute(transaction);
      if (result.rows[0] === undefined) {
        throw new ApplicationException(
          "accounting_event_not_reprocessable",
          "Only a failed or blocked Accounting Event can be reprocessed",
          HttpStatus.CONFLICT,
        );
      }
      const resultBody = result.rows[0]!;
      await this.support.audit(transaction, {
        action: "accounting.event.reprocessing_requested",
        after: { ...resultBody, reason: input.reason.trim() },
        correlationId: idempotencyKey ?? randomUUID(),
        subjectId: eventId,
        subjectType: "accounting_event",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "accounting.event.reprocess",
        resourceId: eventId,
        resourceType: "accounting_event",
        responseBody: resultBody,
      });
      return resultBody;
    });
    void this.processor.drain(1).catch(() => undefined);
    return response;
  }

  public async reprocessPreview(input: AccountingEventBulkReprocessDto) {
    this.support.assertAnyPermission("accounting.post", "accounting.manage");
    const { companyId } = this.support.context();
    const ids = [...new Set(input.eventIds)].slice(0, 100);
    const result = await sql<Record<string, unknown>>`
      select id,event_type as "eventType",processing_status as status,
             failure_category as "failureCategory",error_code as "errorCode",
             (processing_status in ('failed','blocked_configuration','retry_pending')) as eligible
        from accounting_events where company_id=${companyId}::uuid and id=any(${ids}::uuid[])
       order by created_at,id
    `.execute(this.database);
    return {
      batchLimit: 100,
      eligibleCount: result.rows.filter((row) => row.eligible).length,
      items: result.rows,
      requestedCount: input.eventIds.length,
    };
  }

  public async reprocessBulk(
    input: AccountingEventBulkReprocessDto,
    idempotencyKey?: string,
  ) {
    this.support.assertAnyPermission("accounting.post", "accounting.manage");
    if (input.eventIds.length > 100) {
      throw new ApplicationException(
        "accounting_backfill_batch_limit_exceeded",
        "A reprocessing batch cannot contain more than 100 Events",
        HttpStatus.BAD_REQUEST,
      );
    }
    const response = await this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.events.reprocess",
        payload: input,
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const { actorId, companyId } = this.support.context();
      const ids = [...new Set(input.eventIds)];
      const result = await sql<{ id: string }>`
        update accounting_events set processing_status='received',next_attempt_at=now(),
               max_attempts=greatest(max_attempts,attempt_count+5),reprocessed_at=now(),
               reviewed_by_account_id=${actorId}::uuid,reviewed_at=now(),
               review_note=${input.reason.trim()},failure_category=null,error_code=null,
               error_metadata=null,safe_error_summary=null
         where company_id=${companyId}::uuid and id=any(${ids}::uuid[])
           and processing_status in ('failed','blocked_configuration','retry_pending')
         returning id
      `.execute(transaction);
      const responseBody = {
        acceptedEventIds: result.rows.map((row) => row.id),
        ignoredCount: ids.length - result.rows.length,
      };
      await this.support.audit(transaction, {
        action: "accounting.events.reprocessing_requested",
        after: { ...responseBody, reason: input.reason.trim() },
        correlationId: idempotencyKey ?? randomUUID(),
        subjectId: companyId,
        subjectType: "accounting_event_batch",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "accounting.events.reprocess",
        resourceId: companyId,
        resourceType: "accounting_event_batch",
        responseBody,
      });
      return responseBody;
    });
    void this.processor.drain(Math.min(25, input.eventIds.length)).catch(() => undefined);
    return response;
  }

  public async reconciliationSummary() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select operational_area as area,
             count(*)::int as "eventCount",
             count(*) filter(where processing_status='posted')::int as "postedCount",
             count(*) filter(where processing_status='reversed')::int as "reversedCount",
             count(*) filter(where processing_status in ('received','processing','retry_pending','validated'))::int as "queuedCount",
             count(*) filter(where processing_status in ('failed','blocked_configuration'))::int as "exceptionCount",
             count(*) filter(where journal_id is null and processing_status in ('posted','reversed'))::int as "linkMismatchCount"
        from accounting_events where company_id=${companyId}::uuid
       group by operational_area order by operational_area
    `.execute(this.database);
    const missing = await sql<{ area: string; count: number }>`
      select 'orders'::text as area,count(*)::int from orders o
       where o.company_id=${companyId}::uuid and o.delivery_status='delivered'
         and not exists(select 1 from accounting_events e where e.company_id=o.company_id
           and e.source_entity_type='order' and e.source_entity_id=o.id
           and e.event_type='order_delivered')
      union all
      select 'trader_receivables',count(*)::int from trader_receivables r
       where r.company_id=${companyId}::uuid and r.status not in ('cancelled','reversed')
         and not exists(select 1 from accounting_events e where e.company_id=r.company_id
           and e.source_entity_type='trader_receivable' and e.source_entity_id=r.id)
      union all
      select 'trader_settlements',count(*)::int from trader_settlements s
       where s.company_id=${companyId}::uuid and s.status='confirmed'
         and not exists(select 1 from accounting_events e where e.company_id=s.company_id
           and e.source_entity_type='trader_settlement' and e.source_entity_id=s.id)
      union all
      select 'driver_collections',count(*)::int from driver_reconciliations r
       where r.company_id=${companyId}::uuid and r.status='confirmed'
         and not exists(select 1 from accounting_events e where e.company_id=r.company_id
           and e.source_entity_type='driver_reconciliation' and e.source_entity_id=r.id)
      union all
      select 'employee_payroll',count(*)::int from payroll_periods p
       where p.company_id=${companyId}::uuid
         and p.status in ('approved','partially_paid','paid','closed')
         and not exists(select 1 from accounting_events e where e.company_id=p.company_id
           and e.source_entity_type='payroll_period' and e.source_entity_id=p.id)
      union all
      select 'outsourced_driver_fees',count(*)::int
        from outsourced_driver_fee_accruals f
       where f.company_id=${companyId}::uuid
         and not exists(select 1 from accounting_events e where e.company_id=f.company_id
           and e.source_entity_type='outsourced_driver_fee_accrual'
           and e.source_entity_id=f.id)
      union all
      select 'general_expenses',count(*)::int
        from general_expenses g
       where g.company_id=${companyId}::uuid
         and g.status in ('approved','partially_paid','paid','reversed')
         and not exists(select 1 from accounting_events e
           where e.company_id=g.company_id
             and e.source_entity_type='general_expense'
             and e.source_entity_id=g.id
             and e.event_type='general_expense_approved')
    `.execute(this.database);
    const missingByArea = new Map(missing.rows.map((row) => [row.area, Number(row.count)]));
    const areas = new Set([
      ...result.rows.map((row) => String(row.area)),
      ...missing.rows.map((row) => row.area),
    ]);
    return {
      items: [...areas].sort().map((area) => ({
        ...(result.rows.find((row) => row.area === area) ?? { area }),
        missingOperationalCount: missingByArea.get(area) ?? 0,
      })),
      readOnly: true,
    };
  }

  public async reconciliation(query: AccountingReconciliationQueryDto) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const pagination = this.support.pagination(query);
    const result = await sql<Record<string, unknown>>`
      select e.id as "eventId",e.operational_area as area,e.event_type as "eventType",
             e.source_entity_type as "sourceEntityType",e.source_entity_id as "sourceEntityId",
             e.source_reference as "sourceReference",e.processing_status as status,
             e.error_code as "errorCode",e.failure_category as "failureCategory",
             e.journal_id as "journalId",j.journal_number as "journalNumber",
             j.status as "journalStatus",j.total_debit::text as "journalDebit",
             j.total_credit::text as "journalCredit",
             coalesce(c.component_debit,0)::text as "componentDebit",
             coalesce(c.component_credit,0)::text as "componentCredit",
             case
               when e.processing_status in ('failed','blocked_configuration') then 'failed'
               when e.processing_status in ('received','processing','retry_pending','validated') then 'queued'
               when e.journal_id is null then 'missing'
               when j.total_debit<>j.total_credit
                 or j.total_debit<>coalesce(c.component_debit,j.total_debit) then 'mismatch'
               when e.processing_status='reversed' then 'reversed'
               else 'posted'
             end as result,
             count(*) over()::int as "totalRows"
        from accounting_events e
        left join journal_entries j on j.id=e.journal_id and j.company_id=e.company_id
        left join lateral (
          select sum(amount) filter(where entry_intent='debit') as component_debit,
                 sum(amount) filter(where entry_intent='credit') as component_credit
            from accounting_event_components c
           where c.company_id=e.company_id and c.accounting_event_id=e.id
        ) c on true
       where e.company_id=${companyId}::uuid
         and (${query.area ?? null}::text is null or e.operational_area=${query.area ?? null})
         and (${query.dateFrom ?? null}::date is null or e.effective_accounting_date>=${query.dateFrom ?? null}::date)
         and (${query.dateTo ?? null}::date is null or e.effective_accounting_date<=${query.dateTo ?? null}::date)
         and (${query.result ?? null}::text is null or (
           case
             when e.processing_status in ('failed','blocked_configuration') then 'failed'
             when e.processing_status in ('received','processing','retry_pending','validated') then 'queued'
             when e.journal_id is null then 'missing'
             when j.total_debit<>j.total_credit
               or j.total_debit<>coalesce(c.component_debit,j.total_debit) then 'mismatch'
             when e.processing_status='reversed' then 'reversed'
             else 'posted'
           end
         )=${query.result ?? null})
       order by e.effective_accounting_date desc,e.created_at desc
       limit ${pagination.limit} offset ${pagination.offset}
    `.execute(this.database);
    const total = Number(result.rows[0]?.totalRows ?? 0);
    return {
      items: result.rows.map(({ totalRows: _totalRows, ...row }) => row),
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      totalPages: Math.ceil(total / pagination.pageSize),
    };
  }

  public async reconciliationDetail(area: string, sourceId: string) {
    const result = await this.reconciliation({ area, page: 1, pageSize: 200 });
    const items = result.items.filter((item) => item.sourceEntityId === sourceId);
    return {
      area,
      items,
      result: items.length === 0 ? "missing" : items[0]?.result,
      sourceId,
    };
  }

  public async operationalStatus(area: string, sourceId: string) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select id as "eventId",event_type as "eventType",processing_status as status,
             journal_id as "journalId",error_code as "errorCode",
             safe_error_summary as "errorSummary",attempt_count as "attemptCount",
             processed_at as "processedAt",created_at as "createdAt"
        from accounting_events where company_id=${companyId}::uuid
         and operational_area=${area} and source_entity_id=${sourceId}::uuid
       order by event_version desc,created_at desc
    `.execute(this.database);
    return { area, events: result.rows, sourceId };
  }

  public async previewBackfill(input: AccountingBackfillPreviewDto) {
    this.support.assertAnyPermission("accounting.post", "accounting.manage");
    const { companyId } = this.support.context();
    const counts = await sql<Record<string, unknown>>`
      select 'orders'::text as area,count(*)::int as "eligibleCount"
        from orders o where o.company_id=${companyId}::uuid
         and o.delivery_status='delivered'
         and (o.delivered_at at time zone 'Asia/Dubai')::date
             between ${input.dateFrom}::date and ${input.dateTo}::date
         and not exists(select 1 from accounting_events e where e.company_id=o.company_id
           and e.source_entity_type='order' and e.source_entity_id=o.id
           and e.event_type='order_delivered')
      union all
      select 'trader_receivables',
        (
          (select count(*) from trader_receivables r
            where r.company_id=${companyId}::uuid
              and r.business_date between ${input.dateFrom}::date and ${input.dateTo}::date
              and r.status not in ('cancelled','reversed')
              and not exists(select 1 from accounting_events e
                where e.company_id=r.company_id
                  and e.source_entity_type='trader_receivable'
                  and e.source_entity_id=r.id))
          +
          (select count(*) from trader_collections c
            where c.company_id=${companyId}::uuid
              and c.payment_date between ${input.dateFrom}::date and ${input.dateTo}::date
              and c.status='confirmed'
              and not exists(select 1 from accounting_events e
                where e.company_id=c.company_id
                  and e.source_entity_type='trader_collection'
                  and e.source_entity_id=c.id))
        )::int
      union all
      select 'trader_settlements',count(*)::int from trader_settlements s
       where s.company_id=${companyId}::uuid and s.status='confirmed'
         and s.business_date between ${input.dateFrom}::date and ${input.dateTo}::date
         and s.reversal_of_id is null
         and not exists(select 1 from accounting_events e where e.company_id=s.company_id
           and e.source_entity_type='trader_settlement' and e.source_entity_id=s.id)
      union all
      select 'driver_collections',count(*)::int from driver_reconciliations r
       where r.company_id=${companyId}::uuid and r.status='confirmed'
         and r.business_date between ${input.dateFrom}::date and ${input.dateTo}::date
         and r.reversal_of_id is null
         and not exists(select 1 from accounting_events e where e.company_id=r.company_id
           and e.source_entity_type='driver_reconciliation' and e.source_entity_id=r.id)
      union all
      select 'employee_payroll',
        (
          (select count(*) from payroll_periods p
            where p.company_id=${companyId}::uuid
              and p.status in ('approved','partially_paid','paid','closed')
              and p.period_end between ${input.dateFrom}::date and ${input.dateTo}::date
              and not exists(select 1 from accounting_events e where e.company_id=p.company_id
                and e.source_entity_type='payroll_period' and e.source_entity_id=p.id))
          +
          (select count(*) from payroll_payments p
            where p.company_id=${companyId}::uuid and p.status='confirmed'
              and p.payment_date between ${input.dateFrom}::date and ${input.dateTo}::date
              and not exists(select 1 from accounting_events e where e.company_id=p.company_id
                and e.source_entity_type='payroll_payment' and e.source_entity_id=p.id))
        )::int
      union all
      select 'outsourced_driver_fees',
        (
          (select count(*) from outsourced_driver_fee_accruals f
            where f.company_id=${companyId}::uuid
              and f.accrual_business_date between ${input.dateFrom}::date and ${input.dateTo}::date
              and not exists(select 1 from accounting_events e where e.company_id=f.company_id
                and e.source_entity_type='outsourced_driver_fee_accrual'
                and e.source_entity_id=f.id))
          +
          (select count(*) from outsourced_driver_fee_payments p
            where p.company_id=${companyId}::uuid and p.status='confirmed'
              and p.payment_source='separate_payment'
              and p.payment_date between ${input.dateFrom}::date and ${input.dateTo}::date
              and not exists(select 1 from accounting_events e where e.company_id=p.company_id
                and e.source_entity_type='outsourced_driver_fee_payment'
                and e.source_entity_id=p.id))
        )::int
      union all
      select 'general_expenses',
        (
          (select count(*) from general_expenses g
            where g.company_id=${companyId}::uuid
              and g.status in ('approved','partially_paid','paid','reversed')
              and g.accounting_date between ${input.dateFrom}::date and ${input.dateTo}::date
              and not exists(select 1 from accounting_events e
                where e.company_id=g.company_id
                  and e.source_entity_type='general_expense'
                  and e.source_entity_id=g.id
                  and e.event_type='general_expense_approved'))
          +
          (select count(*) from general_expense_payments p
            where p.company_id=${companyId}::uuid and p.status='confirmed'
              and p.accounting_date between ${input.dateFrom}::date and ${input.dateTo}::date
              and not exists(select 1 from accounting_events e
                where e.company_id=p.company_id
                  and e.source_entity_type='general_expense_payment'
                  and e.source_entity_id=p.id
                  and e.event_type='general_expense_payment_completed'))
        )::int
    `.execute(this.database);
    return {
      areas: counts.rows.filter((row) => input.areas.includes(String(row.area))),
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      executionAvailable: false,
      executionBlocker: "accounting_backfill_execution_unavailable",
      note: "Preview is read-only. No repository-wide durable backfill job framework exists.",
    };
  }
}
