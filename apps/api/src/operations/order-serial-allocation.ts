import { type Kysely, sql, type Transaction } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * Automatic Serial Number assignment ("smart last number"), agreed with Aiman
 * on 9 Oct 2026.
 *
 * A Serial Number left blank on create is assigned by the server INSIDE the
 * create transaction, at the moment of saving -- never pre-fetched by a screen
 * when it opens. Two users with the same screen open can therefore no longer
 * be shown, and then race for, the same number.
 *
 * A typed Serial Number is never changed: it is saved as typed or refused as a
 * duplicate for the day. Because people sometimes type a number far outside
 * the running sequence (a parcel label, a Trader's own sheet), the automatic
 * number must not simply be `max + 1`: one typed `500` would otherwise make
 * every later automatic number jump to 501.
 *
 * Rule: walk the day's numeric serials from the highest down. A serial whose
 * gap down to the next lower existing serial (or to 0) is greater than
 * `gapLimit` is treated as a manual outlier and skipped. The first serial
 * within the limit is the real last number; the next serial is that + 1,
 * stepping over any number that is already taken.
 *
 * Small natural gaps are normal -- Lahthza, 8 Oct 2026: 60 Orders, highest
 * Serial 63 -- and are NOT refilled, because the walk stops at the highest
 * serial whose own gap is within the limit.
 */
export const AUTOMATIC_SERIAL_GAP_LIMIT = 10;

const numericSerialPattern = /^[0-9]+$/u;

export function nextAutomaticSerial(
  existing: readonly string[],
  gapLimit: number = AUTOMATIC_SERIAL_GAP_LIMIT,
): string {
  const zero = BigInt(0);
  const one = BigInt(1);
  const limit = BigInt(gapLimit);
  const taken = new Set<bigint>();
  for (const value of existing) {
    const trimmed = value.trim();
    if (numericSerialPattern.test(trimmed)) taken.add(BigInt(trimmed));
  }
  const descending = [...taken].sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
  let realLast = zero;
  for (let index = 0; index < descending.length; index += 1) {
    const current = descending[index]!;
    const below = descending[index + 1] ?? zero;
    if (current - below <= limit) {
      realLast = current;
      break;
    }
  }
  let candidate = realLast + one;
  while (taken.has(candidate)) candidate += one;
  return candidate.toString();
}

/**
 * Takes the per-Company, per-day allocator lock and returns the next automatic
 * Serial Number for the Order Business Date (`current_date`, exactly as the
 * duplicate check in `assertOrderIdentifiersAvailable` and the INSERT use it --
 * this deliberately does NOT change which day a Serial belongs to).
 *
 * The lock is transaction-scoped, so a second automatic create for the same
 * Company and day waits until the first commits or rolls back, then sees its
 * row. A rolled-back create therefore consumes no number.
 *
 * `alsoTaken` lets the caller step over a number it just tried and lost to a
 * typed Serial that committed between this read and the per-serial lock.
 */
export async function allocateAutomaticOrderSerial(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  companyId: string,
  alsoTaken: readonly string[] = [],
): Promise<string> {
  await sql`
    select pg_advisory_xact_lock(
      hashtext(${companyId}),
      hashtext('order-serial-allocator:' || current_date::text)
    )
  `.execute(database);
  const result = await sql<{ serial: string }>`
    select distinct serial_number as serial
      from orders
     where company_id = ${companyId}::uuid
       and order_date = current_date
       and serial_number ~ '^[0-9]+$'
  `.execute(database);
  return nextAutomaticSerial([...result.rows.map((row) => row.serial), ...alsoTaken]);
}
