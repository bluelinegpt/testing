import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table expense_types (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      code text not null,
      name_en text not null,
      name_ar text,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      constraint expense_types_version_positive check (version > 0)
    );
    create unique index expense_types_code_unique on expense_types (company_id, lower(code));

    create table order_expenses (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      order_id uuid not null,
      expense_type_id uuid not null,
      amount numeric(18,2) not null,
      description text,
      attachment_file_id uuid,
      status text not null default 'draft',
      reversal_of_id uuid,
      business_date date not null,
      created_by_account_id uuid not null,
      confirmed_by_account_id uuid,
      confirmed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (id, company_id),
      constraint order_expenses_order_fk foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint order_expenses_type_fk foreign key (expense_type_id, company_id)
        references expense_types(id, company_id) on delete restrict,
      constraint order_expenses_file_fk foreign key (attachment_file_id, company_id)
        references file_objects(id, company_id) on delete restrict,
      constraint order_expenses_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint order_expenses_confirmer_fk foreign key (confirmed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint order_expenses_reversal_fk foreign key (reversal_of_id, company_id)
        references order_expenses(id, company_id) on delete restrict,
      constraint order_expenses_amount_positive check (amount > 0),
      constraint order_expenses_status_check check (status in ('draft', 'confirmed')),
      constraint order_expenses_confirmation_check check (
        (status = 'draft' and confirmed_by_account_id is null and confirmed_at is null)
        or (status = 'confirmed' and confirmed_by_account_id is not null and confirmed_at is not null)
      ),
      constraint order_expenses_reversal_self_check check (reversal_of_id is null or reversal_of_id <> id)
    );
    create index order_expenses_order_index on order_expenses (company_id, order_id, business_date);

    create table operating_expenses (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      expense_number text not null,
      expense_type_id uuid not null,
      driver_id uuid,
      vehicle_id uuid,
      amount numeric(18,2) not null,
      business_date date not null,
      description text,
      attachment_file_id uuid,
      status text not null default 'draft',
      reversal_of_id uuid,
      created_by_account_id uuid not null,
      confirmed_by_account_id uuid,
      confirmed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, expense_number),
      constraint operating_expenses_type_fk foreign key (expense_type_id, company_id)
        references expense_types(id, company_id) on delete restrict,
      constraint operating_expenses_driver_fk foreign key (driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint operating_expenses_vehicle_fk foreign key (vehicle_id, company_id)
        references vehicles(id, company_id) on delete restrict,
      constraint operating_expenses_file_fk foreign key (attachment_file_id, company_id)
        references file_objects(id, company_id) on delete restrict,
      constraint operating_expenses_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint operating_expenses_confirmer_fk foreign key (confirmed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint operating_expenses_reversal_fk foreign key (reversal_of_id, company_id)
        references operating_expenses(id, company_id) on delete restrict,
      constraint operating_expenses_amount_positive check (amount > 0),
      constraint operating_expenses_status_check check (status in ('draft', 'confirmed')),
      constraint operating_expenses_confirmation_check check (
        (status = 'draft' and confirmed_by_account_id is null and confirmed_at is null)
        or (status = 'confirmed' and confirmed_by_account_id is not null and confirmed_at is not null)
      ),
      constraint operating_expenses_reversal_self_check check (reversal_of_id is null or reversal_of_id <> id)
    );
    create index operating_expenses_company_date_index on operating_expenses (company_id, business_date desc);

    create table driver_reconciliations (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      reconciliation_number text not null,
      driver_id uuid not null,
      business_date date not null,
      gross_collections numeric(18,2) not null,
      driver_payable_deduction numeric(18,2) not null default 0,
      reconciliation_expenses numeric(18,2) not null default 0,
      net_amount_received numeric(18,2) not null,
      status text not null default 'draft',
      reversal_of_id uuid,
      created_by_account_id uuid not null,
      confirmed_by_account_id uuid,
      confirmed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, reconciliation_number),
      constraint driver_reconciliations_driver_fk foreign key (driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint driver_reconciliations_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint driver_reconciliations_confirmer_fk foreign key (confirmed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint driver_reconciliations_reversal_fk foreign key (reversal_of_id, company_id)
        references driver_reconciliations(id, company_id) on delete restrict,
      constraint driver_reconciliations_amounts_check check (
        gross_collections >= 0 and driver_payable_deduction >= 0 and reconciliation_expenses >= 0
        and net_amount_received >= 0
        and net_amount_received = gross_collections - driver_payable_deduction - reconciliation_expenses
      ),
      constraint driver_reconciliations_status_check check (status in ('draft', 'confirmed')),
      constraint driver_reconciliations_confirmation_check check (
        (status = 'draft' and confirmed_by_account_id is null and confirmed_at is null)
        or (status = 'confirmed' and confirmed_by_account_id is not null and confirmed_at is not null)
      ),
      constraint driver_reconciliations_reversal_self_check check (reversal_of_id is null or reversal_of_id <> id)
    );
    create index driver_reconciliations_driver_date_index
      on driver_reconciliations (company_id, driver_id, business_date desc);

    create table driver_reconciliation_orders (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      reconciliation_id uuid not null,
      order_id uuid not null,
      customer_collection_amount numeric(18,2) not null,
      driver_payable_deduction numeric(18,2) not null default 0,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, reconciliation_id, order_id),
      constraint driver_reconciliation_orders_reconciliation_fk foreign key (reconciliation_id, company_id)
        references driver_reconciliations(id, company_id) on delete restrict,
      constraint driver_reconciliation_orders_order_fk foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint driver_reconciliation_orders_amounts_check check (customer_collection_amount >= 0 and driver_payable_deduction >= 0)
    );
    create index driver_reconciliation_orders_order_index on driver_reconciliation_orders (company_id, order_id);

    create table driver_reconciliation_expenses (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      reconciliation_id uuid not null,
      expense_type_id uuid not null,
      amount numeric(18,2) not null,
      description text,
      attachment_file_id uuid,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      constraint driver_reconciliation_expenses_reconciliation_fk foreign key (reconciliation_id, company_id)
        references driver_reconciliations(id, company_id) on delete restrict,
      constraint driver_reconciliation_expenses_type_fk foreign key (expense_type_id, company_id)
        references expense_types(id, company_id) on delete restrict,
      constraint driver_reconciliation_expenses_file_fk foreign key (attachment_file_id, company_id)
        references file_objects(id, company_id) on delete restrict,
      constraint driver_reconciliation_expenses_amount_positive check (amount > 0)
    );

    create table driver_reconciliation_payments (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      reconciliation_id uuid not null,
      payment_method text not null,
      amount numeric(18,2) not null,
      company_bank_account_id uuid,
      bank_reference text,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      constraint driver_reconciliation_payments_reconciliation_fk foreign key (reconciliation_id, company_id)
        references driver_reconciliations(id, company_id) on delete restrict,
      constraint driver_reconciliation_payments_bank_fk foreign key (company_bank_account_id, company_id)
        references company_bank_accounts(id, company_id) on delete restrict,
      constraint driver_reconciliation_payments_method_check check (payment_method in ('cash', 'bank_transfer')),
      constraint driver_reconciliation_payments_amount_positive check (amount > 0),
      constraint driver_reconciliation_payments_bank_check check (
        (payment_method = 'cash' and company_bank_account_id is null and bank_reference is null)
        or (payment_method = 'bank_transfer' and company_bank_account_id is not null and bank_reference is not null)
      )
    );

    create table trader_settlements (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      settlement_number text not null,
      trader_id uuid not null,
      business_date date not null,
      gross_payable numeric(18,2) not null,
      service_fee_deductions numeric(18,2) not null default 0,
      other_deductions numeric(18,2) not null default 0,
      charges numeric(18,2) not null default 0,
      adjustments numeric(18,2) not null default 0,
      net_payable numeric(18,2) not null,
      status text not null default 'draft',
      reversal_of_id uuid,
      created_by_account_id uuid not null,
      confirmed_by_account_id uuid,
      confirmed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, settlement_number),
      constraint trader_settlements_trader_fk foreign key (trader_id, company_id)
        references traders(id, company_id) on delete restrict,
      constraint trader_settlements_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint trader_settlements_confirmer_fk foreign key (confirmed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint trader_settlements_reversal_fk foreign key (reversal_of_id, company_id)
        references trader_settlements(id, company_id) on delete restrict,
      constraint trader_settlements_amounts_check check (
        gross_payable >= 0 and service_fee_deductions >= 0 and other_deductions >= 0 and charges >= 0
        and net_payable >= 0
        and net_payable = gross_payable - service_fee_deductions - other_deductions - charges + adjustments
      ),
      constraint trader_settlements_status_check check (status in ('draft', 'confirmed')),
      constraint trader_settlements_confirmation_check check (
        (status = 'draft' and confirmed_by_account_id is null and confirmed_at is null)
        or (status = 'confirmed' and confirmed_by_account_id is not null and confirmed_at is not null)
      ),
      constraint trader_settlements_reversal_self_check check (reversal_of_id is null or reversal_of_id <> id)
    );
    create index trader_settlements_trader_date_index on trader_settlements (company_id, trader_id, business_date desc);

    create table trader_settlement_orders (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      settlement_id uuid not null,
      order_id uuid not null,
      gross_payable numeric(18,2) not null,
      deductions_and_charges numeric(18,2) not null default 0,
      adjustments numeric(18,2) not null default 0,
      net_payable numeric(18,2) not null,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, settlement_id, order_id),
      constraint trader_settlement_orders_settlement_fk foreign key (settlement_id, company_id)
        references trader_settlements(id, company_id) on delete restrict,
      constraint trader_settlement_orders_order_fk foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint trader_settlement_orders_amounts_check check (
        gross_payable >= 0 and deductions_and_charges >= 0 and net_payable >= 0
        and net_payable = gross_payable - deductions_and_charges + adjustments
      )
    );
    create index trader_settlement_orders_order_index on trader_settlement_orders (company_id, order_id);

    create table trader_settlement_payments (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      settlement_id uuid not null,
      payment_method text not null,
      amount numeric(18,2) not null,
      company_bank_account_id uuid,
      bank_reference text,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      constraint trader_settlement_payments_settlement_fk foreign key (settlement_id, company_id)
        references trader_settlements(id, company_id) on delete restrict,
      constraint trader_settlement_payments_bank_fk foreign key (company_bank_account_id, company_id)
        references company_bank_accounts(id, company_id) on delete restrict,
      constraint trader_settlement_payments_method_check check (payment_method in ('cash', 'bank_transfer')),
      constraint trader_settlement_payments_amount_positive check (amount > 0),
      constraint trader_settlement_payments_bank_check check (
        (payment_method = 'cash' and company_bank_account_id is null and bank_reference is null)
        or (payment_method = 'bank_transfer' and company_bank_account_id is not null and bank_reference is not null)
      )
    );

    create table payroll_periods (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      period_start date not null,
      period_end date not null,
      status text not null default 'open',
      closed_by_account_id uuid,
      closed_at timestamptz,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, period_start, period_end),
      constraint payroll_periods_closer_fk foreign key (closed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint payroll_periods_dates_check check (period_end >= period_start),
      constraint payroll_periods_status_check check (status in ('open', 'closed')),
      constraint payroll_periods_close_check check (
        (status = 'open' and closed_by_account_id is null and closed_at is null)
        or (status = 'closed' and closed_by_account_id is not null and closed_at is not null)
      )
    );

    create table payroll_entries (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      payroll_number text not null,
      payroll_period_id uuid not null,
      employee_id uuid not null,
      basic_salary numeric(18,2) not null default 0,
      delivered_order_commission numeric(18,2) not null default 0,
      allowances numeric(18,2) not null default 0,
      deductions numeric(18,2) not null default 0,
      advances numeric(18,2) not null default 0,
      total_salary numeric(18,2) not null,
      status text not null default 'draft',
      reversal_of_id uuid,
      created_by_account_id uuid not null,
      confirmed_by_account_id uuid,
      confirmed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, payroll_number),
      unique (company_id, payroll_period_id, employee_id),
      constraint payroll_entries_period_fk foreign key (payroll_period_id, company_id)
        references payroll_periods(id, company_id) on delete restrict,
      constraint payroll_entries_employee_fk foreign key (employee_id, company_id)
        references employees(id, company_id) on delete restrict,
      constraint payroll_entries_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint payroll_entries_confirmer_fk foreign key (confirmed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint payroll_entries_reversal_fk foreign key (reversal_of_id, company_id)
        references payroll_entries(id, company_id) on delete restrict,
      constraint payroll_entries_amounts_check check (
        basic_salary >= 0 and delivered_order_commission >= 0 and allowances >= 0
        and deductions >= 0 and advances >= 0 and total_salary >= 0
        and total_salary = basic_salary + delivered_order_commission + allowances - deductions - advances
      ),
      constraint payroll_entries_status_check check (status in ('draft', 'confirmed')),
      constraint payroll_entries_confirmation_check check (
        (status = 'draft' and confirmed_by_account_id is null and confirmed_at is null)
        or (status = 'confirmed' and confirmed_by_account_id is not null and confirmed_at is not null)
      ),
      constraint payroll_entries_reversal_self_check check (reversal_of_id is null or reversal_of_id <> id)
    );

    create table accounting_periods (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      period_start date not null,
      period_end date not null,
      status text not null default 'open',
      closed_by_account_id uuid,
      closed_at timestamptz,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, period_start, period_end),
      constraint accounting_periods_closer_fk foreign key (closed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint accounting_periods_dates_check check (period_end >= period_start),
      constraint accounting_periods_status_check check (status in ('open', 'closed')),
      constraint accounting_periods_close_check check (
        (status = 'open' and closed_by_account_id is null and closed_at is null)
        or (status = 'closed' and closed_by_account_id is not null and closed_at is not null)
      )
    );

    create table chart_of_accounts (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      parent_account_id uuid,
      code text not null,
      name_en text not null,
      name_ar text,
      account_type text not null,
      is_posting_account boolean not null default true,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      constraint chart_of_accounts_parent_fk foreign key (parent_account_id, company_id)
        references chart_of_accounts(id, company_id) on delete restrict,
      constraint chart_of_accounts_type_check check (account_type in ('asset', 'liability', 'equity', 'revenue', 'expense')),
      constraint chart_of_accounts_version_positive check (version > 0)
    );
    create unique index chart_of_accounts_code_unique on chart_of_accounts (company_id, lower(code));

    alter table company_bank_accounts add column gl_account_id uuid;
    alter table company_bank_accounts add constraint company_bank_accounts_gl_fk
      foreign key (gl_account_id, company_id) references chart_of_accounts(id, company_id) on delete restrict;

    create table journal_entries (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      journal_number text not null,
      accounting_period_id uuid not null,
      business_date date not null,
      source_type text not null,
      source_id uuid,
      description text not null,
      status text not null default 'draft',
      reversal_of_id uuid,
      created_by_account_id uuid not null,
      posted_by_account_id uuid,
      posted_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, journal_number),
      constraint journal_entries_period_fk foreign key (accounting_period_id, company_id)
        references accounting_periods(id, company_id) on delete restrict,
      constraint journal_entries_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint journal_entries_poster_fk foreign key (posted_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint journal_entries_reversal_fk foreign key (reversal_of_id, company_id)
        references journal_entries(id, company_id) on delete restrict,
      constraint journal_entries_source_check check (source_type in ('manual', 'order', 'reconciliation', 'settlement', 'expense', 'payroll', 'reversal')),
      constraint journal_entries_status_check check (status in ('draft', 'posted')),
      constraint journal_entries_posting_check check (
        (status = 'draft' and posted_by_account_id is null and posted_at is null)
        or (status = 'posted' and posted_by_account_id is not null and posted_at is not null)
      ),
      constraint journal_entries_reversal_self_check check (reversal_of_id is null or reversal_of_id <> id)
    );
    create index journal_entries_company_date_index on journal_entries (company_id, business_date desc);
    create index journal_entries_source_index on journal_entries (company_id, source_type, source_id);

    create table journal_lines (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      journal_entry_id uuid not null,
      account_id uuid not null,
      description text,
      debit numeric(18,2) not null default 0,
      credit numeric(18,2) not null default 0,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      constraint journal_lines_entry_fk foreign key (journal_entry_id, company_id)
        references journal_entries(id, company_id) on delete restrict,
      constraint journal_lines_account_fk foreign key (account_id, company_id)
        references chart_of_accounts(id, company_id) on delete restrict,
      constraint journal_lines_amount_check check (
        debit >= 0 and credit >= 0 and ((debit > 0 and credit = 0) or (credit > 0 and debit = 0))
      )
    );
    create index journal_lines_entry_index on journal_lines (company_id, journal_entry_id);
    create index journal_lines_account_index on journal_lines (company_id, account_id);

    create function reject_finalized_financial_mutation() returns trigger language plpgsql as $$
    begin
      if old.status in ('confirmed', 'posted') then
        raise exception 'confirmed or posted financial records are immutable; create a linked reversal or adjustment';
      end if;
      if tg_op = 'DELETE' then
        return old;
      end if;
      return new;
    end;
    $$;

    create trigger order_expenses_immutable before update or delete on order_expenses
      for each row execute function reject_finalized_financial_mutation();
    create trigger operating_expenses_immutable before update or delete on operating_expenses
      for each row execute function reject_finalized_financial_mutation();
    create trigger driver_reconciliations_immutable before update or delete on driver_reconciliations
      for each row execute function reject_finalized_financial_mutation();
    create trigger trader_settlements_immutable before update or delete on trader_settlements
      for each row execute function reject_finalized_financial_mutation();
    create trigger payroll_entries_immutable before update or delete on payroll_entries
      for each row execute function reject_finalized_financial_mutation();
    create trigger journal_entries_immutable before update or delete on journal_entries
      for each row execute function reject_finalized_financial_mutation();

    create function validate_posted_journal_balance() returns trigger language plpgsql as $$
    declare
      total_debit numeric(18,2);
      total_credit numeric(18,2);
      line_count integer;
    begin
      if new.status = 'posted' and old.status = 'draft' then
        select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
          into total_debit, total_credit, line_count
          from journal_lines
          where company_id = new.company_id and journal_entry_id = new.id;
        if line_count < 2 or total_debit <= 0 or total_debit <> total_credit then
          raise exception 'posted journal must contain at least two balanced non-zero lines';
        end if;
        if exists (
          select 1 from accounting_periods
          where id = new.accounting_period_id and company_id = new.company_id and status = 'closed'
        ) then
          raise exception 'cannot post a journal into a closed accounting period';
        end if;
      end if;
      return new;
    end;
    $$;

    create trigger journal_entries_balance_before_post
      before update of status on journal_entries
      for each row execute function validate_posted_journal_balance();

    create function reject_posted_journal_line_mutation() returns trigger language plpgsql as $$
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
      if tg_op = 'DELETE' then
        return old;
      end if;
      return new;
    end;
    $$;

    create trigger journal_lines_immutable_when_posted
      before insert or update or delete on journal_lines
      for each row execute function reject_posted_journal_line_mutation();
  `.execute(database);
}
