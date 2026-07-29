import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Order Serial Number uniqueness, rescoped to daily instead of forever.
 *
 * Before this migration, `orders_serial_number_normalized_unique` (added in
 * `20260723140000_order_identifiers_financial_model.ts`) enforced
 * `(company_id, serial_number_normalized)` uniqueness for the lifetime of the
 * Company — Serial Number "1" could only ever be used once, period. The
 * approved rule is narrower: the same Serial Number cannot be reused on the
 * same Business Date (`orders.order_date`, the only date-of-record column on
 * `orders` — there is no separate `business_date` column, and `order_date` is
 * always server-set to `current_date` at Order creation), but the same
 * Serial Number is expected to repeat on a different date. The old,
 * stricter, date-unaware index is therefore replaced (not kept alongside)
 * by `orders_daily_serial_number_unique` on
 * `(company_id, order_date, serial_number_normalized)`.
 *
 * `serial_number_normalized` already carries the app's own normalization
 * (NFKC, trimmed, internal whitespace collapsed, lower-cased —
 * `OperationsService.normalizeOrderIdentifier`) and is populated by the
 * application at INSERT time, never derived in SQL, so no column or trigger
 * changes are needed here — this migration only touches the index. Leading
 * zeros are preserved throughout: `serial_number`/`serial_number_normalized`
 * are `text`, never cast to a numeric type, and normalization never strips
 * digits. `orders_reference_number_normalized_unique` (External Reference
 * Number) is untouched.
 *
 * Existing data is preserved unconditionally: a `do $$ ... $$` guard runs
 * first and RAISES (rolling back the whole migration, applying nothing) if
 * any existing Orders would already violate the new, narrower index — i.e.
 * two Orders sharing `(company_id, order_date, serial_number_normalized)`.
 * That can only happen today if two Orders were created for the same
 * Company on the same day with what normalizes to the same Serial Number,
 * which the OLD (stricter, cross-date) index should have already prevented
 * — so in practice this guard is expected to find nothing and is a safety
 * net, not an anticipated blocker. No duplicate Order is ever deleted or
 * rewritten by this migration; if the guard fires, the reported rows must be
 * corrected manually before re-running the migration.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    do $$
    declare
      conflict_summary text;
    begin
      select string_agg(
        format(
          'company_id=%s, order_date=%s, serial_number_normalized=%s, duplicate_count=%s',
          d.company_id, d.order_date, d.serial_number_normalized, d.cnt
        ),
        E'\n' order by d.company_id, d.order_date, d.serial_number_normalized
      )
        into conflict_summary
        from (
          select company_id, order_date, serial_number_normalized, count(*) as cnt
            from orders
           where serial_number_normalized is not null
           group by company_id, order_date, serial_number_normalized
          having count(*) > 1
           limit 50
        ) d;

      if conflict_summary is not null then
        raise exception E'Cannot add daily Serial Number uniqueness: existing duplicate Orders found (showing up to 50 groups):\n%', conflict_summary
          using errcode = 'unique_violation';
      end if;
    end $$;

    drop index if exists orders_serial_number_normalized_unique;

    create unique index orders_daily_serial_number_unique
      on orders (company_id, order_date, serial_number_normalized)
      where serial_number_normalized is not null;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists orders_daily_serial_number_unique;

    create unique index orders_serial_number_normalized_unique
      on orders (company_id, serial_number_normalized)
      where serial_number_normalized is not null;
  `.execute(database);
}
