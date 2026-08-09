import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * An Order that is deliberately free, as a stated fact rather than an inference.
 *
 * ---------------------------------------------------------------------------
 * WHY A FLAG, WHEN COD 0 AND FEE 0 ALREADY EXIST
 * ---------------------------------------------------------------------------
 *
 * "This Order is worth nothing" and "we chose to give this delivery away" are
 * different business facts that happen to produce the same two numbers. The
 * first can be a pricing gap, a data-entry slip, or a Trader configured at zero;
 * the second is a decision somebody made and should have to justify.
 *
 * Deriving the second from the first would make every pricing accident look like
 * a promotion, and would leave nobody accountable for either. So the intent is
 * stored, with the reason, and the zero amounts follow from it.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT IS A DATABASE FACT
 * ---------------------------------------------------------------------------
 *
 * `orders_free_order_shape_check` makes the mixed state unrepresentable: a free
 * Order carries a non-blank reason and zeroes on both COD and Service Fee, and a
 * non-free Order carries no free-order reason at all. A client that sends
 * `isFreeOrder: true` with `cod: 300` cannot produce a row, whatever the service
 * layer does or fails to do.
 *
 * The service still forces the zeroes itself -- a constraint violation is a
 * safety net, not an error message an operator should ever see -- but the net
 * is what makes the guarantee true rather than merely intended.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT TOUCH
 * ---------------------------------------------------------------------------
 *
 * Nothing about Trader pricing. A free Order is one Order; the Trader's
 * configured rate is unchanged and the next Order prices normally. The existing
 * `service_fee_override_reason` also stays as it is, because
 * `orders_zero_service_fee_reason_check` still requires it whenever the fee is
 * zero -- the service copies the operator's free-order reason into it so both
 * the general zero-fee rule and the specific free-order record are satisfied by
 * the same stated words. `is_free_order` remains the discriminator that tells a
 * deliberate free delivery apart from a configured-zero price or any other
 * zero-fee override.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders
      add column is_free_order boolean not null default false,
      add column free_order_reason text;

    alter table orders
      add constraint orders_free_order_shape_check check (
        (
          is_free_order
          and free_order_reason is not null
          and btrim(free_order_reason) <> ''
          and cod_amount = 0
          and service_fee = 0
        )
        or (not is_free_order and free_order_reason is null)
      );

    -- Reporting reads "the free Orders in this Company", never "is this one
    -- free". Partial, because the flag is false on almost every row.
    create index if not exists orders_company_free_order_index
      on orders (company_id, order_date desc)
      where is_free_order;

    comment on column orders.is_free_order is
      'A deliberate free delivery, stated by the operator. Never inferred from zero amounts: a zero-valued Order may be a pricing gap, and the two must stay distinguishable.';
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists orders_company_free_order_index;
    alter table orders
      drop constraint if exists orders_free_order_shape_check,
      drop column if exists free_order_reason,
      drop column if exists is_free_order;
  `.execute(database);
}
