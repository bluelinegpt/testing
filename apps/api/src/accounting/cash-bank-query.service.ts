import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import type {
  CashBankBackfillPreviewDto,
  CashBankListQueryDto,
} from "./cash-bank.dto.js";

@Injectable()
export class CashBankQueryService {
  public constructor(
    @Inject(DATABASE) private readonly database: import("kysely").Kysely<DatabaseSchema>,
    @Inject(AccountingOperationSupport)
    private readonly support: AccountingOperationSupport,
  ) {}

  public async list(input: CashBankListQueryDto) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 50;
    const search = input.search?.trim() || null;
    const result = await sql<Record<string, unknown>>`
      select m.id,m.movement_number as "movementNumber",m.movement_type as "movementType",
             m.movement_date::text as "movementDate",m.accounting_date::text as "accountingDate",
             m.amount::text,m.fee_amount::text as "feeAmount",m.currency,m.status,
             m.reference_number as "referenceNumber",m.external_reference as "externalReference",
             m.description,m.source_cash_account_id as "sourceCashAccountId",
             sc.cash_account_name as "sourceCashAccountName",
             m.source_bank_account_id as "sourceBankAccountId",
             sb.account_name as "sourceBankAccountName",
             m.destination_cash_account_id as "destinationCashAccountId",
             dc.cash_account_name as "destinationCashAccountName",
             m.destination_bank_account_id as "destinationBankAccountId",
             db.account_name as "destinationBankAccountName",
             m.accounting_event_id as "accountingEventId",j.id as "journalId",
             j.journal_number as "journalNumber",m.created_at as "createdAt",
             count(*) over()::text as "totalCount"
        from cash_bank_movements m
        left join company_cash_accounts sc on sc.id=m.source_cash_account_id and sc.company_id=m.company_id
        left join company_bank_accounts sb on sb.id=m.source_bank_account_id and sb.company_id=m.company_id
        left join company_cash_accounts dc on dc.id=m.destination_cash_account_id and dc.company_id=m.company_id
        left join company_bank_accounts db on db.id=m.destination_bank_account_id and db.company_id=m.company_id
        left join accounting_events e on e.id=m.accounting_event_id and e.company_id=m.company_id
        left join journal_entries j on j.id=e.journal_id and j.company_id=e.company_id
       where m.company_id=${companyId}::uuid
         and (${input.movementType ?? null}::text is null or m.movement_type=${input.movementType ?? null})
         and (${input.status ?? null}::text is null or m.status=${input.status ?? null})
         and (${input.dateFrom ?? null}::date is null or m.accounting_date>=${input.dateFrom ?? null}::date)
         and (${input.dateTo ?? null}::date is null or m.accounting_date<=${input.dateTo ?? null}::date)
         and (${input.cashAccountId ?? null}::uuid is null or
              ${input.cashAccountId ?? null}::uuid in(m.source_cash_account_id,m.destination_cash_account_id))
         and (${input.bankAccountId ?? null}::uuid is null or
              ${input.bankAccountId ?? null}::uuid in(m.source_bank_account_id,m.destination_bank_account_id))
         and (${input.reversedOnly ?? false}::boolean=false or m.status='reversed')
         and (${input.missingJournalOnly ?? false}::boolean=false or
              (m.status='confirmed' and j.id is null))
         and (${search}::text is null or
              m.movement_number ilike '%'||${search}||'%' or
              coalesce(m.reference_number,'') ilike '%'||${search}||'%' or
              coalesce(m.external_reference,'') ilike '%'||${search}||'%')
       order by m.accounting_date desc,m.created_at desc
       limit ${pageSize} offset ${(page - 1) * pageSize}
    `.execute(this.database);
    return { items: result.rows, page, pageSize, total: result.rows[0]?.totalCount ?? "0" };
  }

  public async detail(id: string) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const movement = await sql<Record<string, unknown>>`
      select m.*,j.id as "journalId",j.journal_number as "journalNumber",
             e.processing_status as "accountingEventStatus",e.last_error_code as "accountingErrorCode"
        from cash_bank_movements m
        left join accounting_events e on e.id=m.accounting_event_id and e.company_id=m.company_id
        left join journal_entries j on j.id=e.journal_id and j.company_id=e.company_id
       where m.id=${id}::uuid and m.company_id=${companyId}::uuid
    `.execute(this.database);
    if (movement.rows[0] === undefined) {
      throw new ApplicationException(
        "accounting_cash_bank_movement_not_found",
        "The Cash/Bank movement was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const attachments = await sql<Record<string, unknown>>`
      select id,file_object_id as "fileObjectId",attachment_type as "attachmentType",
             description,file_name_snapshot as "fileName",content_type_snapshot as "contentType",
             size_bytes_snapshot::text as "sizeBytes",uploaded_at as "uploadedAt"
        from cash_bank_movement_attachments
       where company_id=${companyId}::uuid and movement_id=${id}::uuid and is_active
       order by uploaded_at,id
    `.execute(this.database);
    return { ...movement.rows[0], attachments: attachments.rows };
  }

  public async summary() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select count(*) filter(where status='draft')::text as "draftCount",
             count(*) filter(where status='confirmed')::text as "confirmedCount",
             count(*) filter(where status='reversed')::text as "reversedCount",
             coalesce(sum(amount) filter(where status='confirmed'),0)::text as "confirmedAmount",
             count(*) filter(where status='confirmed' and accounting_event_id is null)::text
               as "missingEventCount"
        from cash_bank_movements where company_id=${companyId}::uuid
    `.execute(this.database);
    return result.rows[0];
  }

  public async balances() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      with movements as (
        select source_cash_account_id as id,'cash'::text as kind,-amount-fee_amount as value
          from cash_bank_movements where company_id=${companyId}::uuid
           and status in('confirmed','reversed') and reversal_of_movement_id is null
        union all select destination_cash_account_id,'cash',amount
          from cash_bank_movements where company_id=${companyId}::uuid
           and status in('confirmed','reversed') and reversal_of_movement_id is null
        union all select source_bank_account_id,'bank',-amount-fee_amount
          from cash_bank_movements where company_id=${companyId}::uuid
           and status in('confirmed','reversed') and reversal_of_movement_id is null
        union all select destination_bank_account_id,'bank',amount
          from cash_bank_movements where company_id=${companyId}::uuid
           and status in('confirmed','reversed') and reversal_of_movement_id is null
        union all select o.source_cash_account_id,'cash',o.amount+o.fee_amount
          from cash_bank_movements r join cash_bank_movements o
            on o.id=r.reversal_of_movement_id and o.company_id=r.company_id
         where r.company_id=${companyId}::uuid and r.status='confirmed'
        union all select o.destination_cash_account_id,'cash',-o.amount
          from cash_bank_movements r join cash_bank_movements o
            on o.id=r.reversal_of_movement_id and o.company_id=r.company_id
         where r.company_id=${companyId}::uuid and r.status='confirmed'
        union all select o.source_bank_account_id,'bank',o.amount+o.fee_amount
          from cash_bank_movements r join cash_bank_movements o
            on o.id=r.reversal_of_movement_id and o.company_id=r.company_id
         where r.company_id=${companyId}::uuid and r.status='confirmed'
        union all select o.destination_bank_account_id,'bank',-o.amount
          from cash_bank_movements r join cash_bank_movements o
            on o.id=r.reversal_of_movement_id and o.company_id=r.company_id
         where r.company_id=${companyId}::uuid and r.status='confirmed'
      ), accounts as (
        select id,'cash'::text kind,cash_account_code code,cash_account_name name,is_active,
               linked_gl_account_id
          from company_cash_accounts where company_id=${companyId}::uuid
        union all
        select id,'bank',bank_account_code,account_name,is_active,linked_gl_account_id
          from company_bank_accounts where company_id=${companyId}::uuid
      ), opening as (
        select l.account_id,coalesce(sum(l.debit-l.credit),0) as value
          from journal_lines l join journal_entries j
            on j.id=l.journal_entry_id and j.company_id=l.company_id
         where l.company_id=${companyId}::uuid and j.status='posted'
           and j.journal_type='opening_balance'
         group by l.account_id
      )
      select a.id,a.kind,a.code,a.name,a.is_active as "isActive",
             (coalesce(o.value,0)+coalesce(sum(m.value),0))::numeric(18,2)::text as balance
        from accounts a left join movements m on m.id=a.id and m.kind=a.kind
        left join opening o on o.account_id=a.linked_gl_account_id
       group by a.id,a.kind,a.code,a.name,a.is_active,o.value order by a.kind,a.code
    `.execute(this.database);
    return result.rows;
  }

  public async ledger(kind: "cash" | "bank", accountId: string, input: CashBankListQueryDto) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const source = kind === "cash" ? sql.ref("m.source_cash_account_id") : sql.ref("m.source_bank_account_id");
    const destination = kind === "cash" ? sql.ref("m.destination_cash_account_id") : sql.ref("m.destination_bank_account_id");
    const originalSource = kind === "cash" ? sql.ref("o.source_cash_account_id") : sql.ref("o.source_bank_account_id");
    const originalDestination = kind === "cash" ? sql.ref("o.destination_cash_account_id") : sql.ref("o.destination_bank_account_id");
    const result = await sql<Record<string, unknown>>`
      with selected_account as (
        select linked_gl_account_id as gl_id from ${
          kind === "cash" ? sql`company_cash_accounts` : sql`company_bank_accounts`
        } where id=${accountId}::uuid and company_id=${companyId}::uuid
      ), opening as (
        select coalesce(sum(l.debit-l.credit),0) as amount
          from journal_lines l join journal_entries j
            on j.id=l.journal_entry_id and j.company_id=l.company_id
         where l.company_id=${companyId}::uuid and j.status='posted'
           and j.journal_type='opening_balance'
           and l.account_id=(select gl_id from selected_account)
      ), activity as (
        select m.id,m.movement_number,m.movement_type,m.accounting_date,m.status,
               m.reference_number,m.description,
               case when m.reversal_of_movement_id is null then
                 case when ${destination}=${accountId}::uuid then m.amount else 0 end
                 - case when ${source}=${accountId}::uuid then m.amount+m.fee_amount else 0 end
               else -(
                 case when ${originalDestination}=${accountId}::uuid then o.amount else 0 end
                 - case when ${originalSource}=${accountId}::uuid then o.amount+o.fee_amount else 0 end
               ) end as net
          from cash_bank_movements m
          left join cash_bank_movements o
            on o.id=m.reversal_of_movement_id and o.company_id=m.company_id
         where m.company_id=${companyId}::uuid and m.status in('confirmed','reversed')
           and (${input.dateTo ?? null}::date is null or m.accounting_date<=${input.dateTo ?? null}::date)
           and (${source}=${accountId}::uuid or ${destination}=${accountId}::uuid
             or ${originalSource}=${accountId}::uuid or ${originalDestination}=${accountId}::uuid)
      ), running as (
      select id,movement_number as "movementNumber",movement_type as "movementType",
             accounting_date::text as "accountingDate",status,reference_number as "referenceNumber",
             description,case when net>0 then net else 0 end::text as debit,
             case when net<0 then -net else 0 end::text as credit,net::text,
             (select amount from opening)::numeric(18,2)::text as "openingBalance",
             ((select amount from opening)+sum(net) over(
               order by accounting_date,movement_number,id
             ))::numeric(18,2)::text as "runningBalance"
        from activity
      )
      select * from running
       where (${input.dateFrom ?? null}::date is null
         or "accountingDate"::date>=${input.dateFrom ?? null}::date)
       order by "accountingDate","movementNumber",id
    `.execute(this.database);
    let openingBalance = result.rows[0]?.openingBalance;
    if (openingBalance === undefined) {
      const opening = await sql<{ value: string }>`
        select coalesce(sum(l.debit-l.credit),0)::numeric(18,2)::text as value
          from ${
            kind === "cash" ? sql`company_cash_accounts` : sql`company_bank_accounts`
          } a
          left join journal_lines l
            on l.account_id=a.linked_gl_account_id and l.company_id=a.company_id
          left join journal_entries j
            on j.id=l.journal_entry_id and j.company_id=l.company_id
           and j.status='posted' and j.journal_type='opening_balance'
         where a.id=${accountId}::uuid and a.company_id=${companyId}::uuid
      `.execute(this.database);
      openingBalance = opening.rows[0]?.value ?? "0.00";
    }
    return {
      accountId,
      accountKind: kind,
      openingBalance,
      items: result.rows,
    };
  }

  public async reconciliation() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select m.id,m.movement_number as "movementNumber",m.accounting_date::text as "accountingDate",
             m.movement_type as "movementType",m.amount::text,m.fee_amount::text as "feeAmount",
             m.status,e.processing_status as "eventStatus",e.last_error_code as "errorCode",
             j.id as "journalId",j.journal_number as "journalNumber"
        from cash_bank_movements m
        left join accounting_events e on e.id=m.accounting_event_id and e.company_id=m.company_id
        left join journal_entries j on j.id=e.journal_id and j.company_id=e.company_id
       where m.company_id=${companyId}::uuid and m.status in('confirmed','reversed')
         and (e.id is null or e.processing_status<>'posted' or j.id is null)
       order by m.accounting_date,m.movement_number
    `.execute(this.database);
    const operational = await this.balances();
    const ledger = await sql<Record<string, unknown>>`
      with accounts as (
        select id,'cash'::text kind,linked_gl_account_id gl_id
          from company_cash_accounts where company_id=${companyId}::uuid
        union all
        select id,'bank',linked_gl_account_id
          from company_bank_accounts where company_id=${companyId}::uuid
      ), totals as (
        select l.account_id,coalesce(sum(l.debit-l.credit),0)::numeric(18,2) value
          from journal_lines l join journal_entries j
            on j.id=l.journal_entry_id and j.company_id=l.company_id
         where l.company_id=${companyId}::uuid and j.status='posted'
         group by l.account_id
      )
      select a.id,a.kind,coalesce(t.value,0)::text as "ledgerBalance"
        from accounts a left join totals t on t.account_id=a.gl_id
       order by a.kind,a.id
    `.execute(this.database);
    const ledgerByAccount = new Map(
      ledger.rows.map((row) => [`${String(row.kind)}:${String(row.id)}`, row.ledgerBalance]),
    );
    return {
      accountBalances: operational.map((row) => ({
        ...row,
        ledgerBalance: ledgerByAccount.get(`${String(row.kind)}:${String(row.id)}`) ?? "0.00",
      })),
      postingExceptions: result.rows,
    };
  }

  public async previewBackfill(input: CashBankBackfillPreviewDto) {
    this.support.assertPermission("accounting.manage");
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select m.id,m.movement_number as "movementNumber",m.movement_type as "movementType",
             m.accounting_date::text as "accountingDate",m.amount::text,m.fee_amount::text as "feeAmount",
             case when m.status not in('confirmed','reversed') then 'not_financial'
                  when m.accounting_event_id is not null then 'already_represented'
                  when m.movement_type='opening_balance' then 'opening_balance_workflow_required'
                  else 'eligible_for_controlled_backfill' end as outcome
        from cash_bank_movements m
       where m.company_id=${companyId}::uuid
         and m.accounting_date between ${input.dateFrom}::date and ${input.dateTo}::date
         and (${input.accountId ?? null}::uuid is null or ${input.accountId ?? null}::uuid in(
           m.source_cash_account_id,m.destination_cash_account_id,
           m.source_bank_account_id,m.destination_bank_account_id))
       order by m.accounting_date,m.movement_number
    `.execute(this.database);
    return {
      readOnly: true,
      noHistoricalPostingPerformed: true,
      items: result.rows,
    };
  }
}
