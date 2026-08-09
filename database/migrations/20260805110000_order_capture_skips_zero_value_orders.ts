import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Stop a zero-value delivered Order from raising an Accounting Event.
 *
 * `capture_order_accounting_event` fired on every transition into `delivered`,
 * regardless of amounts. An Order carrying no money at all therefore produced
 * an Accounting Event, which produced a Journal with nothing meaningful in it —
 * or failed, because a Journal with no lines cannot balance. Either outcome is
 * noise in the ledger and in the Events list.
 *
 * The rule is applied HERE, in the capture trigger, rather than being spread
 * across the writer, the processor and the posting service. Capture is the one
 * place every delivered Order passes through, so one guard covers them all and
 * there is a single place to read the policy from.
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS AS ACCOUNTING IMPACT
 * ---------------------------------------------------------------------------
 *
 * COD and Service Fee are the headline case, but they are not the whole of an
 * Order's financial substance. An Order with no COD and no Service Fee can
 * still carry Additional Fees or VAT, and suppressing its Event would lose
 * real revenue recognition.
 *
 * The guard therefore tests TOTAL impact — cod_amount, service_fee,
 * additional_fees and vat_amount. "Both zero" remains necessary for an Order
 * to be classified No Accounting Required; it is simply not sufficient on its
 * own. Every column named here was confirmed to exist on `orders` before this
 * migration was written.
 *
 * Comparisons are strict numeric `<> 0` against a `coalesce(..., 0)`, never a
 * truthy test: `0.00`, `0` and NULL all behave identically and predictably.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REVERSAL BRANCH IS NOT GATED
 * ---------------------------------------------------------------------------
 *
 * It does not need to be. `enqueue_operational_accounting_event` already
 * returns early when a reversal cannot find its original Event:
 *
 *     if reversal_source_id is not null then
 *       select e.id into original_event_id ...
 *       if original_event_id is null then return; end if;
 *     end if;
 *
 * A zero-value Order never created a delivery Event, so a later return or
 * cancellation finds no original and no-ops on its own. Adding a second guard
 * here would be redundant and would risk the two drifting apart.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCY AND HISTORY
 * ---------------------------------------------------------------------------
 *
 * Event identity is unchanged: `enqueue_operational_accounting_event` still
 * builds the same stable key and still relies on
 * `accounting_events_identity_unique` for its `on conflict do nothing`. This
 * migration only decides WHETHER the helper is called, never how it behaves.
 *
 * No existing row is read, written or backfilled. Orders already delivered
 * keep the Events and Journals they already have.
 */

const declaration = `create or replace function capture_order_accounting_event() returns trigger language plpgsql as $function$`;

/** Fires for every delivered Order, whatever it is worth. */
const alwaysCapture = `
begin
  if new.delivery_status='delivered'
     and old.delivery_status is distinct from 'delivered' then
    perform enqueue_operational_accounting_event(
      new.company_id,'orders','order_delivered','order',new.id,new.order_number,
      coalesce((new.delivered_at at time zone 'Asia/Dubai')::date,new.order_date),
      new.created_by_account_id,'order-delivery:'||new.id::text
    );
  elsif old.delivery_status='delivered'
     and new.delivery_status in ('returned_to_trader','cancelled') then
    perform enqueue_operational_accounting_event(
      new.company_id,'orders','order_recognition_reversed','order',new.id,new.order_number,
      (now() at time zone 'Asia/Dubai')::date,new.created_by_account_id,
      'order-reversal:'||new.id::text,'order',new.id
    );
  end if;
  return new;
end;
`;

/** Skips capture when the delivered Order carries no financial substance. */
const skipZeroValue = `
declare
  accounting_impact numeric(18,2);
begin
  if new.delivery_status='delivered'
     and old.delivery_status is distinct from 'delivered' then
    accounting_impact :=
      abs(coalesce(new.cod_amount, 0))
      + abs(coalesce(new.service_fee, 0))
      + abs(coalesce(new.additional_fees, 0))
      + abs(coalesce(new.vat_amount, 0));
    -- Strict numeric comparison. abs() so components can never cancel each
    -- other out and hide a real impact behind a coincidental net of zero.
    if accounting_impact <> 0 then
      perform enqueue_operational_accounting_event(
        new.company_id,'orders','order_delivered','order',new.id,new.order_number,
        coalesce((new.delivered_at at time zone 'Asia/Dubai')::date,new.order_date),
        new.created_by_account_id,'order-delivery:'||new.id::text
      );
    end if;
  elsif old.delivery_status='delivered'
     and new.delivery_status in ('returned_to_trader','cancelled') then
    -- Ungated on purpose: the helper no-ops when no original Event exists.
    perform enqueue_operational_accounting_event(
      new.company_id,'orders','order_recognition_reversed','order',new.id,new.order_number,
      (now() at time zone 'Asia/Dubai')::date,new.created_by_account_id,
      'order-reversal:'||new.id::text,'order',new.id
    );
  end if;
  return new;
end;
`;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql.raw(`${declaration}${skipZeroValue}$function$;`).execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql.raw(`${declaration}${alwaysCapture}$function$;`).execute(database);
}
