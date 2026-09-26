import { Decimal } from "decimal.js";

import { ApplicationException } from "../presentation/errors/application.exception.js";
import {
  payrollAdjustmentDirections,
  payrollAdjustmentTypes,
  payrollFinalLineStatuses,
  payrollLineStatuses,
  payrollPeriodStatuses,
  type PayrollLineStatus,
  type PayrollPeriodStatus,
} from "./payroll-foundation.constants.js";

const conflict = 409;
const badRequest = 400;

export function assertPayrollCompanyScope(
  expectedCompanyId: string,
  actualCompanyId: string,
): void {
  if (expectedCompanyId !== actualCompanyId) {
    throw new ApplicationException(
      "payroll_company_mismatch",
      "The Payroll record does not belong to the active Company",
      conflict,
    );
  }
}

export function assertPayrollLineMutable(status: PayrollLineStatus): void {
  if (payrollFinalLineStatuses.has(status)) {
    throw new ApplicationException(
      "payroll_line_immutable",
      "Approved or finalized Payroll lines must be corrected through reversal",
      conflict,
    );
  }
}

export function assertPayrollReversalEligible(status: string): void {
  if (status === "reversed") {
    throw new ApplicationException(
      "payroll_already_reversed",
      "This Payroll record has already been reversed",
      conflict,
    );
  }
}

export function assertPayrollPeriodStatus(value: string): asserts value is PayrollPeriodStatus {
  if (!(payrollPeriodStatuses as readonly string[]).includes(value)) {
    throw new ApplicationException(
      "payroll_period_status_invalid",
      "The Payroll period status is invalid",
      badRequest,
    );
  }
}

export function assertPayrollLineStatus(value: string): asserts value is PayrollLineStatus {
  if (!(payrollLineStatuses as readonly string[]).includes(value)) {
    throw new ApplicationException(
      "payroll_line_status_invalid",
      "The Payroll line status is invalid",
      badRequest,
    );
  }
}

export function assertPayrollPeriodTransition(
  from: PayrollPeriodStatus,
  to: PayrollPeriodStatus,
): void {
  const allowed: Readonly<Record<PayrollPeriodStatus, readonly PayrollPeriodStatus[]>> = {
    approved: ["partially_paid", "paid", "reversed"],
    calculated: ["draft", "approved", "reversed"],
    closed: ["reversed"],
    draft: ["calculated", "reversed"],
    paid: ["closed", "reversed"],
    partially_paid: ["paid", "reversed"],
    reversed: [],
  };
  if (from !== to && !allowed[from].includes(to)) {
    throw new ApplicationException(
      "payroll_period_invalid_status",
      `Payroll period cannot transition from ${from} to ${to}`,
      conflict,
    );
  }
}

export function assertPayrollAdjustment(input: {
  amount: string | number;
  direction: string;
  reason: string;
  type: string;
}): void {
  if (!new Decimal(input.amount).isPositive()) {
    throw new ApplicationException(
      "payroll_adjustment_amount_invalid",
      "Payroll adjustment amount must be greater than zero",
      badRequest,
    );
  }
  if (!(payrollAdjustmentDirections as readonly string[]).includes(input.direction)) {
    throw new ApplicationException(
      "payroll_adjustment_direction_invalid",
      "Payroll adjustment direction is invalid",
      badRequest,
    );
  }
  if (!(payrollAdjustmentTypes as readonly string[]).includes(input.type)) {
    throw new ApplicationException(
      "payroll_adjustment_type_invalid",
      "Payroll adjustment type is invalid",
      badRequest,
    );
  }
  if (input.reason.trim().length === 0) {
    throw new ApplicationException(
      "payroll_adjustment_reason_required",
      "A reason is required for a Payroll adjustment",
      badRequest,
    );
  }
}

export function payrollOutstanding(netSalary: string | number, activeAllocated: string | number) {
  const outstanding = new Decimal(netSalary).minus(activeAllocated);
  if (outstanding.isNegative()) {
    throw new ApplicationException(
      "payroll_overallocated",
      "Payroll payment allocations cannot exceed the outstanding salary",
      conflict,
    );
  }
  return outstanding;
}

export function assertPayrollPaymentTotal(
  paymentTotal: string | number,
  allocations: readonly (string | number)[],
): void {
  if (allocations.length === 0 || allocations.some((amount) => !new Decimal(amount).isPositive())) {
    throw new ApplicationException(
      "payroll_allocation_amount_invalid",
      "Payroll payment allocations must be greater than zero",
      badRequest,
    );
  }
  const allocated = allocations.reduce((sum, amount) => sum.plus(amount), new Decimal(0));
  if (!allocated.equals(paymentTotal)) {
    throw new ApplicationException(
      "payroll_payment_total_mismatch",
      "Payroll payment total must equal its active allocation total",
      conflict,
    );
  }
}
