/**
 * Orders list "Delivery status" filter.
 *
 * The filter takes one status or several, comma separated
 * ("assigned_to_driver,out_for_delivery"), so the Orders screen can tick more
 * than one. One status reads exactly as it always did. Values are trimmed,
 * blanks and duplicates dropped, and each one is sent as a bound parameter,
 * never concatenated. An unknown value simply matches no Order, the same as
 * the single-value filter always behaved.
 *
 * Shared by the list, count, export, bulk-selection and driver-manifest
 * queries so "the Orders I filtered" is the same set everywhere. Every caller
 * uses the `o` alias for `orders`.
 */
import { type RawBuilder, sql } from "kysely";

/** Upper bound on how many statuses one request may carry. */
const maximumStatuses = 20;

export function parseDeliveryStatusFilter(value: string | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  const statuses: string[] = [];
  for (const part of value.split(",")) {
    const status = part.trim();
    if (status.length > 0 && !statuses.includes(status)) statuses.push(status);
    if (statuses.length >= maximumStatuses) break;
  }
  return statuses;
}

/** `true` when no status is chosen; otherwise `o.delivery_status in (...)`. */
export function deliveryStatusFilterPredicate(value: string | null | undefined): RawBuilder<unknown> {
  const statuses = parseDeliveryStatusFilter(value);
  if (statuses.length === 0) return sql`true`;
  return sql`(o.delivery_status in (${sql.join(statuses)}))`;
}
