/**
 * Orders menu ("order views") -- the SQL a custom tab filters by.
 *
 * Pure: takes a validated definition and returns a predicate over the Orders
 * list's `o` alias. The menu itself is validated by
 * `company-configuration/order-views.ts` on save and again on read, so every
 * value reaching here is already one of the allowed statuses, windows and
 * fields. Statuses and dates are still sent as bound parameters, never
 * concatenated.
 *
 * Dates follow the Company-local day, the same convention Delivery Activity
 * uses: `order_date` is already a date; `created_at` and `delivered_at` are
 * instants and are read in the Company's timezone, and "today" is today in
 * that timezone. Weeks start on Monday (Postgres `date_trunc('week')`).
 */
import { type RawBuilder, sql } from "kysely";

import type { CustomViewDefinition } from "../company-configuration/order-views.js";

function dateExpression(
  field: CustomViewDefinition["dateField"],
  timezone: string,
): RawBuilder<unknown> {
  switch (field) {
    case "created_at":
      return sql`(o.created_at at time zone ${timezone})::date`;
    case "delivered_at":
      return sql`(o.delivered_at at time zone ${timezone})::date`;
    case "order_date":
    default:
      return sql`o.order_date`;
  }
}

function windowPredicate(
  definition: CustomViewDefinition,
  timezone: string,
): RawBuilder<unknown> | null {
  const day = dateExpression(definition.dateField, timezone);
  const today = sql`(now() at time zone ${timezone})::date`;
  const week = sql`date_trunc('week', ${today})::date`;
  const month = sql`date_trunc('month', ${today})::date`;
  switch (definition.dateWindow) {
    case "today":
      return sql`${day} = ${today}`;
    case "yesterday":
      return sql`${day} = ${today} - 1`;
    case "this_week":
      return sql`${day} >= ${week} and ${day} < ${week} + 7`;
    case "last_week":
      return sql`${day} >= ${week} - 7 and ${day} < ${week}`;
    case "this_month":
      return sql`${day} >= ${month} and ${day} < (${month} + interval '1 month')::date`;
    case "last_month":
      return sql`${day} >= (${month} - interval '1 month')::date and ${day} < ${month}`;
    case "last_n_days": {
      const days = definition.lastNDays ?? 1;
      return sql`${day} >= ${today} - ${days - 1}::int and ${day} <= ${today}`;
    }
    case "range":
      return sql`${day} >= ${definition.dateFrom ?? null}::date and ${day} <= ${definition.dateTo ?? null}::date`;
    case "any":
    default:
      return null;
  }
}

/** `true` when the definition filters nothing (every status, any date). */
export function customOrderViewPredicate(
  definition: CustomViewDefinition,
  timezone: string,
): RawBuilder<unknown> {
  const parts: RawBuilder<unknown>[] = [];
  if (definition.statuses.length > 0) {
    parts.push(sql`o.delivery_status in (${sql.join(definition.statuses)})`);
  }
  const dates = windowPredicate(definition, timezone);
  if (dates !== null) {
    // An Order that was never delivered has no delivery date, so it cannot be
    // in any delivery-date window. Explicit, so the intent survives edits.
    if (definition.dateField === "delivered_at") parts.push(sql`o.delivered_at is not null`);
    parts.push(dates);
  }
  if (parts.length === 0) return sql`true`;
  return sql`(${sql.join(parts, sql` and `)})`;
}

/** Active Orders' statuses: the menu's list in place of the standard one. */
export function activeStatusPredicate(statuses: readonly string[] | null): RawBuilder<unknown> {
  if (statuses === null) {
    // Byte-for-byte the standard list, so Companies without a custom menu run
    // exactly the query they always ran.
    return sql`o.delivery_status in ('new','in_branch','assigned_to_driver','out_for_delivery','hold','delivered','returned_to_branch','returned_to_trader','collect_order')`;
  }
  if (statuses.length === 0) return sql`false`;
  return sql`o.delivery_status in (${sql.join(statuses)})`;
}
