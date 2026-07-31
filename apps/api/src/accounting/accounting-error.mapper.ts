import { HttpStatus } from "@nestjs/common";

import { ApplicationException } from "../presentation/errors/application.exception.js";

const stableConstraintMessages = new Set([
  "accounting_account_class_type_mismatch",
  "accounting_account_deactivation_mapping_conflict",
  "accounting_account_normal_balance_invalid",
  "accounting_account_hierarchy_cycle",
  "accounting_account_delete_prohibited",
  "accounting_control_account_subledger_required",
  "accounting_configuration_account_incompatible",
  "accounting_configuration_cross_company_account",
  "accounting_configuration_version_conflict",
  "accounting_event_already_posted",
  "accounting_event_accounting_date_missing",
  "accounting_event_actor_missing",
  "accounting_event_fiscal_period_not_found",
  "accounting_event_mapping_inactive_account",
  "accounting_event_mapping_control_account_invalid",
  "accounting_event_mapping_missing",
  "accounting_event_mapping_overlap",
  "accounting_event_mapping_summary_account",
  "accounting_event_not_balanced",
  "accounting_event_original_not_posted",
  "accounting_event_payload_mismatch",
  "accounting_event_period_closed",
  "accounting_event_period_soft_closed",
  "accounting_event_source_conflict",
  "accounting_fiscal_period_closed",
  "accounting_fiscal_period_not_found",
  "accounting_fiscal_period_outside_year",
  "accounting_fiscal_period_overlap",
  "accounting_fiscal_period_soft_closed",
  "accounting_fiscal_year_closed",
  "accounting_fiscal_year_not_found",
  "accounting_fiscal_year_overlap",
  "accounting_journal_company_mismatch",
  "accounting_journal_approved_immutable",
  "accounting_journal_invalid_transition",
  "accounting_journal_line_cross_company_account",
  "accounting_journal_line_inactive_account",
  "accounting_journal_line_summary_account",
  "accounting_journal_no_lines",
  "accounting_journal_not_balanced",
  "accounting_journal_not_editable",
  "accounting_journal_insufficient_lines",
  "accounting_journal_posted_immutable",
  "accounting_journal_zero_total",
  "accounting_journal_totals_stale",
  "accounting_mapping_account_incompatible",
  "accounting_mapping_cross_company",
  "accounting_mapping_inactive_account",
  "accounting_mapping_overlap",
  "accounting_mapping_summary_account",
  "accounting_mapping_history_immutable",
  "accounting_invalid_opening_balance_account",
  "accounting_invalid_opening_balance_period",
  "accounting_opening_balance_invalid_transition",
  "accounting_opening_balance_not_balanced",
  "accounting_opening_balance_totals_stale",
  "accounting_opening_balance_immutable",
  "accounting_opening_balance_account_unavailable",
  "accounting_opening_balance_control_account_invalid",
  "accounting_general_expense_lines_immutable",
  "accounting_general_expense_payment_history_immutable",
  "accounting_cash_bank_delete_prohibited",
  "accounting_cash_bank_history_immutable",
  "accounting_cash_bank_gl_account_invalid",
]);

export function mapAccountingDatabaseError(error: unknown): never {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : "";
  const stableCode = [...stableConstraintMessages].find((code) => message.includes(code));
  if (stableCode !== undefined) {
    throw new ApplicationException(
      stableCode,
      "The Accounting operation conflicts with the current financial integrity rules",
      HttpStatus.CONFLICT,
    );
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String(error.code) === "23505"
  ) {
    const constraint =
      "constraint" in error && typeof error.constraint === "string" ? error.constraint : "";
    if (constraint === "chart_of_accounts_code_unique") {
      throw new ApplicationException(
        "accounting_account_code_already_exists",
        "The Account Code already exists in the active Company",
        HttpStatus.CONFLICT,
      );
    }
    if (constraint === "accounting_events_identity_unique") {
      throw new ApplicationException(
        "accounting_event_duplicate",
        "This operational Accounting Event was already received",
        HttpStatus.CONFLICT,
      );
    }
    if (constraint === "accounting_events_idempotency_unique") {
      throw new ApplicationException(
        "accounting_event_idempotency_conflict",
        "The Accounting Event idempotency identity was already used",
        HttpStatus.CONFLICT,
      );
    }
    if (constraint === "journal_entries_company_id_journal_number_key") {
      throw new ApplicationException(
        "accounting_journal_number_generation_failed",
        "A unique Journal Number could not be reserved",
        HttpStatus.CONFLICT,
      );
    }
    if (constraint === "opening_balance_batches_company_id_batch_number_key") {
      throw new ApplicationException(
        "accounting_opening_balance_number_generation_failed",
        "A unique Opening Balance reference could not be reserved",
        HttpStatus.CONFLICT,
      );
    }
    if (constraint === "opening_balance_batches_posted_journal_unique") {
      throw new ApplicationException(
        "accounting_opening_balance_journal_exists",
        "The Opening Balance Batch already has a linked Journal",
        HttpStatus.CONFLICT,
      );
    }
    if (constraint === "general_expense_categories_code_unique") {
      throw new ApplicationException(
        "accounting_general_expense_category_code_exists",
        "The Expense Category Code already exists in the active Company",
        HttpStatus.CONFLICT,
      );
    }
    if (constraint === "general_expenses_company_id_expense_number_key") {
      throw new ApplicationException(
        "accounting_general_expense_number_generation_failed",
        "A unique General Expense Number could not be reserved",
        HttpStatus.CONFLICT,
      );
    }
    if (constraint === "general_expenses_source_unique") {
      throw new ApplicationException(
        "accounting_general_expense_duplicate_source",
        "This source is already represented by another General Expense",
        HttpStatus.CONFLICT,
      );
    }
    if (constraint === "general_expense_payments_company_id_payment_number_key") {
      throw new ApplicationException(
        "accounting_general_expense_payment_number_generation_failed",
        "A unique General Expense Payment Number could not be reserved",
        HttpStatus.CONFLICT,
      );
    }
    if (constraint === "company_cash_accounts_code_unique") {
      throw new ApplicationException(
        "accounting_cash_account_code_exists",
        "The Cash Account Code already exists in the active Company",
        HttpStatus.CONFLICT,
      );
    }
    if (constraint === "company_bank_accounts_code_unique") {
      throw new ApplicationException(
        "accounting_bank_account_code_exists",
        "The Bank Account Code already exists in the active Company",
        HttpStatus.CONFLICT,
      );
    }
    if (constraint === "cash_bank_movements_number_unique") {
      throw new ApplicationException(
        "accounting_cash_bank_number_generation_failed",
        "A unique Cash/Bank Movement Number could not be reserved",
        HttpStatus.CONFLICT,
      );
    }
    if (constraint === "cash_bank_movements_reversal_unique") {
      throw new ApplicationException(
        "accounting_cash_bank_movement_already_reversed",
        "This Cash/Bank Movement already has a reversal",
        HttpStatus.CONFLICT,
      );
    }
    throw new ApplicationException(
      "accounting_record_already_exists",
      "The Accounting record already exists",
      HttpStatus.CONFLICT,
    );
  }
  throw new ApplicationException(
    "accounting_integrity_conflict",
    "The Accounting operation could not be completed safely",
    HttpStatus.CONFLICT,
  );
}
