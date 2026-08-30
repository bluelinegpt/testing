import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Employee interim earnings and Salary Advances already have dedicated
 * operational loaders and mappings. Add their event/component values to the
 * database allow-lists so confirming either payment can enqueue its journal.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table accounting_events
      drop constraint accounting_events_type_check,
      add constraint accounting_events_type_check check(event_type in(
        'order_delivered','order_recognition_reversed',
        'trader_receivable_recognized','trader_receivable_reversed',
        'trader_receivable_payment_received','trader_receivable_payment_reversed',
        'trader_settlement_confirmed','trader_settlement_reversed',
        'driver_collection_confirmed','driver_collection_reversed',
        'driver_expense_confirmed','employee_payroll_approved',
        'employee_payroll_reversed','employee_payroll_paid',
        'employee_payroll_payment_reversed',
        'employee_variable_earnings_interim_paid',
        'employee_variable_earnings_interim_payment_reversed',
        'employee_salary_advance_paid','employee_salary_advance_reversed',
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
      ));

    alter table accounting_event_components
      drop constraint accounting_event_components_type_check,
      add constraint accounting_event_components_type_check check(component_type in(
        'cod_receivable','delivery_revenue','service_fee_revenue',
        'additional_fee_revenue','output_vat','trader_payable',
        'trader_settlement','driver_collection_cash','driver_expense',
        'payroll_expense','payroll_payable','payroll_cash_payment',
        'employee_interim_payroll_clearing','employee_advances',
        'outsourced_driver_fee_expense','outsourced_driver_payable',
        'outsourced_driver_payment','general_expense','input_vat',
        'general_expense_payable','general_expense_payment',
        'cash_transfer','bank_transfer','cash_bank_account',
        'cash_bank_external_source','cash_bank_external_destination','cash_bank_fee'
      ));

    create or replace function capture_employee_early_payment_accounting_event()
    returns trigger language plpgsql as $$
    declare event_type text; entity_type text; ref text; actor uuid; reversal_type text;
    begin
      if tg_table_name='employee_variable_earning_payments' then
        entity_type:='employee_variable_earning_payment'; ref:=new.payment_number;
        event_type:='employee_variable_earnings_interim_paid';
        reversal_type:='employee_variable_earnings_interim_payment_reversed';
      else
        entity_type:='employee_salary_advance'; ref:=new.advance_number;
        event_type:='employee_salary_advance_paid';
        reversal_type:='employee_salary_advance_reversed';
      end if;
      if tg_op='INSERT' and new.status='confirmed' then
        perform enqueue_operational_accounting_event(
          new.company_id,'employee_payroll',event_type,entity_type,new.id,ref,
          new.payment_date,new.paid_by_account_id,entity_type||':'||new.id::text
        );
      elsif tg_op='UPDATE' and old.status<>'reversed' and new.status='reversed' then
        select id into actor from accounts
          where id=new.reversed_by_account_id and company_id=new.company_id;
        perform enqueue_operational_accounting_event(
          new.company_id,'employee_payroll',reversal_type,entity_type,new.id,ref,
          coalesce((new.reversed_at at time zone 'Asia/Dubai')::date,new.payment_date),
          actor,entity_type||'-reversal:'||new.id::text,entity_type,new.id
        );
      end if;
      return new;
    end;
    $$;

    drop trigger if exists employee_variable_payment_accounting_event
      on employee_variable_earning_payments;
    create trigger employee_variable_payment_accounting_event
      after insert or update of status on employee_variable_earning_payments
      for each row execute function capture_employee_early_payment_accounting_event();
    drop trigger if exists employee_salary_advance_accounting_event
      on employee_salary_advances;
    create trigger employee_salary_advance_accounting_event
      after insert or update of status on employee_salary_advances
      for each row execute function capture_employee_early_payment_accounting_event();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  const used = await sql<{ used: boolean }>`select exists(
    select 1 from accounting_events where event_type in(
      'employee_variable_earnings_interim_paid',
      'employee_variable_earnings_interim_payment_reversed',
      'employee_salary_advance_paid','employee_salary_advance_reversed'
    ) union all select 1 from accounting_event_components where component_type in(
      'employee_interim_payroll_clearing','employee_advances'
    )
  ) as used`.execute(database);
  if (used.rows[0]?.used) {
    throw new Error("Cannot remove Employee early-payment Accounting types while data uses them");
  }
  await sql`
    drop trigger if exists employee_variable_payment_accounting_event
      on employee_variable_earning_payments;
    drop trigger if exists employee_salary_advance_accounting_event
      on employee_salary_advances;
    drop function if exists capture_employee_early_payment_accounting_event();

    alter table accounting_events
      drop constraint accounting_events_type_check,
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
      ));
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
  `.execute(database);
}
