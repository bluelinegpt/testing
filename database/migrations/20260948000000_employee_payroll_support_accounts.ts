import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Payroll setup requires two dedicated asset control accounts, but the
 * database allow-lists predate those mapping/control types. Until this
 * forward repair, the setup wizard can correctly identify the missing rows
 * but no lawful account or mapping can be created for them.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table chart_of_accounts
      drop constraint chart_of_accounts_control_check,
      add constraint chart_of_accounts_control_check check (
        (not is_control_account and control_account_type is null)
        or (
          is_control_account and is_posting_account and control_account_type in (
            'trader_payable','driver_payable','payroll_payable','accounts_receivable',
            'accounts_payable','vat','employee_interim_payroll_clearing','employee_advances'
          )
        )
      );

    alter table account_mappings
      drop constraint account_mappings_key_check,
      add constraint account_mappings_key_check check(mapping_key in(
        'order_cod_receivable','delivery_revenue','service_fee_revenue',
        'additional_fee_revenue','output_vat','trader_payable',
        'trader_settlement_cash','trader_settlement_bank','driver_collection_cash',
        'driver_collection_fee_offset','driver_expense','employee_payroll_expense',
        'employee_payroll_payable','employee_payroll_cash_payment',
        'employee_interim_payroll_clearing','employee_advances',
        'outsourced_driver_fee_expense','outsourced_driver_payable',
        'outsourced_driver_cash_payment','general_expense','input_vat',
        'general_expense_payable','general_expense_cash_payment',
        'general_expense_bank_payment','cash_transfer','bank_transfer',
        'cash_bank_account','bank_charge','cash_bank_deposit_owner_contribution',
        'cash_bank_deposit_refund','cash_bank_deposit_loan','cash_bank_withdrawal_owner',
        'cash_bank_withdrawal_refund','cash_bank_withdrawal_loan_repayment'
      ));
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  const used = await sql<{ used: boolean }>`select exists(
    select 1 from chart_of_accounts where control_account_type in(
      'employee_interim_payroll_clearing','employee_advances'
    ) union all select 1 from account_mappings where mapping_key in(
      'employee_interim_payroll_clearing','employee_advances'
    )
  ) as used`.execute(database);
  if (used.rows[0]?.used) {
    throw new Error("Cannot remove payroll support account types while Company data uses them");
  }
  await sql`
    alter table chart_of_accounts
      drop constraint chart_of_accounts_control_check,
      add constraint chart_of_accounts_control_check check (
        (not is_control_account and control_account_type is null)
        or (is_control_account and is_posting_account and control_account_type in (
          'trader_payable','driver_payable','payroll_payable','accounts_receivable',
          'accounts_payable','vat'
        ))
      );
    alter table account_mappings
      drop constraint account_mappings_key_check,
      add constraint account_mappings_key_check check(mapping_key in(
        'order_cod_receivable','delivery_revenue','service_fee_revenue',
        'additional_fee_revenue','output_vat','trader_payable',
        'trader_settlement_cash','trader_settlement_bank','driver_collection_cash',
        'driver_collection_fee_offset','driver_expense','employee_payroll_expense',
        'employee_payroll_payable','employee_payroll_cash_payment',
        'outsourced_driver_fee_expense','outsourced_driver_payable',
        'outsourced_driver_cash_payment','general_expense','input_vat',
        'general_expense_payable','general_expense_cash_payment',
        'general_expense_bank_payment','cash_transfer','bank_transfer',
        'cash_bank_account','bank_charge','cash_bank_deposit_owner_contribution',
        'cash_bank_deposit_refund','cash_bank_deposit_loan','cash_bank_withdrawal_owner',
        'cash_bank_withdrawal_refund','cash_bank_withdrawal_loan_repayment'
      ));
  `.execute(database);
}
