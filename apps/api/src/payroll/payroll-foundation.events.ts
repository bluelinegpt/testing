export const payrollAccountingEventTypes = [
  "payroll.period.approved",
  "payroll.payment.confirmed",
  "payroll.payment.reversed",
  "payroll.period.reversed",
  "outsourced_driver_fee.accrual.created",
  "outsourced_driver_fee.accrual.reversed",
  "outsourced_driver_fee.accrual.recovery_required",
  "outsourced_driver_fee.payment.confirmed",
  "outsourced_driver_fee.payment.reversed",
  "outsourced_driver_fee.collection_offset.confirmed",
  "outsourced_driver_fee.collection_offset.reversed",
] as const;

export type PayrollAccountingEventType = (typeof payrollAccountingEventTypes)[number];

/**
 * Contract only. No Accounting posting or event publishing is implemented by
 * the Payroll foundation prompts.
 */
export interface PayrollAccountingEventContract {
  readonly amountAed: string;
  readonly companyId: string;
  readonly createdAt: string;
  readonly effectiveDate: string;
  readonly eventType: PayrollAccountingEventType;
  readonly eventVersion: 1;
  readonly idempotencyKey: string;
  readonly sourceId: string;
  readonly sourceType:
    | "outsourced_driver_fee_accrual"
    | "outsourced_driver_fee_payment"
    | "payroll_payment"
    | "payroll_period";
}
