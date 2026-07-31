import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Accounting Prompt 4.
 *
 * `operating_expenses` is intentionally left unchanged. It is an earlier
 * single-value operational record and cannot safely represent VAT line
 * snapshots, approval/payable recognition, or partial payment history.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table general_expense_categories (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      code text not null,
      name_en text not null,
      name_ar text,
      description text,
      default_expense_mapping_key text not null default 'general_expense',
      default_vat_treatment text not null default 'out_of_scope',
      is_active boolean not null default true,
      effective_from date not null,
      effective_to date,
      created_by_account_id uuid not null,
      deactivated_by_account_id uuid,
      deactivated_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      constraint general_expense_categories_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint general_expense_categories_deactivator_fk
        foreign key (deactivated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint general_expense_categories_code_check
        check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
      constraint general_expense_categories_name_check
        check (btrim(name_en) <> ''),
      constraint general_expense_categories_mapping_check
        check (btrim(default_expense_mapping_key) <> ''),
      constraint general_expense_categories_vat_check check (
        default_vat_treatment in (
          'standard_rated','zero_rated','exempt','out_of_scope',
          'non_recoverable','partially_recoverable'
        )
      ),
      constraint general_expense_categories_dates_check
        check (effective_to is null or effective_to >= effective_from),
      constraint general_expense_categories_deactivation_check check (
        (is_active and deactivated_by_account_id is null and deactivated_at is null)
        or
        (not is_active and deactivated_by_account_id is not null and deactivated_at is not null)
      ),
      constraint general_expense_categories_version_check check (version > 0)
    );
    create unique index general_expense_categories_code_unique
      on general_expense_categories (company_id, upper(code));
    create index general_expense_categories_active_index
      on general_expense_categories (company_id, is_active, effective_from, effective_to);

    create table general_expenses (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      expense_number text not null,
      expense_date date,
      accounting_date date,
      category_id uuid,
      category_code_snapshot text,
      category_name_en_snapshot text,
      category_name_ar_snapshot text,
      payee_type text,
      payee_id uuid,
      payee_name_snapshot text,
      payee_contact_snapshot text,
      description text,
      reference_number text,
      external_reference text,
      vat_registration_number text,
      tax_invoice_number text,
      tax_invoice_date date,
      currency char(3) not null default 'AED',
      subtotal numeric(18,2) not null default 0,
      vat_amount numeric(18,2) not null default 0,
      recoverable_vat_amount numeric(18,2) not null default 0,
      nonrecoverable_vat_amount numeric(18,2) not null default 0,
      total_amount numeric(18,2) not null default 0,
      approved_amount numeric(18,2) not null default 0,
      paid_amount numeric(18,2) not null default 0,
      outstanding_amount numeric(18,2) not null default 0,
      status text not null default 'draft',
      payment_status text not null default 'unpaid',
      notes text,
      source_type text not null default 'manual_general_expense',
      source_entity_type text,
      source_entity_id uuid,
      correlation_id uuid not null default gen_random_uuid(),
      created_by_account_id uuid not null,
      updated_by_account_id uuid not null,
      submitted_by_account_id uuid,
      submitted_at timestamptz,
      approved_by_account_id uuid,
      approved_at timestamptz,
      rejected_by_account_id uuid,
      rejected_at timestamptz,
      rejection_reason text,
      cancelled_by_account_id uuid,
      cancelled_at timestamptz,
      cancellation_reason text,
      reversed_by_account_id uuid,
      reversed_at timestamptz,
      reversal_reason text,
      fully_paid_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      unique (company_id, expense_number),
      constraint general_expenses_category_fk
        foreign key (category_id, company_id)
        references general_expense_categories(id, company_id) on delete restrict,
      constraint general_expenses_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint general_expenses_updater_fk
        foreign key (updated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint general_expenses_submitter_fk
        foreign key (submitted_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint general_expenses_approver_fk
        foreign key (approved_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint general_expenses_rejector_fk
        foreign key (rejected_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint general_expenses_canceller_fk
        foreign key (cancelled_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint general_expenses_reverser_fk
        foreign key (reversed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint general_expenses_currency_check check (currency = 'AED'),
      constraint general_expenses_status_check check (
        status in (
          'draft','submitted','approved','partially_paid','paid',
          'rejected','cancelled','reversed'
        )
      ),
      constraint general_expenses_payment_status_check
        check (payment_status in ('unpaid','partially_paid','paid','reversed')),
      constraint general_expenses_source_check check (
        source_type in (
          'manual_general_expense','driver_collection_expense',
          'employee_reimbursement','bank_charge','system_generated'
        )
      ),
      constraint general_expenses_payee_check check (
        payee_type is null or payee_type in (
          'supplier','employee','driver','trader','government',
          'landlord','service_provider','other'
        )
      ),
      constraint general_expenses_amounts_check check (
        subtotal >= 0 and vat_amount >= 0
        and recoverable_vat_amount >= 0 and nonrecoverable_vat_amount >= 0
        and total_amount >= 0 and approved_amount >= 0
        and paid_amount >= 0 and outstanding_amount >= 0
        and recoverable_vat_amount + nonrecoverable_vat_amount = vat_amount
        and subtotal + vat_amount = total_amount
        and paid_amount <= approved_amount
        and outstanding_amount = approved_amount - paid_amount
      ),
      constraint general_expenses_lifecycle_shape_check check (
        (status <> 'submitted' or (submitted_by_account_id is not null and submitted_at is not null))
        and
        (status not in ('approved','partially_paid','paid','reversed')
          or (approved_by_account_id is not null and approved_at is not null and approved_amount > 0))
        and
        (status <> 'rejected'
          or (rejected_by_account_id is not null and rejected_at is not null
              and btrim(coalesce(rejection_reason,'')) <> ''))
        and
        (status <> 'cancelled'
          or (cancelled_by_account_id is not null and cancelled_at is not null
              and btrim(coalesce(cancellation_reason,'')) <> ''))
        and
        (status <> 'reversed'
          or (reversed_by_account_id is not null and reversed_at is not null
              and btrim(coalesce(reversal_reason,'')) <> ''))
      ),
      constraint general_expenses_version_check check (version > 0)
    );
    create unique index general_expenses_source_unique
      on general_expenses (company_id, source_type, source_entity_type, source_entity_id)
      where source_entity_id is not null and status <> 'cancelled';
    create index general_expenses_status_index
      on general_expenses (company_id, status, expense_date desc);
    create index general_expenses_payment_status_index
      on general_expenses (company_id, payment_status, accounting_date desc);
    create index general_expenses_category_index
      on general_expenses (company_id, category_id, expense_date desc);
    create index general_expenses_payee_index
      on general_expenses (company_id, payee_type, payee_id, expense_date desc);

    create table general_expense_lines (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      general_expense_id uuid not null,
      line_number integer not null,
      category_id uuid not null,
      category_code_snapshot text not null,
      category_name_en_snapshot text not null,
      category_name_ar_snapshot text,
      description text not null,
      quantity numeric(18,4) not null,
      unit_amount numeric(18,4) not null,
      net_amount numeric(18,2) not null,
      vat_treatment text not null,
      vat_rate numeric(8,4) not null default 0,
      vat_amount numeric(18,2) not null default 0,
      recoverable_vat_amount numeric(18,2) not null default 0,
      nonrecoverable_vat_amount numeric(18,2) not null default 0,
      gross_amount numeric(18,2) not null,
      expense_cost_amount numeric(18,2) not null,
      expense_account_mapping_key text not null,
      vat_account_mapping_key text not null default 'input_vat',
      trader_id uuid,
      driver_id uuid,
      employee_id uuid,
      order_id uuid,
      created_by_account_id uuid not null,
      updated_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      unique (general_expense_id, line_number),
      constraint general_expense_lines_header_fk
        foreign key (general_expense_id, company_id)
        references general_expenses(id, company_id) on delete restrict,
      constraint general_expense_lines_category_fk
        foreign key (category_id, company_id)
        references general_expense_categories(id, company_id) on delete restrict,
      constraint general_expense_lines_trader_fk
        foreign key (trader_id, company_id)
        references traders(id, company_id) on delete restrict,
      constraint general_expense_lines_driver_fk
        foreign key (driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint general_expense_lines_employee_fk
        foreign key (employee_id, company_id)
        references employees(id, company_id) on delete restrict,
      constraint general_expense_lines_order_fk
        foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint general_expense_lines_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint general_expense_lines_updater_fk
        foreign key (updated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint general_expense_lines_values_check check (
        line_number > 0 and quantity > 0 and unit_amount >= 0
        and net_amount > 0 and vat_rate >= 0 and vat_rate <= 100
        and vat_amount >= 0 and gross_amount > 0
        and recoverable_vat_amount >= 0 and nonrecoverable_vat_amount >= 0
        and recoverable_vat_amount + nonrecoverable_vat_amount = vat_amount
        and gross_amount = net_amount + vat_amount
        and expense_cost_amount = net_amount + nonrecoverable_vat_amount
      ),
      constraint general_expense_lines_vat_check check (
        vat_treatment in (
          'standard_rated','zero_rated','exempt','out_of_scope',
          'non_recoverable','partially_recoverable'
        )
      ),
      constraint general_expense_lines_mapping_check check (
        btrim(expense_account_mapping_key) <> ''
        and btrim(vat_account_mapping_key) <> ''
      ),
      constraint general_expense_lines_version_check check (version > 0)
    );
    create index general_expense_lines_header_index
      on general_expense_lines (company_id, general_expense_id, line_number);

    create table general_expense_payments (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      payment_number text not null,
      general_expense_id uuid not null,
      payment_date date not null,
      accounting_date date not null,
      amount numeric(18,2) not null,
      cash_amount numeric(18,2) not null default 0,
      visa_amount numeric(18,2) not null default 0,
      currency char(3) not null default 'AED',
      status text not null default 'confirmed',
      reference_number text,
      notes text,
      correlation_id uuid not null default gen_random_uuid(),
      confirmed_by_account_id uuid not null,
      confirmed_at timestamptz not null default now(),
      reversed_by_account_id uuid,
      reversed_at timestamptz,
      reversal_reason text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      unique (company_id, payment_number),
      constraint general_expense_payments_header_fk
        foreign key (general_expense_id, company_id)
        references general_expenses(id, company_id) on delete restrict,
      constraint general_expense_payments_confirmer_fk
        foreign key (confirmed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint general_expense_payments_reverser_fk
        foreign key (reversed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint general_expense_payments_currency_check check (currency = 'AED'),
      constraint general_expense_payments_status_check
        check (status in ('confirmed','reversed')),
      constraint general_expense_payments_amount_check check (
        amount > 0 and cash_amount >= 0 and visa_amount >= 0
        and amount = cash_amount + visa_amount
      ),
      constraint general_expense_payments_reversal_check check (
        (status = 'confirmed'
          and reversed_by_account_id is null and reversed_at is null and reversal_reason is null)
        or
        (status = 'reversed'
          and reversed_by_account_id is not null and reversed_at is not null
          and btrim(coalesce(reversal_reason,'')) <> '')
      ),
      constraint general_expense_payments_version_check check (version > 0)
    );
    create index general_expense_payments_header_index
      on general_expense_payments (company_id, general_expense_id, payment_date);
    create index general_expense_payments_status_index
      on general_expense_payments (company_id, status, accounting_date desc);

    create table general_expense_payment_rows (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      general_expense_payment_id uuid not null,
      row_number integer not null,
      payment_method text not null,
      amount numeric(18,2) not null,
      cash_account_id uuid,
      company_bank_account_id uuid,
      reference_number text,
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (general_expense_payment_id, row_number),
      constraint general_expense_payment_rows_payment_fk
        foreign key (general_expense_payment_id, company_id)
        references general_expense_payments(id, company_id) on delete restrict,
      constraint general_expense_payment_rows_cash_account_fk
        foreign key (cash_account_id, company_id)
        references chart_of_accounts(id, company_id) on delete restrict,
      constraint general_expense_payment_rows_bank_fk
        foreign key (company_bank_account_id, company_id)
        references company_bank_accounts(id, company_id) on delete restrict,
      constraint general_expense_payment_rows_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint general_expense_payment_rows_number_check check (row_number > 0),
      constraint general_expense_payment_rows_method_check
        check (payment_method in ('cash','visa')),
      constraint general_expense_payment_rows_amount_check check (amount > 0),
      constraint general_expense_payment_rows_destination_check check (
        (payment_method = 'cash' and cash_account_id is not null
          and company_bank_account_id is null)
        or
        (payment_method = 'visa' and company_bank_account_id is not null
          and cash_account_id is null)
      )
    );
    create index general_expense_payment_rows_payment_index
      on general_expense_payment_rows
      (company_id, general_expense_payment_id, row_number);

    create table general_expense_attachments (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      general_expense_id uuid not null,
      general_expense_payment_id uuid,
      file_object_id uuid not null,
      attachment_type text not null,
      file_name_snapshot text not null,
      media_type_snapshot text not null,
      size_bytes_snapshot bigint not null,
      description text,
      is_active boolean not null default true,
      uploaded_by_account_id uuid not null,
      deactivated_by_account_id uuid,
      deactivated_at timestamptz,
      uploaded_at timestamptz not null default now(),
      unique (id, company_id),
      constraint general_expense_attachments_header_fk
        foreign key (general_expense_id, company_id)
        references general_expenses(id, company_id) on delete restrict,
      constraint general_expense_attachments_payment_fk
        foreign key (general_expense_payment_id, company_id)
        references general_expense_payments(id, company_id) on delete restrict,
      constraint general_expense_attachments_file_fk
        foreign key (file_object_id, company_id)
        references file_objects(id, company_id) on delete restrict,
      constraint general_expense_attachments_uploader_fk
        foreign key (uploaded_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint general_expense_attachments_deactivator_fk
        foreign key (deactivated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint general_expense_attachments_type_check check (
        attachment_type in (
          'invoice','receipt','tax_invoice','quotation','approval',
          'payment_evidence','contract','other'
        )
      ),
      constraint general_expense_attachments_active_check check (
        (is_active and deactivated_by_account_id is null and deactivated_at is null)
        or
        (not is_active and deactivated_by_account_id is not null and deactivated_at is not null)
      )
    );
    create unique index general_expense_attachments_active_unique
      on general_expense_attachments
      (company_id, general_expense_id, file_object_id, coalesce(general_expense_payment_id, '00000000-0000-0000-0000-000000000000'::uuid))
      where is_active;
    create index general_expense_attachments_header_index
      on general_expense_attachments (company_id, general_expense_id, is_active);

    alter table accounting_configurations
      drop constraint accounting_configurations_automatic_areas_check,
      add constraint accounting_configurations_automatic_areas_check check (
        automatic_posting_areas <@ array[
          'orders','trader_receivables','trader_settlements',
          'driver_collections','driver_expenses','employee_payroll',
          'outsourced_driver_fees','general_expenses'
        ]::text[]
      );

    alter table accounting_events
      drop constraint accounting_events_type_check,
      drop constraint accounting_events_operational_area_check,
      add constraint accounting_events_type_check check (
        event_type in (
          'order_delivered','order_recognition_reversed',
          'trader_receivable_recognized','trader_receivable_reversed',
          'trader_receivable_payment_received','trader_receivable_payment_reversed',
          'trader_settlement_confirmed','trader_settlement_reversed',
          'driver_collection_confirmed','driver_collection_reversed',
          'driver_expense_confirmed','employee_payroll_approved',
          'employee_payroll_reversed','employee_payroll_paid',
          'employee_payroll_payment_reversed',
          'outsourced_driver_fee_accrued','outsourced_driver_fee_accrual_reversed',
          'outsourced_driver_fee_paid','outsourced_driver_fee_payment_reversed',
          'general_expense_approved','general_expense_payment_completed',
          'general_expense_reversed','general_expense_payment_reversed',
          'bank_transfer_confirmed','bank_transfer_reversed'
        )
      ),
      add constraint accounting_events_operational_area_check check (
        operational_area is null or operational_area in (
          'orders','trader_receivables','trader_settlements',
          'driver_collections','driver_expenses','employee_payroll',
          'outsourced_driver_fees','general_expenses'
        )
      );

    alter table accounting_event_components
      drop constraint accounting_event_components_type_check,
      add constraint accounting_event_components_type_check check (
        component_type in (
          'cod_receivable','delivery_revenue','service_fee_revenue',
          'additional_fee_revenue','output_vat','trader_payable',
          'trader_settlement','driver_collection_cash','driver_expense',
          'payroll_expense','payroll_payable','payroll_cash_payment',
          'outsourced_driver_fee_expense','outsourced_driver_payable',
          'outsourced_driver_payment','general_expense','input_vat',
          'general_expense_payable','general_expense_payment',
          'cash_transfer','bank_transfer'
        )
      );

    alter table account_mappings
      drop constraint account_mappings_key_check,
      add constraint account_mappings_key_check check (
        mapping_key in (
          'order_cod_receivable','delivery_revenue','service_fee_revenue',
          'additional_fee_revenue','output_vat','trader_payable',
          'trader_settlement_cash','trader_settlement_bank',
          'driver_collection_cash','driver_collection_fee_offset','driver_expense',
          'employee_payroll_expense','employee_payroll_payable',
          'employee_payroll_cash_payment','outsourced_driver_fee_expense',
          'outsourced_driver_payable','outsourced_driver_cash_payment',
          'general_expense','input_vat','general_expense_payable',
          'general_expense_cash_payment','general_expense_bank_payment',
          'cash_transfer','bank_transfer'
        )
      );

    alter table chart_of_accounts
      drop constraint chart_of_accounts_control_check,
      add constraint chart_of_accounts_control_check check (
        (not is_control_account and control_account_type is null)
        or (
          is_control_account and is_posting_account
          and control_account_type in (
            'trader_payable','driver_payable','payroll_payable',
            'accounts_payable','accounts_receivable','vat'
          )
        )
      );

    create function validate_general_expense_account_mapping()
      returns trigger language plpgsql as $$
    begin
      if new.mapping_key = 'general_expense_payable'
         and not exists (
           select 1 from chart_of_accounts
            where id = coalesce(new.payable_account_id,new.credit_account_id,new.debit_account_id)
              and company_id = new.company_id
              and account_type = 'liability' and account_class = 'accounts_payable'
              and is_control_account and control_account_type = 'accounts_payable'
              and is_active and is_posting_account
         ) then
        raise exception using errcode = '23514',
          message = 'accounting_mapping_account_incompatible';
      end if;
      if new.mapping_key = 'general_expense_cash_payment'
         and not exists (
           select 1 from chart_of_accounts
            where id in (new.debit_account_id,new.credit_account_id)
              and company_id = new.company_id
              and account_type = 'asset' and account_class = 'cash'
              and is_active and is_posting_account
         ) then
        raise exception using errcode = '23514',
          message = 'accounting_mapping_account_incompatible';
      end if;
      if new.mapping_key = 'general_expense_bank_payment'
         and not exists (
           select 1 from chart_of_accounts
            where id in (new.debit_account_id,new.credit_account_id)
              and company_id = new.company_id
              and account_type = 'asset' and account_class = 'bank'
              and is_active and is_posting_account
         ) then
        raise exception using errcode = '23514',
          message = 'accounting_mapping_account_incompatible';
      end if;
      return new;
    end;
    $$;
    create trigger account_mappings_general_expense_guard
      before insert or update on account_mappings
      for each row execute function validate_general_expense_account_mapping();

    alter table journal_lines
      add column general_expense_payment_id uuid,
      add constraint journal_lines_general_expense_fk
        foreign key (general_expense_id, company_id)
        references general_expenses(id, company_id) on delete restrict,
      add constraint journal_lines_general_expense_payment_fk
        foreign key (general_expense_payment_id, company_id)
        references general_expense_payments(id, company_id) on delete restrict;
    create index journal_lines_general_expense_index
      on journal_lines (company_id, general_expense_id);
    create index journal_lines_general_expense_payment_index
      on journal_lines (company_id, general_expense_payment_id);

    create or replace function validate_accounting_journal_line()
      returns trigger language plpgsql as $$
    declare
      entry_company uuid;
      account_posting boolean;
      account_active boolean;
      account_control boolean;
      account_control_type text;
    begin
      select company_id into entry_company
        from journal_entries
       where id = new.journal_entry_id and company_id = new.company_id;
      if entry_company is null then
        raise exception using errcode = '23503',
          message = 'accounting_journal_company_mismatch';
      end if;
      select is_posting_account,is_active,is_control_account,control_account_type
        into account_posting,account_active,account_control,account_control_type
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
          account_control_type = 'accounts_payable'
          and new.general_expense_id is null
          and new.general_expense_payment_id is null
          and new.subledger_id is null
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

    create or replace function guard_general_expense_financial_history()
      returns trigger language plpgsql as $$
    declare
      expense_status text;
    begin
      if tg_table_name = 'general_expense_lines' then
        select status into expense_status
          from general_expenses
         where id = old.general_expense_id and company_id = old.company_id;
        if expense_status not in ('draft','rejected') then
          raise exception using errcode = '23514',
            message = 'accounting_general_expense_lines_immutable';
        end if;
      elsif tg_table_name in ('general_expense_payments','general_expense_payment_rows') then
        if tg_op = 'DELETE' then
          raise exception using errcode = '23514',
            message = 'accounting_general_expense_payment_history_immutable';
        end if;
      end if;
      if tg_op = 'DELETE' then
        return old;
      end if;
      return new;
    end;
    $$;
    create trigger general_expense_lines_immutable
      before update or delete on general_expense_lines
      for each row execute function guard_general_expense_financial_history();
    create trigger general_expense_payments_immutable
      before delete on general_expense_payments
      for each row execute function guard_general_expense_financial_history();
    create trigger general_expense_payment_rows_immutable
      before update or delete on general_expense_payment_rows
      for each row execute function guard_general_expense_financial_history();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists account_mappings_general_expense_guard on account_mappings;
    drop function if exists validate_general_expense_account_mapping();
    drop trigger if exists general_expense_payment_rows_immutable
      on general_expense_payment_rows;
    drop trigger if exists general_expense_payments_immutable
      on general_expense_payments;
    drop trigger if exists general_expense_lines_immutable
      on general_expense_lines;
    drop function if exists guard_general_expense_financial_history();
    alter table journal_lines
      drop constraint if exists journal_lines_general_expense_payment_fk,
      drop constraint if exists journal_lines_general_expense_fk,
      drop column if exists general_expense_payment_id;
    create or replace function validate_accounting_journal_line()
      returns trigger language plpgsql as $$
    declare
      entry_company uuid;
      account_posting boolean;
      account_active boolean;
      account_control boolean;
      account_control_type text;
    begin
      select company_id into entry_company
        from journal_entries
       where id = new.journal_entry_id and company_id = new.company_id;
      if entry_company is null then
        raise exception using errcode = '23503',
          message = 'accounting_journal_company_mismatch';
      end if;
      select is_posting_account,is_active,is_control_account,control_account_type
        into account_posting,account_active,account_control,account_control_type
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
    drop table if exists general_expense_attachments;
    drop table if exists general_expense_payment_rows;
    drop table if exists general_expense_payments;
    drop table if exists general_expense_lines;
    drop table if exists general_expenses;
    drop table if exists general_expense_categories;
  `.execute(database);
}
