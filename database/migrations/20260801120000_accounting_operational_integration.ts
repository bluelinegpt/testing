import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Accounting Prompt 3: durable operational event delivery and automatic-posting
 * controls. Existing accounting_events is the queue; no parallel outbox is
 * introduced. Capture triggers only enqueue after an authoritative operational
 * state change and only for Companies that explicitly enabled the relevant area.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table accounting_configurations
      drop constraint accounting_configurations_auto_posting_check,
      add column automatic_posting_areas text[] not null default array[]::text[],
      add column automatic_posting_enabled_by_account_id uuid,
      add column automatic_posting_enabled_at timestamptz,
      add column automatic_posting_disabled_by_account_id uuid,
      add column automatic_posting_disabled_at timestamptz,
      add column automatic_posting_change_reason text,
      add constraint accounting_configurations_automatic_areas_check check (
        automatic_posting_areas <@ array[
          'orders','trader_receivables','trader_settlements',
          'driver_collections','driver_expenses','employee_payroll',
          'outsourced_driver_fees'
        ]::text[]
      ),
      add constraint accounting_configurations_automatic_shape_check check (
        (not automatic_posting_enabled)
        or (
          accounting_enabled
          and cardinality(automatic_posting_areas) > 0
          and automatic_posting_enabled_by_account_id is not null
          and automatic_posting_enabled_at is not null
        )
      ),
      add constraint accounting_configurations_automatic_enabler_fk
        foreign key (automatic_posting_enabled_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint accounting_configurations_automatic_disabler_fk
        foreign key (automatic_posting_disabled_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict;

    alter table accounting_events
      drop constraint accounting_events_type_check,
      drop constraint accounting_events_status_check,
      add column operational_area text,
      add column source_operation_id text,
      add column failure_category text,
      add column safe_error_summary text,
      add column attempt_count integer not null default 0,
      add column max_attempts integer not null default 5,
      add column next_attempt_at timestamptz,
      add column last_attempt_at timestamptz,
      add column processing_locked_at timestamptz,
      add column processing_locked_by text,
      add column reviewed_by_account_id uuid,
      add column reviewed_at timestamptz,
      add column review_note text,
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
          'general_expense_approved','general_expense_reversed',
          'bank_transfer_confirmed','bank_transfer_reversed'
        )
      ),
      add constraint accounting_events_status_check check (
        processing_status in (
          'received','processing','validated','posted','failed','retry_pending',
          'blocked_configuration','reversed','ignored_duplicate'
        )
      ),
      add constraint accounting_events_operational_area_check check (
        operational_area is null or operational_area in (
          'orders','trader_receivables','trader_settlements',
          'driver_collections','driver_expenses','employee_payroll',
          'outsourced_driver_fees'
        )
      ),
      add constraint accounting_events_attempts_check check (
        attempt_count >= 0 and max_attempts between 1 and 20
      ),
      add constraint accounting_events_reviewer_fk
        foreign key (reviewed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict;

    alter table journal_entries
      add column accounting_event_id uuid,
      add constraint journal_entries_accounting_event_fk
        foreign key (accounting_event_id, company_id)
        references accounting_events(id, company_id) on delete restrict;
    create unique index journal_entries_accounting_event_unique
      on journal_entries (company_id, accounting_event_id)
      where accounting_event_id is not null;

    create index accounting_events_type_status_index
      on accounting_events (company_id, event_type, processing_status, created_at);
    create index accounting_events_retry_index
      on accounting_events (processing_status, next_attempt_at, created_at)
      where processing_status in ('received','retry_pending');
    create index accounting_events_failure_index
      on accounting_events (company_id, failure_category, effective_accounting_date)
      where processing_status in ('failed','blocked_configuration');
    create index accounting_events_journal_index
      on accounting_events (company_id, journal_id)
      where journal_id is not null;

    create or replace function enqueue_operational_accounting_event(
      event_company_id uuid,
      event_area text,
      event_type_value text,
      source_type_value text,
      source_id_value uuid,
      source_reference_value text,
      accounting_date_value date,
      actor_id_value uuid,
      operation_id_value text,
      reversal_source_type text default null,
      reversal_source_id uuid default null
    ) returns void language plpgsql as $$
    declare
      original_event_id uuid;
      stable_key text;
      stable_hash text;
    begin
      if not exists (
        select 1 from accounting_configurations c
         where c.company_id=event_company_id
           and c.accounting_enabled and c.automatic_posting_enabled
           and event_area=any(c.automatic_posting_areas)
      ) then
        return;
      end if;
      if reversal_source_id is not null then
        select e.id into original_event_id
          from accounting_events e
         where e.company_id=event_company_id
           and e.source_entity_type=reversal_source_type
           and e.source_entity_id=reversal_source_id
           and e.event_type not like '%_reversed'
           and e.event_type <> 'order_recognition_reversed'
         order by e.event_version desc limit 1;
        if original_event_id is null then
          return;
        end if;
      end if;
      stable_key := event_type_value || ':' || source_id_value::text || ':v1';
      stable_hash := md5(
        event_company_id::text || '|' || stable_key || '|' ||
        coalesce(source_reference_value,'') || '|' || accounting_date_value::text
      );
      insert into accounting_events (
        company_id,event_type,event_version,source_entity_type,source_entity_id,
        source_reference,effective_accounting_date,currency,correlation_id,
        idempotency_key,event_hash,actor_id,actor_type,description,
        reversal_of_event_id,supplementary_metadata,processing_status,
        operational_area,source_operation_id,next_attempt_at
      ) values (
        event_company_id,event_type_value,1,source_type_value,source_id_value,
        source_reference_value,accounting_date_value,'AED',
        coalesce(operation_id_value,stable_key),stable_key,stable_hash,
        actor_id_value,case when actor_id_value is null then 'system' else 'company_user' end,
        event_type_value || ' for ' || coalesce(source_reference_value,source_id_value::text),
        original_event_id,'{}'::jsonb,'received',event_area,
        coalesce(operation_id_value,stable_key),now()
      )
      on conflict (company_id,event_type,source_entity_type,source_entity_id,event_version)
      do nothing;
    end;
    $$;

    create function capture_order_accounting_event() returns trigger language plpgsql as $$
    begin
      if new.delivery_status='delivered'
         and old.delivery_status is distinct from 'delivered' then
        perform enqueue_operational_accounting_event(
          new.company_id,'orders','order_delivered','order',new.id,new.order_number,
          coalesce((new.delivered_at at time zone 'Asia/Dubai')::date,new.order_date),
          new.created_by_account_id,'order-delivery:'||new.id::text
        );
      elsif old.delivery_status='delivered'
         and new.delivery_status in ('returned_to_trader','cancelled') then
        perform enqueue_operational_accounting_event(
          new.company_id,'orders','order_recognition_reversed','order',new.id,new.order_number,
          (now() at time zone 'Asia/Dubai')::date,new.created_by_account_id,
          'order-reversal:'||new.id::text,'order',new.id
        );
      end if;
      return new;
    end;
    $$;
    create trigger orders_accounting_event_capture
      after update of delivery_status on orders
      for each row execute function capture_order_accounting_event();

    create function capture_trader_receivable_accounting_event() returns trigger language plpgsql as $$
    begin
      if tg_op='INSERT' and new.status <> 'cancelled' then
        perform enqueue_operational_accounting_event(
          new.company_id,'trader_receivables','trader_receivable_recognized',
          'trader_receivable',new.id,new.receivable_number,new.business_date,
          new.created_by_account_id,'trader-receivable:'||new.id::text
        );
      elsif tg_op='UPDATE' and old.status not in ('cancelled','reversed')
         and new.status in ('cancelled','reversed') then
        perform enqueue_operational_accounting_event(
          new.company_id,'trader_receivables','trader_receivable_reversed',
          'trader_receivable',new.id,new.receivable_number,
          (now() at time zone 'Asia/Dubai')::date,new.created_by_account_id,
          'trader-receivable-reversal:'||new.id::text,'trader_receivable',new.id
        );
      end if;
      return new;
    end;
    $$;
    create trigger trader_receivables_accounting_event_capture
      after insert or update of status on trader_receivables
      for each row execute function capture_trader_receivable_accounting_event();

    create function capture_trader_collection_accounting_event() returns trigger language plpgsql as $$
    begin
      if tg_op='INSERT' and new.status='confirmed' then
        perform enqueue_operational_accounting_event(
          new.company_id,'trader_receivables','trader_receivable_payment_received',
          'trader_collection',new.id,new.collection_number,new.payment_date,
          new.received_by_account_id,'trader-collection:'||new.id::text
        );
      elsif tg_op='UPDATE' and old.status='confirmed' and new.status='reversed' then
        perform enqueue_operational_accounting_event(
          new.company_id,'trader_receivables','trader_receivable_payment_reversed',
          'trader_collection',new.id,new.collection_number,
          coalesce((new.reversed_at at time zone 'Asia/Dubai')::date,new.payment_date),
          new.reversed_by_account_id,'trader-collection-reversal:'||new.id::text,
          'trader_collection',new.id
        );
      end if;
      return new;
    end;
    $$;
    create trigger trader_collections_accounting_event_capture
      after insert or update of status on trader_collections
      for each row execute function capture_trader_collection_accounting_event();

    create function capture_trader_settlement_accounting_event() returns trigger language plpgsql as $$
    begin
      if new.status='confirmed' then
        perform enqueue_operational_accounting_event(
          new.company_id,'trader_settlements',
          case when new.reversal_of_id is null then 'trader_settlement_confirmed'
               else 'trader_settlement_reversed' end,
          'trader_settlement',new.id,new.settlement_number,new.business_date,
          coalesce(new.confirmed_by_account_id,new.created_by_account_id),
          'trader-settlement:'||new.id::text,
          case when new.reversal_of_id is null then null else 'trader_settlement' end,
          new.reversal_of_id
        );
      end if;
      return new;
    end;
    $$;
    create trigger trader_settlements_accounting_event_capture
      after insert or update of status on trader_settlements
      for each row when (new.status='confirmed')
      execute function capture_trader_settlement_accounting_event();

    create function capture_driver_collection_accounting_event() returns trigger language plpgsql as $$
    begin
      if new.status='confirmed' then
        perform enqueue_operational_accounting_event(
          new.company_id,'driver_collections',
          case when new.reversal_of_id is null then 'driver_collection_confirmed'
               else 'driver_collection_reversed' end,
          'driver_reconciliation',new.id,new.reconciliation_number,new.business_date,
          coalesce(new.confirmed_by_account_id,new.created_by_account_id),
          'driver-collection:'||new.id::text,
          case when new.reversal_of_id is null then null else 'driver_reconciliation' end,
          new.reversal_of_id
        );
      end if;
      return new;
    end;
    $$;
    create trigger driver_reconciliations_accounting_event_capture
      after insert or update of status on driver_reconciliations
      for each row when (new.status='confirmed')
      execute function capture_driver_collection_accounting_event();

    create function capture_payroll_period_accounting_event() returns trigger language plpgsql as $$
    begin
      if new.status='approved' and old.status is distinct from 'approved' then
        perform enqueue_operational_accounting_event(
          new.company_id,'employee_payroll','employee_payroll_approved',
          'payroll_period',new.id,new.period_reference,new.period_end,
          new.approved_by_account_id,'payroll-approval:'||new.id::text
        );
      elsif new.status='reversed' and old.status is distinct from 'reversed' then
        perform enqueue_operational_accounting_event(
          new.company_id,'employee_payroll','employee_payroll_reversed',
          'payroll_period',new.id,new.period_reference,
          coalesce((new.reversed_at at time zone 'Asia/Dubai')::date,new.period_end),
          new.reversed_by_account_id,'payroll-reversal:'||new.id::text,
          'payroll_period',new.id
        );
      end if;
      return new;
    end;
    $$;
    create trigger payroll_periods_accounting_event_capture
      after update of status on payroll_periods
      for each row execute function capture_payroll_period_accounting_event();

    create function capture_payroll_payment_accounting_event() returns trigger language plpgsql as $$
    begin
      if tg_op='INSERT' and new.status='confirmed' then
        perform enqueue_operational_accounting_event(
          new.company_id,'employee_payroll','employee_payroll_paid',
          'payroll_payment',new.id,new.payment_number,new.payment_date,
          new.paid_by_account_id,'payroll-payment:'||new.id::text
        );
      elsif tg_op='UPDATE' and old.status='confirmed' and new.status='reversed' then
        perform enqueue_operational_accounting_event(
          new.company_id,'employee_payroll','employee_payroll_payment_reversed',
          'payroll_payment',new.id,new.payment_number,
          coalesce((new.reversed_at at time zone 'Asia/Dubai')::date,new.payment_date),
          new.reversed_by_account_id,'payroll-payment-reversal:'||new.id::text,
          'payroll_payment',new.id
        );
      end if;
      return new;
    end;
    $$;
    create trigger payroll_payments_accounting_event_capture
      after insert or update of status on payroll_payments
      for each row execute function capture_payroll_payment_accounting_event();

    create function capture_driver_fee_accrual_accounting_event() returns trigger language plpgsql as $$
    begin
      if tg_op='INSERT' then
        perform enqueue_operational_accounting_event(
          new.company_id,'outsourced_driver_fees','outsourced_driver_fee_accrued',
          'outsourced_driver_fee_accrual',new.id,new.source_reference,
          new.accrual_business_date,new.created_by_account_id,
          'driver-fee-accrual:'||new.id::text
        );
      elsif tg_op='UPDATE' and new.status in ('reversed','recovery_required')
         and old.status not in ('reversed','recovery_required') then
        perform enqueue_operational_accounting_event(
          new.company_id,'outsourced_driver_fees','outsourced_driver_fee_accrual_reversed',
          'outsourced_driver_fee_accrual',new.id,new.source_reference,
          coalesce((new.reversed_at at time zone 'Asia/Dubai')::date,new.accrual_business_date),
          new.reversed_by_account_id,'driver-fee-accrual-reversal:'||new.id::text,
          'outsourced_driver_fee_accrual',new.id
        );
      end if;
      return new;
    end;
    $$;
    create trigger outsourced_driver_fee_accruals_accounting_event_capture
      after insert or update of status on outsourced_driver_fee_accruals
      for each row execute function capture_driver_fee_accrual_accounting_event();

    create function capture_driver_fee_payment_accounting_event() returns trigger language plpgsql as $$
    begin
      if tg_op='INSERT' and new.status='confirmed'
         and new.payment_source='separate_payment' then
        perform enqueue_operational_accounting_event(
          new.company_id,'outsourced_driver_fees','outsourced_driver_fee_paid',
          'outsourced_driver_fee_payment',new.id,new.payment_number,new.payment_date,
          new.paid_by_account_id,'driver-fee-payment:'||new.id::text
        );
      elsif tg_op='UPDATE' and old.status='confirmed' and new.status='reversed'
         and new.payment_source='separate_payment' then
        perform enqueue_operational_accounting_event(
          new.company_id,'outsourced_driver_fees','outsourced_driver_fee_payment_reversed',
          'outsourced_driver_fee_payment',new.id,new.payment_number,
          coalesce((new.reversed_at at time zone 'Asia/Dubai')::date,new.payment_date),
          new.reversed_by_account_id,'driver-fee-payment-reversal:'||new.id::text,
          'outsourced_driver_fee_payment',new.id
        );
      end if;
      return new;
    end;
    $$;
    create trigger outsourced_driver_fee_payments_accounting_event_capture
      after insert or update of status on outsourced_driver_fee_payments
      for each row execute function capture_driver_fee_payment_accounting_event();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists outsourced_driver_fee_payments_accounting_event_capture
      on outsourced_driver_fee_payments;
    drop trigger if exists outsourced_driver_fee_accruals_accounting_event_capture
      on outsourced_driver_fee_accruals;
    drop trigger if exists payroll_payments_accounting_event_capture on payroll_payments;
    drop trigger if exists payroll_periods_accounting_event_capture on payroll_periods;
    drop trigger if exists driver_reconciliations_accounting_event_capture on driver_reconciliations;
    drop trigger if exists trader_settlements_accounting_event_capture on trader_settlements;
    drop trigger if exists trader_collections_accounting_event_capture on trader_collections;
    drop trigger if exists trader_receivables_accounting_event_capture on trader_receivables;
    drop trigger if exists orders_accounting_event_capture on orders;
    drop function if exists capture_driver_fee_payment_accounting_event();
    drop function if exists capture_driver_fee_accrual_accounting_event();
    drop function if exists capture_payroll_payment_accounting_event();
    drop function if exists capture_payroll_period_accounting_event();
    drop function if exists capture_driver_collection_accounting_event();
    drop function if exists capture_trader_settlement_accounting_event();
    drop function if exists capture_trader_collection_accounting_event();
    drop function if exists capture_trader_receivable_accounting_event();
    drop function if exists capture_order_accounting_event();
    drop function if exists enqueue_operational_accounting_event(
      uuid,text,text,text,uuid,text,date,uuid,text,text,uuid
    );
    drop index if exists accounting_events_journal_index;
    drop index if exists accounting_events_failure_index;
    drop index if exists accounting_events_retry_index;
    drop index if exists accounting_events_type_status_index;
    drop index if exists journal_entries_accounting_event_unique;
    alter table journal_entries
      drop constraint if exists journal_entries_accounting_event_fk,
      drop column if exists accounting_event_id;
    alter table accounting_events
      drop constraint if exists accounting_events_reviewer_fk,
      drop constraint if exists accounting_events_attempts_check,
      drop constraint if exists accounting_events_operational_area_check,
      drop constraint if exists accounting_events_status_check,
      drop constraint if exists accounting_events_type_check,
      drop column if exists review_note,
      drop column if exists reviewed_at,
      drop column if exists reviewed_by_account_id,
      drop column if exists processing_locked_by,
      drop column if exists processing_locked_at,
      drop column if exists last_attempt_at,
      drop column if exists next_attempt_at,
      drop column if exists max_attempts,
      drop column if exists attempt_count,
      drop column if exists safe_error_summary,
      drop column if exists failure_category,
      drop column if exists source_operation_id,
      drop column if exists operational_area;
    alter table accounting_events
      add constraint accounting_events_type_check check (
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
      add constraint accounting_events_status_check check (
        processing_status in (
          'received','validated','posted','failed','reversed','ignored_duplicate'
        )
      );
    alter table accounting_configurations
      drop constraint if exists accounting_configurations_automatic_disabler_fk,
      drop constraint if exists accounting_configurations_automatic_enabler_fk,
      drop constraint if exists accounting_configurations_automatic_shape_check,
      drop constraint if exists accounting_configurations_automatic_areas_check,
      drop column if exists automatic_posting_change_reason,
      drop column if exists automatic_posting_disabled_at,
      drop column if exists automatic_posting_disabled_by_account_id,
      drop column if exists automatic_posting_enabled_at,
      drop column if exists automatic_posting_enabled_by_account_id,
      drop column if exists automatic_posting_areas,
      add constraint accounting_configurations_auto_posting_check
        check (not automatic_posting_enabled);
  `.execute(database);
}
