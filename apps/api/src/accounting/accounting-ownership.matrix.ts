import type { AccountingEventType, AccountingJournalSource } from "./accounting.constants.js";

export interface AccountingPostingOwnership {
  readonly area: string;
  readonly eventType: AccountingEventType;
  readonly journalSource: AccountingJournalSource;
  readonly movementOwner: string;
  readonly reversal: boolean;
}

/**
 * One authoritative owner per financial movement. In particular, settlement
 * payment, Driver Collection expense/deduction, and Payroll payment ownership
 * are explicit so related records cannot create a second Cash/Bank movement.
 */
export const accountingPostingOwnershipMatrix: readonly AccountingPostingOwnership[] = [
  {
    area: "orders",
    eventType: "order_delivered",
    journalSource: "order",
    movementOwner: "orders",
    reversal: false,
  },
  {
    area: "orders",
    eventType: "order_recognition_reversed",
    journalSource: "order",
    movementOwner: "orders",
    reversal: true,
  },
  {
    area: "trader_receivables",
    eventType: "trader_receivable_recognized",
    journalSource: "trader_receivable",
    movementOwner: "trader_receivables",
    reversal: false,
  },
  {
    area: "trader_receivables",
    eventType: "trader_receivable_reversed",
    journalSource: "trader_receivable",
    movementOwner: "trader_receivables",
    reversal: true,
  },
  {
    area: "trader_receivables",
    eventType: "trader_receivable_payment_received",
    journalSource: "trader_receivable",
    movementOwner: "trader_collections",
    reversal: false,
  },
  {
    area: "trader_receivables",
    eventType: "trader_receivable_payment_reversed",
    journalSource: "trader_receivable",
    movementOwner: "trader_collections",
    reversal: true,
  },
  {
    area: "trader_settlements",
    eventType: "trader_settlement_confirmed",
    journalSource: "trader_settlement",
    movementOwner: "trader_settlements",
    reversal: false,
  },
  {
    area: "trader_settlements",
    eventType: "trader_settlement_reversed",
    journalSource: "trader_settlement",
    movementOwner: "trader_settlements",
    reversal: true,
  },
  {
    area: "driver_collections",
    eventType: "driver_collection_confirmed",
    journalSource: "driver_collection",
    movementOwner: "driver_reconciliations",
    reversal: false,
  },
  {
    area: "driver_collections",
    eventType: "driver_collection_reversed",
    journalSource: "driver_collection",
    movementOwner: "driver_reconciliations",
    reversal: true,
  },
  {
    area: "employee_payroll",
    eventType: "employee_payroll_approved",
    journalSource: "employee_payroll",
    movementOwner: "payroll_periods",
    reversal: false,
  },
  {
    area: "employee_payroll",
    eventType: "employee_payroll_reversed",
    journalSource: "employee_payroll",
    movementOwner: "payroll_periods",
    reversal: true,
  },
  {
    area: "employee_payroll",
    eventType: "employee_payroll_paid",
    journalSource: "employee_payroll",
    movementOwner: "payroll_payments",
    reversal: false,
  },
  {
    area: "employee_payroll",
    eventType: "employee_payroll_payment_reversed",
    journalSource: "employee_payroll",
    movementOwner: "payroll_payments",
    reversal: true,
  },
  {
    area: "employee_payroll",
    eventType: "employee_variable_earnings_interim_paid",
    journalSource: "employee_payroll",
    movementOwner: "employee_variable_earning_payments",
    reversal: false,
  },
  {
    area: "employee_payroll",
    eventType: "employee_variable_earnings_interim_payment_reversed",
    journalSource: "employee_payroll",
    movementOwner: "employee_variable_earning_payments",
    reversal: true,
  },
  {
    area: "employee_payroll",
    eventType: "employee_salary_advance_paid",
    journalSource: "employee_payroll",
    movementOwner: "employee_salary_advances",
    reversal: false,
  },
  {
    area: "employee_payroll",
    eventType: "employee_salary_advance_reversed",
    journalSource: "employee_payroll",
    movementOwner: "employee_salary_advances",
    reversal: true,
  },
  {
    area: "outsourced_driver_fees",
    eventType: "outsourced_driver_fee_accrued",
    journalSource: "outsourced_driver_fee",
    movementOwner: "outsourced_driver_fee_accruals",
    reversal: false,
  },
  {
    area: "outsourced_driver_fees",
    eventType: "outsourced_driver_fee_accrual_reversed",
    journalSource: "outsourced_driver_fee",
    movementOwner: "outsourced_driver_fee_accruals",
    reversal: true,
  },
  {
    area: "outsourced_driver_fees",
    eventType: "outsourced_driver_fee_paid",
    journalSource: "outsourced_driver_fee",
    movementOwner: "outsourced_driver_fee_payments",
    reversal: false,
  },
  {
    area: "outsourced_driver_fees",
    eventType: "outsourced_driver_fee_payment_reversed",
    journalSource: "outsourced_driver_fee",
    movementOwner: "outsourced_driver_fee_payments",
    reversal: true,
  },
  {
    area: "general_expenses",
    eventType: "general_expense_approved",
    journalSource: "general_expense",
    movementOwner: "general_expenses",
    reversal: false,
  },
  {
    area: "general_expenses",
    eventType: "general_expense_reversed",
    journalSource: "general_expense",
    movementOwner: "general_expenses",
    reversal: true,
  },
  {
    area: "general_expenses",
    eventType: "general_expense_payment_completed",
    journalSource: "general_expense",
    movementOwner: "general_expense_payments",
    reversal: false,
  },
  {
    area: "general_expenses",
    eventType: "general_expense_payment_reversed",
    journalSource: "general_expense",
    movementOwner: "general_expense_payments",
    reversal: true,
  },
  {
    area: "cash_bank_management",
    eventType: "cash_deposit_confirmed",
    journalSource: "cash_bank_management",
    movementOwner: "cash_bank_movements",
    reversal: false,
  },
  {
    area: "cash_bank_management",
    eventType: "cash_withdrawal_confirmed",
    journalSource: "cash_bank_management",
    movementOwner: "cash_bank_movements",
    reversal: false,
  },
  {
    area: "cash_bank_management",
    eventType: "bank_deposit_confirmed",
    journalSource: "cash_bank_management",
    movementOwner: "cash_bank_movements",
    reversal: false,
  },
  {
    area: "cash_bank_management",
    eventType: "bank_withdrawal_confirmed",
    journalSource: "cash_bank_management",
    movementOwner: "cash_bank_movements",
    reversal: false,
  },
  {
    area: "cash_bank_management",
    eventType: "cash_to_bank_transfer_confirmed",
    journalSource: "cash_bank_management",
    movementOwner: "cash_bank_movements",
    reversal: false,
  },
  {
    area: "cash_bank_management",
    eventType: "bank_to_cash_transfer_confirmed",
    journalSource: "cash_bank_management",
    movementOwner: "cash_bank_movements",
    reversal: false,
  },
  {
    area: "cash_bank_management",
    eventType: "bank_to_bank_transfer_confirmed",
    journalSource: "cash_bank_management",
    movementOwner: "cash_bank_movements",
    reversal: false,
  },
  {
    area: "cash_bank_management",
    eventType: "cash_to_cash_transfer_confirmed",
    journalSource: "cash_bank_management",
    movementOwner: "cash_bank_movements",
    reversal: false,
  },
  {
    area: "cash_bank_management",
    eventType: "cash_bank_movement_reversed",
    journalSource: "cash_bank_management",
    movementOwner: "cash_bank_movements",
    reversal: true,
  },
] as const;

export const accountingOperationalAreas = [
  "orders",
  "trader_receivables",
  "trader_settlements",
  "driver_collections",
  "driver_expenses",
  "employee_payroll",
  "outsourced_driver_fees",
  "general_expenses",
  "cash_bank_management",
] as const;

export type AccountingOperationalArea = (typeof accountingOperationalAreas)[number];
