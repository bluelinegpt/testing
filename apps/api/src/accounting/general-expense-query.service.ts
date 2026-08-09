import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import type {
  GeneralExpenseBackfillPreviewDto,
  GeneralExpenseListQueryDto,
  GeneralExpensePaymentListQueryDto,
  GeneralExpensePaymentPreviewQueryDto,
  PayableGeneralExpenseQueryDto,
} from "./general-expense.dto.js";

/** One mapping key resolved to a Chart of Accounts account, or the reason it could not be. */
export interface ResolvedMappingAccount {
  readonly accountCode: string | null;
  readonly accountId: string | null;
  readonly accountNameAr: string | null;
  readonly accountNameEn: string | null;
  /** Stable business code when unresolved, otherwise null. */
  readonly issue: string | null;
  readonly mappingKey: string;
  readonly status: "ambiguous" | "inactive_account" | "missing" | "not_posting_account" | "resolved";
}

@Injectable()
export class GeneralExpenseQueryService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(AccountingOperationSupport) private readonly support: AccountingOperationSupport,
  ) {}

  /**
   * Read-only resolution of one mapping key to its Chart of Accounts account,
   * mirroring `AccountMappingResolver` exactly (same Company scope, same
   * effective-date window, same debit/credit account preference order) but
   * reporting problems as data instead of throwing — so a detail view or a
   * preview can describe an unresolved mapping rather than fail.
   *
   * Never writes and never creates a Journal.
   */
  public async resolveMappingAccount(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    mappingKey: string | null,
    accountingDate: string,
    intent: "credit" | "debit",
  ): Promise<ResolvedMappingAccount> {
    const empty = {
      accountCode: null,
      accountId: null,
      accountNameAr: null,
      accountNameEn: null,
      mappingKey: mappingKey ?? "",
    };
    if (mappingKey === null || mappingKey.trim() === "") {
      return { ...empty, issue: "expense_account_mapping_key_missing", status: "missing" };
    }
    const result = await sql<{
      accountCode: string;
      accountId: string;
      accountNameAr: string | null;
      accountNameEn: string;
      active: boolean;
      posting: boolean;
    }>`
      select a.id as "accountId",a.code as "accountCode",
             a.name_en as "accountNameEn",a.name_ar as "accountNameAr",
             a.is_active as active,a.is_posting_account as posting
        from account_mappings m
        join chart_of_accounts a
          on a.company_id=m.company_id
         and a.id=case
           when ${intent}='debit'
             then coalesce(m.debit_account_id,m.expense_account_id,m.vat_account_id,
                           m.fee_account_id,m.payable_account_id,m.credit_account_id)
           else coalesce(m.credit_account_id,m.payable_account_id,m.vat_account_id,
                         m.fee_account_id,m.expense_account_id,m.debit_account_id)
         end
       where m.company_id=${companyId}::uuid
         and m.mapping_key=${mappingKey} and m.is_active
         and m.effective_from<=${accountingDate}::date
         and coalesce(m.effective_to,'infinity'::date)>=${accountingDate}::date
    `.execute(database);
    if (result.rows.length === 0) {
      return { ...empty, issue: "accounting_event_mapping_missing", status: "missing" };
    }
    if (result.rows.length > 1) {
      return { ...empty, issue: "accounting_event_mapping_overlap", status: "ambiguous" };
    }
    const account = result.rows[0]!;
    const resolved = {
      accountCode: account.accountCode,
      accountId: account.accountId,
      accountNameAr: account.accountNameAr,
      accountNameEn: account.accountNameEn,
      mappingKey,
    };
    if (!account.active) {
      return { ...resolved, issue: "accounting_event_mapping_inactive_account", status: "inactive_account" };
    }
    if (!account.posting) {
      return { ...resolved, issue: "accounting_event_mapping_summary_account", status: "not_posting_account" };
    }
    return { ...resolved, issue: null, status: "resolved" };
  }

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
      select e.id,e.expense_number as "expenseNumber",
             -- Cast to text so a business DATE crosses the wire as YYYY-MM-DD.
             -- Returned as a Date object it is serialised as a UTC timestamp,
             -- which both leaks a timezone and can display the previous day.
             e.expense_date::text as "expenseDate",
             e.accounting_date::text as "accountingDate",e.status,
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
             -- Business dates as YYYY-MM-DD text, never timezone-shifted
             -- timestamps (these override the matching e.* columns above).
             e.expense_date::text as "expenseDate",
             e.accounting_date::text as "accountingDate",
             e.tax_invoice_date::text as "taxInvoiceDate",
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
               -- ::text so a business DATE crosses the wire as YYYY-MM-DD. As a
               -- Date object it serialises to a UTC timestamp, which in
               -- Asia/Dubai (+04) renders as the PREVIOUS day — the reported
               -- "Payment Date 04 Aug but Event Date 03 Aug" mismatch.
               p.payment_date::text as "paymentDate",
               p.accounting_date::text as "accountingDate",
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
        select ev.id,ev.event_type as "eventType",
               ev.processing_status as "processingStatus",
               ev.journal_id as "journalId",
               ev.reversal_journal_id as "reversalJournalId",
               -- Journal NUMBERS so Related Records can show a business
               -- reference rather than a Journal identifier. Both joins are on
               -- the primary key and company_id, so no row escapes the Company.
               j.journal_number as "journalNumber",
               rj.journal_number as "reversalJournalNumber",
               ev.source_entity_type as "sourceEntityType",
               ev.source_entity_id as "sourceEntityId",
               ev.source_reference as "sourceReference",
               ev.error_code as "errorCode",
               ev.safe_error_summary as "safeErrorSummary",
               ev.attempt_count as "attemptCount",ev.created_at as "createdAt",
               ev.processed_at as "processedAt"
          from accounting_events ev
          left join journal_entries j
            on j.id=ev.journal_id and j.company_id=ev.company_id
          left join journal_entries rj
            on rj.id=ev.reversal_journal_id and rj.company_id=ev.company_id
         where ev.company_id=${companyId}::uuid
           and ev.operational_area='general_expenses'
           and (
             (ev.source_entity_type='general_expense'
               and ev.source_entity_id=${expenseId}::uuid)
             or
             (ev.source_entity_type='general_expense_payment'
               and ev.source_entity_id in (
                 select id from general_expense_payments
                  where company_id=${companyId}::uuid
                    and general_expense_id=${expenseId}::uuid
               ))
           )
         order by ev.created_at,ev.id
      `.execute(this.database),
    ]);
    const row = header.rows[0]!;
    // Resolve each line's expense account and the header's payable account so
    // the User sees "5030 — General Expense" instead of a blank cell. Raw
    // mapping keys are internal wiring and stay hidden unless the caller can
    // administer Accounting configuration.
    const accountingDate = String(row.accountingDate ?? row.expenseDate ?? "");
    const showTechnical = this.support.hasAnyPermission("accounting.configure", "accounting.manage");
    const resolvedLines = await Promise.all(
      lines.rows.map(async (line) => {
        const account = await this.resolveMappingAccount(
          this.database,
          companyId,
          typeof line.expenseAccountMappingKey === "string" ? line.expenseAccountMappingKey : null,
          accountingDate,
          "debit",
        );
        const { expenseAccountMappingKey, ...rest } = line;
        return {
          ...rest,
          ...(showTechnical ? { expenseAccountMappingKey } : {}),
          expenseAccountCode: account.accountCode,
          expenseAccountId: account.accountId,
          expenseAccountNameAr: account.accountNameAr,
          expenseAccountNameEn: account.accountNameEn,
          expenseAccountStatus: account.status,
        };
      }),
    );
    const payable = await this.resolveMappingAccount(
      this.database,
      companyId,
      "general_expense_payable",
      accountingDate,
      "credit",
    );
    return {
      ...row,
      accountingEvents: events.rows,
      attachments: attachments.rows,
      lines: resolvedLines,
      payableAccountCode: payable.accountCode,
      payableAccountId: payable.accountId,
      payableAccountNameAr: payable.accountNameAr,
      payableAccountNameEn: payable.accountNameEn,
      payableAccountStatus: payable.status,
      payments: payments.rows,
    };
  }

  /**
   * Read-only Accounting Preview for an unapproved (or approved) General
   * Expense: the Debit/Credit lines approval WOULD produce, the accounts they
   * resolve to, the outstanding amount that would be recognised, and any
   * blocking issues. Creates no Journal and no Accounting Event, and writes
   * nothing.
   */
  public async accountingPreview(expenseId: string) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const expense = (
      await sql<{
        accountingDate: string | null;
        approvedAmount: string;
        expenseDate: string | null;
        expenseNumber: string;
        outstandingAmount: string;
        paidAmount: string;
        status: string;
        totalAmount: string;
      }>`
        select expense_number as "expenseNumber",status,
               expense_date::text as "expenseDate",
               accounting_date::text as "accountingDate",
               total_amount::text as "totalAmount",
               approved_amount::text as "approvedAmount",
               paid_amount::text as "paidAmount",
               outstanding_amount::text as "outstandingAmount"
          from general_expenses
         where id=${expenseId}::uuid and company_id=${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (expense === undefined) {
      throw new ApplicationException(
        "accounting_general_expense_not_found",
        "The General Expense was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const accountingDate = expense.accountingDate ?? expense.expenseDate ?? "";
    const lines = (
      await sql<{
        description: string | null;
        expenseCostAmount: string;
        expenseMappingKey: string | null;
        lineNumber: number;
        recoverableVat: string;
      }>`
        select line_number as "lineNumber",description,
               expense_cost_amount::text as "expenseCostAmount",
               recoverable_vat_amount::text as "recoverableVat",
               expense_account_mapping_key as "expenseMappingKey"
          from general_expense_lines
         where company_id=${companyId}::uuid and general_expense_id=${expenseId}::uuid
         order by line_number,id
      `.execute(this.database)
    ).rows;

    const issues: string[] = [];
    const warnings: string[] = [];
    const previewLines: Record<string, unknown>[] = [];

    if (accountingDate === "") issues.push("accounting_date_required");
    if (lines.length === 0) issues.push("expense_lines_required");

    for (const line of lines) {
      const account = await this.resolveMappingAccount(
        this.database,
        companyId,
        line.expenseMappingKey,
        accountingDate,
        "debit",
      );
      if (account.issue !== null) issues.push(`${account.issue}:${line.expenseMappingKey ?? ""}`);
      previewLines.push({
        accountCode: account.accountCode,
        accountNameAr: account.accountNameAr,
        accountNameEn: account.accountNameEn,
        amount: line.expenseCostAmount,
        description: line.description,
        entryIntent: "debit",
        lineNumber: line.lineNumber,
        mappingStatus: account.status,
      });
      // Recoverable input VAT only produces a line when it is non-zero,
      // matching the posting loader's own zero-amount filtering.
      if (Number(line.recoverableVat) > 0) {
        const vat = await this.resolveMappingAccount(
          this.database,
          companyId,
          "input_vat",
          accountingDate,
          "debit",
        );
        if (vat.issue !== null) issues.push(`${vat.issue}:input_vat`);
        previewLines.push({
          accountCode: vat.accountCode,
          accountNameAr: vat.accountNameAr,
          accountNameEn: vat.accountNameEn,
          amount: line.recoverableVat,
          description: "Recoverable input VAT",
          entryIntent: "debit",
          lineNumber: line.lineNumber,
          mappingStatus: vat.status,
        });
      }
    }

    const payable = await this.resolveMappingAccount(
      this.database,
      companyId,
      "general_expense_payable",
      accountingDate,
      "credit",
    );
    if (payable.issue !== null) issues.push(`${payable.issue}:general_expense_payable`);
    previewLines.push({
      accountCode: payable.accountCode,
      accountNameAr: payable.accountNameAr,
      accountNameEn: payable.accountNameEn,
      amount: expense.totalAmount,
      description: `General Expense payable ${expense.expenseNumber}`,
      entryIntent: "credit",
      mappingStatus: payable.status,
    });

    const debitTotal = previewLines
      .filter((line) => line.entryIntent === "debit")
      .reduce((sum, line) => sum + Number(line.amount ?? 0), 0);
    const creditTotal = previewLines
      .filter((line) => line.entryIntent === "credit")
      .reduce((sum, line) => sum + Number(line.amount ?? 0), 0);
    if (Math.abs(debitTotal - creditTotal) > 0.004) {
      issues.push("accounting_general_expense_amount_mismatch");
    }
    if (expense.status !== "submitted") warnings.push("not_awaiting_approval");

    return {
      approvable: issues.length === 0 && expense.status === "submitted",
      creditTotal: creditTotal.toFixed(2),
      currentOutstanding: expense.outstandingAmount,
      debitTotal: debitTotal.toFixed(2),
      expectedOutstandingAfterApproval:
        expense.status === "submitted"
          ? (Number(expense.totalAmount) - Number(expense.paidAmount)).toFixed(2)
          : expense.outstandingAmount,
      expenseNumber: expense.expenseNumber,
      grossAmount: expense.totalAmount,
      issues,
      lines: previewLines,
      paidAmount: expense.paidAmount,
      status: expense.status,
      warnings,
    };
  }

  public async payment(paymentId: string) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select p.id,p.payment_number as "paymentNumber",
             p.general_expense_id as "expenseId",e.expense_number as "expenseNumber",
             -- ::text: see the payments sub-query in detail() — a raw DATE
             -- serialises as a UTC timestamp and displays a day early.
             p.payment_date::text as "paymentDate",
             p.accounting_date::text as "accountingDate",
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

  /**
   * Everything the Record Payment form needs to render without the User
   * typing an identifier: the Company currency, today in the Company
   * timezone, and the active Cash and Bank Accounts with their GL link
   * resolved. Read-only.
   *
   * Cash and Bank are symmetrical: an option's `id` IS what the confirmation
   * contract expects -- `companyCashAccountId` for Cash, `companyBankAccountId`
   * for Bank. Neither carries a GL account id for the client to submit back.
   * The GL account is derived server-side from the chosen account's own link;
   * `glLinkValid` is published only so the form can decline to offer an account
   * whose link would fail, not so the client can nominate the account itself.
   */
  public async paymentContext() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const [configuration, settings, cash, bank] = await Promise.all([
      sql<{ baseCurrency: string }>`
        select base_currency as "baseCurrency" from accounting_configurations
         where company_id=${companyId}::uuid
      `.execute(this.database),
      sql<{ timezone: string }>`
        select timezone from company_settings where company_id=${companyId}::uuid
      `.execute(this.database),
      sql<Record<string, unknown>>`
        select c.id,c.cash_account_code as code,c.cash_account_name as name,
               c.cash_account_name_ar as "nameAr",c.currency,
               a.code as "glAccountCode",a.name_en as "glAccountName",
               (a.id is not null and a.is_active and a.is_posting_account
                 and a.account_type='asset' and a.account_class='cash') as "glLinkValid"
          from company_cash_accounts c
          left join chart_of_accounts a
            on a.id=c.linked_gl_account_id and a.company_id=c.company_id
         where c.company_id=${companyId}::uuid and c.is_active
         order by c.cash_account_code
      `.execute(this.database),
      sql<Record<string, unknown>>`
        select b.id,b.bank_account_code as code,b.account_name as name,
               b.bank_name as "bankName",b.currency,
               a.code as "glAccountCode",a.name_en as "glAccountName",
               (a.id is not null and a.is_active and a.is_posting_account) as "glLinkValid"
          from company_bank_accounts b
          left join chart_of_accounts a
            on a.id=b.linked_gl_account_id and a.company_id=b.company_id
         where b.company_id=${companyId}::uuid and b.is_active
         order by b.bank_account_code
      `.execute(this.database),
    ]);
    const timezone = settings.rows[0]?.timezone ?? "Asia/Dubai";
    const parts = new Intl.DateTimeFormat("en", {
      day: "2-digit",
      month: "2-digit",
      timeZone: timezone,
      year: "numeric",
    })
      .formatToParts(new Date())
      .reduce<Record<string, string>>((result, part) => {
        result[part.type] = part.value;
        return result;
      }, {});
    return {
      bankAccounts: bank.rows,
      cashAccounts: cash.rows,
      currency: configuration.rows[0]?.baseCurrency ?? "AED",
      timezone,
      today: `${parts.year}-${parts.month}-${parts.day}`,
    };
  }

  /**
   * Eligible "Expense to Pay" options: Company-scoped, approved (or already
   * partially paid), never reversed or cancelled, and still carrying an
   * outstanding amount. A fully paid Expense can never appear, so the
   * selector cannot offer an Expense that would be rejected on confirmation.
   */
  public async payableExpenses(query: PayableGeneralExpenseQueryDto) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const search = query.search?.trim() ?? "";
    const result = await sql<Record<string, unknown>>`
      select e.id,e.expense_number as "expenseNumber",
             e.payee_name_snapshot as "payeeName",e.payee_type as "payeeType",
             e.reference_number as "referenceNumber",e.currency,
             e.expense_date::text as "expenseDate",
             e.accounting_date::text as "accountingDate",
             e.approved_amount::text as "approvedAmount",
             e.paid_amount::text as "paidAmount",
             e.outstanding_amount::text as "outstandingAmount",
             e.status,e.payment_status as "paymentStatus",e.version::text,
             c.code as "categoryCode",c.name_en as "categoryNameEn",
             c.name_ar as "categoryNameAr"
        from general_expenses e
        left join general_expense_categories c
          on c.id=e.category_id and c.company_id=e.company_id
       where e.company_id=${companyId}::uuid
         and e.status in ('approved','partially_paid')
         and e.payment_status in ('unpaid','partially_paid')
         and e.outstanding_amount>0
         and (
           ${search}=''
           or e.id=${query.includeExpenseId ?? null}::uuid
           or e.expense_number ilike ${`%${search}%`}
           or coalesce(e.payee_name_snapshot,'') ilike ${`%${search}%`}
           or coalesce(e.reference_number,'') ilike ${`%${search}%`}
           or coalesce(c.code,'') ilike ${`%${search}%`}
           or coalesce(c.name_en,'') ilike ${`%${search}%`}
           or coalesce(c.name_ar,'') ilike ${`%${search}%`}
         )
       order by e.expense_date,e.expense_number
       limit ${query.limit ?? 50}
    `.execute(this.database);
    return { items: result.rows };
  }

  /**
   * Read-only Payment preview: the Debit/Credit pair confirmation WOULD
   * produce, the outstanding before and after, and every blocker. Creates no
   * Journal, no Accounting Event, and no Payment — it only reads.
   *
   * The Debit/Credit shape mirrors `OperationalSourceLoader.generalExpensePayment`
   * exactly: Debit `general_expense_payable`, Credit
   * `general_expense_cash_payment` (overridden by the chosen Cash Account) or
   * `general_expense_bank_payment`.
   */
  public async paymentPreview(expenseId: string, query: GeneralExpensePaymentPreviewQueryDto) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const expense = (
      await sql<{
        accountingDate: string | null;
        approvedAmount: string;
        approvedBy: string | null;
        currency: string;
        expenseDate: string | null;
        expenseNumber: string;
        outstandingAmount: string;
        paidAmount: string;
        payeeName: string | null;
        status: string;
        version: string;
      }>`
        select expense_number as "expenseNumber",status,currency,
               payee_name_snapshot as "payeeName",
               approved_by_account_id as "approvedBy",
               expense_date::text as "expenseDate",
               accounting_date::text as "accountingDate",
               approved_amount::text as "approvedAmount",
               paid_amount::text as "paidAmount",
               outstanding_amount::text as "outstandingAmount",version::text
          from general_expenses
         where id=${expenseId}::uuid and company_id=${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (expense === undefined) {
      throw new ApplicationException(
        "accounting_general_expense_not_found",
        "The General Expense was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const issues: string[] = [];
    const accountingDate =
      query.accountingDate ?? expense.accountingDate ?? expense.expenseDate ?? "";
    if (accountingDate === "") issues.push("accounting_date_required");
    if (!["approved", "partially_paid"].includes(expense.status)) {
      issues.push("accounting_general_expense_not_payable");
    }
    // Segregation of duties, evaluated exactly as the confirmation does, so the
    // User learns they cannot release this payment before filling the form
    // rather than at the final click.
    if (
      expense.approvedBy !== null &&
      this.support.context().actorId === expense.approvedBy &&
      (await this.support.hasAlternateAuthorizedActor(this.database, "accounting.manage"))
    ) {
      issues.push("accounting_general_expense_payment_segregation_blocked");
    }
    // Decimal throughout: a payment amount is money, never a float.
    const outstanding = new Decimal(expense.outstandingAmount);
    let amount = new Decimal(0);
    try {
      amount = new Decimal(query.amount);
    } catch {
      issues.push("accounting_general_expense_payment_amount_invalid");
    }
    if (!amount.isFinite() || !amount.greaterThan(0)) {
      issues.push("accounting_general_expense_payment_amount_invalid");
    }
    if (!outstanding.greaterThan(0)) issues.push("accounting_general_expense_nothing_outstanding");
    if (amount.greaterThan(outstanding)) {
      issues.push("accounting_general_expense_payment_exceeds_outstanding");
    }
    const configuration = (
      await sql<{ baseCurrency: string }>`
        select base_currency as "baseCurrency" from accounting_configurations
         where company_id=${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    const currency = configuration?.baseCurrency ?? "AED";
    if (expense.currency !== currency) issues.push("accounting_general_expense_currency_mismatch");

    // Fiscal Period: a Payment can only be accounted into an Open Period.
    if (accountingDate !== "") {
      const period = (
        await sql<{ status: string }>`
          select status from accounting_periods
           where company_id=${companyId}::uuid
             and ${accountingDate}::date between period_start and period_end
           limit 1
        `.execute(this.database)
      ).rows[0];
      if (period === undefined) issues.push("accounting_event_fiscal_period_not_found");
      else if (period.status !== "open") issues.push("accounting_event_period_closed");
    }

    const payable = await this.resolveMappingAccount(
      this.database,
      companyId,
      "general_expense_payable",
      accountingDate === "" ? (expense.expenseDate ?? "") : accountingDate,
      "debit",
    );
    if (payable.issue !== null) issues.push(`${payable.issue}:general_expense_payable`);

    // Credit side: the chosen destination, resolved the same way the posting
    // path resolves it — Cash overrides the mapped account with the selected
    // Cash GL Account, Bank uses the Bank Account's own GL link.
    let credit: ResolvedMappingAccount = await this.resolveMappingAccount(
      this.database,
      companyId,
      query.paymentMethod === "cash"
        ? "general_expense_cash_payment"
        : "general_expense_bank_payment",
      accountingDate === "" ? (expense.expenseDate ?? "") : accountingDate,
      "credit",
    );
    if (query.paymentMethod === "cash") {
      if (query.companyCashAccountId === undefined) {
        issues.push("accounting_general_expense_cash_account_required");
      } else {
        // The preview resolves the credit the same way the confirmation does:
        // from the Cash Account's own GL link, never from a GL id supplied by
        // the caller. A preview that resolved it differently would show a line
        // the write path would not produce.
        const override = (
          await sql<{
            accountCode: string;
            accountId: string;
            accountNameAr: string | null;
            accountNameEn: string;
          }>`
            select a.id as "accountId",a.code as "accountCode",
                   a.name_en as "accountNameEn",a.name_ar as "accountNameAr"
              from company_cash_accounts c
              join chart_of_accounts a
                on a.id=c.linked_gl_account_id and a.company_id=c.company_id
             where c.id=${query.companyCashAccountId}::uuid and c.company_id=${companyId}::uuid
               and c.is_active
               and a.is_active and a.is_posting_account
               and a.account_type='asset' and a.account_class='cash'
          `.execute(this.database)
        ).rows[0];
        if (override === undefined) issues.push("accounting_general_expense_cash_account_invalid");
        else credit = { ...override, issue: null, mappingKey: credit.mappingKey, status: "resolved" };
      }
    } else if (query.companyBankAccountId === undefined) {
      issues.push("accounting_general_expense_bank_account_required");
    } else {
      const bank = (
        await sql<{
          accountCode: string | null;
          accountId: string | null;
          accountNameAr: string | null;
          accountNameEn: string | null;
          valid: boolean;
        }>`
          select a.id as "accountId",a.code as "accountCode",
                 a.name_en as "accountNameEn",a.name_ar as "accountNameAr",
                 (b.is_active and b.currency=${currency}) as valid
            from company_bank_accounts b
            left join chart_of_accounts a
              on a.id=b.linked_gl_account_id and a.company_id=b.company_id
           where b.id=${query.companyBankAccountId}::uuid and b.company_id=${companyId}::uuid
        `.execute(this.database)
      ).rows[0];
      if (bank === undefined || !bank.valid) {
        issues.push("accounting_general_expense_bank_account_invalid");
      } else if (bank.accountId === null) {
        issues.push("accounting_cash_bank_gl_account_invalid");
      } else if (credit.issue === null) {
        // The posting path credits the mapped Bank payment account; the Bank
        // Account's own GL link is surfaced alongside it for the User.
        credit = {
          ...credit,
          accountCode: bank.accountCode ?? credit.accountCode,
          accountId: bank.accountId,
          accountNameAr: bank.accountNameAr,
          accountNameEn: bank.accountNameEn ?? credit.accountNameEn,
        };
      }
    }
    if (credit.issue !== null) issues.push(`${credit.issue}:${credit.mappingKey}`);

    const remaining = outstanding.minus(amount.isFinite() ? amount : new Decimal(0));
    return {
      accountingDate,
      amount: amount.isFinite() ? amount.toFixed(2) : "0.00",
      confirmable: issues.length === 0,
      currency,
      expenseNumber: expense.expenseNumber,
      expenseStatus: expense.status,
      expenseVersion: expense.version,
      issues,
      lines: [
        {
          accountCode: payable.accountCode,
          accountNameAr: payable.accountNameAr,
          accountNameEn: payable.accountNameEn,
          amount: amount.isFinite() ? amount.toFixed(2) : "0.00",
          description: `Expense payable cleared by ${expense.expenseNumber}`,
          entryIntent: "debit",
          mappingStatus: payable.status,
        },
        {
          accountCode: credit.accountCode,
          accountNameAr: credit.accountNameAr,
          accountNameEn: credit.accountNameEn,
          amount: amount.isFinite() ? amount.toFixed(2) : "0.00",
          description: `${query.paymentMethod === "cash" ? "Cash" : "Bank"} payment`,
          entryIntent: "credit",
          mappingStatus: credit.status,
        },
      ],
      outstandingAfter: remaining.isNegative() ? "0.00" : remaining.toFixed(2),
      outstandingBefore: outstanding.toFixed(2),
      paidBefore: new Decimal(expense.paidAmount).toFixed(2),
      payeeName: expense.payeeName,
      paymentMethod: query.paymentMethod,
    };
  }

  public async payments(query: GeneralExpensePaymentListQueryDto) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    // Sorting is chosen from a closed list validated by the DTO, so the
    // resolved expression is a literal here and never User text.
    const sortColumns: Readonly<Record<string, string>> = {
      amount: "p.amount",
      expenseNumber: "e.expense_number",
      payee: "e.payee_name_snapshot",
      paymentDate: "p.payment_date",
      paymentNumber: "p.payment_number",
    };
    const sort = sortColumns[query.sortBy ?? "paymentDate"] ?? "p.payment_date";
    const direction = query.sortDirection === "asc" ? "asc" : "desc";
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
         and (${query.expenseNumber ?? null}::text is null
              or e.expense_number ilike '%'||${query.expenseNumber ?? null}||'%')
         and (${query.paymentNumber ?? null}::text is null
              or p.payment_number ilike '%'||${query.paymentNumber ?? null}||'%')
         and (${query.payee ?? null}::text is null
              or coalesce(e.payee_name_snapshot,'') ilike '%'||${query.payee ?? null}||'%')
         and (${query.amountFrom ?? null}::numeric is null
              or p.amount>=${query.amountFrom ?? null}::numeric)
         and (${query.amountTo ?? null}::numeric is null
              or p.amount<=${query.amountTo ?? null}::numeric)
         and (${query.accountingStatus ?? null}::text is null
           or (${query.accountingStatus ?? null}='posted' and ae.processing_status='posted')
           or (${query.accountingStatus ?? null}='failed'
               and ae.processing_status in ('failed','blocked_configuration','blocked_period'))
           or (${query.accountingStatus ?? null}='pending'
               and (ae.id is null
                    or ae.processing_status in ('received','processing','retry_pending'))))
       order by ${sql.raw(sort)} ${sql.raw(direction)} nulls last,p.created_at desc,p.id
       limit ${pageSize} offset ${(page - 1) * pageSize}
    `.execute(this.database);
    const totalCount = Number(result.rows[0]?.totalCount ?? 0);
    return {
      items: result.rows,
      page,
      pageSize,
      total: String(totalCount),
      // `totalCount` is the key the shared paging shape uses elsewhere; `total`
      // is preserved so existing callers keep working.
      totalCount,
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
      note: "Preview only. Legacy operating expenses are not automatically converted or posted.",
    };
  }
}
