import { Decimal } from "decimal.js";

import { ApplicationException } from "../presentation/errors/application.exception.js";

export const outsourcedDriverFeeRateStatuses = [
  "draft",
  "active",
  "superseded",
  "inactive",
] as const;
export const outsourcedDriverFeeAccrualStatuses = [
  "accrued",
  "partially_paid",
  "paid",
  "reversed",
  "recovery_required",
] as const;
export const outsourcedDriverFeeAccrualSources = [
  "delivery",
  "daily_reconciliation",
  "authorized_backfill",
] as const;
export const outsourcedDriverFeePaymentMethods = ["cash", "collection_offset"] as const;
export const outsourcedDriverFeePaymentSources = ["separate_payment", "driver_collection"] as const;
export const outsourcedDriverFeePaymentStatuses = ["confirmed", "reversed"] as const;
export const outsourcedDriverFeePermissionCodes = [
  "outsourced_driver_fees.view",
  "outsourced_driver_fees.manage",
  "outsourced_driver_fees.pay",
  "outsourced_driver_fees.reverse",
] as const;
export const outsourcedDriverFeeDefaultAllocationOrder = [
  "accrual_business_date",
  "delivery_date",
  "created_at",
  "id",
] as const;

export const outsourcedDriverFeeEligibilityOutcomes = [
  "eligible",
  "driver_not_outsourced",
  "no_effective_rate",
  "duplicate_accrual",
  "invalid_delivery_status",
  "missing_delivery_date",
  "company_mismatch",
  "represented_by_legacy_commission",
] as const;
export type OutsourcedDriverFeeEligibilityOutcome =
  (typeof outsourcedDriverFeeEligibilityOutcomes)[number];
export type OutsourcedDriverFeeAccrualStatus = (typeof outsourcedDriverFeeAccrualStatuses)[number];

export interface OutsourcedDriverFeeEligibilityInput {
  readonly activeOrHistoricalAccrualExists: boolean;
  readonly deliveredAt: string | null;
  readonly driverCompanyId: string;
  readonly driverType: string;
  readonly effectiveRateExists: boolean;
  readonly orderCompanyId: string;
  readonly orderStatus: string;
  readonly representedByLegacyCommission: boolean;
}

export interface OutsourcedDriverFeeReversalFoundation {
  readonly recoveryAmount: Decimal;
  readonly status: "recovery_required" | "reversed";
}

export const outsourcedDriverFeeIdempotencyOperations = {
  accrualBackfill: "outsourced_driver_fee.accrual.backfill",
  accrualCreate: "outsourced_driver_fee.accrual.create",
  accrualDailyReconciliation: "outsourced_driver_fee.accrual.daily_reconciliation",
  accrualDelivery: "outsourced_driver_fee.accrual.delivery",
  accrualReversal: "outsourced_driver_fee.accrual.reverse",
  allocationManual: "outsourced_driver_fee.allocation.manual",
  allocationProposal: "outsourced_driver_fee.allocation.propose",
  collectionOffsetConfirmation: "outsourced_driver_fee.collection_offset.confirm",
  collectionOffsetReversal: "outsourced_driver_fee.collection_offset.reverse",
  paymentConfirmation: "outsourced_driver_fee.payment.confirm",
  paymentReversal: "outsourced_driver_fee.payment.reverse",
} as const;

export function outsourcedDriverFeeOutstanding(
  earnedAmount: string | number,
  activeAllocatedAmount: string | number,
) {
  const outstanding = new Decimal(earnedAmount).minus(activeAllocatedAmount);
  if (outstanding.isNegative()) {
    throw new ApplicationException(
      "outsourced_driver_fee_overallocated",
      "Outsourced Driver fee allocations cannot exceed the accrual outstanding",
      409,
    );
  }
  return outstanding;
}

export function assertOutsourcedDriverFeePaymentTotal(
  paymentAmount: string | number,
  allocations: readonly (string | number)[],
): void {
  if (allocations.length === 0 || allocations.some((amount) => !new Decimal(amount).isPositive())) {
    throw new ApplicationException(
      "outsourced_driver_fee_allocation_amount_invalid",
      "Outsourced Driver fee payment allocations must be greater than zero",
      400,
    );
  }
  const allocated = allocations.reduce((sum, amount) => sum.plus(amount), new Decimal(0));
  if (!allocated.equals(paymentAmount)) {
    throw new ApplicationException(
      "outsourced_driver_fee_payment_total_mismatch",
      "Outsourced Driver fee payment total must equal its active allocation total",
      409,
    );
  }
}

export function assertOutsourcedDriverType(driverType: string): void {
  if (driverType !== "outsourced") {
    throw new ApplicationException(
      "outsourced_driver_required",
      "This operation requires an Outsourced Driver",
      409,
    );
  }
}

export function assertFeeCompanyScope(expectedCompanyId: string, actualCompanyId: string): void {
  if (expectedCompanyId !== actualCompanyId) {
    throw new ApplicationException(
      "outsourced_driver_fee_company_mismatch",
      "The Outsourced Driver fee record does not belong to the active Company",
      409,
    );
  }
}

export function evaluateOutsourcedDriverFeeEligibility(
  input: OutsourcedDriverFeeEligibilityInput,
): OutsourcedDriverFeeEligibilityOutcome {
  if (input.orderCompanyId !== input.driverCompanyId) {
    return "company_mismatch";
  }
  if (input.orderStatus !== "delivered") {
    return "invalid_delivery_status";
  }
  if (input.deliveredAt === null) {
    return "missing_delivery_date";
  }
  if (input.driverType !== "outsourced") {
    return "driver_not_outsourced";
  }
  if (input.activeOrHistoricalAccrualExists) {
    return "duplicate_accrual";
  }
  if (input.representedByLegacyCommission) {
    return "represented_by_legacy_commission";
  }
  return input.effectiveRateExists ? "eligible" : "no_effective_rate";
}

export function prepareOutsourcedDriverFeeAccrualReversal(input: {
  readonly activeAllocatedAmount: string | number;
  readonly reason: string;
  readonly status: OutsourcedDriverFeeAccrualStatus;
}): OutsourcedDriverFeeReversalFoundation {
  if (input.status === "reversed") {
    throw new ApplicationException(
      "outsourced_driver_fee_accrual_already_reversed",
      "This Outsourced Driver fee accrual has already been reversed",
      409,
    );
  }
  if (input.status === "recovery_required") {
    throw new ApplicationException(
      "outsourced_driver_fee_recovery_already_required",
      "Recovery has already been recorded for this Outsourced Driver fee accrual",
      409,
    );
  }
  if (input.reason.trim().length === 0) {
    throw new ApplicationException(
      "outsourced_driver_fee_reversal_reason_required",
      "A reversal reason is required",
      400,
    );
  }

  const allocated = new Decimal(input.activeAllocatedAmount);
  if (allocated.isNegative()) {
    throw new ApplicationException(
      "outsourced_driver_fee_paid_amount_invalid",
      "The active allocated amount cannot be negative",
      409,
    );
  }
  return allocated.isZero()
    ? { recoveryAmount: new Decimal(0), status: "reversed" }
    : { recoveryAmount: allocated, status: "recovery_required" };
}

export function assertOutsourcedDriverFeePaymentSource(input: {
  readonly linkedDriverReconciliationId: string | null;
  readonly paymentMethod: string;
  readonly paymentSource: string;
}): void {
  const separateCashPayment =
    input.paymentMethod === "cash" &&
    input.paymentSource === "separate_payment" &&
    input.linkedDriverReconciliationId === null;
  const collectionOffset =
    input.paymentMethod === "collection_offset" &&
    input.paymentSource === "driver_collection" &&
    input.linkedDriverReconciliationId !== null;
  if (!separateCashPayment && !collectionOffset) {
    throw new ApplicationException(
      "outsourced_driver_fee_payment_source_invalid",
      "The payment method, source, and Driver Collection link are inconsistent",
      400,
    );
  }
}

export function assertOutsourcedDriverFeePaymentReversalEligible(status: string): void {
  if (status === "reversed") {
    throw new ApplicationException(
      "outsourced_driver_fee_payment_already_reversed",
      "This Outsourced Driver fee payment has already been reversed",
      409,
    );
  }
}
