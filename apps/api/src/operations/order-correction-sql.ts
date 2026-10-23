import { type RawBuilder, sql } from "kysely";

/**
 * Order corrections (DCX) never change or delete the original collection,
 * settlement or 0-due line: they record the line in `order_correction_lines`
 * instead (migration 20261023100000). Every reader that asks "is this Order
 * still on this document?" must therefore skip a line named there. These
 * fragments are the one definition of that rule.
 *
 * Readers that show a document AS IT WAS (the original print, the audit
 * history) deliberately do not use them.
 */

/** The `driver_reconciliation_orders` row aliased `alias` was not removed by a correction. */
export function collectionLineActiveSql(alias: string): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  return sql<boolean>`not exists (
    select 1 from order_correction_lines removed_collection_line
     where removed_collection_line.company_id = ${column("company_id")}
       and removed_collection_line.driver_reconciliation_order_id = ${column("id")})`;
}

/** The `trader_settlement_orders` row aliased `alias` was not removed by a correction. */
export function settlementLineActiveSql(alias: string): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  return sql<boolean>`not exists (
    select 1 from order_correction_lines removed_settlement_line
     where removed_settlement_line.company_id = ${column("company_id")}
       and removed_settlement_line.trader_settlement_order_id = ${column("id")})`;
}

/** The `trader_settlement_zero_due_orders` row aliased `alias` was not removed by a correction. */
export function zeroDueLineActiveSql(alias: string): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  return sql<boolean>`not exists (
    select 1 from order_correction_lines removed_zero_due_line
     where removed_zero_due_line.company_id = ${column("company_id")}
       and removed_zero_due_line.zero_due_order_id = ${column("id")})`;
}

/** Plain-text twins, for the few readers that build SQL with `sql.raw`. */
export const collectionLineActiveRaw = (alias: string) =>
  `not exists (select 1 from order_correction_lines removed_collection_line
     where removed_collection_line.company_id = ${alias}.company_id
       and removed_collection_line.driver_reconciliation_order_id = ${alias}.id)`;

export const settlementLineActiveRaw = (alias: string) =>
  `not exists (select 1 from order_correction_lines removed_settlement_line
     where removed_settlement_line.company_id = ${alias}.company_id
       and removed_settlement_line.trader_settlement_order_id = ${alias}.id)`;
