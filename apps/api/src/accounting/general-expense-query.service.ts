import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import type {
  GeneralExpenseBackfillPreviewDto,
  GeneralExpenseListQueryDto,
  GeneralExpensePaymentListQueryDto,
} from "./general-expense.dto.js";

@Injectable()
export class GeneralExpenseQueryService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(AccountingOperationSupport) private readonly support: AccountingOperationSupport,
  ) {}

  public async categories(activeOnly = false) {
    this.support.assertAnyPermission("accounting.view", "accounting.manage");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select id,code,name_en as "nameEn",name_ar as "nameAr",description,
             default_expense_mapping_key as "defaultExpenseMappingKey",
             default_vat_treatment as "defaultVatTreatment",
             is_active as "isActive",effective_from as "effectiveFrom",
             effective_to as "effectiveTo",version::text
        from general_expense_categories
       where company_id=${companyId}::uuid
         and (${activeOnly}=false or is_active)
       order by is_active desc,code
    `.execute(this.database);
    return result.rows;
  }

  public async categoryDependencies(categoryId: string) {
    this.support.assertAnyPermission("accounting.view", "accounting.manage");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select
        (select count(*) from general_expenses
          where company_id=${companyId}::uuid and category_id=${categoryId}::uuid)::text
          as "headerCount",
        (select count(*) from general_expense_lines
          where company_id=${companyId}::uuid and category_id=${categoryId}::uuid)::text
          as "lineCount"
    `.execute(this.database);
    return result.rows[0]!;
  }

  public async summary() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select count(*)::text as "expenseCount",
             count(*) filter (where status='submitted')::text as "awaitingApprovalCount",
             count(*) filter (where payment_status='unpaid'
                               and status='approved')::text as "unpaidCount",
             count(*) filter (where payment_status='partially_paid')::text
               as "partiallyPaidCount",
             coalesce(sum(approved_amount)
               filter (where status in ('approved','partially_paid','paid')),0)::text
               as "approvedAmount",
             coalesce(sum(paid_amount)
               filter (where status in ('approved','partially_paid','paid')),0)::text
               as "paidAmount",
             coalesce(sum(outstanding_amount)
               filter (where status in ('approved','partially_paid','paid')),0)::text
               as "outstandingAmount",
             coalesce(sum(recoverable_vat_amount)
               filter (where status in ('approved','partially_paid','paid')),0)::text
               as "recoverableVatAmount"
        from general_expenses where company_id=${companyId}::uuid
    `.execute(this.database);
    return result.rows[0]!;
  }

  public async list(query: GeneralExpenseListQueryDto) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const page = this.support.pagination(query);
    const search = query.search?.trim() ?? "";
    const result = await sql<Record<string, unknown>>`
      select e.id,e.expense_number as "expenseNumber",e.expense_date as "expenseDate",
             e.accounting_date as "accountingDate",e.status,
             e.payment_status as "paymentStatus",e.payee_type as "payeeType",
             e.payee_name_snapshot as "payeeName",e.description,
             e.total_amount::text as "totalAmount",
             e.approved_amount::text as "approvedAmount",
             e.paid_amount::text as "paidAmount",
             e.outstanding_amount::text as "outstandingAmount",
             e.vat_amount::text as "vatAmount",e.version::text,
             c.code as "categoryCode",c.name_en as "categoryNameEn",
             c.name_ar as "categoryNameAr",
             count(*) over()::text as "totalCount"
        from general_expenses e
        left join general_expense_categories c
          on c.id=e.category_id and c.company_id=e.company_id
       where e.company_id=${companyId}::uuid
         and (${query.status ?? null}::text is null or e.status=${query.status ?? null})
         and (${query.paymentStatus ?? null}::text is null
              or e.payment_status=${query.paymentStatus ?? null})
         and (${query.categoryId ?? null}::uuid is null
              or e.category_id=${query.categoryId ?? null}::uuid)
         and (${query.dateFrom ?? null}::date is null
              or e.expense_date>=${query.dateFrom ?? null}::date)
         and (${query.dateTo ?? null}::date is null
              or e.expense_date<=${query.dateTo ?? null}::date)
         and (${search}=''
              or e.expense_number ilike ${`%${search}%`}
              or coalesce(e.payee_name_snapshot,'') ilike ${`%${search}%`}
              or coalesce(e.reference_number,'') ilike ${`%${search}%`})
       order by e.expense_date desc nulls last,e.created_at desc,e.id
       limit ${page.limit} offset ${page.offset}
    `.execute(this.database);
    return {
      items: result.rows,
      page: page.page,
      pageSize: page.pageSize,
      totalCount: Number(result.rows[0]?.totalCount ?? 0),
    };
  }

  public async detail(expenseId: string) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const header = await sql<Record<string, unknown>>`
      select e.*,e.subtotal::text as subtotal,e.vat_amount::text as "vatAmount",
             e.recoverable_vat_amount::text as "recoverableVatAmount",
             e.nonrecoverable_vat_amount::text as "nonrecoverableVatAmount",
             e.total_amount::text as "totalAmount",
             e.approved_amount::text as "approvedAmount",
             e.paid_amount::text as "paidAmount",
             e.outstanding_amount::text as "outstandingAmount",
             e.version::text,c.code as "categoryCode",c.name_en as "categoryNameEn",
             c.name_ar as "categoryNameAr"
        from general_expenses e
        left join general_expense_categories c
          on c.id=e.category_id and c.company_id=e.company_id
       where e.id=${expenseId}::uuid and e.company_id=${companyId}::uuid
    `.execute(this.database);
    if (header.rows[0] === undefined) {
      throw new ApplicationException(
        "accounting_general_expense_not_found",
        "The General Expense was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const [lines, payments, attachments, events] = await Promise.all([
      sql<Record<string, unknown>>`
        select id,line_number as "lineNumber",category_id as "categoryId",
               category_code_snapshot as "categoryCode",
               category_name_en_snapshot as "categoryNameEn",
               category_name_ar_snapshot as "categoryNameAr",description,
               quantity::text,unit_amount::text as "unitAmount",
               net_amount::text as "netAmount",vat_treatment as "vatTreatment",
               vat_rate::text as "vatRate",vat_amount::text as "vatAmount",
               recoverable_vat_amount::text as "recoverableVatAmount",
               nonrecoverable_vat_amount::text as "nonrecoverableVatAmount",
               gross_amount::text as "grossAmount",
               expense_cost_amount::text as "expenseCostAmount",
               expense_account_mapping_key as "expenseAccountMappingKey",
               trader_id as "traderId",driver_id as "driverId",
               employee_id as "employeeId",order_id as "orderId",version::text
          from general_expense_lines
         where company_id=${companyId}::uuid
           and general_expense_id=${expenseId}::uuid
         order by line_number
      `.execute(this.database),
      sql<Record<string, unknown>>`
        select p.id,p.payment_number as "paymentNumber",
               p.payment_date as "paymentDate",p.accounting_date as "accountingDate",
               p.amount::text,p.cash_amount::text as "cashAmount",
               p.visa_amount::text as "visaAmount",p.status,
               p.reference_number as "referenceNumber",p.notes,p.version::text,
               coalesce(jsonb_agg(jsonb_build_object(
                 'id',r.id,'rowNumber',r.row_number,'paymentMethod',r.payment_method,
                 'amount',r.amount::text,'cashAccountId',r.cash_account_id,
                 'companyBankAccountId',r.company_bank_account_id,
                 'referenceNumber',r.reference_number
               ) order by r.row_number) filter (where r.id is not null),'[]'::jsonb) as rows
          from general_expense_payments p
          left join general_expense_payment_rows r
            on r.company_id=p.company_id and r.general_expense_payment_id=p.id
         where p.company_id=${companyId}::uuid
           and p.general_expense_id=${expenseId}::uuid
         group by p.id order by p.payment_date,p.created_at,p.id
      `.execute(this.database),
      sql<Record<string, unknown>>`
        select id,general_expense_payment_id as "paymentId",
               file_object_id as "fileObjectId",attachment_type as "attachmentType",
               file_name_snapshot as "fileName",media_type_snapshot as "mediaType",
               size_bytes_snapshot::text as "sizeBytes",description,is_active as "isActive",
               uploaded_at as "uploadedAt"
          from general_expense_attachments
         where company_id=${companyId}::uuid
           and general_expense_id=${expenseId}::uuid
         order by uploaded_at,id
      `.execute(this.database),
      sql<Record<string, unknown>>`
        select id,event_type as "eventType",processing_status as "processingStatus",
               journal_id as "journalId",reversal_journal_id as "reversalJournalId",
               error_code as "errorCode",safe_error_summary as "safeErrorSummary",
               attempt_count as "attemptCount",created_at as "createdAt",
               processed_at as "processedAt"
          from accounting_events
         where company_id=${companyId}::uuid
           and operational_area='general_expenses'
           and (
             (source_entity_type='general_expense'
               and source_entity_id=${expenseId}::uuid)
             or
             (source_entity_type='general_expense_payment'
               and source_entity_id in (
                 select id from general_expense_payments
                  where company_id=${companyId}::uuid
                    and general_expense_id=${expenseId}::uuid
               ))
           )
         order by created_at,id
      `.execute(this.database),
    ]);
    return {
      ...header.rows[0],
      accountingEvents: events.rows,
      attachments: attachments.rows,
      lines: lines.rows,
      payments: payments.rows,
    };
  }

  public async payment(paymentId: string) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select p.id,p.payment_number as "paymentNumber",
             p.general_expense_id as "expenseId",e.expense_number as "expenseNumber",
             p.payment_date as "paymentDate",p.accounting_date as "accountingDate",
             p.amount::text,p.cash_amount::text as "cashAmount",
             p.visa_amount::text as "visaAmount",p.status,p.version::text,
             p.reference_number as "referenceNumber",p.notes,
             p.confirmed_at as "confirmedAt",p.reversed_at as "reversedAt",
             p.reversal_reason as "reversalReason",
             ae.id as "accountingEventId",ae.processing_status as "accountingStatus",
             j.id as "journalId",j.journal_number as "journalNumber",
             coalesce(jsonb_agg(jsonb_build_object(
               'id',r.id,'rowNumber',r.row_number,'paymentMethod',r.payment_method,
               'amount',r.amount::text,'cashAccountId',r.cash_account_id,
               'companyBankAccountId',r.company_bank_account_id,
               'referenceNumber',r.reference_number
             ) order by r.row_number),'[]'::jsonb) as rows
        from general_expense_payments p
        join general_expenses e
          on e.id=p.general_expense_id and e.company_id=p.company_id
        join general_expense_payment_rows r
          on r.general_expense_payment_id=p.id and r.company_id=p.company_id
        left join lateral (
          select id,processing_status,journal_id
            from accounting_events
           where company_id=p.company_id
             and source_entity_type='general_expense_payment'
             and source_entity_id=p.id
           order by created_at desc,id desc
           limit 1
        ) ae on true
        left join journal_entries j
          on j.id=ae.journal_id and j.company_id=p.company_id
       where p.id=${paymentId}::uuid and p.company_id=${companyId}::uuid
       group by p.id,e.expense_number,ae.id,ae.processing_status,j.id,j.journal_number
    `.execute(this.database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "accounting_general_expense_payment_not_found",
        "The General Expense Payment was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const attachments = await sql<Record<string, unknown>>`
      select id,general_expense_id as "expenseId",general_expense_payment_id as "paymentId",
             file_object_id as "fileObjectId",attachment_type as "attachmentType",
             file_name_snapshot as "fileName",media_type_snapshot as "mediaType",
             size_bytes_snapshot::text as "sizeBytes",description,uploaded_at as "uploadedAt"
        from general_expense_attachments
       where company_id=${companyId}::uuid
         and general_expense_payment_id=${paymentId}::uuid and is_active
       order by uploaded_at,id
    `.execute(this.database);
    return { ...row, attachments: attachments.rows };
  }

  public async payments(query: GeneralExpensePaymentListQueryDto) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const result = await sql<Record<string, unknown>>`
      select p.id,p.payment_number as "paymentNumber",
             p.general_expense_id as "expenseId",e.expense_number as "expenseNumber",
             e.payee_name_snapshot as "payeeName",p.payment_date::text as "paymentDate",
             p.accounting_date::text as "accountingDate",p.amount::text,
             p.cash_amount::text as "cashAmount",p.visa_amount::text as "visaAmount",
             p.status,p.reference_number as "referenceNumber",
             p.confirmed_by_account_id as "confirmedBy",p.confirmed_at as "confirmedAt",
             ae.processing_status as "accountingStatus",j.journal_number as "journalNumber",
             count(*) over()::text as "totalCount"
        from general_expense_payments p
        join general_expenses e on e.id=p.general_expense_id and e.company_id=p.company_id
        left join lateral (
          select id,processing_status,journal_id
            from accounting_events
           where company_id=p.company_id
             and source_entity_type='general_expense_payment'
             and source_entity_id=p.id
           order by created_at desc,id desc
           limit 1
        ) ae on true
        left join journal_entries j on j.id=ae.journal_id and j.company_id=p.company_id
       where p.company_id=${companyId}::uuid
         and (${query.status ?? null}::text is null or p.status=${query.status ?? null})
         and (${query.paymentMethod ?? null}::text is null or
           (${query.paymentMethod ?? null}='cash' and p.cash_amount>0) or
           (${query.paymentMethod ?? null}='visa' and p.visa_amount>0))
         and (${query.dateFrom ?? null}::date is null or p.payment_date>=${query.dateFrom ?? null}::date)
         and (${query.dateTo ?? null}::date is null or p.payment_date<=${query.dateTo ?? null}::date)
         and (${query.search ?? null}::text is null or p.payment_number ilike '%'||${query.search ?? null}||'%'
           or e.expense_number ilike '%'||${query.search ?? null}||'%'
           or coalesce(e.payee_name_snapshot,'') ilike '%'||${query.search ?? null}||'%')
       order by p.payment_date desc,p.created_at desc
       limit ${pageSize} offset ${(page - 1) * pageSize}
    `.execute(this.database);
    return {
      items: result.rows,
      page,
      pageSize,
      total: result.rows[0]?.totalCount ?? "0",
    };
  }

  public async reconciliationSummary() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select
        count(*)::text as "approvedOrPaidSourceCount",
        count(*) filter (where event_id is null)::text as "missingEventCount",
        count(*) filter (where processing_status in ('failed','blocked_configuration'))
          ::text as "failedOrBlockedCount",
        count(*) filter (where processing_status='posted')::text as "postedCount"
      from (
        select e.id,
               ae.id as event_id,ae.processing_status
          from general_expenses e
          left join accounting_events ae
            on ae.company_id=e.company_id
           and ae.source_entity_type='general_expense'
           and ae.source_entity_id=e.id
           and ae.event_type='general_expense_approved'
         where e.company_id=${companyId}::uuid
           and e.status in ('approved','partially_paid','paid','reversed')
      ) source
    `.execute(this.database);
    return result.rows[0]!;
  }

  public async reconciliation() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select 'expense' as "sourceType",e.id as "sourceId",
             e.expense_number as "sourceReference",e.accounting_date as "accountingDate",
             e.approved_amount::text as amount,e.status,
             ae.id as "eventId",ae.processing_status as "eventStatus",
             ae.journal_id as "journalId",ae.error_code as "errorCode"
        from general_expenses e
        left join accounting_events ae
          on ae.company_id=e.company_id
         and ae.source_entity_type='general_expense'
         and ae.source_entity_id=e.id
         and ae.event_type='general_expense_approved'
       where e.company_id=${companyId}::uuid
         and e.status in ('approved','partially_paid','paid','reversed')
      union all
      select 'payment',p.id,p.payment_number,p.accounting_date,p.amount::text,p.status,
             ae.id,ae.processing_status,ae.journal_id,ae.error_code
        from general_expense_payments p
        left join accounting_events ae
          on ae.company_id=p.company_id
         and ae.source_entity_type='general_expense_payment'
         and ae.source_entity_id=p.id
         and ae.event_type='general_expense_payment_completed'
       where p.company_id=${companyId}::uuid
       order by "accountingDate" desc,"sourceReference"
    `.execute(this.database);
    return result.rows;
  }

  public async previewBackfill(input: GeneralExpenseBackfillPreviewDto) {
    this.support.assertAnyPermission("accounting.manage", "accounting.post");
    const { companyId } = this.support.context();
    const current = await sql<Record<string, unknown>>`
      select e.id as "sourceId",e.expense_number as "sourceReference",
             e.accounting_date as "accountingDate",e.approved_amount::text as amount,
             case
               when ae.id is not null then 'already_represented'
               when e.status not in ('approved','partially_paid','paid','reversed')
                 then 'not_financial'
               else 'eligible_preview_only'
             end as outcome
        from general_expenses e
        left join accounting_events ae
          on ae.company_id=e.company_id
         and ae.source_entity_type='general_expense'
         and ae.source_entity_id=e.id
         and ae.event_type='general_expense_approved'
       where e.company_id=${companyId}::uuid
         and e.accounting_date between ${input.dateFrom}::date and ${input.dateTo}::date
       order by e.accounting_date,e.expense_number
    `.execute(this.database);
    let legacy: readonly Record<string, unknown>[] = [];
    if (input.includeLegacyOperatingExpenses === true) {
      const result = await sql<Record<string, unknown>>`
        select id as "sourceId",expense_number as "sourceReference",
               business_date as "accountingDate",amount::text,
               'legacy_incompatible_read_only' as outcome
          from operating_expenses
         where company_id=${companyId}::uuid
           and business_date between ${input.dateFrom}::date and ${input.dateTo}::date
         order by business_date,expense_number
      `.execute(this.database);
      legacy = result.rows;
    }
    return {
      executionSupported: false,
      generatedAt: new Date().toISOString(),
      items: [...current.rows, ...legacy],
      note:
        "Preview only. Legacy operating expenses are not automatically converted or posted.",
    };
  }
}
