/**
 * The Driver Cash Status an Order takes when its delivery status changes.
 *
 * Shared by the Driver/mobile path (`operations.service.ts`) and the office
 * "Change delivery status" path (`orders-workflow.service.ts`) so the two can
 * never disagree.
 *
 * Rule (Aiman, 10 Oct 2026 -- Option A of
 * `claude/driver-collection-mixed-payment-spec.md`, R6):
 * - `hold` and `closed` keep whatever the Order already had.
 * - `delivered` with an assigned Driver becomes `pending` -- INCLUDING an Order
 *   with nothing to collect from the customer (COD 0, Trader pays the fee).
 *   It then appears in Driver Collections at 0.00, so it is counted in the
 *   collection, its Outsourced Driver fee can be offset there, and it counts
 *   towards collection earnings. Before this rule such Orders were
 *   `not_applicable` and never reached a collection.
 * - The one exception is an explicit Free Order with no value at all
 *   (`is_free_order`, nothing due from the customer, nothing payable to the
 *   Trader). Those stay `not_applicable`, exactly as the 14 Aug 2026 repair
 *   (`20260814000000_free_order_delivered_status_repair`) established.
 * - Every other status is `not_applicable`.
 */
export interface DriverCashStatusInput {
  readonly status: string;
  readonly assignedDriverId: string | null;
  readonly currentDriverReconciliationStatus: string;
  readonly customerAmountDue: number;
  readonly isFreeOrder: boolean | null | undefined;
  readonly traderNetPayable: number;
}

export function isDeliveredFreeNoValue(input: {
  readonly status: string;
  readonly customerAmountDue: number;
  readonly isFreeOrder: boolean | null | undefined;
  readonly traderNetPayable: number;
}): boolean {
  return (
    input.status === "delivered" &&
    input.isFreeOrder === true &&
    input.customerAmountDue === 0 &&
    Number.isFinite(input.traderNetPayable) &&
    input.traderNetPayable <= 0
  );
}

export function driverCashStatusAfterStatusChange(input: DriverCashStatusInput): string {
  if (input.status === "hold" || input.status === "closed") {
    return input.currentDriverReconciliationStatus;
  }
  if (
    input.status === "delivered" &&
    input.assignedDriverId !== null &&
    Number.isFinite(input.customerAmountDue) &&
    input.customerAmountDue >= 0 &&
    !isDeliveredFreeNoValue(input)
  ) {
    return "pending";
  }
  return "not_applicable";
}
