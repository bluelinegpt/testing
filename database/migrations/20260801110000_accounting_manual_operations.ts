import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Accounting Prompt 2 operational metadata and lifecycle hardening.
 * Prompt 1 tables are evolved additively; no ledger model is duplicated.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table fiscal_years
      add column close_reason text,
      add column version bigint not null default 1,
      add constraint fiscal_years_version_positive check (version > 0);

    alter table accounting_periods
      add column close_reason text,
      add column version bigint not null default 1,
      add constraint accounting_periods_version_positive check (version > 0);

    alter table journal_entries
      add column notes text,
      add column approval_note text,
      add column posting_note text,
      add column version bigint not null default 1,
      add constraint journal_entries_version_positive check (version > 0);

    alter table opening_balance_batches
      add column notes text,
      add column approval_note text,
      add column posting_note text,
      add column version bigint not null default 1,
      add constraint opening_balance_batches_version_positive check (version > 0);

    alter table journal_lines
      add column account_code_snapshot text,
      add column account_name_en_snapshot text,
      add column account_name_ar_snapshot text;

    alter table opening_balance_lines
      add column account_code_snapshot text,
      add column account_name_en_snapshot text,
      add column account_name_ar_snapshot text;

    drop trigger if exists journal_lines_immutable_when_posted on journal_lines;
    drop trigger if exists opening_balance_lines_immutable on opening_balance_lines;

    update journal_lines l
       set account_code_snapshot=a.code,
           account_name_en_snapshot=a.name_en,
           account_name_ar_snapshot=a.name_ar
      from chart_of_accounts a
     where a.id=l.account_id and a.company_id=l.company_id;

    update opening_balance_lines l
       set account_code_snapshot=a.code,
           account_name_en_snapshot=a.name_en,
           account_name_ar_snapshot=a.name_ar
     from chart_of_accounts a
     where a.id=l.account_id and a.company_id=l.company_id;

    create trigger journal_lines_immutable_when_posted
      before insert or update or delete on journal_lines
      for each row execute function reject_posted_journal_line_mutation();
    create trigger opening_balance_lines_immutable
      before update or delete on opening_balance_lines
      for each row execute function protect_opening_balance_history();

    create function snapshot_accounting_line_account()
      returns trigger language plpgsql as $$
    begin
      if new.account_code_snapshot is null or new.account_name_en_snapshot is null then
        select code, name_en, name_ar
          into new.account_code_snapshot, new.account_name_en_snapshot,
               new.account_name_ar_snapshot
          from chart_of_accounts
         where id=new.account_id and company_id=new.company_id;
      end if;
      return new;
    end;
    $$;
    create trigger journal_lines_account_snapshot
      before insert or update of account_id on journal_lines
      for each row execute function snapshot_accounting_line_account();
    create trigger opening_balance_lines_account_snapshot
      before insert or update of account_id on opening_balance_lines
      for each row execute function snapshot_accounting_line_account();

    create or replace function reject_posted_journal_line_mutation()
      returns trigger language plpgsql as $$
    declare
      target_entry_id uuid;
      target_company_id uuid;
    begin
      target_entry_id := case when tg_op = 'DELETE' then old.journal_entry_id else new.journal_entry_id end;
      target_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
      if exists (
        select 1 from journal_entries
         where id = target_entry_id and company_id = target_company_id
           and status in ('balanced','approved','posted','reversed','cancelled')
      ) then
        raise exception using errcode = '23514',
          message = 'accounting_journal_not_editable';
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;

    create or replace function protect_accounting_journal_history()
      returns trigger language plpgsql as $$
    declare
      computed_debit numeric(18,2);
      computed_credit numeric(18,2);
    begin
      if tg_op = 'DELETE' and old.status in (
        'balanced','approved','posted','reversed','cancelled'
      ) then
        raise exception using errcode = '23514',
          message = 'accounting_journal_posted_immutable';
      end if;
      if tg_op = 'UPDATE' and old.status in ('posted','reversed','cancelled') then
        if not (
          old.status = 'posted'
          and new.status = 'reversed'
          and new.reversed_by_journal_id is not null
          and new.reversal_reason is not null
          and new.id = old.id
          and new.company_id = old.company_id
          and new.journal_number = old.journal_number
          and new.accounting_period_id = old.accounting_period_id
          and new.business_date = old.business_date
          and new.source_type = old.source_type
          and new.source_id is not distinct from old.source_id
          and new.currency = old.currency
          and new.total_debit = old.total_debit
          and new.total_credit = old.total_credit
        ) then
          raise exception using errcode = '23514',
            message = 'accounting_journal_posted_immutable';
        end if;
      end if;
      if tg_op = 'UPDATE' and old.status = 'approved'
         and not (
           new.status in ('posted','cancelled')
           and new.id = old.id and new.company_id = old.company_id
           and new.journal_number = old.journal_number
           and new.accounting_period_id = old.accounting_period_id
           and new.fiscal_year_id = old.fiscal_year_id
           and new.business_date = old.business_date
           and new.journal_type = old.journal_type
           and new.source_type = old.source_type
           and new.source_id is not distinct from old.source_id
           and new.description = old.description
           and new.currency = old.currency
           and new.exchange_rate = old.exchange_rate
           and new.total_debit = old.total_debit
           and new.total_credit = old.total_credit
         ) then
        raise exception using errcode = '23514',
          message = 'accounting_journal_approved_immutable';
      end if;
      if tg_op = 'UPDATE' and old.status = 'balanced'
         and not (
           new.status in ('draft','approved','cancelled')
           and new.id = old.id and new.company_id = old.company_id
           and new.journal_number = old.journal_number
           and new.accounting_period_id = old.accounting_period_id
           and new.fiscal_year_id = old.fiscal_year_id
           and new.business_date = old.business_date
           and new.journal_type = old.journal_type
           and new.source_type = old.source_type
           and new.source_id is not distinct from old.source_id
           and new.description = old.description
           and new.currency = old.currency
           and new.exchange_rate = old.exchange_rate
           and new.total_debit = old.total_debit
           and new.total_credit = old.total_credit
         ) then
        raise exception using errcode = '23514',
          message = 'accounting_journal_not_editable';
      end if;
      if tg_op = 'UPDATE'
         and (
           new.total_debit is distinct from old.total_debit
           or new.total_credit is distinct from old.total_credit
         ) then
        select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
          into computed_debit, computed_credit
          from journal_lines
         where company_id = new.company_id and journal_entry_id = new.id;
        if new.total_debit <> computed_debit or new.total_credit <> computed_credit then
          raise exception using errcode = '23514',
            message = 'accounting_journal_totals_stale';
        end if;
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;

    create or replace function validate_accounting_journal_state()
      returns trigger language plpgsql as $$
    declare
      computed_debit numeric(18,2);
      computed_credit numeric(18,2);
      line_count integer;
      period_status text;
      year_status text;
      period_start date;
      period_end date;
    begin
      if old.status <> new.status and not (
        (old.status = 'draft' and new.status in ('balanced','cancelled'))
        or (old.status = 'balanced' and new.status in ('draft','approved','cancelled'))
        or (old.status = 'approved' and new.status in ('posted','cancelled'))
        or (old.status = 'posted' and new.status = 'reversed')
      ) then
        raise exception using errcode = '23514',
          message = 'accounting_journal_invalid_transition';
      end if;
      if new.status in ('balanced','approved','posted') then
        select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
          into computed_debit, computed_credit, line_count
          from journal_lines
         where company_id = new.company_id and journal_entry_id = new.id;
        if line_count < 2 then
          raise exception using errcode = '23514',
            message = 'accounting_journal_insufficient_lines';
        end if;
        if computed_debit <= 0 or computed_credit <= 0 then
          raise exception using errcode = '23514',
            message = 'accounting_journal_zero_total';
        end if;
        if computed_debit <> computed_credit then
          raise exception using errcode = '23514',
            message = 'accounting_journal_not_balanced';
        end if;
        new.total_debit := computed_debit;
        new.total_credit := computed_credit;
      end if;
      if new.status = 'posted' and old.status <> 'posted' then
        select p.status, y.status, p.period_start, p.period_end
          into period_status, year_status, period_start, period_end
          from accounting_periods p
          join fiscal_years y
            on y.id = p.fiscal_year_id and y.company_id = p.company_id
         where p.id = new.accounting_period_id and p.company_id = new.company_id;
        if period_status is null or new.business_date not between period_start and period_end then
          raise exception using errcode = '23514',
            message = 'accounting_fiscal_period_not_found';
        end if;
        if year_status = 'closed' then
          raise exception using errcode = '23514',
            message = 'accounting_fiscal_year_closed';
        end if;
        if period_status = 'soft_closed' then
          raise exception using errcode = '23514',
            message = 'accounting_fiscal_period_soft_closed';
        end if;
        if period_status not in ('open','reopened')
           or year_status not in ('open','reopened') then
          raise exception using errcode = '23514',
            message = 'accounting_fiscal_period_closed';
        end if;
      end if;
      return new;
    end;
    $$;

    create or replace function protect_opening_balance_history()
      returns trigger language plpgsql as $$
    declare
      target_batch_id uuid;
      target_company_id uuid;
      batch_status text;
      computed_debit numeric(18,2);
      computed_credit numeric(18,2);
    begin
      if tg_table_name = 'opening_balance_batches' then
        if old.status in ('validated','approved','posted','reversed') then
          if not (
            tg_op = 'UPDATE'
            and (
              (
                old.status = 'validated' and new.status in ('draft','approved')
                and new.effective_date = old.effective_date
                and new.fiscal_year_id = old.fiscal_year_id
                and new.accounting_period_id = old.accounting_period_id
                and new.description = old.description
                and new.currency = old.currency
                and new.total_debit = old.total_debit
                and new.total_credit = old.total_credit
              )
              or (
                old.status = 'approved' and new.status = 'posted'
                and new.effective_date = old.effective_date
                and new.fiscal_year_id = old.fiscal_year_id
                and new.accounting_period_id = old.accounting_period_id
                and new.description = old.description
                and new.currency = old.currency
                and new.total_debit = old.total_debit
                and new.total_credit = old.total_credit
              )
              or (
                old.status = 'posted' and new.status = 'reversed'
                and new.reversal_journal_id is not null
                and new.reversed_by_account_id is not null
                and btrim(coalesce(new.reversal_reason, '')) <> ''
                and new.effective_date = old.effective_date
                and new.fiscal_year_id = old.fiscal_year_id
                and new.accounting_period_id = old.accounting_period_id
                and new.description = old.description
                and new.currency = old.currency
                and new.total_debit = old.total_debit
                and new.total_credit = old.total_credit
              )
            )
          ) then
            raise exception using errcode = '23514',
              message = 'accounting_opening_balance_immutable';
          end if;
        end if;
      else
        target_batch_id := case when tg_op = 'DELETE' then old.opening_balance_batch_id else new.opening_balance_batch_id end;
        target_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
        select status into batch_status from opening_balance_batches
         where id = target_batch_id and company_id = target_company_id;
        if batch_status in ('validated','approved','posted','reversed') then
          raise exception using errcode = '23514',
            message = 'accounting_opening_balance_immutable';
        end if;
      end if;
      if tg_table_name = 'opening_balance_batches'
         and tg_op = 'UPDATE'
         and (
           new.total_debit is distinct from old.total_debit
           or new.total_credit is distinct from old.total_credit
         ) then
        select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
          into computed_debit, computed_credit
          from opening_balance_lines
         where opening_balance_batch_id=new.id and company_id=new.company_id;
        if new.total_debit <> computed_debit or new.total_credit <> computed_credit then
          raise exception using errcode = '23514',
            message = 'accounting_opening_balance_totals_stale';
        end if;
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function reject_posted_journal_line_mutation()
      returns trigger language plpgsql as $$
    declare
      target_entry_id uuid;
      target_company_id uuid;
    begin
      target_entry_id := case when tg_op = 'DELETE' then old.journal_entry_id else new.journal_entry_id end;
      target_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
      if exists (
        select 1 from journal_entries
         where id = target_entry_id and company_id = target_company_id
           and status in ('posted','reversed','cancelled')
      ) then
        raise exception using errcode = '23514',
          message = 'accounting_journal_posted_immutable';
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;

    create or replace function protect_accounting_journal_history()
      returns trigger language plpgsql as $$
    declare
      computed_debit numeric(18,2);
      computed_credit numeric(18,2);
    begin
      if tg_op = 'DELETE' and old.status in (
        'balanced','approved','posted','reversed','cancelled'
      ) then
        raise exception using errcode = '23514',
          message = 'accounting_journal_posted_immutable';
      end if;
      if tg_op = 'UPDATE' and old.status in ('posted','reversed','cancelled') then
        if not (
          old.status = 'posted'
          and new.status = 'reversed'
          and new.reversed_by_journal_id is not null
          and new.reversal_reason is not null
          and new.id = old.id
          and new.company_id = old.company_id
          and new.journal_number = old.journal_number
          and new.accounting_period_id = old.accounting_period_id
          and new.business_date = old.business_date
          and new.source_type = old.source_type
          and new.source_id is not distinct from old.source_id
          and new.currency = old.currency
          and new.total_debit = old.total_debit
          and new.total_credit = old.total_credit
        ) then
          raise exception using errcode = '23514',
            message = 'accounting_journal_posted_immutable';
        end if;
      end if;
      if tg_op = 'UPDATE' and old.status = 'approved'
         and not (
           new.status = 'posted' and new.id = old.id and new.company_id = old.company_id
         ) then
        raise exception using errcode = '23514',
          message = 'accounting_journal_approved_immutable';
      end if;
      if tg_op = 'UPDATE'
         and (
           new.total_debit is distinct from old.total_debit
           or new.total_credit is distinct from old.total_credit
         ) then
        select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
          into computed_debit, computed_credit
          from journal_lines
         where company_id = new.company_id and journal_entry_id = new.id;
        if new.total_debit <> computed_debit or new.total_credit <> computed_credit then
          raise exception using errcode = '23514',
            message = 'accounting_journal_totals_stale';
        end if;
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;

    create or replace function validate_accounting_journal_state()
      returns trigger language plpgsql as $$
    declare
      computed_debit numeric(18,2);
      computed_credit numeric(18,2);
      line_count integer;
      period_status text;
      year_status text;
      period_start date;
      period_end date;
    begin
      if old.status <> new.status and not (
        (old.status = 'draft' and new.status in ('balanced','cancelled'))
        or (old.status = 'balanced' and new.status in ('draft','approved'))
        or (old.status = 'approved' and new.status = 'posted')
        or (old.status = 'posted' and new.status = 'reversed')
      ) then
        raise exception using errcode = '23514',
          message = 'accounting_journal_invalid_transition';
      end if;
      if new.status in ('balanced','approved','posted') then
        select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
          into computed_debit, computed_credit, line_count
          from journal_lines
         where company_id = new.company_id and journal_entry_id = new.id;
        if line_count < 2 then
          raise exception using errcode = '23514',
            message = 'accounting_journal_no_lines';
        end if;
        if computed_debit <= 0 or computed_credit <= 0 then
          raise exception using errcode = '23514',
            message = 'accounting_journal_zero_total';
        end if;
        if computed_debit <> computed_credit then
          raise exception using errcode = '23514',
            message = 'accounting_journal_not_balanced';
        end if;
        new.total_debit := computed_debit;
        new.total_credit := computed_credit;
      end if;
      if new.status = 'posted' and old.status <> 'posted' then
        select p.status, y.status, p.period_start, p.period_end
          into period_status, year_status, period_start, period_end
          from accounting_periods p
          join fiscal_years y
            on y.id = p.fiscal_year_id and y.company_id = p.company_id
         where p.id = new.accounting_period_id and p.company_id = new.company_id;
        if period_status is null or new.business_date not between period_start and period_end then
          raise exception using errcode = '23514',
            message = 'accounting_fiscal_period_not_found';
        end if;
        if year_status = 'closed' then
          raise exception using errcode = '23514',
            message = 'accounting_fiscal_year_closed';
        end if;
        if period_status = 'soft_closed' then
          raise exception using errcode = '23514',
            message = 'accounting_fiscal_period_soft_closed';
        end if;
        if period_status not in ('open','reopened')
           or year_status not in ('open','reopened') then
          raise exception using errcode = '23514',
            message = 'accounting_fiscal_period_closed';
        end if;
      end if;
      return new;
    end;
    $$;

    create or replace function protect_opening_balance_history()
      returns trigger language plpgsql as $$
    declare
      target_batch_id uuid;
      target_company_id uuid;
      batch_status text;
    begin
      if tg_table_name = 'opening_balance_batches' then
        if old.status in ('posted','reversed') then
          if not (
            tg_op = 'UPDATE'
            and old.status = 'posted'
            and new.status = 'reversed'
            and new.reversal_journal_id is not null
            and new.reversed_by_account_id is not null
            and btrim(coalesce(new.reversal_reason, '')) <> ''
          ) then
            raise exception using errcode = '23514',
              message = 'accounting_opening_balance_immutable';
          end if;
        end if;
      else
        target_batch_id := case when tg_op = 'DELETE' then old.opening_balance_batch_id else new.opening_balance_batch_id end;
        target_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
        select status into batch_status from opening_balance_batches
         where id = target_batch_id and company_id = target_company_id;
        if batch_status in ('posted','reversed') then
          raise exception using errcode = '23514',
            message = 'accounting_opening_balance_immutable';
        end if;
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;

    drop trigger if exists opening_balance_lines_account_snapshot on opening_balance_lines;
    drop trigger if exists journal_lines_account_snapshot on journal_lines;
    drop function if exists snapshot_accounting_line_account();
    alter table opening_balance_lines
      drop column if exists account_name_ar_snapshot,
      drop column if exists account_name_en_snapshot,
      drop column if exists account_code_snapshot;
    alter table journal_lines
      drop column if exists account_name_ar_snapshot,
      drop column if exists account_name_en_snapshot,
      drop column if exists account_code_snapshot;
    alter table opening_balance_batches
      drop constraint if exists opening_balance_batches_version_positive,
      drop column if exists version,
      drop column if exists posting_note,
      drop column if exists approval_note,
      drop column if exists notes;
    alter table journal_entries
      drop constraint if exists journal_entries_version_positive,
      drop column if exists version,
      drop column if exists posting_note,
      drop column if exists approval_note,
      drop column if exists notes;
    alter table accounting_periods
      drop constraint if exists accounting_periods_version_positive,
      drop column if exists version,
      drop column if exists close_reason;
    alter table fiscal_years
      drop constraint if exists fiscal_years_version_positive,
      drop column if exists version,
      drop column if exists close_reason;
  `.execute(database);
}
