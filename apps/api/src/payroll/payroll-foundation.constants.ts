export const payrollPeriodStatuses = [
  "draft",
  "calculated",
  "approved",
  "partially_paid",
  "paid",
  "closed",
  "reversed",
] as const;
export type PayrollPeriodStatus = (typeof payrollPeriodStatuses)[number];

export const payrollLineStatuses = [
  "draft",
  "calculated",
  "approved",
  "partially_paid",
  "paid",
  "held",
  "reversed",
] as const;
export type PayrollLineStatus = (typeof payrollLineStatuses)[number];

export const payrollAdjustmentTypes = [
  "bonus",
  "penalty",
  "unpaid_leave",
  "advance_recovery",
  "correction",
  "other",
] as const;
export type PayrollAdjustmentType = (typeof payrollAdjustmentTypes)[number];

export const payrollAdjustmentDirections = ["earning", "deduction"] as const;
export type PayrollAdjustmentDirection = (typeof payrollAdjustmentDirections)[number];

export const payrollAdjustmentStatuses = ["active", "reversed"] as const;
export const payrollPaymentStatuses = ["confirmed", "reversed"] as const;
export const payrollAcknowledgementTypes = [
  "checkbox",
  "typed_name",
  "physical_signature",
] as const;
export const payrollPaymentMethods = ["cash"] as const;
export const payrollFrequency = "monthly" as const;
export const payrollSalaryProrationSupported = false as const;

export const payrollReferenceDefinitions = {
  payrollPayment: {
    prefix: "PAYPMT",
    referenceType: "payroll_payment",
  },
  outsourcedDriverFeePayment: {
    prefix: "DFPAY",
    referenceType: "outsourced_driver_fee_payment",
  },
} as const;

export const payrollPermissionCodes = [
  "payroll.view",
  "payroll.manage",
  "payroll.approve",
  "payroll.pay",
  "payroll.reverse",
] as const;

export const payrollIdempotencyOperations = {
  adjustmentCreate: "payroll.adjustment.create",
  adjustmentReversal: "payroll.adjustment.reverse",
  approval: "payroll.approve",
  calculation: "payroll.calculate",
  periodClose: "payroll.period.close",
  periodCreate: "payroll.period.create",
  paymentConfirmation: "payroll.payment.confirm",
  paymentReversal: "payroll.payment.reverse",
  periodReversal: "payroll.period.reverse",
  recalculation: "payroll.recalculate",
} as const;

export const payrollFinalLineStatuses: ReadonlySet<PayrollLineStatus> = new Set([
  "approved",
  "partially_paid",
  "paid",
  "held",
  "reversed",
]);
