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
import {
  AccountingOperationSupport,
  numericReferenceOrder,
} from "./accounting-operation.support.js";

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
    // Allowlisted sort keys. Amount and Journal Number sort on the joined
    // display values the list already computes, so no extra join is needed.
    const sort = this.support.sorting(
      query,
      {
        accountingDate: "e.effective_accounting_date",
        amount: 'coalesce(j.total_debit, comp."debitTotal")',
        attemptCount: "e.attempt_count",
        createdAt: "e.created_at",
        eventType: "e.event_type",
        journalNumber: numericReferenceOrder("j.journal_number"),
        sourceReference: "e.source_reference",
        status: "e.processing_status",
      },
      "createdAt",
    );
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
             e.processed_at as "processedAt",
             -- Business Party and Amount for the list, resolved in this ONE
             -- query. The Journal's total debit is authoritative once posted;
             -- before that the Event's own debit components are. Null when the
             -- Event carries neither, so the screen shows an em dash rather
             -- than a misleading 0.00.
             coalesce(j.total_debit, comp."debitTotal")::text as amount,
             coalesce(pt.code, pd.code, pe.employee_number) as "partyReference",
             coalesce(pt.name_en, pd.name_en, pe.name_en, ge.payee_name_snapshot)
               as "partyName",
             coalesce(pt.name_ar, pd.name_ar, pe.name_ar) as "partyNameAr",
             -- Configuration state, so the list can distinguish an Event that
             -- is WAITING for Automatic Posting from one that FAILED. One row
             -- per Company, so this join is a single lookup for the page.
             coalesce(cfg.accounting_enabled,false) as "accountingEnabled",
             coalesce(cfg.automatic_posting_enabled,false) as "automaticPostingEnabled",
             coalesce(
               e.operational_area is not null
                 and e.operational_area = any(cfg.automatic_posting_areas),
               false
             ) as "areaEnabled",
             count(*) over()::int as "totalRows"
        from accounting_events e
        left join accounting_configurations cfg on cfg.company_id=e.company_id
        left join journal_entries j on j.id=e.journal_id and j.company_id=e.company_id
        -- One aggregate per row over this Event's own components: the debit
        -- total, plus the first component that carries a subledger. Indexed on
        -- (accounting_event_id, component_number); no per-row round trip.
        left join lateral (
          select sum(c.amount) filter (where c.entry_intent='debit') as "debitTotal",
                 (array_agg(c.subledger_type order by c.component_number)
                    filter (where c.subledger_id is not null))[1] as "subledgerType",
                 (array_agg(c.subledger_id order by c.component_number)
                    filter (where c.subledger_id is not null))[1] as "subledgerId"
            from accounting_event_components c
           where c.accounting_event_id=e.id and c.company_id=e.company_id
        ) comp on true
        -- Each party join is guarded by the subledger type, so exactly one
        -- index probe runs per row rather than four.
        left join traders pt
          on comp."subledgerType"='trader' and pt.id=comp."subledgerId"
         and pt.company_id=e.company_id
        left join drivers pd
          on comp."subledgerType"='driver' and pd.id=comp."subledgerId"
         and pd.company_id=e.company_id
        left join employees pe
          on comp."subledgerType"='employee' and pe.id=comp."subledgerId"
         and pe.company_id=e.company_id
        -- A General Expense has a Payee rather than a master-data party.
        left join general_expenses ge
          on e.source_entity_type='general_expense' and ge.id=e.source_entity_id
         and ge.company_id=e.company_id
       where e.company_id=${companyId}::uuid
         and (${query.status ?? null}::text is null or e.processing_status=${query.status ?? null})
         and (${query.area ?? null}::text is null or e.operational_area=${query.area ?? null})
         and (${query.eventType ?? null}::text is null or e.event_type=${query.eventType ?? null})
         and (${query.dateFrom ?? null}::date is null or e.effective_accounting_date>=${query.dateFrom ?? null}::date)
         and (${query.dateTo ?? null}::date is null or e.effective_accounting_date<=${query.dateTo ?? null}::date)
       -- Requested sort first, then the deterministic tail. Both fall to
       -- e.id desc so offset pagination can never repeat or omit an Event.
       order by ${sql.raw(sort.column)} ${sql.raw(sort.direction)} nulls last,
                e.created_at desc, e.id desc
       limit ${pagination.limit} offset ${pagination.offset}
    `.execute(this.database);
    const total = Number(result.rows[0]?.totalRows ?? 0);
    return {
      items: result.rows.map(({ totalRows, ...row }) => {
        void totalRows;
        return row;
      }),
      page: pagination.page,
      pageSize: pagination.pageSize,
      sortBy: sort.sortBy,
      sortDirection: sort.sortDirection,
      total,
      totalPages: Math.ceil(total / pagination.pageSize),
    };
  }

  public async detail(eventId: string) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const header = await sql<Record<string, unknown>>`
      select e.*,j.journal_number as "journalNumber",r.journal_number as "reversalJournalNumber",
             -- camelCase aliases so Related Records can build routes without
             -- re-deriving them from the raw snake_case row. Additive only.
             e.journal_id as "journalId", e.reversal_journal_id as "reversalJournalId",
             e.source_entity_type as "sourceEntityType",
             e.source_entity_id as "sourceEntityId",
             e.source_reference as "sourceReference",
             e.reversal_of_event_id as "originalEventId",
             o.source_reference as "originalEventReference",
             o.event_type as "originalEventType",
             -- The reverse edge. The schema stores only child -> parent
             -- (reversal_of_event_id), so the Event that REVERSES this one is
             -- found by looking for the child that points back here. Done in
             -- the query layer, Company-scoped, capped at the single most
             -- recent row: no migration, and no fabricated relationship.
             rev.id as "reversalEventId",
             rev.source_reference as "reversalEventReference",
             rev.event_type as "reversalEventType",
             -- Whether the Journal this Event produced has itself been
             -- reversed, so the Journal pair navigates both ways.
             j.reversed_by_journal_id as "journalReversedByJournalId",
             jrev.journal_number as "journalReversedByJournalNumber",
             j.reversal_of_id as "journalReversalOfJournalId",
             jorig.journal_number as "journalReversalOfJournalNumber",
             -- Configuration state, so a waiting Event can say WHAT it is
             -- waiting for instead of sitting on a bare "Received" badge.
             -- accounting_configurations holds one row per Company, so this
             -- join adds a single row lookup, not a scan.
             coalesce(c.accounting_enabled,false) as "accountingEnabled",
             coalesce(c.automatic_posting_enabled,false) as "automaticPostingEnabled",
             coalesce(
               e.operational_area is not null
                 and e.operational_area = any(c.automatic_posting_areas),
               false
             ) as "areaEnabled"
        from accounting_events e
        left join journal_entries j on j.id=e.journal_id and j.company_id=e.company_id
        left join journal_entries r on r.id=e.reversal_journal_id and r.company_id=e.company_id
        left join journal_entries jrev
          on jrev.id=j.reversed_by_journal_id and jrev.company_id=j.company_id
        left join journal_entries jorig
          on jorig.id=j.reversal_of_id and jorig.company_id=j.company_id
        left join accounting_events o
          on o.id=e.reversal_of_event_id and o.company_id=e.company_id
        left join lateral (
          select c2.id, c2.source_reference, c2.event_type
            from accounting_events c2
           where c2.reversal_of_event_id=e.id and c2.company_id=e.company_id
           order by c2.created_at desc, c2.id desc
           limit 1
        ) rev on true
        left join accounting_configurations c on c.company_id=e.company_id
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
    // Durable processing history. The Event row itself only ever holds the
    // LATEST failure, so earlier attempts would vanish the moment a reprocess
    // succeeded. The audit trail is append-only and already records both
    // failures and reprocess requests, so it is the honest source for the
    // timeline — nothing here is reconstructed or inferred.
    //
    // Bounded at 50 and Company-scoped; one query per Event detail, never per
    // timeline entry.
    const history = await sql<Record<string, unknown>>`
      select a.action, a.occurred_at as "occurredAt", a.reason,
             a.after_data as "details", a.correlation_id as "correlationId",
             actor.username as "actorName"
        from audit_events a
        left join accounts actor on actor.id=a.actor_account_id
       where a.company_id=${companyId}::uuid
         and a.subject_type='accounting_event'
         and a.subject_id=${eventId}
       order by a.occurred_at, a.id
       limit 50
    `.execute(this.database);
    const row = header.rows[0]!;
    const sourceTransaction = await this.sourceTransaction(
      companyId,
      String(row.source_entity_type ?? ""),
      String(row.source_entity_id ?? ""),
    );
    return {
      ...row,
      components: components.rows,
      history: history.rows,
      ...(sourceTransaction === undefined ? {} : { sourceTransaction }),
    };
  }

  /**
   * Read-only business summary of the operational record an Accounting Event
   * was raised from, for the Event detail screen's Source Transaction section.
   *
   * One query per Event detail — a screen, not a row — so this cannot become an
   * N+1. Every branch is Company-scoped and every column here is taken from a
   * query already in production use (`operational-source.loader.ts`), so no
   * column name is assumed.
   *
   * An unrecognised or missing source returns `undefined`; the screen then
   * shows "Source Record Not Found" rather than an empty card.
   */
  private async sourceTransaction(companyId: string, type: string, id: string) {
    if (id === "" || type === "") return undefined;
    const one = async (statement: ReturnType<typeof sql<Record<string, unknown>>>) =>
      (await statement.execute(this.database)).rows[0];
    switch (type) {
      case "order":
        return this.wrap(
          type,
          await one(sql<Record<string, unknown>>`
            select o.order_number as "orderNumber",o.serial_number as "serialNumber",
                   o.delivery_status as "deliveryStatus",
                   o.customer_amount_due::text as "customerAmountDue",
                   o.trader_net_payable::text as "traderNetPayable",
                   o.service_fee_net_amount::text as "serviceFeeNet",
                   o.vat_amount::text as "vatAmount",
                   t.code as "traderCode",t.name_en as "traderName",t.name_ar as "traderNameAr",
                   d.code as "driverCode",d.name_en as "driverName",d.name_ar as "driverNameAr"
              from orders o
              left join traders t on t.id=o.trader_id and t.company_id=o.company_id
              left join drivers d on d.id=o.assigned_driver_id and d.company_id=o.company_id
             where o.id=${id}::uuid and o.company_id=${companyId}::uuid
          `),
        );
      case "general_expense":
        return this.wrap(
          type,
          await one(sql<Record<string, unknown>>`
            select expense_number as "expenseNumber",payee_name_snapshot as payee,
                   expense_date::text as "expenseDate",subtotal::text as "netAmount",
                   vat_amount::text as "vatAmount",total_amount::text as "totalAmount",status
              from general_expenses
             where id=${id}::uuid and company_id=${companyId}::uuid
          `),
        );
      case "general_expense_payment":
        return this.wrap(
          type,
          await one(sql<Record<string, unknown>>`
            select p.payment_number as "paymentNumber",p.general_expense_id as "expenseId",
                   e.expense_number as "expenseNumber",e.payee_name_snapshot as payee,
                   p.payment_date::text as "paymentDate",p.amount::text as amount,
                   p.cash_amount::text as "cashAmount",p.visa_amount::text as "visaAmount",
                   p.status
              from general_expense_payments p
              join general_expenses e on e.id=p.general_expense_id and e.company_id=p.company_id
             where p.id=${id}::uuid and p.company_id=${companyId}::uuid
          `),
        );
      case "cash_bank_movement":
        return this.wrap(
          type,
          await one(sql<Record<string, unknown>>`
            select m.movement_number as "movementNumber",m.movement_type as "movementType",
                   m.amount::text as amount,m.fee_amount::text as "feeAmount",m.status,
                   coalesce(sc.cash_account_code,sb.bank_account_code) as "sourceAccountCode",
                   coalesce(sc.cash_account_name,sb.account_name) as "sourceAccountName",
                   coalesce(dc.cash_account_code,db.bank_account_code)
                     as "destinationAccountCode",
                   coalesce(dc.cash_account_name,db.account_name) as "destinationAccountName"
              from cash_bank_movements m
              left join company_cash_accounts sc
                on sc.id=m.source_cash_account_id and sc.company_id=m.company_id
              left join company_bank_accounts sb
                on sb.id=m.source_bank_account_id and sb.company_id=m.company_id
              left join company_cash_accounts dc
                on dc.id=m.destination_cash_account_id and dc.company_id=m.company_id
              left join company_bank_accounts db
                on db.id=m.destination_bank_account_id and db.company_id=m.company_id
             where m.id=${id}::uuid and m.company_id=${companyId}::uuid
          `),
        );
      case "driver_reconciliation":
        return this.wrap(
          type,
          await one(sql<Record<string, unknown>>`
            select r.reconciliation_number as "reconciliationNumber",
                   r.business_date::text as "businessDate",
                   r.gross_collections::text as "grossCollections",
                   r.reconciliation_expenses::text as "driverExpenses",
                   r.driver_payable_deduction::text as "feeDeduction",r.status,
                   d.code as "driverCode",d.name_en as "driverName",d.name_ar as "driverNameAr"
              from driver_reconciliations r
              left join drivers d on d.id=r.driver_id and d.company_id=r.company_id
             where r.id=${id}::uuid and r.company_id=${companyId}::uuid
          `),
        );
      case "trader_settlement":
        return this.wrap(
          type,
          await one(sql<Record<string, unknown>>`
            select s.settlement_number as "settlementNumber",
                   s.business_date::text as "businessDate",
                   s.net_payable::text as "netPayable",s.status,
                   t.code as "traderCode",t.name_en as "traderName",t.name_ar as "traderNameAr"
              from trader_settlements s
              left join traders t on t.id=s.trader_id and t.company_id=s.company_id
             where s.id=${id}::uuid and s.company_id=${companyId}::uuid
          `),
        );
      case "trader_receivable":
        return this.wrap(
          type,
          await one(sql<Record<string, unknown>>`
            select r.receivable_number as "receivableNumber",r.source_type as "sourceType",
                   r.business_date::text as "businessDate",
                   r.original_amount_due::text as amount,r.reason,r.status,
                   t.code as "traderCode",t.name_en as "traderName",t.name_ar as "traderNameAr"
              from trader_receivables r
              left join traders t on t.id=r.trader_id and t.company_id=r.company_id
             where r.id=${id}::uuid and r.company_id=${companyId}::uuid
          `),
        );
      case "trader_collection":
        return this.wrap(
          type,
          await one(sql<Record<string, unknown>>`
            select c.collection_number as "collectionNumber",
                   c.payment_date::text as "paymentDate",
                   c.payment_method as "paymentMethod",
                   c.amount_received::text as amount,c.status,
                   t.code as "traderCode",t.name_en as "traderName",t.name_ar as "traderNameAr"
              from trader_collections c
              left join traders t on t.id=c.trader_id and t.company_id=c.company_id
             where c.id=${id}::uuid and c.company_id=${companyId}::uuid
          `),
        );
      case "payroll_period":
        return this.wrap(
          type,
          await one(sql<Record<string, unknown>>`
            select period_reference as "periodReference",period_end::text as "periodEnd",
                   total_net_salary::text as "netPayroll",status
              from payroll_periods
             where id=${id}::uuid and company_id=${companyId}::uuid
          `),
        );
      case "payroll_payment":
        return this.wrap(
          type,
          await one(sql<Record<string, unknown>>`
            select p.payment_number as "paymentNumber",
                   p.payment_date::text as "paymentDate",
                   p.payment_method as "paymentMethod",p.status,
                   period.period_reference as "periodReference"
              from payroll_payments p
              left join payroll_periods period
                on period.id=p.payroll_period_id and period.company_id=p.company_id
             where p.id=${id}::uuid and p.company_id=${companyId}::uuid
          `),
        );
      case "outsourced_driver_fee_accrual":
        return this.wrap(
          type,
          await one(sql<Record<string, unknown>>`
            select a.source_reference as "feeReference",
                   a.accrual_business_date::text as "businessDate",
                   a.earned_amount::text as "feeAmount",a.status,
                   o.order_number as "orderNumber",
                   d.code as "driverCode",d.name_en as "driverName",d.name_ar as "driverNameAr"
              from outsourced_driver_fee_accruals a
              left join drivers d on d.id=a.driver_id and d.company_id=a.company_id
              left join orders o on o.id=a.order_id and o.company_id=a.company_id
             where a.id=${id}::uuid and a.company_id=${companyId}::uuid
          `),
        );
      case "outsourced_driver_fee_payment":
        return this.wrap(
          type,
          await one(sql<Record<string, unknown>>`
            select p.payment_number as "paymentNumber",
                   p.payment_date::text as "paymentDate",
                   p.payment_method as "paymentMethod",p.payment_source as "paymentSource",
                   p.amount_paid::text as amount,p.status,
                   d.code as "driverCode",d.name_en as "driverName",d.name_ar as "driverNameAr"
              from outsourced_driver_fee_payments p
              left join drivers d on d.id=p.driver_id and d.company_id=p.company_id
             where p.id=${id}::uuid and p.company_id=${companyId}::uuid
          `),
        );
      default:
        return undefined;
    }
  }

  /** `{kind, found, ...fields}` — `found:false` drives "Source Record Not Found". */
  private wrap(kind: string, row: Record<string, unknown> | undefined) {
    return row === undefined ? { found: false, kind } : { ...row, found: true, kind };
  }

  /**
   * Every Accounting Event raised from one operational record, with the
   * business reference of each Journal it produced.
   *
   * This is the single backend entry point behind Related Records on the
   * operational screens (Order, Trader Settlement, Trader Receivable, Driver
   * Collection, Payroll, Outsourced Driver Fee). It is deliberately one
   * Company-scoped query with both Journal joins resolved inline, so a screen
   * showing the panel makes exactly one extra request and can never fan out
   * into a per-Event lookup.
   *
   * The result is bounded: a single operational record raises a handful of
   * Events in practice, and the limit stops a pathological row from returning
   * an unbounded list.
   */
  public async relatedRecords(sourceEntityType: string, sourceEntityId: string) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select e.id, e.event_type as "eventType",
             e.processing_status as "processingStatus",
             e.source_reference as "sourceReference",
             e.effective_accounting_date::text as "accountingDate",
             e.journal_id as "journalId", j.journal_number as "journalNumber",
             e.reversal_journal_id as "reversalJournalId",
             r.journal_number as "reversalJournalNumber"
        from accounting_events e
        left join journal_entries j on j.id=e.journal_id and j.company_id=e.company_id
        left join journal_entries r
          on r.id=e.reversal_journal_id and r.company_id=e.company_id
       where e.company_id=${companyId}::uuid
         and e.source_entity_type=${sourceEntityType}
         and e.source_entity_id=${sourceEntityId}::uuid
       order by e.created_at, e.id
       limit 50
    `.execute(this.database);
    return { events: result.rows, sourceEntityId, sourceEntityType };
  }

  /**
   * Everything the Reprocessing Preview needs, resolved from stored state.
   *
   * This deliberately reports blockers rather than removing them. Reprocessing
   * only ever re-queues an Event for the NORMAL processor, and the processor's
   * own claim query still requires Accounting enabled, Automatic Posting
   * enabled and the Event's operational Area enabled — so re-queueing an Event
   * whose Area is switched off would silently do nothing. Surfacing that here
   * is the difference between "nothing happened" and "here is what to fix".
   *
   * Reuses `detail()`, so the preview costs the same queries the detail screen
   * already makes and adds no per-blocker lookup.
   */
  public async reprocessingReadiness(eventId: string) {
    const event = (await this.detail(eventId)) as Record<string, unknown>;
    const status = String(event.processing_status ?? event.status ?? "");
    const blockers: string[] = [];

    // Terminal or in-flight states are never reprocessable. Posted is listed
    // first because it is the one a User is most likely to attempt.
    if (status === "posted") blockers.push("event_already_posted");
    else if (status === "processing") blockers.push("event_currently_processing");
    else if (status === "reversed") blockers.push("event_reversed");
    else if (status === "ignored_duplicate") blockers.push("event_ignored_duplicate");
    else if (!["failed", "blocked_configuration", "retry_pending"].includes(status)) {
      blockers.push("event_status_not_reprocessable");
    }

    // A Journal already owning this Event means posting succeeded; re-queueing
    // would risk a second Journal for the same source.
    if (event.journal_id !== null && event.journal_id !== undefined) {
      blockers.push("event_journal_already_exists");
    }
    // Configuration gates the processor applies on claim.
    if (event.accountingEnabled !== true) blockers.push("accounting_disabled");
    if (event.automaticPostingEnabled !== true) blockers.push("automatic_posting_disabled");
    if (event.areaEnabled !== true) blockers.push("operational_area_disabled");
    // A source record that no longer resolves cannot be re-posted.
    const source = event.sourceTransaction as { found?: boolean } | undefined;
    if (source !== undefined && source.found === false) blockers.push("source_record_missing");

    const attempts = Number(event.attempt_count ?? 0);
    const maximum = Number(event.max_attempts ?? 0);
    return {
      attemptCount: attempts,
      blockers,
      eligible: blockers.length === 0,
      eventId,
      failureCategory: event.failure_category ?? null,
      maxAttempts: maximum,
      operationalArea: event.operational_area ?? null,
      // A transient failure clears itself on retry; anything else needs a
      // person to change something first.
      requiresManualIntervention: event.failure_category !== "transient",
      status,
    };
  }

  public async reprocess(
    eventId: string,
    input: AccountingEventReprocessDto,
    idempotencyKey?: string,
    /**
     * Optional extra revalidation, run AFTER the idempotency replay check and
     * BEFORE any write — so an exact replay still returns the stored result,
     * while a fresh attempt is refused if the hook objects. The full-precheck
     * execution path passes the precheck here; passing a callback (rather than
     * this service importing the precheck service) avoids a DI cycle, since
     * the precheck service already depends on this one.
     */
    revalidate?: () => Promise<void>,
  ) {
    this.support.assertAnyPermission("accounting.post", "accounting.manage");
    const response = await this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.event.reprocess",
        // `expectedStatus` is part of the hashed payload: the same key with a
        // different observed state is a mismatch, never a stale replay.
        payload: {
          eventId,
          expectedStatus: input.expectedStatus ?? null,
          reason: input.reason.trim(),
        },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const { actorId, companyId } = this.support.context();
      // Blockers are enforced, not bypassed. Re-queueing an Event whose Area
      // is disabled, whose source record has gone, or that already owns a
      // Journal would either do nothing or risk a second Journal — so the
      // request is refused with the specific reasons instead.
      const readiness = await this.reprocessingReadiness(eventId);
      if (!readiness.eligible) {
        throw new ApplicationException(
          "accounting_event_not_reprocessable",
          "This Accounting Event cannot be reprocessed yet",
          HttpStatus.CONFLICT,
          readiness.blockers,
        );
      }
      // Stale-observation guard: the caller acts on the Event they REVIEWED.
      if (input.expectedStatus !== undefined && readiness.status !== input.expectedStatus) {
        throw new ApplicationException(
          "accounting_event_state_changed",
          "The Accounting Event changed after it was last reviewed",
          HttpStatus.CONFLICT,
        );
      }
      if (revalidate !== undefined) await revalidate();
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
        after: {
          ...resultBody,
          // Prior state is captured so the timeline can say what the Event was
          // before the request, after the row itself has moved on.
          priorAttemptCount: readiness.attemptCount,
          priorFailureCategory: readiness.failureCategory,
          priorStatus: readiness.status,
          reason: input.reason.trim(),
        },
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

  public async reprocessBulk(input: AccountingEventBulkReprocessDto, idempotencyKey?: string) {
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
      items: result.rows.map(({ totalRows, ...row }) => {
        void totalRows;
        return row;
      }),
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
