import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import type { AccountingReportKind, AccountingReportQueryDto } from "./accounting-report.dto.js";

type Row = Readonly<Record<string, unknown>>;
type ReportMode = "interactive" | "export" | "pdf";

export interface AccountingReportEnvelope {
  readonly columns: readonly string[];
  readonly currency: "AED";
  readonly dataSource: "posted_journal_lines" | "operational_reconciliation";
  readonly filters: Readonly<Record<string, string | undefined>>;
  readonly generatedAt: string;
  readonly items: readonly Row[];
  readonly kind: AccountingReportKind;
  readonly page: number;
  readonly pageSize: number;
  readonly provisional: boolean;
  readonly snapshotAt: string;
  readonly title: string;
  readonly total: number;
  readonly totalPages: number;
  readonly totals: Row;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
  readonly warningCodes: readonly string[];
}

const titles: Readonly<Record<AccountingReportKind, string>> = {
  "account-statement": "Account Statement",
  "balance-sheet": "Balance Sheet",
  "cash-movement": "Cash Movement",
  "general-expenses": "General Expense Report",
  "general-ledger": "General Ledger",
  "profit-and-loss": "Profit and Loss",
  "trial-balance": "Trial Balance",
  vat: "VAT Reporting Foundation",
};

@Injectable()
export class AccountingReportService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(AccountingOperationSupport) private readonly support: AccountingOperationSupport,
  ) {}

  public async readiness() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Row>`
      select exists(select 1 from accounting_configurations
                     where company_id=${companyId}::uuid and accounting_enabled) as "accountingEnabled",
             exists(select 1 from chart_of_accounts
                     where company_id=${companyId}::uuid and is_posting_account) as "hasPostingAccounts",
             exists(select 1 from fiscal_years
                     where company_id=${companyId}::uuid) as "hasFiscalYear",
             exists(select 1 from journal_entries
                     where company_id=${companyId}::uuid and status in ('posted','reversed')) as "hasPostedJournals",
             (select count(*)::int from journal_entries where company_id=${companyId}::uuid
               and status='approved') as "approvedUnpostedCount",
             (select count(*)::int from accounting_events where company_id=${companyId}::uuid
               and processing_status='failed') as "failedEventCount",
             (select count(*)::int from accounting_events where company_id=${companyId}::uuid
               and processing_status='blocked_configuration') as "configurationBlockedCount",
             (select count(*)::int from accounting_events where company_id=${companyId}::uuid
               and processing_status='failed' and error_code in
                 ('accounting_event_period_closed','accounting_event_period_soft_closed')) as "periodBlockedCount",
             (select max(business_date)::text from journal_entries where company_id=${companyId}::uuid
               and status in ('posted','reversed')) as "latestPostedJournalDate",
             (select min(effective_accounting_date)::text from accounting_events
               where company_id=${companyId}::uuid and processing_status in
                 ('failed','blocked_configuration','retry_pending')) as "oldestUnresolvedIssueDate",
             (select count(*)::int from chart_of_accounts
               where company_id=${companyId}::uuid and is_posting_account
                 and (account_type is null or account_class is null)) as "unclassifiedAccountCount",
             now()::text as "snapshotAt"
    `.execute(this.database);
    const row = result.rows[0]!;
    return {
      ...row,
      officialSource: "posted_journal_lines",
      ready: row.accountingEnabled === true && row.hasPostingAccounts === true,
      warnings: [
        ...(row.hasPostedJournals === false ? ["No Posted Journals are available yet."] : []),
        ...(Number(row.approvedUnpostedCount) > 0 ? ["Approved but unposted Journals exist."] : []),
        ...(Number(row.failedEventCount) > 0 ? ["Failed Accounting Events exist."] : []),
        ...(Number(row.configurationBlockedCount) > 0
          ? ["Configuration-blocked Accounting Events exist."]
          : []),
        ...(Number(row.periodBlockedCount) > 0 ? ["Period-blocked Accounting Events exist."] : []),
        ...(Number(row.unclassifiedAccountCount) > 0
          ? ["Some posting Accounts are unclassified and will remain visible under Unclassified."]
          : []),
      ],
      warningCodes: [
        ...(row.hasPostedJournals === false ? ["accounting_report_no_posted_journals"] : []),
        ...(Number(row.approvedUnpostedCount) > 0
          ? ["accounting_report_unposted_journals_exist"]
          : []),
        ...(Number(row.failedEventCount) > 0 ? ["accounting_report_failed_events_exist"] : []),
        ...(Number(row.configurationBlockedCount) > 0
          ? ["accounting_report_configuration_blockers_exist"]
          : []),
        ...(Number(row.periodBlockedCount) > 0 ? ["accounting_report_period_blockers_exist"] : []),
        ...(Number(row.unclassifiedAccountCount) > 0
          ? ["accounting_report_unclassified_accounts"]
          : []),
      ],
    };
  }

  public async report(
    kind: AccountingReportKind,
    query: AccountingReportQueryDto,
    mode: ReportMode = "interactive",
  ): Promise<AccountingReportEnvelope> {
    this.support.assertPermission("accounting.view");
    this.validate(kind, query);
    const limit =
      mode === "interactive" ? Math.min(query.pageSize ?? 50, 200) : mode === "pdf" ? 1_000 : 5_000;
    const page = mode === "interactive" ? (query.page ?? 1) : 1;
    let data: {
      columns: readonly string[];
      items: readonly Row[];
      total: number;
      totals: Row;
      warnings?: readonly string[];
    };
    switch (kind) {
      case "trial-balance":
        data = await this.trialBalance(query, page, limit);
        break;
      case "general-ledger":
      case "account-statement":
        data = await this.ledger(query, page, limit);
        break;
      case "profit-and-loss":
        data = await this.profitAndLoss(query);
        break;
      case "balance-sheet":
        data = await this.balanceSheet(query);
        break;
      case "cash-movement":
        data = await this.cashMovement(query);
        break;
      case "general-expenses":
        data = await this.generalExpenses(query, page, limit);
        break;
      case "vat":
        data = await this.vat(query);
        break;
    }
    const metadata = await sql<{ provisional: boolean; snapshotAt: string }>`
      select now()::text as "snapshotAt",
             exists(select 1 from accounting_periods
               where company_id=${this.support.context().companyId}::uuid
                 and status in ('open','reopened')
                 and period_start <= coalesce(${query.dateTo ?? query.asOfDate ?? null}::date,current_date)
                 and period_end >= coalesce(${query.dateFrom ?? query.asOfDate ?? null}::date,current_date)
             ) as provisional
    `.execute(this.database);
    const snapshotAt = metadata.rows[0]!.snapshotAt;
    const truncated = mode !== "interactive" && data.total > limit;
    return {
      columns: data.columns,
      currency: "AED",
      dataSource:
        kind === "general-expenses" ? "operational_reconciliation" : "posted_journal_lines",
      filters: {
        accountId: query.accountId,
        asOfDate: query.asOfDate,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
      },
      generatedAt: snapshotAt,
      items: data.items,
      kind,
      page,
      pageSize: limit,
      provisional: metadata.rows[0]!.provisional,
      snapshotAt,
      title: titles[kind],
      total: data.total,
      totalPages: Math.max(1, Math.ceil(data.total / limit)),
      totals: data.totals,
      truncated,
      warnings: [
        ...(metadata.rows[0]!.provisional
          ? ["This report includes an Open or Reopened Period and is provisional."]
          : []),
        ...(data.warnings ?? []),
        ...(truncated
          ? [`The ${mode} limit is ${limit} rows. Narrow the filters to include all rows.`]
          : []),
      ],
      warningCodes: [
        ...(metadata.rows[0]!.provisional ? ["accounting_report_open_period_provisional"] : []),
        ...(kind === "vat" ? ["accounting_report_vat_not_tax_return"] : []),
        ...(kind === "cash-movement" ? ["accounting_report_bank_reconciliation_unavailable"] : []),
        ...(kind === "general-expenses"
          ? ["accounting_report_reconciliation_difference_possible"]
          : []),
        ...((data.warnings?.length ?? 0) > 0 &&
        !["vat", "cash-movement", "general-expenses"].includes(kind)
          ? ["accounting_report_reconciliation_difference"]
          : []),
        ...(truncated ? ["accounting_report_query_limit_exceeded"] : []),
      ],
    };
  }

  public async auditGeneration(kind: string, format: string, filters: object): Promise<void> {
    const { companyId } = this.support.context();
    await this.support.audit(this.database, {
      action: `accounting.report.${format}`,
      after: { filters, format, report: kind },
      correlationId: randomUUID(),
      subjectId: companyId,
      subjectType: "accounting_report",
    });
  }

  public async document(
    type: "journal" | "opening-balance" | "expense" | "expense-payment" | "cash-bank-movement",
    id: string,
  ): Promise<{
    columns: readonly string[];
    items: readonly Row[];
    title: string;
    warnings: readonly string[];
  }> {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    let result;
    if (type === "journal") {
      result = await sql<Row>`
        select j.journal_number as "Document Number",j.business_date::text as "Date",
               j.status as "Status",j.description as "Description",
               a.code as "Account Code",a.name_en as "Account",
               l.description as "Line Description",l.debit::text as "Debit",l.credit::text as "Credit",
               j.source_reference as "Reference"
          from journal_entries j join journal_lines l on l.journal_entry_id=j.id and l.company_id=j.company_id
          join chart_of_accounts a on a.id=l.account_id and a.company_id=l.company_id
         where j.company_id=${companyId}::uuid and j.id=${id}::uuid order by l.line_number
      `.execute(this.database);
    } else if (type === "opening-balance") {
      result = await sql<Row>`
        select b.batch_number as "Document Number",b.effective_date::text as "Date",b.status as "Status",
               a.code as "Account Code",a.name_en as "Account",l.debit::text as "Debit",
               l.credit::text as "Credit",l.description as "Description"
          from opening_balance_batches b join opening_balance_lines l
            on l.opening_balance_batch_id=b.id and l.company_id=b.company_id
          join chart_of_accounts a on a.id=l.account_id and a.company_id=l.company_id
         where b.company_id=${companyId}::uuid and b.id=${id}::uuid order by l.line_number
      `.execute(this.database);
    } else if (type === "expense") {
      result = await sql<Row>`
        select e.expense_number as "Document Number",e.expense_date::text as "Date",e.status as "Status",
               l.line_number::text as "Line",l.category_code_snapshot as "Category",
               l.description as "Description",l.net_amount::text as "Net",
               l.vat_amount::text as "VAT",l.gross_amount::text as "Gross",e.reference_number as "Reference"
          from general_expenses e join general_expense_lines l
            on l.general_expense_id=e.id and l.company_id=e.company_id
         where e.company_id=${companyId}::uuid and e.id=${id}::uuid order by l.line_number
      `.execute(this.database);
    } else if (type === "expense-payment") {
      result = await sql<Row>`
        select p.payment_number as "Document Number",p.payment_date::text as "Date",p.status as "Status",
               e.expense_number as "Expense",e.payee_name_snapshot as "Payee",
               p.amount::text as "Amount",p.cash_amount::text as "Cash",p.visa_amount::text as "Visa",
               p.reference_number as "Reference",p.notes as "Notes"
          from general_expense_payments p join general_expenses e
            on e.id=p.general_expense_id and e.company_id=p.company_id
         where p.company_id=${companyId}::uuid and p.id=${id}::uuid
      `.execute(this.database);
    } else {
      result = await sql<Row>`
        select m.movement_number as "Document Number",m.movement_date::text as "Date",m.status as "Status",
               m.movement_type as "Movement Type",m.amount::text as "Amount",m.fee_amount::text as "Fee",
               m.payment_method as "Payment Method",m.reference_number as "Reference",
               m.description as "Description"
          from cash_bank_movements m where m.company_id=${companyId}::uuid and m.id=${id}::uuid
      `.execute(this.database);
    }
    if (result.rows.length === 0) {
      throw new ApplicationException(
        "accounting_document_not_found",
        "The Accounting document was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return {
      columns: Object.keys(result.rows[0]!),
      items: result.rows,
      title: titlesForDocument[type],
      warnings: [],
    };
  }

  private validate(kind: AccountingReportKind, query: AccountingReportQueryDto): void {
    if (
      query.dateFrom !== undefined &&
      query.dateTo !== undefined &&
      query.dateFrom > query.dateTo
    ) {
      throw new ApplicationException(
        "accounting_report_date_range_invalid",
        "The report start date must not be after the end date",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (["general-ledger", "account-statement"].includes(kind) && query.accountId === undefined) {
      throw new ApplicationException(
        "accounting_report_account_required",
        "Select an Account for this report",
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async trialBalance(query: AccountingReportQueryDto, page: number, limit: number) {
    const { companyId } = this.support.context();
    const offset = (page - 1) * limit;
    const result = await sql<Row & { totalRows: number }>`
      with balances as (
        select a.id,a.code,a.name_en as "accountNameEn",a.name_ar as "accountNameAr",
               a.account_type as "accountType",a.account_class as "accountClass",
               coalesce(sum(l.debit-l.credit) filter(where j.business_date < ${query.dateFrom ?? "0001-01-01"}::date),0) as opening,
               coalesce(sum(l.debit) filter(where j.business_date between ${query.dateFrom ?? "0001-01-01"}::date and ${query.dateTo ?? "9999-12-31"}::date),0) as debits,
               coalesce(sum(l.credit) filter(where j.business_date between ${query.dateFrom ?? "0001-01-01"}::date and ${query.dateTo ?? "9999-12-31"}::date),0) as credits
          from chart_of_accounts a
          left join journal_lines l on l.account_id=a.id and l.company_id=a.company_id
          left join journal_entries j on j.id=l.journal_entry_id and j.company_id=l.company_id and j.status in ('posted','reversed')
         where a.company_id=${companyId}::uuid and a.is_posting_account
         group by a.id,a.code,a.name_en,a.name_ar,a.account_type,a.account_class
      ), visible as (
        select *, opening+debits-credits as closing from balances
         where ${query.includeZero ?? false} or opening<>0 or debits<>0 or credits<>0
      )
      select id,code,"accountNameEn","accountNameAr","accountType",
             coalesce("accountClass",'unclassified') as "accountClass",
             case when opening>=0 then opening else 0 end::text as "openingDebit",
             case when opening<0 then -opening else 0 end::text as "openingCredit",
             debits::text as "periodDebit",credits::text as "periodCredit",
             case when closing>=0 then closing else 0 end::text as "closingDebit",
             case when closing<0 then -closing else 0 end::text as "closingCredit",
             count(*) over()::int as "totalRows"
        from visible order by code,id limit ${limit} offset ${offset}
    `.execute(this.database);
    const totals = await sql<Row>`
      with balances as (
        select a.id,
          coalesce(sum(l.debit-l.credit) filter(where j.business_date < ${query.dateFrom ?? "0001-01-01"}::date),0) opening,
          coalesce(sum(l.debit) filter(where j.business_date between ${query.dateFrom ?? "0001-01-01"}::date and ${query.dateTo ?? "9999-12-31"}::date),0) debits,
          coalesce(sum(l.credit) filter(where j.business_date between ${query.dateFrom ?? "0001-01-01"}::date and ${query.dateTo ?? "9999-12-31"}::date),0) credits
        from chart_of_accounts a left join journal_lines l on l.account_id=a.id and l.company_id=a.company_id
        left join journal_entries j on j.id=l.journal_entry_id and j.company_id=l.company_id and j.status in ('posted','reversed')
        where a.company_id=${companyId}::uuid and a.is_posting_account group by a.id
      ) select coalesce(sum(greatest(opening,0)),0)::text as "openingDebit",
          coalesce(sum(greatest(-opening,0)),0)::text as "openingCredit",
          coalesce(sum(debits),0)::text as "periodDebit",coalesce(sum(credits),0)::text as "periodCredit",
          coalesce(sum(greatest(opening+debits-credits,0)),0)::text as "closingDebit",
          coalesce(sum(greatest(-(opening+debits-credits),0)),0)::text as "closingCredit",
          (coalesce(sum(greatest(opening+debits-credits,0)),0)
           -coalesce(sum(greatest(-(opening+debits-credits),0)),0))::text as difference from balances
    `.execute(this.database);
    const total = result.rows[0]?.totalRows ?? 0;
    return {
      columns: [
        "code",
        "accountNameEn",
        "accountNameAr",
        "accountType",
        "accountClass",
        "openingDebit",
        "openingCredit",
        "periodDebit",
        "periodCredit",
        "closingDebit",
        "closingCredit",
      ],
      items: result.rows.map(({ totalRows, ...row }) => {
        void totalRows;
        return row;
      }),
      total,
      totals: totals.rows[0] ?? {},
    };
  }

  private async ledger(query: AccountingReportQueryDto, page: number, limit: number) {
    const { companyId } = this.support.context();
    const offset = (page - 1) * limit;
    const accountResult = await sql<Row>`
      select code,name_en as "accountNameEn",name_ar as "accountNameAr",
             account_type as "accountType",account_class as "accountClass",
             normal_balance as "normalBalance",is_posting_account as "isPostingAccount"
        from chart_of_accounts where company_id=${companyId}::uuid and id=${query.accountId!}::uuid
    `.execute(this.database);
    const account = accountResult.rows[0];
    if (account === undefined) {
      throw new ApplicationException(
        "accounting_account_not_found",
        "The selected Account was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    if (account.isPostingAccount !== true) {
      throw new ApplicationException(
        "accounting_report_posting_account_required",
        "Select a Posting Account for this report",
        HttpStatus.BAD_REQUEST,
      );
    }
    const result = await sql<Row & { totalRows: number }>`
      with base as (
        select coalesce(sum(l.debit-l.credit),0) as opening
          from journal_lines l join journal_entries j on j.id=l.journal_entry_id and j.company_id=l.company_id
         where j.company_id=${companyId}::uuid and j.status in ('posted','reversed') and l.account_id=${query.accountId!}::uuid
           and j.business_date < ${query.dateFrom ?? "0001-01-01"}::date
      ), activity as (
        select j.id as "journalId",j.journal_number as "journalNumber",j.business_date::text as "date",
               j.source_entity_type as "sourceEntityType",j.source_entity_id as "sourceEntityId",
               j.accounting_event_id as "eventId",
               l.line_number as "lineNumber",j.source_type as "source",coalesce(l.description,j.description) as "description",
               j.source_reference as "reference",l.debit::text as "debit",l.credit::text as "credit",
               (select opening from base)+sum(l.debit-l.credit) over(order by j.business_date,j.journal_number,l.line_number,l.id) as running,
               count(*) over()::int as "totalRows",
               (select opening from base)+sum(l.debit-l.credit) over() as closing
          from journal_lines l join journal_entries j on j.id=l.journal_entry_id and j.company_id=l.company_id
         where j.company_id=${companyId}::uuid and j.status in ('posted','reversed') and l.account_id=${query.accountId!}::uuid
           and j.business_date between ${query.dateFrom ?? "0001-01-01"}::date and ${query.dateTo ?? "9999-12-31"}::date
      )
      select *,(select opening::text from base) as "openingBalance",running::text as "runningBalance",
             closing::text as "closingBalance"
        from activity order by date,"journalNumber","lineNumber" limit ${limit} offset ${offset}
    `.execute(this.database);
    const items = result.rows.map(({ totalRows, running, closing, ...row }) => {
      void totalRows;
      void running;
      void closing;
      return row;
    });
    const total = result.rows[0]?.totalRows ?? 0;
    return {
      columns: [
        "date",
        "journalNumber",
        "source",
        "description",
        "reference",
        "debit",
        "credit",
        "runningBalance",
      ],
      items,
      total,
      totals: {
        ...account,
        openingBalance: result.rows[0]?.openingBalance ?? "0",
        closingBalance: result.rows[0]?.closingBalance ?? result.rows[0]?.openingBalance ?? "0",
      },
    };
  }

  private async profitAndLoss(query: AccountingReportQueryDto) {
    const { companyId } = this.support.context();
    const result = await sql<Row>`
      select a.id,a.account_type as "section",coalesce(a.account_class,'unclassified') as "accountClass",
             a.code,a.name_en as "accountNameEn",a.name_ar as "accountNameAr",
             (case when a.account_type='revenue' then sum(l.credit-l.debit) else sum(l.debit-l.credit) end)::text as amount
        from journal_lines l join journal_entries j on j.id=l.journal_entry_id and j.company_id=l.company_id
        join chart_of_accounts a on a.id=l.account_id and a.company_id=l.company_id
       where j.company_id=${companyId}::uuid and j.status in ('posted','reversed') and a.account_type in ('revenue','expense')
         and j.business_date between ${query.dateFrom ?? "0001-01-01"}::date and ${query.dateTo ?? "9999-12-31"}::date
       group by a.account_type,a.account_class,a.code,a.name_en,a.name_ar,a.id order by a.account_type desc,a.account_class,a.code
    `.execute(this.database);
    const totals = await sql<Row>`
      select coalesce(sum(case when a.account_type='revenue' then l.credit-l.debit else 0 end),0)::text as revenue,
             coalesce(sum(case when a.account_type='expense' then l.debit-l.credit else 0 end),0)::text as expenses,
             (coalesce(sum(case when a.account_type='revenue' then l.credit-l.debit else 0 end),0)
              -coalesce(sum(case when a.account_type='expense' then l.debit-l.credit else 0 end),0))::text as "netProfit"
        from journal_lines l join journal_entries j on j.id=l.journal_entry_id and j.company_id=l.company_id
        join chart_of_accounts a on a.id=l.account_id and a.company_id=l.company_id
       where j.company_id=${companyId}::uuid and j.status in ('posted','reversed')
         and j.business_date between ${query.dateFrom ?? "0001-01-01"}::date and ${query.dateTo ?? "9999-12-31"}::date
    `.execute(this.database);
    return {
      columns: ["section", "accountClass", "code", "accountNameEn", "accountNameAr", "amount"],
      items: result.rows,
      total: result.rows.length,
      totals: totals.rows[0] ?? {},
    };
  }

  private async balanceSheet(query: AccountingReportQueryDto) {
    const { companyId } = this.support.context();
    const asOf = query.asOfDate ?? query.dateTo ?? "9999-12-31";
    const result = await sql<Row>`
      select a.id,a.account_type as "section",coalesce(a.account_class,'unclassified') as "accountClass",
             a.code,a.name_en as "accountNameEn",a.name_ar as "accountNameAr",
             (case when a.account_type='asset' then sum(l.debit-l.credit) else sum(l.credit-l.debit) end)::text as amount
        from journal_lines l join journal_entries j on j.id=l.journal_entry_id and j.company_id=l.company_id
        join chart_of_accounts a on a.id=l.account_id and a.company_id=l.company_id
       where j.company_id=${companyId}::uuid and j.status in ('posted','reversed') and a.account_type in ('asset','liability','equity')
         and j.business_date <= ${asOf}::date
       group by a.account_type,a.account_class,a.code,a.name_en,a.name_ar,a.id order by a.account_type,a.account_class,a.code
    `.execute(this.database);
    const totals = await sql<Row>`
      with fy as (select start_date from fiscal_years where company_id=${companyId}::uuid
        and ${asOf}::date between start_date and end_date order by start_date desc limit 1),
      values as (
        select coalesce(sum(case when a.account_type='asset' then l.debit-l.credit else 0 end),0) assets,
          coalesce(sum(case when a.account_type='liability' then l.credit-l.debit else 0 end),0) liabilities,
          coalesce(sum(case when a.account_type='equity' then l.credit-l.debit else 0 end),0) equity
        from journal_lines l join journal_entries j on j.id=l.journal_entry_id and j.company_id=l.company_id
        join chart_of_accounts a on a.id=l.account_id and a.company_id=l.company_id
        where j.company_id=${companyId}::uuid and j.status in ('posted','reversed') and j.business_date<=${asOf}::date
      ), earnings as (
        select case when exists(select 1 from journal_entries j where j.company_id=${companyId}::uuid
                    and j.status='posted' and j.journal_type='closing' and j.business_date<=${asOf}::date
                    and j.business_date>=coalesce((select start_date from fy),'0001-01-01'::date))
          then 0 else coalesce(sum(case when a.account_type='revenue' then l.credit-l.debit
                                   when a.account_type='expense' then l.credit-l.debit else 0 end),0) end value
        from journal_lines l join journal_entries j on j.id=l.journal_entry_id and j.company_id=l.company_id
        join chart_of_accounts a on a.id=l.account_id and a.company_id=l.company_id
        where j.company_id=${companyId}::uuid and j.status in ('posted','reversed') and j.business_date<=${asOf}::date
          and j.business_date>=coalesce((select start_date from fy),'0001-01-01'::date)
      )
      select assets::text,liabilities::text,equity::text,earnings.value::text as "currentPeriodEarnings",
             (assets-liabilities-equity-earnings.value)::text as "balanceDifference",
             (assets=liabilities+equity+earnings.value) as balanced from values,earnings
    `.execute(this.database);
    return {
      columns: ["section", "accountClass", "code", "accountNameEn", "accountNameAr", "amount"],
      items: result.rows,
      total: result.rows.length,
      totals: totals.rows[0] ?? {},
      warnings:
        totals.rows[0]?.balanced === false
          ? ["Assets do not equal Liabilities plus Equity. No artificial balancing row was added."]
          : [],
    };
  }

  private async cashMovement(query: AccountingReportQueryDto) {
    const { companyId } = this.support.context();
    const result = await sql<Row>`
      select j.id as "journalId",j.source_entity_type as "sourceEntityType",
             j.source_entity_id as "sourceEntityId",j.accounting_event_id as "eventId",
             j.business_date::text as date,j.journal_number as "journalNumber",j.source_type as source,
             case when j.source_type='bank_transfer' or (
               select count(*) from journal_lines x join chart_of_accounts xa on xa.id=x.account_id and xa.company_id=x.company_id
                where x.journal_entry_id=j.id and xa.account_class in('cash','bank'))>1 then 'internal_transfer'
               when sum(l.debit-l.credit)>0 then 'inflow' else 'outflow' end as direction,
             (case when j.source_type='bank_transfer' or (
               select count(*) from journal_lines x join chart_of_accounts xa on xa.id=x.account_id and xa.company_id=x.company_id
                where x.journal_entry_id=j.id and xa.account_class in('cash','bank'))>1
               then greatest(sum(l.debit),sum(l.credit)) else abs(sum(l.debit-l.credit)) end)::text as amount,
             j.description,j.source_reference as reference
        from journal_entries j join journal_lines l on l.journal_entry_id=j.id and l.company_id=j.company_id
        join chart_of_accounts a on a.id=l.account_id and a.company_id=l.company_id
       where j.company_id=${companyId}::uuid and j.status in ('posted','reversed') and a.account_class in('cash','bank')
         and j.business_date between ${query.dateFrom ?? "0001-01-01"}::date and ${query.dateTo ?? "9999-12-31"}::date
       group by j.id,j.source_entity_type,j.source_entity_id,j.accounting_event_id,
             j.business_date,j.journal_number,j.source_type,j.description,j.source_reference
       order by j.business_date,j.journal_number
    `.execute(this.database);
    const totals = await sql<Row>`
      with movements as (
        select j.id,sum(l.debit-l.credit) amount,greatest(sum(l.debit),sum(l.credit)) transfer_amount,
          (j.source_type='bank_transfer' or count(*) filter(where a.account_class in('cash','bank'))>1) internal
        from journal_entries j join journal_lines l on l.journal_entry_id=j.id and l.company_id=j.company_id
        join chart_of_accounts a on a.id=l.account_id and a.company_id=l.company_id
        where j.company_id=${companyId}::uuid and j.status in ('posted','reversed') and a.account_class in('cash','bank')
          and j.business_date between ${query.dateFrom ?? "0001-01-01"}::date and ${query.dateTo ?? "9999-12-31"}::date
        group by j.id,j.source_type
      ) select coalesce(sum(amount) filter(where amount>0 and not internal),0)::text as "externalInflows",
               coalesce(sum(-amount) filter(where amount<0 and not internal),0)::text as "externalOutflows",
               coalesce(sum(transfer_amount) filter(where internal),0)::text as "internalTransfers"
          from movements
    `.execute(this.database);
    return {
      columns: [
        "date",
        "journalNumber",
        "source",
        "direction",
        "amount",
        "description",
        "reference",
      ],
      items: result.rows,
      total: result.rows.length,
      totals: totals.rows[0] ?? {},
      warnings: [
        "Internal transfers are shown but excluded from consolidated external inflow and outflow totals.",
      ],
    };
  }

  private async generalExpenses(query: AccountingReportQueryDto, page: number, limit: number) {
    const { companyId } = this.support.context();
    const offset = (page - 1) * limit;
    const result = await sql<Row & { totalRows: number }>`
      select e.id,e.expense_number as "expenseNumber",e.expense_date::text as "expenseDate",
             e.accounting_date::text as "accountingDate",e.category_code_snapshot as "categoryCode",
             e.category_name_en_snapshot as "categoryNameEn",e.category_name_ar_snapshot as "categoryNameAr",
             e.payee_name_snapshot as payee,e.description,e.status,e.payment_status as "paymentStatus",
             e.approved_amount::text as "operationalApproved",e.paid_amount::text as "operationalPaid",
             e.outstanding_amount::text as "operationalOutstanding",e.recoverable_vat_amount::text as "recoverableVat",
             -- Posted Net is the expense actually RECOGNISED in the ledger, so
             -- it sums only lines that hit an expense-type Account.
             --
             -- Without that restriction the subquery summed every posted line
             -- carrying this Expense — both sides of the approval Journal and
             -- both sides of each payment Journal. Those always balance, so the
             -- column could only ever report 0.00 once the Expense was posted,
             -- which read as "nothing was posted" for a correctly posted
             -- Expense. Recoverable input VAT is deliberately still excluded:
             -- it debits a receivable, not an expense, and has its own column.
             --
             -- 'reversed' stays alongside 'posted': a reversed original keeps
             -- its lines and the reversal Journal contributes the counter-lines,
             -- so a reversed Expense correctly nets back to zero.
             coalesce((select sum(l.debit-l.credit) from journal_lines l
                join journal_entries j
                  on j.id=l.journal_entry_id and j.company_id=l.company_id
                join chart_of_accounts a
                  on a.id=l.account_id and a.company_id=l.company_id
               where l.general_expense_id=e.id and j.status in ('posted','reversed')
                 and a.account_type='expense'),0)::text as "postedNet",
             count(*) over()::int as "totalRows"
        from general_expenses e where e.company_id=${companyId}::uuid
         and e.expense_date between ${query.dateFrom ?? "0001-01-01"}::date and ${query.dateTo ?? "9999-12-31"}::date
         and (${query.categoryId ?? null}::uuid is null or e.category_id=${query.categoryId ?? null}::uuid)
       order by e.expense_date,e.expense_number limit ${limit} offset ${offset}
    `.execute(this.database);
    const total = result.rows[0]?.totalRows ?? 0;
    return {
      columns: [
        "expenseNumber",
        "expenseDate",
        "accountingDate",
        "categoryCode",
        "categoryNameEn",
        "categoryNameAr",
        "payee",
        "description",
        "status",
        "paymentStatus",
        "operationalApproved",
        "operationalPaid",
        "operationalOutstanding",
        "recoverableVat",
        "postedNet",
      ],
      items: result.rows.map(({ totalRows, ...row }) => {
        void totalRows;
        return row;
      }),
      total,
      totals: {},
      warnings: [
        "Operational values are shown beside Posted Journal recognition; differences remain visible for reconciliation.",
      ],
    };
  }

  private async vat(query: AccountingReportQueryDto) {
    const { companyId } = this.support.context();
    const result = await sql<Row>`
      select a.id,a.code,a.name_en as "accountNameEn",a.name_ar as "accountNameAr",
             a.account_class as "accountClass",sum(l.debit)::text as debit,sum(l.credit)::text as credit,
             sum(l.credit-l.debit)::text as "netVat"
        from journal_lines l join journal_entries j on j.id=l.journal_entry_id and j.company_id=l.company_id
        join chart_of_accounts a on a.id=l.account_id and a.company_id=l.company_id
       where j.company_id=${companyId}::uuid and j.status in ('posted','reversed')
         and (a.account_class='vat_payable' or a.control_account_type='vat')
         and j.business_date between ${query.dateFrom ?? "0001-01-01"}::date and ${query.dateTo ?? "9999-12-31"}::date
       group by a.id,a.code,a.name_en,a.name_ar,a.account_class order by a.code
    `.execute(this.database);
    const totals = await sql<Row>`
      select coalesce(sum(l.recoverable_vat_amount),0)::text as "approvedRecoverableVat",
        coalesce((select sum(jl.debit-jl.credit) from journal_lines jl join journal_entries j
          on j.id=jl.journal_entry_id and j.company_id=jl.company_id join chart_of_accounts a
          on a.id=jl.account_id and a.company_id=jl.company_id where j.company_id=${companyId}::uuid
          and j.status in ('posted','reversed') and (a.account_class='vat_payable' or a.control_account_type='vat')
          and j.business_date between ${query.dateFrom ?? "0001-01-01"}::date and ${query.dateTo ?? "9999-12-31"}::date),0)::text as "postedVatNet"
        from general_expense_lines l join general_expenses e on e.id=l.general_expense_id and e.company_id=l.company_id
       where e.company_id=${companyId}::uuid and e.status in('approved','partially_paid','paid')
         and e.accounting_date between ${query.dateFrom ?? "0001-01-01"}::date and ${query.dateTo ?? "9999-12-31"}::date
    `.execute(this.database);
    return {
      columns: [
        "code",
        "accountNameEn",
        "accountNameAr",
        "accountClass",
        "debit",
        "credit",
        "netVat",
      ],
      items: result.rows,
      total: result.rows.length,
      totals: totals.rows[0] ?? {},
      warnings: [
        "This is a VAT reporting foundation for reconciliation only. It is not an FTA return, filing, or tax advice.",
      ],
    };
  }
}

const titlesForDocument = {
  "cash-bank-movement": "Cash / Bank Movement",
  expense: "General Expense",
  "expense-payment": "Expense Payment Receipt",
  journal: "Accounting Journal",
  "opening-balance": "Opening Balance",
} as const;
