import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Accounting Prompt 5: Company Cash/Bank masters and immutable operational
 * movement foundations. Existing Company Bank Accounts are extended in place;
 * Trader beneficiary accounts remain separate.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table company_reference_counters
      drop constraint company_reference_counters_type_check,
      add constraint company_reference_counters_type_check check(reference_type in(
        'order','payment','reconciliation','settlement','journal','payroll','import',
        'trader','area','customer','driver','employee','trader_receivable',
        'trader_collection','payroll_payment','outsourced_driver_fee_payment',
        'accounting_opening_balance','cash_bank_movement'
      ));

    alter table company_bank_accounts
      add column bank_account_code text,
      add column branch_name text,
      add column account_number text,
      add column account_type text not null default 'current',
      add column linked_gl_account_id uuid,
      add column effective_from date not null default current_date,
      add column effective_to date,
      add column description text,
      add column created_by_account_id uuid,
      add column updated_by_account_id uuid,
      add column deactivated_by_account_id uuid,
      add column deactivated_at timestamptz;
    with numbered as (
      select id, row_number() over (partition by company_id order by created_at,id) as sequence
        from company_bank_accounts
    )
    update company_bank_accounts b
       set bank_account_code='BANK-'||lpad(numbered.sequence::text,4,'0')
      from numbered where numbered.id=b.id;
    alter table company_bank_accounts
      alter column bank_account_code set not null,
      add constraint company_bank_accounts_code_unique unique (company_id,bank_account_code),
      add constraint company_bank_accounts_type_check
        check (account_type in ('current','savings','merchant','settlement','other')),
      add constraint company_bank_accounts_dates_check
        check (effective_to is null or effective_to>=effective_from),
      add constraint company_bank_accounts_linked_gl_fk
        foreign key (linked_gl_account_id,company_id)
        references chart_of_accounts(id,company_id) on delete restrict,
      add constraint company_bank_accounts_creator_fk
        foreign key (created_by_account_id,company_id)
        references accounts(id,company_id) on delete restrict,
      add constraint company_bank_accounts_updater_fk
        foreign key (updated_by_account_id,company_id)
        references accounts(id,company_id) on delete restrict,
      add constraint company_bank_accounts_deactivator_fk
        foreign key (deactivated_by_account_id,company_id)
        references accounts(id,company_id) on delete restrict;
    create index company_bank_accounts_active_index
      on company_bank_accounts(company_id,is_active,bank_account_code);

    create table company_cash_accounts (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      cash_account_code text not null,
      cash_account_name text not null,
      cash_account_name_ar text,
      cash_account_type text not null,
      branch_id uuid,
      location_or_custodian text,
      linked_gl_account_id uuid not null,
      currency text not null default 'AED',
      effective_from date not null,
      effective_to date,
      description text,
      is_active boolean not null default true,
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      updated_by_account_id uuid,
      updated_at timestamptz not null default now(),
      deactivated_by_account_id uuid,
      deactivated_at timestamptz,
      version bigint not null default 1,
      unique(id,company_id),
      constraint company_cash_accounts_code_unique unique(company_id,cash_account_code),
      constraint company_cash_accounts_type_check check (
        cash_account_type in ('main_cash','branch_cash','petty_cash','cash_drawer','safe','other')
      ),
      constraint company_cash_accounts_currency_check check(currency='AED'),
      constraint company_cash_accounts_dates_check
        check(effective_to is null or effective_to>=effective_from),
      constraint company_cash_accounts_version_check check(version>0),
      constraint company_cash_accounts_gl_fk
        foreign key(linked_gl_account_id,company_id)
        references chart_of_accounts(id,company_id) on delete restrict,
      constraint company_cash_accounts_creator_fk
        foreign key(created_by_account_id,company_id)
        references accounts(id,company_id) on delete restrict,
      constraint company_cash_accounts_updater_fk
        foreign key(updated_by_account_id,company_id)
        references accounts(id,company_id) on delete restrict,
      constraint company_cash_accounts_deactivator_fk
        foreign key(deactivated_by_account_id,company_id)
        references accounts(id,company_id) on delete restrict
    );
    create index company_cash_accounts_active_index
      on company_cash_accounts(company_id,is_active,cash_account_code);

    create function validate_company_financial_account()
      returns trigger language plpgsql as $$
    declare
      gl_type text;
      gl_class text;
      gl_active boolean;
      gl_posting boolean;
    begin
      select account_type,account_class,is_active,is_posting_account
        into gl_type,gl_class,gl_active,gl_posting
        from chart_of_accounts
       where id=new.linked_gl_account_id and company_id=new.company_id;
      if new.linked_gl_account_id is not null and gl_type is null then
        raise exception using errcode='23503',
          message='accounting_cash_bank_linked_gl_cross_company';
      end if;
      if new.linked_gl_account_id is not null and (
        gl_type<>'asset' or not gl_active or not gl_posting
        or (tg_table_name='company_cash_accounts' and gl_class<>'cash')
        or (tg_table_name='company_bank_accounts' and gl_class<>'bank')
      ) then
        raise exception using errcode='23514',
          message='accounting_cash_bank_linked_gl_invalid';
      end if;
      return new;
    end;
    $$;
    create trigger company_cash_accounts_gl_guard
      before insert or update on company_cash_accounts
      for each row execute function validate_company_financial_account();
    create trigger company_bank_accounts_gl_guard
      before insert or update on company_bank_accounts
      for each row execute function validate_company_financial_account();

    create table cash_bank_movements (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      movement_number text not null,
      movement_type text not null,
      movement_date date not null,
      accounting_date date not null,
      source_cash_account_id uuid,
      source_bank_account_id uuid,
      destination_cash_account_id uuid,
      destination_bank_account_id uuid,
      amount numeric(18,2) not null,
      fee_amount numeric(18,2) not null default 0,
      fee_description text,
      payment_method text not null,
      source_classification text,
      destination_classification text,
      classification_mapping_key text,
      reference_number text,
      external_reference text,
      description text,
      currency text not null default 'AED',
      status text not null default 'draft',
      correlation_id text not null,
      idempotency_identity text not null,
      reversal_of_movement_id uuid,
      reversed_by_movement_id uuid,
      original_snapshot jsonb,
      accounting_event_id uuid,
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      updated_by_account_id uuid,
      updated_at timestamptz not null default now(),
      confirmed_by_account_id uuid,
      confirmed_at timestamptz,
      confirmation_note text,
      cancelled_by_account_id uuid,
      cancelled_at timestamptz,
      cancellation_reason text,
      reversed_by_account_id uuid,
      reversed_at timestamptz,
      reversal_reason text,
      version bigint not null default 1,
      unique(id,company_id),
      constraint cash_bank_movements_number_unique unique(company_id,movement_number),
      constraint cash_bank_movements_idempotency_unique unique(company_id,idempotency_identity),
      constraint cash_bank_movements_type_check check(movement_type in (
        'cash_deposit','cash_withdrawal','bank_deposit','bank_withdrawal',
        'cash_to_bank_transfer','bank_to_cash_transfer',
        'bank_to_bank_transfer','cash_to_cash_transfer','opening_balance'
      )),
      constraint cash_bank_movements_status_check
        check(status in ('draft','confirmed','cancelled','reversed')),
      constraint cash_bank_movements_payment_method_check
        check(payment_method in ('cash','visa','internal_transfer')),
      constraint cash_bank_movements_currency_check check(currency='AED'),
      constraint cash_bank_movements_amount_check check(amount>0 and fee_amount>=0),
      constraint cash_bank_movements_version_check check(version>0),
      constraint cash_bank_movements_source_cash_fk
        foreign key(source_cash_account_id,company_id)
        references company_cash_accounts(id,company_id) on delete restrict,
      constraint cash_bank_movements_source_bank_fk
        foreign key(source_bank_account_id,company_id)
        references company_bank_accounts(id,company_id) on delete restrict,
      constraint cash_bank_movements_destination_cash_fk
        foreign key(destination_cash_account_id,company_id)
        references company_cash_accounts(id,company_id) on delete restrict,
      constraint cash_bank_movements_destination_bank_fk
        foreign key(destination_bank_account_id,company_id)
        references company_bank_accounts(id,company_id) on delete restrict,
      constraint cash_bank_movements_reversal_fk
        foreign key(reversal_of_movement_id,company_id)
        references cash_bank_movements(id,company_id) on delete restrict,
      constraint cash_bank_movements_reversed_by_fk
        foreign key(reversed_by_movement_id,company_id)
        references cash_bank_movements(id,company_id) on delete restrict,
      constraint cash_bank_movements_event_fk
        foreign key(accounting_event_id,company_id)
        references accounting_events(id,company_id) on delete restrict,
      constraint cash_bank_movements_creator_fk
        foreign key(created_by_account_id,company_id)
        references accounts(id,company_id) on delete restrict,
      constraint cash_bank_movements_updater_fk
        foreign key(updated_by_account_id,company_id)
        references accounts(id,company_id) on delete restrict,
      constraint cash_bank_movements_confirmer_fk
        foreign key(confirmed_by_account_id,company_id)
        references accounts(id,company_id) on delete restrict,
      constraint cash_bank_movements_canceller_fk
        foreign key(cancelled_by_account_id,company_id)
        references accounts(id,company_id) on delete restrict,
      constraint cash_bank_movements_reverser_fk
        foreign key(reversed_by_account_id,company_id)
        references accounts(id,company_id) on delete restrict,
      constraint cash_bank_movements_reversal_self_check
        check(reversal_of_movement_id is null or reversal_of_movement_id<>id),
      constraint cash_bank_movements_structure_check check(
        status in('draft','cancelled') or (
        (movement_type='cash_deposit' and destination_cash_account_id is not null
          and num_nonnulls(source_cash_account_id,source_bank_account_id,destination_bank_account_id)=0)
        or (movement_type='cash_withdrawal' and source_cash_account_id is not null
          and num_nonnulls(source_bank_account_id,destination_cash_account_id,destination_bank_account_id)=0)
        or (movement_type='bank_deposit' and destination_bank_account_id is not null
          and num_nonnulls(source_cash_account_id,source_bank_account_id,destination_cash_account_id)=0)
        or (movement_type='bank_withdrawal' and source_bank_account_id is not null
          and num_nonnulls(source_cash_account_id,destination_cash_account_id,destination_bank_account_id)=0)
        or (movement_type='cash_to_bank_transfer' and source_cash_account_id is not null
          and destination_bank_account_id is not null
          and source_bank_account_id is null and destination_cash_account_id is null)
        or (movement_type='bank_to_cash_transfer' and source_bank_account_id is not null
          and destination_cash_account_id is not null
          and source_cash_account_id is null and destination_bank_account_id is null)
        or (movement_type='bank_to_bank_transfer' and source_bank_account_id is not null
          and destination_bank_account_id is not null
          and source_bank_account_id<>destination_bank_account_id
          and source_cash_account_id is null and destination_cash_account_id is null)
        or (movement_type='cash_to_cash_transfer' and source_cash_account_id is not null
          and destination_cash_account_id is not null
          and source_cash_account_id<>destination_cash_account_id
          and source_bank_account_id is null and destination_bank_account_id is null)
        or (movement_type='opening_balance'
          and num_nonnulls(destination_cash_account_id,destination_bank_account_id)=1
          and source_cash_account_id is null and source_bank_account_id is null))
      ),
      constraint cash_bank_movements_lifecycle_check check(
        (status='draft' and confirmed_at is null and cancelled_at is null)
        or (status='confirmed' and confirmed_by_account_id is not null and confirmed_at is not null)
        or (status='cancelled' and cancelled_by_account_id is not null
          and cancelled_at is not null and cancellation_reason is not null)
        or (status='reversed' and reversed_by_account_id is not null
          and reversed_at is not null and reversal_reason is not null
          and reversed_by_movement_id is not null)
      )
    );
    create unique index cash_bank_movements_reversal_unique
      on cash_bank_movements(company_id,reversal_of_movement_id)
      where reversal_of_movement_id is not null;
    create index cash_bank_movements_status_index
      on cash_bank_movements(company_id,status,accounting_date,id);
    create index cash_bank_movements_source_cash_index
      on cash_bank_movements(company_id,source_cash_account_id,accounting_date)
      where source_cash_account_id is not null;
    create index cash_bank_movements_source_bank_index
      on cash_bank_movements(company_id,source_bank_account_id,accounting_date)
      where source_bank_account_id is not null;
    create index cash_bank_movements_destination_cash_index
      on cash_bank_movements(company_id,destination_cash_account_id,accounting_date)
      where destination_cash_account_id is not null;
    create index cash_bank_movements_destination_bank_index
      on cash_bank_movements(company_id,destination_bank_account_id,accounting_date)
      where destination_bank_account_id is not null;

    create table cash_bank_movement_attachments (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      movement_id uuid not null,
      file_object_id uuid not null,
      attachment_type text not null,
      description text,
      file_name_snapshot text not null,
      content_type_snapshot text not null,
      size_bytes_snapshot bigint not null,
      is_active boolean not null default true,
      uploaded_by_account_id uuid not null,
      uploaded_at timestamptz not null default now(),
      deactivated_by_account_id uuid,
      deactivated_at timestamptz,
      unique(id,company_id),
      constraint cash_bank_movement_attachments_movement_fk
        foreign key(movement_id,company_id)
        references cash_bank_movements(id,company_id) on delete restrict,
      constraint cash_bank_movement_attachments_file_fk
        foreign key(file_object_id,company_id)
        references file_objects(id,company_id) on delete restrict,
      constraint cash_bank_movement_attachments_uploader_fk
        foreign key(uploaded_by_account_id,company_id)
        references accounts(id,company_id) on delete restrict,
      constraint cash_bank_movement_attachments_deactivator_fk
        foreign key(deactivated_by_account_id,company_id)
        references accounts(id,company_id) on delete restrict,
      constraint cash_bank_movement_attachments_type_check check(attachment_type in(
        'deposit_slip','withdrawal_slip','transfer_instruction','bank_confirmation',
        'cash_receipt','payment_proof','fee_evidence','approval','other'
      )),
      constraint cash_bank_movement_attachments_size_check check(size_bytes_snapshot>=0)
    );
    create unique index cash_bank_movement_attachments_active_unique
      on cash_bank_movement_attachments(company_id,movement_id,file_object_id)
      where is_active;
    create index cash_bank_movement_attachments_movement_index
      on cash_bank_movement_attachments(company_id,movement_id,is_active);

    create function protect_cash_bank_history() returns trigger language plpgsql as $$
    begin
      if tg_op='DELETE' then
        raise exception using errcode='23514',
          message='accounting_cash_bank_delete_prohibited';
      end if;
      if old.status in ('confirmed','reversed') and (
        new.company_id<>old.company_id
        or new.movement_number<>old.movement_number
        or new.movement_type<>old.movement_type
        or new.movement_date<>old.movement_date
        or new.accounting_date<>old.accounting_date
        or new.source_cash_account_id is distinct from old.source_cash_account_id
        or new.source_bank_account_id is distinct from old.source_bank_account_id
        or new.destination_cash_account_id is distinct from old.destination_cash_account_id
        or new.destination_bank_account_id is distinct from old.destination_bank_account_id
        or new.amount<>old.amount or new.fee_amount<>old.fee_amount
        or new.classification_mapping_key is distinct from old.classification_mapping_key
      ) then
        raise exception using errcode='23514',
          message='accounting_cash_bank_confirmed_immutable';
      end if;
      return new;
    end;
    $$;
    create trigger cash_bank_movements_immutable
      before update or delete on cash_bank_movements
      for each row execute function protect_cash_bank_history();

    alter table accounting_configurations
      drop constraint accounting_configurations_automatic_areas_check,
      add constraint accounting_configurations_automatic_areas_check check(
        automatic_posting_areas <@ array[
          'orders','trader_receivables','trader_settlements',
          'driver_collections','driver_expenses','employee_payroll',
          'outsourced_driver_fees','general_expenses','cash_bank_management'
        ]::text[]
      );
    alter table accounting_events
      drop constraint accounting_events_type_check,
      drop constraint accounting_events_operational_area_check,
      add constraint accounting_events_type_check check(event_type in(
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
        'bank_transfer_confirmed','bank_transfer_reversed',
        'cash_deposit_confirmed','cash_withdrawal_confirmed',
        'bank_deposit_confirmed','bank_withdrawal_confirmed',
        'cash_to_bank_transfer_confirmed','bank_to_cash_transfer_confirmed',
        'bank_to_bank_transfer_confirmed','cash_to_cash_transfer_confirmed',
        'cash_bank_movement_reversed'
      )),
      add constraint accounting_events_operational_area_check check(
        operational_area is null or operational_area in(
          'orders','trader_receivables','trader_settlements',
          'driver_collections','driver_expenses','employee_payroll',
          'outsourced_driver_fees','general_expenses','cash_bank_management'
        )
      );
    alter table accounting_event_components
      drop constraint accounting_event_components_type_check,
      add constraint accounting_event_components_type_check check(component_type in(
        'cod_receivable','delivery_revenue','service_fee_revenue',
        'additional_fee_revenue','output_vat','trader_payable',
        'trader_settlement','driver_collection_cash','driver_expense',
        'payroll_expense','payroll_payable','payroll_cash_payment',
        'outsourced_driver_fee_expense','outsourced_driver_payable',
        'outsourced_driver_payment','general_expense','input_vat',
        'general_expense_payable','general_expense_payment',
        'cash_transfer','bank_transfer','cash_bank_account',
        'cash_bank_external_source','cash_bank_external_destination','cash_bank_fee'
      ));
    alter table account_mappings
      drop constraint account_mappings_key_check,
      add constraint account_mappings_key_check check(mapping_key in(
        'order_cod_receivable','delivery_revenue','service_fee_revenue',
        'additional_fee_revenue','output_vat','trader_payable',
        'trader_settlement_cash','trader_settlement_bank',
        'driver_collection_cash','driver_collection_fee_offset','driver_expense',
        'employee_payroll_expense','employee_payroll_payable',
        'employee_payroll_cash_payment','outsourced_driver_fee_expense',
        'outsourced_driver_payable','outsourced_driver_cash_payment',
        'general_expense','input_vat','general_expense_payable',
        'general_expense_cash_payment','general_expense_bank_payment',
        'cash_transfer','bank_transfer','cash_bank_account','bank_charge',
        'cash_bank_deposit_owner_contribution','cash_bank_deposit_refund',
        'cash_bank_deposit_loan','cash_bank_withdrawal_owner',
        'cash_bank_withdrawal_refund','cash_bank_withdrawal_loan_repayment'
      ));
    alter table journal_lines
      add column cash_bank_movement_id uuid,
      add constraint journal_lines_cash_bank_movement_fk
        foreign key(cash_bank_movement_id,company_id)
        references cash_bank_movements(id,company_id) on delete restrict;
    create index journal_lines_cash_bank_movement_index
      on journal_lines(company_id,cash_bank_movement_id)
      where cash_bank_movement_id is not null;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from company_reference_counters where reference_type='cash_bank_movement';
    alter table company_reference_counters
      drop constraint company_reference_counters_type_check,
      add constraint company_reference_counters_type_check check(reference_type in(
        'order','payment','reconciliation','settlement','journal','payroll','import',
        'trader','area','customer','driver','employee','trader_receivable',
        'trader_collection','payroll_payment','outsourced_driver_fee_payment',
        'accounting_opening_balance'
      ));
    alter table accounting_configurations
      drop constraint accounting_configurations_automatic_areas_check,
      add constraint accounting_configurations_automatic_areas_check check(
        automatic_posting_areas <@ array[
          'orders','trader_receivables','trader_settlements',
          'driver_collections','driver_expenses','employee_payroll',
          'outsourced_driver_fees','general_expenses'
        ]::text[]
      );
    alter table accounting_events
      drop constraint accounting_events_type_check,
      drop constraint accounting_events_operational_area_check,
      add constraint accounting_events_type_check check(event_type in(
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
      )),
      add constraint accounting_events_operational_area_check check(
        operational_area is null or operational_area in(
          'orders','trader_receivables','trader_settlements',
          'driver_collections','driver_expenses','employee_payroll',
          'outsourced_driver_fees','general_expenses'
        )
      );
    alter table accounting_event_components
      drop constraint accounting_event_components_type_check,
      add constraint accounting_event_components_type_check check(component_type in(
        'cod_receivable','delivery_revenue','service_fee_revenue',
        'additional_fee_revenue','output_vat','trader_payable',
        'trader_settlement','driver_collection_cash','driver_expense',
        'payroll_expense','payroll_payable','payroll_cash_payment',
        'outsourced_driver_fee_expense','outsourced_driver_payable',
        'outsourced_driver_payment','general_expense','input_vat',
        'general_expense_payable','general_expense_payment',
        'cash_transfer','bank_transfer'
      ));
    alter table account_mappings
      drop constraint account_mappings_key_check,
      add constraint account_mappings_key_check check(mapping_key in(
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
      ));
    alter table journal_lines
      drop constraint if exists journal_lines_cash_bank_movement_fk,
      drop column if exists cash_bank_movement_id;
    drop trigger if exists cash_bank_movements_immutable on cash_bank_movements;
    drop function if exists protect_cash_bank_history();
    drop table if exists cash_bank_movement_attachments;
    drop table if exists cash_bank_movements;
    drop trigger if exists company_cash_accounts_gl_guard on company_cash_accounts;
    drop trigger if exists company_bank_accounts_gl_guard on company_bank_accounts;
    drop function if exists validate_company_financial_account();
    drop table if exists company_cash_accounts;
    alter table company_bank_accounts
      drop constraint if exists company_bank_accounts_code_unique,
      drop constraint if exists company_bank_accounts_type_check,
      drop constraint if exists company_bank_accounts_dates_check,
      drop constraint if exists company_bank_accounts_linked_gl_fk,
      drop constraint if exists company_bank_accounts_creator_fk,
      drop constraint if exists company_bank_accounts_updater_fk,
      drop constraint if exists company_bank_accounts_deactivator_fk,
      drop column if exists bank_account_code,
      drop column if exists branch_name,
      drop column if exists account_number,
      drop column if exists account_type,
      drop column if exists linked_gl_account_id,
      drop column if exists effective_from,
      drop column if exists effective_to,
      drop column if exists description,
      drop column if exists created_by_account_id,
      drop column if exists updated_by_account_id,
      drop column if exists deactivated_by_account_id,
      drop column if exists deactivated_at;
  `.execute(database);
}
