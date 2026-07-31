import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Accounting Prompt 1.
 *
 * This migration evolves the 20260713230020 Accounting tables in place and
 * adds only foundation records. It intentionally exposes no posting workflow.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table fiscal_years (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      fiscal_year_code text not null,
      name text not null,
      start_date date not null,
      end_date date not null,
      status text not null default 'draft',
      created_by_account_id uuid,
      created_at timestamptz not null default now(),
      opened_by_account_id uuid,
      opened_at timestamptz,
      closed_by_account_id uuid,
      closed_at timestamptz,
      reopened_by_account_id uuid,
      reopened_at timestamptz,
      reopen_reason text,
      unique (id, company_id),
      constraint fiscal_years_code_unique unique (company_id, fiscal_year_code),
      constraint fiscal_years_dates_check check (end_date >= start_date),
      constraint fiscal_years_status_check
        check (status in ('draft','open','closed','reopened')),
      constraint fiscal_years_reopen_check check (
        status <> 'reopened'
        or (
          reopened_by_account_id is not null
          and reopened_at is not null
          and btrim(coalesce(reopen_reason, '')) <> ''
        )
      ),
      constraint fiscal_years_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint fiscal_years_opener_fk foreign key (opened_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint fiscal_years_closer_fk foreign key (closed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint fiscal_years_reopener_fk foreign key (reopened_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint fiscal_years_no_overlap exclude using gist (
        company_id with =,
        daterange(start_date, end_date, '[]') with &&
      )
    );
    create index fiscal_years_company_dates_index
      on fiscal_years (company_id, start_date, end_date);

    create function prevent_accounting_date_overlap() returns trigger language plpgsql as $$
    declare
      conflict_exists boolean;
    begin
      if tg_table_name = 'fiscal_years' then
        select exists (
          select 1 from fiscal_years x
           where x.company_id = new.company_id
             and x.id <> new.id
             and daterange(x.start_date, x.end_date, '[]')
                 && daterange(new.start_date, new.end_date, '[]')
        ) into conflict_exists;
        if conflict_exists then
          raise exception using errcode = '23514',
            message = 'accounting_fiscal_year_overlap';
        end if;
      else
        select exists (
          select 1 from accounting_periods x
           where x.company_id = new.company_id
             and x.id <> new.id
             and daterange(x.period_start, x.period_end, '[]')
                 && daterange(new.period_start, new.period_end, '[]')
        ) into conflict_exists;
        if conflict_exists then
          raise exception using errcode = '23514',
            message = 'accounting_fiscal_period_overlap';
        end if;
      end if;
      return new;
    end;
    $$;
    create trigger fiscal_years_overlap_guard
      before insert or update of company_id, start_date, end_date on fiscal_years
      for each row execute function prevent_accounting_date_overlap();

    insert into fiscal_years (
      company_id, fiscal_year_code, name, start_date, end_date, status, opened_at
    )
    select company_id, 'LEGACY', 'Legacy Accounting Calendar',
           min(period_start), max(period_end), 'open', now()
      from accounting_periods
     group by company_id;

    alter table accounting_periods
      drop constraint accounting_periods_status_check,
      drop constraint accounting_periods_close_check,
      add column fiscal_year_id uuid,
      add column period_number integer,
      add column period_code text,
      add column name text,
      add column is_adjustment_period boolean not null default false,
      add column created_by_account_id uuid,
      add column opened_by_account_id uuid,
      add column opened_at timestamptz,
      add column reopened_by_account_id uuid,
      add column reopened_at timestamptz,
      add column reopen_reason text;
    with numbered as (
      select p.id,
             row_number() over (
               partition by p.company_id order by p.period_start, p.id
             ) as period_number
        from accounting_periods p
    )
    update accounting_periods p
       set fiscal_year_id = y.id,
           period_number = numbered.period_number,
           period_code = 'LEGACY-' || lpad(numbered.period_number::text, 2, '0'),
           name = 'Legacy Period ' || numbered.period_number::text,
           opened_at = case when p.status = 'open' then p.created_at else null end
      from numbered, fiscal_years y
     where numbered.id = p.id
       and y.company_id = p.company_id
       and y.fiscal_year_code = 'LEGACY';
    alter table accounting_periods
      alter column fiscal_year_id set not null,
      alter column period_number set not null,
      alter column period_code set not null,
      alter column name set not null,
      add constraint accounting_periods_fiscal_year_fk
        foreign key (fiscal_year_id, company_id)
        references fiscal_years(id, company_id) on delete restrict,
      add constraint accounting_periods_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint accounting_periods_opener_fk
        foreign key (opened_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint accounting_periods_reopener_fk
        foreign key (reopened_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint accounting_periods_status_check
        check (status in ('future','open','soft_closed','closed','reopened')),
      add constraint accounting_periods_number_positive check (period_number > 0),
      add constraint accounting_periods_reopen_check check (
        status <> 'reopened'
        or (
          reopened_by_account_id is not null
          and reopened_at is not null
          and btrim(coalesce(reopen_reason, '')) <> ''
        )
      ),
      add constraint accounting_periods_number_unique
        unique (fiscal_year_id, period_number),
      add constraint accounting_periods_code_unique
        unique (company_id, period_code),
      add constraint accounting_periods_no_overlap exclude using gist (
        company_id with =,
        daterange(period_start, period_end, '[]') with &&
      );
    create index accounting_periods_company_dates_index
      on accounting_periods (company_id, period_start, period_end);
    create trigger accounting_periods_overlap_guard
      before insert or update of company_id, period_start, period_end on accounting_periods
      for each row execute function prevent_accounting_date_overlap();

    create function validate_accounting_period_calendar() returns trigger language plpgsql as $$
    declare
      year_start date;
      year_end date;
    begin
      select start_date, end_date into year_start, year_end
        from fiscal_years
       where id = new.fiscal_year_id and company_id = new.company_id;
      if year_start is null then
        raise exception using errcode = '23503',
          message = 'accounting_fiscal_year_not_found';
      end if;
      if new.period_start < year_start or new.period_end > year_end then
        raise exception using errcode = '23514',
          message = 'accounting_fiscal_period_outside_year';
      end if;
      return new;
    end;
    $$;
    create trigger accounting_periods_calendar_guard
      before insert or update of company_id, fiscal_year_id, period_start, period_end
      on accounting_periods
      for each row execute function validate_accounting_period_calendar();
    create function protect_accounting_calendar_history() returns trigger language plpgsql as $$
    begin
      if tg_table_name = 'fiscal_years' then
        if tg_op = 'DELETE' and exists (
          select 1 from accounting_periods
           where fiscal_year_id = old.id and company_id = old.company_id
        ) then
          raise exception using errcode = '23514',
            message = 'accounting_fiscal_year_has_history';
        end if;
        if tg_op = 'UPDATE'
           and (new.start_date <> old.start_date or new.end_date <> old.end_date)
           and exists (
             select 1 from journal_entries
              where fiscal_year_id = old.id and company_id = old.company_id
                and status in ('posted','reversed')
           ) then
          raise exception using errcode = '23514',
            message = 'accounting_fiscal_calendar_change_prohibited';
        end if;
      else
        if tg_op = 'DELETE' and exists (
          select 1 from journal_entries
           where accounting_period_id = old.id and company_id = old.company_id
        ) then
          raise exception using errcode = '23514',
            message = 'accounting_fiscal_period_has_history';
        end if;
        if tg_op = 'UPDATE'
           and (new.period_start <> old.period_start or new.period_end <> old.period_end)
           and exists (
             select 1 from journal_entries
              where accounting_period_id = old.id and company_id = old.company_id
                and status in ('posted','reversed')
           ) then
          raise exception using errcode = '23514',
            message = 'accounting_fiscal_calendar_change_prohibited';
        end if;
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;
    create trigger fiscal_years_history_guard
      before update or delete on fiscal_years
      for each row execute function protect_accounting_calendar_history();
    create trigger accounting_periods_history_guard
      before update or delete on accounting_periods
      for each row execute function protect_accounting_calendar_history();

    alter table chart_of_accounts
      add column account_class text,
      add column normal_balance text,
      add column is_contra_account boolean not null default false,
      add column is_control_account boolean not null default false,
      add column control_account_type text,
      add column is_system_account boolean not null default false,
      add column system_purpose text,
      add column currency text not null default 'AED',
      add column description text,
      add column effective_from date not null default current_date,
      add column effective_to date,
      add column created_by_account_id uuid,
      add column updated_by_account_id uuid,
      add column deactivated_by_account_id uuid,
      add column deactivated_at timestamptz;
    update chart_of_accounts
       set account_class = case account_type
             when 'asset' then 'other_asset'
             when 'liability' then 'other_liability'
             when 'equity' then 'other_equity'
             when 'revenue' then 'other_income'
             else 'other_expense'
           end,
           normal_balance = case
             when account_type in ('asset','expense') then 'debit'
             else 'credit'
           end,
           code = btrim(code);
    alter table chart_of_accounts
      alter column account_class set not null,
      alter column normal_balance set not null,
      add constraint chart_of_accounts_code_nonempty check (btrim(code) <> ''),
      add constraint chart_of_accounts_name_nonempty check (btrim(name_en) <> ''),
      add constraint chart_of_accounts_class_check check (
        account_class in (
          'cash','bank','accounts_receivable','other_receivable','prepaid_expense',
          'fixed_asset','accumulated_depreciation','other_asset',
          'trader_payable','driver_payable','payroll_payable','accounts_payable',
          'vat_payable','accrued_liability','other_liability',
          'share_capital','retained_earnings','current_year_earnings',
          'owner_equity','other_equity',
          'delivery_revenue','service_fee_revenue','additional_fee_revenue',
          'other_operating_revenue','other_income',
          'driver_expense','outsourced_driver_fee_expense','payroll_expense',
          'administrative_expense','bank_charge','general_expense','vat_expense',
          'other_expense'
        )
      ),
      add constraint chart_of_accounts_normal_balance_check
        check (normal_balance in ('debit','credit')),
      add constraint chart_of_accounts_currency_check check (currency = 'AED'),
      add constraint chart_of_accounts_dates_check
        check (effective_to is null or effective_to >= effective_from),
      add constraint chart_of_accounts_parent_self_check
        check (parent_account_id is null or parent_account_id <> id),
      add constraint chart_of_accounts_control_check check (
        (not is_control_account and control_account_type is null)
        or (
          is_control_account
          and is_posting_account
          and control_account_type in (
            'trader_payable','driver_payable','payroll_payable',
            'accounts_receivable','vat'
          )
        )
      ),
      add constraint chart_of_accounts_system_check check (
        (not is_system_account and system_purpose is null)
        or (
          is_system_account
          and system_purpose in (
            'retained_earnings','current_year_earnings','rounding','suspense'
          )
        )
      ),
      add constraint chart_of_accounts_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint chart_of_accounts_updater_fk
        foreign key (updated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint chart_of_accounts_deactivator_fk
        foreign key (deactivated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict;
    create unique index chart_of_accounts_system_purpose_unique
      on chart_of_accounts (company_id, system_purpose)
      where is_system_account and is_active;

    create function validate_accounting_account() returns trigger language plpgsql as $$
    declare
      expected_type text;
      expected_normal text;
      parent_type text;
      parent_class text;
      parent_from date;
      parent_to date;
    begin
      new.code := btrim(new.code);
      expected_type := case
        when new.account_class in (
          'cash','bank','accounts_receivable','other_receivable','prepaid_expense',
          'fixed_asset','accumulated_depreciation','other_asset'
        ) then 'asset'
        when new.account_class in (
          'trader_payable','driver_payable','payroll_payable','accounts_payable',
          'vat_payable','accrued_liability','other_liability'
        ) then 'liability'
        when new.account_class in (
          'share_capital','retained_earnings','current_year_earnings',
          'owner_equity','other_equity'
        ) then 'equity'
        when new.account_class in (
          'delivery_revenue','service_fee_revenue','additional_fee_revenue',
          'other_operating_revenue','other_income'
        ) then 'revenue'
        else 'expense'
      end;
      if new.account_type <> expected_type then
        raise exception using errcode = '23514',
          message = 'accounting_account_class_type_mismatch';
      end if;
      expected_normal := case
        when new.account_type in ('asset','expense') then 'debit'
        else 'credit'
      end;
      if new.normal_balance <> expected_normal and not new.is_contra_account then
        raise exception using errcode = '23514',
          message = 'accounting_account_normal_balance_invalid';
      end if;
      if new.parent_account_id is not null then
        select account_type, account_class, effective_from, effective_to
          into parent_type, parent_class, parent_from, parent_to
          from chart_of_accounts
         where id = new.parent_account_id and company_id = new.company_id;
        if parent_type is null then
          raise exception using errcode = '23503',
            message = 'accounting_parent_account_not_found';
        end if;
        if parent_type <> new.account_type then
          raise exception using errcode = '23514',
            message = 'accounting_account_parent_incompatible';
        end if;
        if new.effective_from < parent_from
           or coalesce(new.effective_to, 'infinity'::date)
              > coalesce(parent_to, 'infinity'::date) then
          raise exception using errcode = '23514',
            message = 'accounting_account_parent_effective_date_conflict';
        end if;
        if exists (
          with recursive ancestors as (
            select a.id, a.parent_account_id
              from chart_of_accounts a
             where a.id = new.parent_account_id and a.company_id = new.company_id
            union all
            select a.id, a.parent_account_id
              from chart_of_accounts a
              join ancestors p on p.parent_account_id = a.id
             where a.company_id = new.company_id
          )
          select 1 from ancestors where id = new.id
        ) then
          raise exception using errcode = '23514',
            message = 'accounting_account_hierarchy_cycle';
        end if;
      end if;
      return new;
    end;
    $$;
    create trigger chart_of_accounts_validation_guard
      before insert or update on chart_of_accounts
      for each row execute function validate_accounting_account();

    create function protect_accounting_account_history() returns trigger language plpgsql as $$
    begin
      if tg_op = 'DELETE' then
        raise exception using errcode = '23514',
          message = 'accounting_account_delete_prohibited';
      end if;
      if tg_op = 'UPDATE'
         and old.is_active
         and (
           not new.is_active
           or (old.is_posting_account and not new.is_posting_account)
         )
         and (
           exists (
             select 1 from account_mappings m
              where m.company_id = old.company_id and m.is_active
                and current_date between m.effective_from
                                     and coalesce(m.effective_to, 'infinity'::date)
                and old.id in (
                  m.debit_account_id, m.credit_account_id, m.vat_account_id,
                  m.fee_account_id, m.expense_account_id, m.payable_account_id
                )
           )
           or exists (
             select 1 from accounting_configurations c
              where c.company_id = old.company_id
                and old.id in (
                  c.retained_earnings_account_id, c.current_year_earnings_account_id,
                  c.default_rounding_account_id, c.default_suspense_account_id,
                  c.default_cash_account_id, c.default_bank_account_id,
                  c.default_vat_output_account_id, c.default_vat_input_account_id,
                  c.default_accounts_receivable_account_id,
                  c.default_accounts_payable_account_id,
                  c.default_payroll_payable_account_id,
                  c.default_outsourced_driver_payable_account_id,
                  c.default_trader_payable_account_id,
                  c.default_service_fee_revenue_account_id,
                  c.default_delivery_revenue_account_id
                )
           )
         ) then
        raise exception using errcode = '23514',
          message = 'accounting_account_deactivation_mapping_conflict';
      end if;
      if exists (
        select 1 from journal_lines l
         join journal_entries j
           on j.id = l.journal_entry_id and j.company_id = l.company_id
         where l.account_id = old.id and l.company_id = old.company_id
           and j.status in ('posted','reversed')
      ) and (
        new.code is distinct from old.code
        or new.account_type is distinct from old.account_type
        or new.account_class is distinct from old.account_class
        or new.normal_balance is distinct from old.normal_balance
      ) then
        raise exception using errcode = '23514',
          message = 'accounting_account_change_prohibited_by_history';
      end if;
      return new;
    end;
    $$;
    create trigger chart_of_accounts_history_guard
      before update or delete on chart_of_accounts
      for each row execute function protect_accounting_account_history();

    create table accounting_configurations (
      company_id uuid primary key references companies(id) on delete restrict,
      accounting_enabled boolean not null default false,
      automatic_posting_enabled boolean not null default false,
      base_currency text not null default 'AED',
      fiscal_year_start_month integer not null default 1,
      default_accounting_method text not null default 'accrual',
      retained_earnings_account_id uuid,
      current_year_earnings_account_id uuid,
      default_rounding_account_id uuid,
      default_suspense_account_id uuid,
      default_cash_account_id uuid,
      default_bank_account_id uuid,
      default_vat_output_account_id uuid,
      default_vat_input_account_id uuid,
      default_accounts_receivable_account_id uuid,
      default_accounts_payable_account_id uuid,
      default_payroll_payable_account_id uuid,
      default_outsourced_driver_payable_account_id uuid,
      default_trader_payable_account_id uuid,
      default_service_fee_revenue_account_id uuid,
      default_delivery_revenue_account_id uuid,
      created_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_by_account_id uuid,
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      constraint accounting_configurations_currency_check check (base_currency = 'AED'),
      constraint accounting_configurations_month_check
        check (fiscal_year_start_month between 1 and 12),
      constraint accounting_configurations_method_check
        check (default_accounting_method in ('accrual','cash')),
      constraint accounting_configurations_auto_posting_check
        check (not automatic_posting_enabled),
      constraint accounting_configurations_version_positive check (version > 0),
      constraint accounting_configurations_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint accounting_configurations_updater_fk
        foreign key (updated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict
    );

    create function add_accounting_configuration_account_fks() returns void language plpgsql as $$
    declare
      column_name text;
    begin
      foreach column_name in array array[
        'retained_earnings_account_id','current_year_earnings_account_id',
        'default_rounding_account_id','default_suspense_account_id',
        'default_cash_account_id','default_bank_account_id',
        'default_vat_output_account_id','default_vat_input_account_id',
        'default_accounts_receivable_account_id','default_accounts_payable_account_id',
        'default_payroll_payable_account_id','default_outsourced_driver_payable_account_id',
        'default_trader_payable_account_id','default_service_fee_revenue_account_id',
        'default_delivery_revenue_account_id'
      ] loop
        execute format(
          'alter table accounting_configurations add constraint %I foreign key (%I, company_id) references chart_of_accounts(id, company_id) on delete restrict',
          'accounting_configurations_' || column_name || '_fk',
          column_name
        );
      end loop;
    end;
    $$;
    select add_accounting_configuration_account_fks();
    drop function add_accounting_configuration_account_fks();

    create table accounting_configuration_history (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      configuration_version bigint not null,
      configuration_snapshot jsonb not null,
      changed_by_account_id uuid,
      change_reason text,
      created_at timestamptz not null default now(),
      unique (company_id, configuration_version),
      constraint accounting_configuration_history_actor_fk
        foreign key (changed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint accounting_configuration_history_version_positive
        check (configuration_version > 0)
    );
    create function validate_accounting_configuration() returns trigger language plpgsql as $$
    declare
      account_id uuid;
      account_active boolean;
      account_posting boolean;
    begin
      foreach account_id in array array[
        new.retained_earnings_account_id, new.current_year_earnings_account_id,
        new.default_rounding_account_id, new.default_suspense_account_id,
        new.default_cash_account_id, new.default_bank_account_id,
        new.default_vat_output_account_id, new.default_vat_input_account_id,
        new.default_accounts_receivable_account_id, new.default_accounts_payable_account_id,
        new.default_payroll_payable_account_id, new.default_outsourced_driver_payable_account_id,
        new.default_trader_payable_account_id, new.default_service_fee_revenue_account_id,
        new.default_delivery_revenue_account_id
      ] loop
        if account_id is not null then
          select is_active, is_posting_account into account_active, account_posting
            from chart_of_accounts
           where id = account_id and company_id = new.company_id;
          if account_active is null then
            raise exception using errcode = '23503',
              message = 'accounting_configuration_cross_company_account';
          end if;
          if not account_active or not account_posting then
            raise exception using errcode = '23514',
              message = 'accounting_configuration_account_incompatible';
          end if;
        end if;
      end loop;
      if new.retained_earnings_account_id is not null and not exists (
        select 1 from chart_of_accounts where id = new.retained_earnings_account_id
          and company_id = new.company_id and account_class = 'retained_earnings'
      ) then raise exception using errcode = '23514',
        message = 'accounting_configuration_account_incompatible'; end if;
      if new.current_year_earnings_account_id is not null and not exists (
        select 1 from chart_of_accounts where id = new.current_year_earnings_account_id
          and company_id = new.company_id and account_class = 'current_year_earnings'
      ) then raise exception using errcode = '23514',
        message = 'accounting_configuration_account_incompatible'; end if;
      if new.default_cash_account_id is not null and not exists (
        select 1 from chart_of_accounts where id = new.default_cash_account_id
          and company_id = new.company_id and account_class = 'cash'
      ) then raise exception using errcode = '23514',
        message = 'accounting_configuration_account_incompatible'; end if;
      if new.default_bank_account_id is not null and not exists (
        select 1 from chart_of_accounts where id = new.default_bank_account_id
          and company_id = new.company_id and account_class = 'bank'
      ) then raise exception using errcode = '23514',
        message = 'accounting_configuration_account_incompatible'; end if;
      if new.default_accounts_receivable_account_id is not null and not exists (
        select 1 from chart_of_accounts
         where id = new.default_accounts_receivable_account_id
           and company_id = new.company_id and account_type = 'asset'
           and account_class in ('accounts_receivable','other_receivable')
      ) then raise exception using errcode = '23514',
        message = 'accounting_configuration_account_incompatible'; end if;
      if new.default_accounts_payable_account_id is not null and not exists (
        select 1 from chart_of_accounts
         where id = new.default_accounts_payable_account_id
           and company_id = new.company_id and account_type = 'liability'
           and account_class = 'accounts_payable'
      ) then raise exception using errcode = '23514',
        message = 'accounting_configuration_account_incompatible'; end if;
      if new.default_payroll_payable_account_id is not null and not exists (
        select 1 from chart_of_accounts
         where id = new.default_payroll_payable_account_id
           and company_id = new.company_id and account_type = 'liability'
           and account_class = 'payroll_payable'
      ) then raise exception using errcode = '23514',
        message = 'accounting_configuration_account_incompatible'; end if;
      if new.default_outsourced_driver_payable_account_id is not null and not exists (
        select 1 from chart_of_accounts
         where id = new.default_outsourced_driver_payable_account_id
           and company_id = new.company_id and account_type = 'liability'
           and account_class = 'driver_payable'
      ) then raise exception using errcode = '23514',
        message = 'accounting_configuration_account_incompatible'; end if;
      if new.default_trader_payable_account_id is not null and not exists (
        select 1 from chart_of_accounts
         where id = new.default_trader_payable_account_id
           and company_id = new.company_id and account_type = 'liability'
           and account_class = 'trader_payable'
      ) then raise exception using errcode = '23514',
        message = 'accounting_configuration_account_incompatible'; end if;
      if new.default_service_fee_revenue_account_id is not null and not exists (
        select 1 from chart_of_accounts
         where id = new.default_service_fee_revenue_account_id
           and company_id = new.company_id and account_type = 'revenue'
           and account_class = 'service_fee_revenue'
      ) then raise exception using errcode = '23514',
        message = 'accounting_configuration_account_incompatible'; end if;
      if new.default_delivery_revenue_account_id is not null and not exists (
        select 1 from chart_of_accounts
         where id = new.default_delivery_revenue_account_id
           and company_id = new.company_id and account_type = 'revenue'
           and account_class = 'delivery_revenue'
      ) then raise exception using errcode = '23514',
        message = 'accounting_configuration_account_incompatible'; end if;
      if new.default_vat_output_account_id is not null and not exists (
        select 1 from chart_of_accounts
         where id = new.default_vat_output_account_id
           and company_id = new.company_id and account_type = 'liability'
           and account_class = 'vat_payable'
      ) then raise exception using errcode = '23514',
        message = 'accounting_configuration_account_incompatible'; end if;
      if new.default_vat_input_account_id is not null and not exists (
        select 1 from chart_of_accounts
         where id = new.default_vat_input_account_id and company_id = new.company_id
           and (
             (account_type = 'asset' and account_class in (
               'accounts_receivable','other_receivable','prepaid_expense','other_asset'
             ))
             or (account_type = 'expense' and account_class = 'vat_expense')
           )
      ) then raise exception using errcode = '23514',
        message = 'accounting_configuration_account_incompatible'; end if;
      if tg_op = 'UPDATE' and new.version <> old.version + 1 then
        raise exception using errcode = '23514',
          message = 'accounting_configuration_version_conflict';
      end if;
      return new;
    end;
    $$;
    create trigger accounting_configurations_validation_guard
      before insert or update on accounting_configurations
      for each row execute function validate_accounting_configuration();
    create function record_accounting_configuration_history() returns trigger language plpgsql as $$
    begin
      insert into accounting_configuration_history (
        company_id, configuration_version, configuration_snapshot,
        changed_by_account_id, created_at
      ) values (
        new.company_id, new.version, to_jsonb(new),
        coalesce(new.updated_by_account_id, new.created_by_account_id), now()
      );
      return new;
    end;
    $$;
    create trigger accounting_configurations_history_writer
      after insert or update on accounting_configurations
      for each row execute function record_accounting_configuration_history();

    alter table journal_entries
      drop constraint journal_entries_source_check,
      drop constraint journal_entries_status_check,
      drop constraint journal_entries_posting_check,
      add column fiscal_year_id uuid,
      add column journal_type text not null default 'operational',
      add column currency text not null default 'AED',
      add column exchange_rate numeric(18,6) not null default 1,
      add column total_debit numeric(18,2) not null default 0,
      add column total_credit numeric(18,2) not null default 0,
      add column source_entity_type text,
      add column source_entity_id uuid,
      add column source_reference text,
      add column correlation_id text,
      add column idempotency_key text,
      add column reversed_by_journal_id uuid,
      add column updated_by_account_id uuid,
      add column approved_by_account_id uuid,
      add column approved_at timestamptz,
      add column reversed_by_account_id uuid,
      add column reversed_at timestamptz,
      add column reversal_reason text,
      add column cancelled_by_account_id uuid,
      add column cancelled_at timestamptz,
      add column cancellation_reason text;
    update journal_entries j
       set fiscal_year_id = p.fiscal_year_id,
           journal_type = case
             when j.source_type = 'manual' then 'manual'
             when j.source_type = 'reversal' then 'reversal'
             else 'operational'
           end,
           source_entity_type = j.source_type,
           source_entity_id = j.source_id,
           approved_by_account_id = case
             when j.status = 'posted' then j.posted_by_account_id else null
           end,
           approved_at = case when j.status = 'posted' then j.posted_at else null end,
           total_debit = (
             select coalesce(sum(l.debit), 0)
               from journal_lines l
              where l.journal_entry_id = j.id and l.company_id = j.company_id
           ),
           total_credit = (
             select coalesce(sum(l.credit), 0)
               from journal_lines l
              where l.journal_entry_id = j.id and l.company_id = j.company_id
           )
      from accounting_periods p
     where p.id = j.accounting_period_id and p.company_id = j.company_id;
    alter table journal_entries
      alter column fiscal_year_id set not null,
      add constraint journal_entries_fiscal_year_fk
        foreign key (fiscal_year_id, company_id)
        references fiscal_years(id, company_id) on delete restrict,
      add constraint journal_entries_reversed_by_fk
        foreign key (reversed_by_journal_id, company_id)
        references journal_entries(id, company_id) on delete restrict,
      add constraint journal_entries_updater_fk
        foreign key (updated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint journal_entries_approver_fk
        foreign key (approved_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint journal_entries_reverser_fk
        foreign key (reversed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint journal_entries_canceller_fk
        foreign key (cancelled_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint journal_entries_source_check check (
        source_type in (
          'manual','opening_balance','order','trader_receivable','trader_settlement',
          'driver_collection','driver_expense','employee_payroll',
          'outsourced_driver_fee','general_expense','bank_transfer',
          'period_close','system','reconciliation','settlement','expense','payroll','reversal'
        )
      ),
      add constraint journal_entries_type_check check (
        journal_type in (
          'manual','opening_balance','operational','adjustment','closing','reversal'
        )
      ),
      add constraint journal_entries_status_check check (
        status in ('draft','balanced','approved','posted','reversed','cancelled')
      ),
      add constraint journal_entries_currency_check check (
        currency = 'AED' and exchange_rate = 1
      ),
      add constraint journal_entries_totals_check check (
        total_debit >= 0 and total_credit >= 0
      ),
      add constraint journal_entries_number_nonempty check (
        btrim(journal_number) <> ''
      ),
      add constraint journal_entries_idempotency_nonempty check (
        idempotency_key is null or btrim(idempotency_key) <> ''
      ),
      add constraint journal_entries_approval_shape_check check (
        status not in ('approved','posted')
        or (approved_by_account_id is not null and approved_at is not null)
      ),
      add constraint journal_entries_posting_shape_check check (
        status not in ('posted','reversed')
        or (posted_by_account_id is not null and posted_at is not null)
      ),
      add constraint journal_entries_reversed_by_self_check check (
        reversed_by_journal_id is null or reversed_by_journal_id <> id
      ),
      add constraint journal_entries_reversal_shape_check check (
        status <> 'reversed'
        or (
          reversed_by_journal_id is not null
          and reversed_by_account_id is not null
          and reversed_at is not null
          and btrim(coalesce(reversal_reason, '')) <> ''
        )
      ),
      add constraint journal_entries_cancellation_shape_check check (
        status <> 'cancelled'
        or (
          cancelled_by_account_id is not null
          and cancelled_at is not null
          and btrim(coalesce(cancellation_reason, '')) <> ''
        )
      );
    create unique index journal_entries_idempotency_unique
      on journal_entries (company_id, idempotency_key)
      where idempotency_key is not null;
    create index journal_entries_period_index
      on journal_entries (company_id, accounting_period_id, business_date);
    create index journal_entries_status_index
      on journal_entries (company_id, status, business_date desc);
    create index journal_entries_source_entity_index
      on journal_entries (company_id, source_entity_type, source_entity_id);
    create index journal_entries_reversal_index
      on journal_entries (company_id, reversal_of_id, reversed_by_journal_id);

    alter table journal_lines
      add column line_number integer,
      add column subledger_type text,
      add column subledger_id uuid,
      add column trader_id uuid,
      add column driver_id uuid,
      add column employee_id uuid,
      add column order_id uuid,
      add column trader_settlement_id uuid,
      add column driver_collection_id uuid,
      add column payroll_period_id uuid,
      add column payroll_payment_id uuid,
      add column outsourced_driver_fee_accrual_id uuid,
      add column outsourced_driver_fee_payment_id uuid,
      add column general_expense_id uuid,
      add column company_bank_account_id uuid,
      add column company_cash_account_id uuid,
      add column source_entity_type text,
      add column source_entity_id uuid,
      add column created_by_account_id uuid,
      add column updated_by_account_id uuid,
      add column updated_at timestamptz not null default now();
    with numbered as (
      select id, row_number() over (
        partition by journal_entry_id order by created_at, id
      ) as line_number
      from journal_lines
    )
    update journal_lines l
       set line_number = numbered.line_number
      from numbered
     where numbered.id = l.id;
    alter table journal_lines
      alter column line_number set not null,
      add constraint journal_lines_number_positive check (line_number > 0),
      add constraint journal_lines_number_unique
        unique (journal_entry_id, line_number),
      add constraint journal_lines_trader_fk
        foreign key (trader_id, company_id)
        references traders(id, company_id) on delete restrict,
      add constraint journal_lines_driver_fk
        foreign key (driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      add constraint journal_lines_employee_fk
        foreign key (employee_id, company_id)
        references employees(id, company_id) on delete restrict,
      add constraint journal_lines_order_fk
        foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      add constraint journal_lines_settlement_fk
        foreign key (trader_settlement_id, company_id)
        references trader_settlements(id, company_id) on delete restrict,
      add constraint journal_lines_collection_fk
        foreign key (driver_collection_id, company_id)
        references driver_reconciliations(id, company_id) on delete restrict,
      add constraint journal_lines_payroll_period_fk
        foreign key (payroll_period_id, company_id)
        references payroll_periods(id, company_id) on delete restrict,
      add constraint journal_lines_payroll_payment_fk
        foreign key (payroll_payment_id, company_id)
        references payroll_payments(id, company_id) on delete restrict,
      add constraint journal_lines_driver_fee_accrual_fk
        foreign key (outsourced_driver_fee_accrual_id, company_id)
        references outsourced_driver_fee_accruals(id, company_id) on delete restrict,
      add constraint journal_lines_driver_fee_payment_fk
        foreign key (outsourced_driver_fee_payment_id, company_id)
        references outsourced_driver_fee_payments(id, company_id) on delete restrict,
      add constraint journal_lines_bank_account_fk
        foreign key (company_bank_account_id, company_id)
        references company_bank_accounts(id, company_id) on delete restrict,
      add constraint journal_lines_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint journal_lines_updater_fk
        foreign key (updated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict;
    create index journal_lines_trader_index on journal_lines (company_id, trader_id);
    create index journal_lines_driver_index on journal_lines (company_id, driver_id);
    create index journal_lines_employee_index on journal_lines (company_id, employee_id);
    create index journal_lines_order_index on journal_lines (company_id, order_id);

    create function validate_accounting_journal_line() returns trigger language plpgsql as $$
    declare
      entry_company uuid;
      entry_status text;
      account_posting boolean;
      account_active boolean;
      account_control boolean;
      account_control_type text;
    begin
      select company_id, status into entry_company, entry_status
        from journal_entries
       where id = new.journal_entry_id and company_id = new.company_id;
      if entry_company is null then
        raise exception using errcode = '23503',
          message = 'accounting_journal_company_mismatch';
      end if;
      select is_posting_account, is_active, is_control_account, control_account_type
        into account_posting, account_active, account_control, account_control_type
        from chart_of_accounts
       where id = new.account_id and company_id = new.company_id;
      if account_posting is null then
        raise exception using errcode = '23503',
          message = 'accounting_journal_line_cross_company_account';
      end if;
      if not account_posting then
        raise exception using errcode = '23514',
          message = 'accounting_journal_line_summary_account';
      end if;
      if not account_active then
        raise exception using errcode = '23514',
          message = 'accounting_journal_line_inactive_account';
      end if;
      if account_control and (
        (account_control_type = 'trader_payable' and new.trader_id is null)
        or (account_control_type = 'driver_payable' and new.driver_id is null)
        or (
          account_control_type = 'payroll_payable'
          and new.employee_id is null
          and new.payroll_period_id is null
          and new.payroll_payment_id is null
        )
        or (
          account_control_type = 'accounts_receivable'
          and new.trader_id is null
          and new.order_id is null
          and new.subledger_id is null
        )
        or (
          account_control_type = 'vat'
          and new.source_entity_id is null
          and new.subledger_id is null
        )
      ) then
        raise exception using errcode = '23514',
          message = 'accounting_control_account_subledger_required';
      end if;
      return new;
    end;
    $$;
    create trigger journal_lines_validation_guard
      before insert or update on journal_lines
      for each row execute function validate_accounting_journal_line();
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

    create function synchronize_accounting_journal_totals() returns trigger language plpgsql as $$
    declare
      target_journal_id uuid;
      target_company_id uuid;
    begin
      target_journal_id := case when tg_op = 'DELETE' then old.journal_entry_id else new.journal_entry_id end;
      target_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
      update journal_entries j
         set total_debit = x.total_debit,
             total_credit = x.total_credit,
             updated_at = now()
        from (
          select coalesce(sum(debit), 0) as total_debit,
                 coalesce(sum(credit), 0) as total_credit
            from journal_lines
           where company_id = target_company_id
             and journal_entry_id = target_journal_id
        ) x
       where j.id = target_journal_id
         and j.company_id = target_company_id
         and j.status in ('draft','balanced');
      return null;
    end;
    $$;
    create trigger journal_lines_totals_guard
      after insert or update or delete on journal_lines
      for each row execute function synchronize_accounting_journal_totals();

    drop trigger journal_entries_immutable on journal_entries;
    create function protect_accounting_journal_history() returns trigger language plpgsql as $$
    declare
      computed_debit numeric(18,2);
      computed_credit numeric(18,2);
    begin
      if tg_op = 'DELETE' and old.status in ('posted','reversed','cancelled') then
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
         and not (new.status = 'posted' and new.id = old.id and new.company_id = old.company_id) then
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
    create trigger journal_entries_accounting_immutable
      before update or delete on journal_entries
      for each row execute function protect_accounting_journal_history();

    create function validate_accounting_journal_state() returns trigger language plpgsql as $$
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
    create trigger journal_entries_accounting_state_guard
      before update of status on journal_entries
      for each row execute function validate_accounting_journal_state();

    create table accounting_events (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      event_type text not null,
      event_version integer not null,
      source_entity_type text not null,
      source_entity_id uuid not null,
      source_reference text,
      effective_accounting_date date not null,
      currency text not null default 'AED',
      correlation_id text not null,
      idempotency_key text not null,
      event_hash text not null,
      actor_id uuid,
      actor_type text not null,
      description text not null,
      reversal_of_event_id uuid,
      supplementary_metadata jsonb not null default '{}'::jsonb,
      processing_status text not null default 'received',
      journal_id uuid,
      reversal_journal_id uuid,
      error_code text,
      error_metadata jsonb,
      created_at timestamptz not null default now(),
      validated_at timestamptz,
      processed_at timestamptz,
      failed_at timestamptz,
      reprocessed_at timestamptz,
      unique (id, company_id),
      constraint accounting_events_identity_unique unique (
        company_id, event_type, source_entity_type, source_entity_id, event_version
      ),
      constraint accounting_events_idempotency_unique unique (
        company_id, idempotency_key
      ),
      constraint accounting_events_version_positive check (event_version > 0),
      constraint accounting_events_currency_check check (currency = 'AED'),
      constraint accounting_events_hash_nonempty check (btrim(event_hash) <> ''),
      constraint accounting_events_type_check check (
        event_type in (
          'order_delivered','trader_receivable_recognized',
          'trader_settlement_confirmed','trader_settlement_reversed',
          'driver_collection_confirmed','driver_collection_reversed',
          'driver_expense_confirmed','employee_payroll_approved',
          'employee_payroll_paid','employee_payroll_payment_reversed',
          'outsourced_driver_fee_accrued','outsourced_driver_fee_paid',
          'outsourced_driver_fee_payment_reversed','general_expense_approved',
          'general_expense_reversed','bank_transfer_confirmed','bank_transfer_reversed'
        )
      ),
      constraint accounting_events_status_check check (
        processing_status in (
          'received','validated','posted','failed','reversed','ignored_duplicate'
        )
      ),
      constraint accounting_events_journal_fk
        foreign key (journal_id, company_id)
        references journal_entries(id, company_id) on delete restrict,
      constraint accounting_events_reversal_journal_fk
        foreign key (reversal_journal_id, company_id)
        references journal_entries(id, company_id) on delete restrict,
      constraint accounting_events_reversal_event_fk
        foreign key (reversal_of_event_id, company_id)
        references accounting_events(id, company_id) on delete restrict
    );
    create index accounting_events_status_index
      on accounting_events (company_id, processing_status, created_at);
    create index accounting_events_source_index
      on accounting_events (company_id, source_entity_type, source_entity_id);

    create table accounting_event_components (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      accounting_event_id uuid not null,
      component_number integer not null,
      component_type text not null,
      amount numeric(18,2) not null,
      entry_intent text not null,
      mapping_key text not null,
      subledger_type text,
      subledger_id uuid,
      source_reference text,
      vat_treatment text,
      description text,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (accounting_event_id, component_number),
      constraint accounting_event_components_event_fk
        foreign key (accounting_event_id, company_id)
        references accounting_events(id, company_id) on delete restrict,
      constraint accounting_event_components_number_positive
        check (component_number > 0),
      constraint accounting_event_components_amount_positive check (amount > 0),
      constraint accounting_event_components_type_check check (
        component_type in (
          'cod_receivable','delivery_revenue','service_fee_revenue',
          'additional_fee_revenue','output_vat','trader_payable',
          'trader_settlement','driver_collection_cash','driver_expense',
          'payroll_expense','payroll_payable','payroll_cash_payment',
          'outsourced_driver_fee_expense','outsourced_driver_payable',
          'outsourced_driver_payment','general_expense','input_vat',
          'cash_transfer','bank_transfer'
        )
      ),
      constraint accounting_event_components_intent_check
        check (entry_intent in ('debit','credit'))
    );

    create function protect_accounting_event_history() returns trigger language plpgsql as $$
    begin
      if tg_op = 'DELETE' and old.processing_status in ('posted','reversed') then
        raise exception using errcode = '23514',
          message = 'accounting_event_already_posted';
      end if;
      if tg_op = 'UPDATE' and old.processing_status in ('posted','reversed')
         and (
           new.company_id <> old.company_id
           or new.event_type <> old.event_type
           or new.event_version <> old.event_version
           or new.source_entity_type <> old.source_entity_type
           or new.source_entity_id <> old.source_entity_id
           or new.event_hash <> old.event_hash
           or new.journal_id is distinct from old.journal_id
         ) then
        raise exception using errcode = '23514',
          message = 'accounting_event_already_posted';
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;
    create trigger accounting_events_immutable
      before update or delete on accounting_events
      for each row execute function protect_accounting_event_history();

    create table account_mappings (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      mapping_key text not null,
      debit_account_id uuid,
      credit_account_id uuid,
      vat_account_id uuid,
      fee_account_id uuid,
      expense_account_id uuid,
      payable_account_id uuid,
      effective_from date not null,
      effective_to date,
      is_active boolean not null default true,
      created_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_by_account_id uuid,
      updated_at timestamptz not null default now(),
      deactivated_by_account_id uuid,
      deactivated_at timestamptz,
      unique (id, company_id),
      constraint account_mappings_dates_check
        check (effective_to is null or effective_to >= effective_from),
      constraint account_mappings_key_check check (
        mapping_key in (
          'order_cod_receivable','delivery_revenue','service_fee_revenue',
          'additional_fee_revenue','output_vat','trader_payable',
          'trader_settlement_cash','trader_settlement_bank',
          'driver_collection_cash','driver_expense','employee_payroll_expense',
          'employee_payroll_payable','employee_payroll_cash_payment',
          'outsourced_driver_fee_expense','outsourced_driver_payable',
          'outsourced_driver_cash_payment','driver_collection_fee_offset',
          'general_expense','input_vat','cash_transfer','bank_transfer'
        )
      ),
      constraint account_mappings_has_account_check check (
        num_nonnulls(
          debit_account_id, credit_account_id, vat_account_id,
          fee_account_id, expense_account_id, payable_account_id
        ) > 0
      ),
      constraint account_mappings_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint account_mappings_updater_fk
        foreign key (updated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint account_mappings_deactivator_fk
        foreign key (deactivated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint account_mappings_no_overlap exclude using gist (
        company_id with =,
        mapping_key with =,
        daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
      ) where (is_active)
    );
    create index account_mappings_effective_index
      on account_mappings (company_id, mapping_key, effective_from, effective_to)
      where is_active;

    create function add_account_mapping_account_fks() returns void language plpgsql as $$
    declare
      column_name text;
    begin
      foreach column_name in array array[
        'debit_account_id','credit_account_id','vat_account_id',
        'fee_account_id','expense_account_id','payable_account_id'
      ] loop
        execute format(
          'alter table account_mappings add constraint %I foreign key (%I, company_id) references chart_of_accounts(id, company_id) on delete restrict',
          'account_mappings_' || column_name || '_fk',
          column_name
        );
      end loop;
    end;
    $$;
    select add_account_mapping_account_fks();
    drop function add_account_mapping_account_fks();

    create function validate_account_mapping() returns trigger language plpgsql as $$
    declare
      account_id uuid;
      mapped_type text;
      mapped_class text;
      mapped_active boolean;
      mapped_posting boolean;
    begin
      if exists (
        select 1 from account_mappings x
         where x.company_id = new.company_id
           and x.mapping_key = new.mapping_key
           and x.id <> new.id
           and x.is_active and new.is_active
           and daterange(x.effective_from, coalesce(x.effective_to, 'infinity'::date), '[]')
               && daterange(new.effective_from, coalesce(new.effective_to, 'infinity'::date), '[]')
      ) then
        raise exception using errcode = '23514',
          message = 'accounting_mapping_overlap';
      end if;
      foreach account_id in array array[
        new.debit_account_id, new.credit_account_id, new.vat_account_id,
        new.fee_account_id, new.expense_account_id, new.payable_account_id
      ] loop
        if account_id is not null then
          select account_type, account_class, is_active, is_posting_account
            into mapped_type, mapped_class, mapped_active, mapped_posting
            from chart_of_accounts
           where id = account_id and company_id = new.company_id;
          if mapped_type is null then
            raise exception using errcode = '23503',
              message = 'accounting_mapping_cross_company';
          end if;
          if not mapped_active then
            raise exception using errcode = '23514',
              message = 'accounting_mapping_inactive_account';
          end if;
          if not mapped_posting then
            raise exception using errcode = '23514',
              message = 'accounting_mapping_summary_account';
          end if;
        end if;
      end loop;
      if new.mapping_key in ('delivery_revenue','service_fee_revenue','additional_fee_revenue')
         and (
           new.credit_account_id is null
           or not exists (
             select 1 from chart_of_accounts
              where id = new.credit_account_id and company_id = new.company_id
                and account_type = 'revenue'
           )
         ) then
        raise exception using errcode = '23514',
          message = 'accounting_mapping_account_incompatible';
      end if;
      if new.mapping_key = 'order_cod_receivable'
         and (
           new.debit_account_id is null
           or not exists (
             select 1 from chart_of_accounts
              where id = new.debit_account_id and company_id = new.company_id
                and account_type = 'asset'
                and account_class in ('accounts_receivable','other_receivable')
           )
         ) then
        raise exception using errcode = '23514',
          message = 'accounting_mapping_account_incompatible';
      end if;
      if new.mapping_key in (
           'trader_payable','employee_payroll_payable','outsourced_driver_payable'
         )
         and (
           coalesce(new.payable_account_id, new.credit_account_id) is null
           or not exists (
             select 1 from chart_of_accounts
              where id = coalesce(new.payable_account_id, new.credit_account_id)
                and company_id = new.company_id and account_type = 'liability'
           )
         ) then
        raise exception using errcode = '23514',
          message = 'accounting_mapping_account_incompatible';
      end if;
      if new.mapping_key in (
           'driver_expense','employee_payroll_expense',
           'outsourced_driver_fee_expense','general_expense'
         )
         and (
           coalesce(new.expense_account_id, new.debit_account_id) is null
           or not exists (
             select 1 from chart_of_accounts
              where id = coalesce(new.expense_account_id, new.debit_account_id)
                and company_id = new.company_id and account_type = 'expense'
           )
         ) then
        raise exception using errcode = '23514',
          message = 'accounting_mapping_account_incompatible';
      end if;
      if new.mapping_key in (
           'trader_settlement_cash','trader_settlement_bank',
           'driver_collection_cash','employee_payroll_cash_payment',
           'outsourced_driver_cash_payment','cash_transfer','bank_transfer'
         )
         and not exists (
           select 1 from chart_of_accounts
            where id in (new.debit_account_id, new.credit_account_id)
              and company_id = new.company_id
              and account_type = 'asset' and account_class in ('cash','bank')
         ) then
        raise exception using errcode = '23514',
          message = 'accounting_mapping_account_incompatible';
      end if;
      if new.mapping_key = 'output_vat'
         and not exists (
           select 1 from chart_of_accounts
            where id in (new.vat_account_id, new.credit_account_id)
              and company_id = new.company_id
              and account_type = 'liability' and account_class = 'vat_payable'
         ) then
        raise exception using errcode = '23514',
          message = 'accounting_mapping_account_incompatible';
      end if;
      if new.mapping_key = 'input_vat'
         and not exists (
           select 1 from chart_of_accounts
            where id in (new.vat_account_id, new.debit_account_id)
              and company_id = new.company_id
              and (
                (account_type = 'asset' and account_class in (
                  'accounts_receivable','other_receivable','prepaid_expense','other_asset'
                ))
                or (account_type = 'expense' and account_class = 'vat_expense')
              )
         ) then
        raise exception using errcode = '23514',
          message = 'accounting_mapping_account_incompatible';
      end if;
      return new;
    end;
    $$;
    create trigger account_mappings_validation_guard
      before insert or update on account_mappings
      for each row execute function validate_account_mapping();
    create function protect_account_mapping_history() returns trigger language plpgsql as $$
    begin
      if tg_op = 'DELETE' then
        raise exception using errcode = '23514',
          message = 'accounting_mapping_history_immutable';
      end if;
      if new.company_id <> old.company_id
         or new.mapping_key <> old.mapping_key
         or new.effective_from <> old.effective_from
         or new.debit_account_id is distinct from old.debit_account_id
         or new.credit_account_id is distinct from old.credit_account_id
         or new.vat_account_id is distinct from old.vat_account_id
         or new.fee_account_id is distinct from old.fee_account_id
         or new.expense_account_id is distinct from old.expense_account_id
         or new.payable_account_id is distinct from old.payable_account_id then
        raise exception using errcode = '23514',
          message = 'accounting_mapping_history_immutable';
      end if;
      return new;
    end;
    $$;
    create trigger account_mappings_history_guard
      before update or delete on account_mappings
      for each row execute function protect_account_mapping_history();

    create table opening_balance_batches (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      batch_number text not null,
      effective_date date not null,
      fiscal_year_id uuid not null,
      accounting_period_id uuid not null,
      description text not null,
      currency text not null default 'AED',
      total_debit numeric(18,2) not null default 0,
      total_credit numeric(18,2) not null default 0,
      status text not null default 'draft',
      journal_id uuid,
      reversal_journal_id uuid,
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      updated_by_account_id uuid,
      updated_at timestamptz not null default now(),
      validated_by_account_id uuid,
      validated_at timestamptz,
      approved_by_account_id uuid,
      approved_at timestamptz,
      posted_by_account_id uuid,
      posted_at timestamptz,
      reversed_by_account_id uuid,
      reversed_at timestamptz,
      reversal_reason text,
      unique (id, company_id),
      unique (company_id, batch_number),
      constraint opening_balance_batches_year_fk
        foreign key (fiscal_year_id, company_id)
        references fiscal_years(id, company_id) on delete restrict,
      constraint opening_balance_batches_period_fk
        foreign key (accounting_period_id, company_id)
        references accounting_periods(id, company_id) on delete restrict,
      constraint opening_balance_batches_journal_fk
        foreign key (journal_id, company_id)
        references journal_entries(id, company_id) on delete restrict,
      constraint opening_balance_batches_reversal_journal_fk
        foreign key (reversal_journal_id, company_id)
        references journal_entries(id, company_id) on delete restrict,
      constraint opening_balance_batches_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint opening_balance_batches_updater_fk
        foreign key (updated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint opening_balance_batches_validator_fk
        foreign key (validated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint opening_balance_batches_approver_fk
        foreign key (approved_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint opening_balance_batches_poster_fk
        foreign key (posted_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint opening_balance_batches_reverser_fk
        foreign key (reversed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint opening_balance_batches_currency_check check (currency = 'AED'),
      constraint opening_balance_batches_totals_check
        check (total_debit >= 0 and total_credit >= 0),
      constraint opening_balance_batches_status_check check (
        status in ('draft','validated','approved','posted','reversed')
      ),
      constraint opening_balance_batches_posted_journal_unique unique (journal_id),
      constraint opening_balance_batches_reversal_shape_check check (
        status <> 'reversed'
        or (
          reversal_journal_id is not null
          and reversed_by_account_id is not null
          and reversed_at is not null
          and btrim(coalesce(reversal_reason, '')) <> ''
        )
      )
    );

    create table opening_balance_lines (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      opening_balance_batch_id uuid not null,
      line_number integer not null,
      account_id uuid not null,
      debit numeric(18,2) not null default 0,
      credit numeric(18,2) not null default 0,
      description text,
      subledger_type text,
      subledger_id uuid,
      trader_id uuid,
      driver_id uuid,
      employee_id uuid,
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      updated_by_account_id uuid,
      updated_at timestamptz not null default now(),
      unique (id, company_id),
      unique (opening_balance_batch_id, line_number),
      constraint opening_balance_lines_batch_fk
        foreign key (opening_balance_batch_id, company_id)
        references opening_balance_batches(id, company_id) on delete restrict,
      constraint opening_balance_lines_account_fk
        foreign key (account_id, company_id)
        references chart_of_accounts(id, company_id) on delete restrict,
      constraint opening_balance_lines_trader_fk
        foreign key (trader_id, company_id)
        references traders(id, company_id) on delete restrict,
      constraint opening_balance_lines_driver_fk
        foreign key (driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint opening_balance_lines_employee_fk
        foreign key (employee_id, company_id)
        references employees(id, company_id) on delete restrict,
      constraint opening_balance_lines_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint opening_balance_lines_updater_fk
        foreign key (updated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint opening_balance_lines_number_positive check (line_number > 0),
      constraint opening_balance_lines_amount_check check (
        debit >= 0 and credit >= 0
        and ((debit > 0 and credit = 0) or (credit > 0 and debit = 0))
      )
    );
    create index opening_balance_lines_account_index
      on opening_balance_lines (company_id, account_id);

    create function validate_opening_balance_foundation() returns trigger language plpgsql as $$
    declare
      period_year_id uuid;
      period_start date;
      period_end date;
      account_posting boolean;
      account_active boolean;
      account_control boolean;
      account_control_type text;
      computed_debit numeric(18,2);
      computed_credit numeric(18,2);
    begin
      if tg_table_name = 'opening_balance_batches' then
        if tg_op = 'UPDATE' and old.status <> new.status and not (
          (old.status = 'draft' and new.status = 'validated')
          or (old.status = 'validated' and new.status in ('draft','approved'))
          or (old.status = 'approved' and new.status = 'posted')
          or (old.status = 'posted' and new.status = 'reversed')
        ) then
          raise exception using errcode = '23514',
            message = 'accounting_opening_balance_invalid_transition';
        end if;
        select fiscal_year_id, accounting_periods.period_start, accounting_periods.period_end
          into period_year_id, period_start, period_end
          from accounting_periods
         where id = new.accounting_period_id and company_id = new.company_id;
        if period_year_id is null
           or period_year_id <> new.fiscal_year_id
           or new.effective_date not between period_start and period_end then
          raise exception using errcode = '23514',
            message = 'accounting_invalid_opening_balance_period';
        end if;
        if new.status in ('validated','approved','posted') then
          select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
            into computed_debit, computed_credit
            from opening_balance_lines
           where opening_balance_batch_id = new.id and company_id = new.company_id;
          if computed_debit <= 0 or computed_debit <> computed_credit then
            raise exception using errcode = '23514',
              message = 'accounting_opening_balance_not_balanced';
          end if;
          new.total_debit := computed_debit;
          new.total_credit := computed_credit;
        end if;
      else
        select is_posting_account, is_active, is_control_account, control_account_type
          into account_posting, account_active, account_control, account_control_type
          from chart_of_accounts
         where id = new.account_id and company_id = new.company_id;
        if account_posting is null or not account_posting or not account_active then
          raise exception using errcode = '23514',
            message = 'accounting_invalid_opening_balance_account';
        end if;
        if account_control and (
          (account_control_type = 'trader_payable' and new.trader_id is null)
          or (account_control_type = 'driver_payable' and new.driver_id is null)
          or (
            account_control_type = 'payroll_payable'
            and new.employee_id is null and new.subledger_id is null
          )
          or (
            account_control_type in ('accounts_receivable','vat')
            and new.subledger_id is null
            and new.trader_id is null
          )
        ) then
          raise exception using errcode = '23514',
            message = 'accounting_control_account_subledger_required';
        end if;
      end if;
      return new;
    end;
    $$;
    create trigger opening_balance_batches_validation_guard
      before insert or update on opening_balance_batches
      for each row execute function validate_opening_balance_foundation();
    create trigger opening_balance_lines_validation_guard
      before insert or update on opening_balance_lines
      for each row execute function validate_opening_balance_foundation();

    create function synchronize_opening_balance_totals() returns trigger language plpgsql as $$
    declare
      target_batch_id uuid;
      target_company_id uuid;
    begin
      target_batch_id := case when tg_op = 'DELETE' then old.opening_balance_batch_id else new.opening_balance_batch_id end;
      target_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
      update opening_balance_batches b
         set total_debit = x.total_debit, total_credit = x.total_credit, updated_at = now()
        from (
          select coalesce(sum(debit), 0) as total_debit,
                 coalesce(sum(credit), 0) as total_credit
            from opening_balance_lines
           where opening_balance_batch_id = target_batch_id
             and company_id = target_company_id
        ) x
       where b.id = target_batch_id and b.company_id = target_company_id
         and b.status in ('draft','validated');
      return null;
    end;
    $$;
    create trigger opening_balance_lines_totals_guard
      after insert or update or delete on opening_balance_lines
      for each row execute function synchronize_opening_balance_totals();

    create function protect_opening_balance_history() returns trigger language plpgsql as $$
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
    create trigger opening_balance_batches_immutable
      before update or delete on opening_balance_batches
      for each row execute function protect_opening_balance_history();
    create trigger opening_balance_lines_immutable
      before update or delete on opening_balance_lines
      for each row execute function protect_opening_balance_history();

    insert into permissions (code, description) values
      ('accounting.view', 'View Accounting foundations and financial records'),
      ('accounting.manage', 'Manage Accounting foundation records'),
      ('accounting.approve', 'Approve Accounting journals and balances'),
      ('accounting.post', 'Post approved Accounting journals'),
      ('accounting.reverse', 'Reverse posted Accounting journals'),
      ('accounting.periods.manage', 'Manage Accounting fiscal years and periods'),
      ('accounting.chart_of_accounts.manage', 'Manage the Chart of Accounts'),
      ('accounting.configuration.manage', 'Manage Accounting configuration and mappings')
    on conflict (code) do nothing;

    alter table company_reference_counters
      drop constraint company_reference_counters_type_check;
    alter table company_reference_counters
      add constraint company_reference_counters_type_check check (
        reference_type in (
          'order','payment','reconciliation','settlement','journal','payroll','import',
          'trader','area','customer','driver','employee','trader_receivable',
          'trader_collection','payroll_payment','outsourced_driver_fee_payment',
          'accounting_opening_balance'
        )
      );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from company_reference_counters
     where reference_type = 'accounting_opening_balance';
    alter table company_reference_counters
      drop constraint company_reference_counters_type_check;
    alter table company_reference_counters
      add constraint company_reference_counters_type_check check (
        reference_type in (
          'order','payment','reconciliation','settlement','journal','payroll','import',
          'trader','area','customer','driver','employee','trader_receivable',
          'trader_collection','payroll_payment','outsourced_driver_fee_payment'
        )
      );
    delete from role_permissions where permission_code in (
      'accounting.view','accounting.manage','accounting.approve','accounting.post',
      'accounting.reverse','accounting.periods.manage',
      'accounting.chart_of_accounts.manage','accounting.configuration.manage'
    );
    delete from permissions where code in (
      'accounting.view','accounting.manage','accounting.approve','accounting.post',
      'accounting.reverse','accounting.periods.manage',
      'accounting.chart_of_accounts.manage','accounting.configuration.manage'
    );

    drop trigger if exists opening_balance_lines_immutable on opening_balance_lines;
    drop trigger if exists opening_balance_batches_immutable on opening_balance_batches;
    drop function if exists protect_opening_balance_history();
    drop trigger if exists opening_balance_lines_totals_guard on opening_balance_lines;
    drop function if exists synchronize_opening_balance_totals();
    drop trigger if exists opening_balance_lines_validation_guard on opening_balance_lines;
    drop trigger if exists opening_balance_batches_validation_guard on opening_balance_batches;
    drop function if exists validate_opening_balance_foundation();
    drop table if exists opening_balance_lines;
    drop table if exists opening_balance_batches;
    drop trigger if exists account_mappings_history_guard on account_mappings;
    drop function if exists protect_account_mapping_history();
    drop trigger if exists account_mappings_validation_guard on account_mappings;
    drop function if exists validate_account_mapping();
    drop table if exists account_mappings;
    drop trigger if exists accounting_events_immutable on accounting_events;
    drop function if exists protect_accounting_event_history();
    drop table if exists accounting_event_components;
    drop table if exists accounting_events;

    drop trigger if exists journal_entries_accounting_state_guard on journal_entries;
    drop function if exists validate_accounting_journal_state();
    drop trigger if exists journal_entries_accounting_immutable on journal_entries;
    drop function if exists protect_accounting_journal_history();
    create trigger journal_entries_immutable before update or delete on journal_entries
      for each row execute function reject_finalized_financial_mutation();
    drop trigger if exists journal_lines_totals_guard on journal_lines;
    drop function if exists synchronize_accounting_journal_totals();
    drop trigger if exists journal_lines_validation_guard on journal_lines;
    drop function if exists validate_accounting_journal_line();
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
         where id = target_entry_id and company_id = target_company_id and status = 'posted'
      ) then
        raise exception 'posted journal lines are immutable';
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;

    alter table journal_lines
      drop constraint if exists journal_lines_updater_fk,
      drop constraint if exists journal_lines_creator_fk,
      drop constraint if exists journal_lines_bank_account_fk,
      drop constraint if exists journal_lines_driver_fee_payment_fk,
      drop constraint if exists journal_lines_driver_fee_accrual_fk,
      drop constraint if exists journal_lines_payroll_payment_fk,
      drop constraint if exists journal_lines_payroll_period_fk,
      drop constraint if exists journal_lines_collection_fk,
      drop constraint if exists journal_lines_settlement_fk,
      drop constraint if exists journal_lines_order_fk,
      drop constraint if exists journal_lines_employee_fk,
      drop constraint if exists journal_lines_driver_fk,
      drop constraint if exists journal_lines_trader_fk,
      drop constraint if exists journal_lines_number_unique,
      drop constraint if exists journal_lines_number_positive,
      drop column if exists updated_at,
      drop column if exists updated_by_account_id,
      drop column if exists created_by_account_id,
      drop column if exists source_entity_id,
      drop column if exists source_entity_type,
      drop column if exists company_cash_account_id,
      drop column if exists company_bank_account_id,
      drop column if exists general_expense_id,
      drop column if exists outsourced_driver_fee_payment_id,
      drop column if exists outsourced_driver_fee_accrual_id,
      drop column if exists payroll_payment_id,
      drop column if exists payroll_period_id,
      drop column if exists driver_collection_id,
      drop column if exists trader_settlement_id,
      drop column if exists order_id,
      drop column if exists employee_id,
      drop column if exists driver_id,
      drop column if exists trader_id,
      drop column if exists subledger_id,
      drop column if exists subledger_type,
      drop column if exists line_number;

    drop index if exists journal_entries_idempotency_unique;
    alter table journal_entries
      drop constraint if exists journal_entries_cancellation_shape_check,
      drop constraint if exists journal_entries_reversal_shape_check,
      drop constraint if exists journal_entries_reversed_by_self_check,
      drop constraint if exists journal_entries_posting_shape_check,
      drop constraint if exists journal_entries_approval_shape_check,
      drop constraint if exists journal_entries_totals_check,
      drop constraint if exists journal_entries_currency_check,
      drop constraint if exists journal_entries_status_check,
      drop constraint if exists journal_entries_type_check,
      drop constraint if exists journal_entries_source_check,
      drop constraint if exists journal_entries_canceller_fk,
      drop constraint if exists journal_entries_reverser_fk,
      drop constraint if exists journal_entries_approver_fk,
      drop constraint if exists journal_entries_updater_fk,
      drop constraint if exists journal_entries_reversed_by_fk,
      drop constraint if exists journal_entries_fiscal_year_fk,
      drop column if exists cancellation_reason,
      drop column if exists cancelled_at,
      drop column if exists cancelled_by_account_id,
      drop column if exists reversal_reason,
      drop column if exists reversed_at,
      drop column if exists reversed_by_account_id,
      drop column if exists approved_at,
      drop column if exists approved_by_account_id,
      drop column if exists updated_by_account_id,
      drop column if exists reversed_by_journal_id,
      drop column if exists idempotency_key,
      drop column if exists correlation_id,
      drop column if exists source_reference,
      drop column if exists source_entity_id,
      drop column if exists source_entity_type,
      drop column if exists total_credit,
      drop column if exists total_debit,
      drop column if exists exchange_rate,
      drop column if exists currency,
      drop column if exists journal_type,
      drop column if exists fiscal_year_id,
      add constraint journal_entries_source_check check (
        source_type in ('manual','order','reconciliation','settlement','expense','payroll','reversal')
      ),
      add constraint journal_entries_status_check check (status in ('draft','posted')),
      add constraint journal_entries_posting_check check (
        (status = 'draft' and posted_by_account_id is null and posted_at is null)
        or (status = 'posted' and posted_by_account_id is not null and posted_at is not null)
      );

    drop trigger if exists accounting_configurations_history_writer on accounting_configurations;
    drop function if exists record_accounting_configuration_history();
    drop trigger if exists accounting_configurations_validation_guard on accounting_configurations;
    drop function if exists validate_accounting_configuration();
    drop table if exists accounting_configuration_history;
    drop table if exists accounting_configurations;
    drop trigger if exists chart_of_accounts_history_guard on chart_of_accounts;
    drop function if exists protect_accounting_account_history();
    drop trigger if exists chart_of_accounts_validation_guard on chart_of_accounts;
    drop function if exists validate_accounting_account();
    alter table chart_of_accounts
      drop constraint if exists chart_of_accounts_deactivator_fk,
      drop constraint if exists chart_of_accounts_updater_fk,
      drop constraint if exists chart_of_accounts_creator_fk,
      drop constraint if exists chart_of_accounts_system_check,
      drop constraint if exists chart_of_accounts_control_check,
      drop constraint if exists chart_of_accounts_parent_self_check,
      drop constraint if exists chart_of_accounts_dates_check,
      drop constraint if exists chart_of_accounts_currency_check,
      drop constraint if exists chart_of_accounts_normal_balance_check,
      drop constraint if exists chart_of_accounts_class_check,
      drop constraint if exists chart_of_accounts_name_nonempty,
      drop constraint if exists chart_of_accounts_code_nonempty,
      drop column if exists deactivated_at,
      drop column if exists deactivated_by_account_id,
      drop column if exists updated_by_account_id,
      drop column if exists created_by_account_id,
      drop column if exists effective_to,
      drop column if exists effective_from,
      drop column if exists description,
      drop column if exists currency,
      drop column if exists system_purpose,
      drop column if exists is_system_account,
      drop column if exists control_account_type,
      drop column if exists is_control_account,
      drop column if exists is_contra_account,
      drop column if exists normal_balance,
      drop column if exists account_class;

    drop trigger if exists accounting_periods_history_guard on accounting_periods;
    drop trigger if exists fiscal_years_history_guard on fiscal_years;
    drop function if exists protect_accounting_calendar_history();
    drop trigger if exists accounting_periods_calendar_guard on accounting_periods;
    drop function if exists validate_accounting_period_calendar();
    drop trigger if exists accounting_periods_overlap_guard on accounting_periods;
    alter table accounting_periods
      drop constraint if exists accounting_periods_no_overlap,
      drop constraint if exists accounting_periods_code_unique,
      drop constraint if exists accounting_periods_number_unique,
      drop constraint if exists accounting_periods_reopen_check,
      drop constraint if exists accounting_periods_number_positive,
      drop constraint if exists accounting_periods_status_check,
      drop constraint if exists accounting_periods_reopener_fk,
      drop constraint if exists accounting_periods_opener_fk,
      drop constraint if exists accounting_periods_creator_fk,
      drop constraint if exists accounting_periods_fiscal_year_fk,
      drop column if exists reopen_reason,
      drop column if exists reopened_at,
      drop column if exists reopened_by_account_id,
      drop column if exists opened_at,
      drop column if exists opened_by_account_id,
      drop column if exists created_by_account_id,
      drop column if exists is_adjustment_period,
      drop column if exists name,
      drop column if exists period_code,
      drop column if exists period_number,
      drop column if exists fiscal_year_id,
      add constraint accounting_periods_status_check check (status in ('open','closed')),
      add constraint accounting_periods_close_check check (
        (status = 'open' and closed_by_account_id is null and closed_at is null)
        or (status = 'closed' and closed_by_account_id is not null and closed_at is not null)
      );
    drop trigger if exists fiscal_years_overlap_guard on fiscal_years;
    drop function if exists prevent_accounting_date_overlap();
    drop table if exists fiscal_years;
  `.execute(database);
}
