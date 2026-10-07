import { sql } from "kysely";

/**
 * Work that still belongs to an assigned Driver.
 *
 * A delivered Order stays here only while the Driver still has to hand over
 * customer money. Trader settlement is intentionally absent: that is Office
 * work, not a Driver task. Returned-to-branch is also absent because the
 * branch, not the Driver, owns the next return step.
 */
export function driverWorkPredicate(tableAlias = "o") {
  const deliveryStatus = sql.ref(`${tableAlias}.delivery_status`);
  const reconciliationStatus = sql.ref(`${tableAlias}.driver_reconciliation_status`);
  return sql<boolean>`(
    ${deliveryStatus} in ('assigned_to_driver', 'out_for_delivery')
    or (
      ${deliveryStatus} = 'delivered'
      and ${reconciliationStatus} = 'pending'
    )
  )`;
}

export function isDriverWorkStatus(input: {
  readonly deliveryStatus: string;
  readonly driverReconciliationStatus: string;
}): boolean {
  return (
    input.deliveryStatus === "assigned_to_driver" ||
    input.deliveryStatus === "out_for_delivery" ||
    (input.deliveryStatus === "delivered" && input.driverReconciliationStatus === "pending")
  );
}
