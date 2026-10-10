import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Driver Collections: Cash/Visa per Order, zero-collection Orders and
 * Company-pays-Driver (Aiman, 10-11 Oct 2026; spec
 * `claude/driver-collection-mixed-payment-spec.md`, section 5).
 *
 * Additive and forward-only. No existing row changes value.
 *
 * 1. Collection header method gains `mixed` (Cash and Visa Orders in one
 *    collection) and `none` (only Orders with nothing to collect). It stays
 *    derived by the application, never chosen.
 * 2. Collection Order line method gains `none` for a zero-collection Order.
 * 3. Collection payments gain `direction`: `in` (money received, every
 *    existing row) or `out` (cash the Company pays the Driver when expenses
 *    exceed the cash collected). `out` is Cash only -- never a transfer.
 * 4. The header no longer requires `net_amount_received >= 0`. The identity
 *    `net = gross - driver payable deduction - expenses` is kept. A negative
 *    net is a Company-pays-Driver collection.
 * 5. The confirmation trigger compares the SIGNED payment total (in minus out)
 *    with the net. This replaces "net > 0 => payments equal net; net = 0 =>
 *    no payments; net < 0 forbidden", which could not express a mixed
 *    collection (Visa received while cash is paid out) or a payout. Every
 *    collection the old rule accepted is still accepted: all existing
 *    payments are `in`, so their signed total is their plain total.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table driver_reconciliations
      drop constraint if exists driver_reconciliations_collection_payment_method_check;
    alter table driver_reconciliations
      add constraint driver_reconciliations_collection_payment_method_check
      check (
        collection_payment_method is null
        or collection_payment_method in ('cash', 'visa', 'mixed', 'none')
      );

    alter table driver_reconciliation_orders
      drop constraint if exists driver_reconciliation_orders_collection_payment_method_check;
    alter table driver_reconciliation_orders
      add constraint driver_reconciliation_orders_collection_payment_method_check
      check (
        collection_payment_method is null
        or collection_payment_method in ('cash', 'visa', 'none')
      );

    alter table driver_reconciliation_payments
      add column direction text not null default 'in';
    alter table driver_reconciliation_payments
      add constraint driver_reconciliation_payments_direction_check
      check (direction in ('in', 'out'));
    alter table driver_reconciliation_payments
      add constraint driver_reconciliation_payments_direction_method_check
      check (direction = 'in' or payment_method = 'cash');

    alter table driver_reconciliations
      drop constraint if exists driver_reconciliations_amounts_check;
    alter table driver_reconciliations
      add constraint driver_reconciliations_amounts_check check (
        gross_collections >= 0 and driver_payable_deduction >= 0 and reconciliation_expenses >= 0
        and net_amount_received = gross_collections - driver_payable_deduction - reconciliation_expenses
      );

    create or replace function validate_driver_reconciliation_confirmation() returns trigger language plpgsql as $$
    declare
      line_count bigint;
      line_gross numeric(18,2);
      line_deduction numeric(18,2);
      expense_total numeric(18,2);
      signed_payment_total numeric(18,2);
      untraceable_payment_count bigint;
    begin
      if new.status <> 'confirmed' or old.status = 'confirmed' then return new; end if;
      perform 1 from orders target_order
      where target_order.company_id = new.company_id and exists (
        select 1 from driver_reconciliation_orders line
        where line.company_id = new.company_id and line.reconciliation_id = new.id
          and line.order_id = target_order.id
      ) order by target_order.id for update;
      if exists (
        select 1 from driver_reconciliation_orders line
        join orders target_order on target_order.id = line.order_id and target_order.company_id = line.company_id
        where line.company_id = new.company_id and line.reconciliation_id = new.id and (
          target_order.assigned_driver_id is distinct from new.driver_id
          or target_order.delivery_status <> 'delivered'
          or target_order.driver_reconciliation_status <> 'pending'
        )
      ) then
        raise exception using errcode = '23514',
          message = 'Driver reconciliation contains an ineligible or wrong-Driver Order';
      end if;
      select count(*), coalesce(sum(customer_collection_amount), 0),
             coalesce(sum(driver_payable_deduction), 0)
        into line_count, line_gross, line_deduction from driver_reconciliation_orders
      where company_id = new.company_id and reconciliation_id = new.id;
      select coalesce(sum(amount), 0) into expense_total from driver_reconciliation_expenses
      where company_id = new.company_id and reconciliation_id = new.id;
      select coalesce(sum(case when direction = 'out' then -amount else amount end), 0),
             count(*) filter (where created_by_account_id is null or payment_at is null)
        into signed_payment_total, untraceable_payment_count
      from driver_reconciliation_payments where company_id = new.company_id and reconciliation_id = new.id;
      if line_count = 0 or new.gross_collections is distinct from line_gross
        or new.driver_payable_deduction is distinct from line_deduction
        or new.reconciliation_expenses is distinct from expense_total
        or new.net_amount_received is distinct from line_gross - line_deduction - expense_total then
        raise exception using errcode = '23514',
          message = 'Driver reconciliation header totals do not match Order and expense lines';
      end if;
      if signed_payment_total is distinct from new.net_amount_received then
        raise exception using errcode = '23514',
          message = 'Driver reconciliation payment total does not match net amount received';
      end if;
      if untraceable_payment_count <> 0 then
        raise exception using errcode = '23514',
          message = 'Confirmed Driver reconciliation payments require an actor and payment timestamp';
      end if;
      return new;
    end;
    $$;
  `.execute(database);
}

/**
 * Restores the previous rules. Fails by design if any confirmed collection
 * already uses `mixed`/`none`, an `out` payment or a negative net -- those
 * rows must be reversed first; nothing is rewritten silently.
 */
export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function validate_driver_reconciliation_confirmation() returns trigger language plpgsql as $$
    declare
      line_count bigint;
      line_gross numeric(18,2);
      line_deduction numeric(18,2);
      expense_total numeric(18,2);
      payment_count bigint;
      payment_total numeric(18,2);
      untraceable_payment_count bigint;
    begin
      if new.status <> 'confirmed' or old.status = 'confirmed' then return new; end if;
      perform 1 from orders target_order
      where target_order.company_id = new.company_id and exists (
        select 1 from driver_reconciliation_orders line
        where line.company_id = new.company_id and line.reconciliation_id = new.id
          and line.order_id = target_order.id
      ) order by target_order.id for update;
      if exists (
        select 1 from driver_reconciliation_orders line
        join orders target_order on target_order.id = line.order_id and target_order.company_id = line.company_id
        where line.company_id = new.company_id and line.reconciliation_id = new.id and (
          target_order.assigned_driver_id is distinct from new.driver_id
          or target_order.delivery_status <> 'delivered'
          or target_order.driver_reconciliation_status <> 'pending'
        )
      ) then
        raise exception using errcode = '23514',
          message = 'Driver reconciliation contains an ineligible or wrong-Driver Order';
      end if;
      select count(*), coalesce(sum(customer_collection_amount), 0),
             coalesce(sum(driver_payable_deduction), 0)
        into line_count, line_gross, line_deduction from driver_reconciliation_orders
      where company_id = new.company_id and reconciliation_id = new.id;
      select coalesce(sum(amount), 0) into expense_total from driver_reconciliation_expenses
      where company_id = new.company_id and reconciliation_id = new.id;
      select count(*), coalesce(sum(amount), 0),
             count(*) filter (where created_by_account_id is null or payment_at is null)
        into payment_count, payment_total, untraceable_payment_count
      from driver_reconciliation_payments where company_id = new.company_id and reconciliation_id = new.id;
      if line_count = 0 or new.gross_collections is distinct from line_gross
        or new.driver_payable_deduction is distinct from line_deduction
        or new.reconciliation_expenses is distinct from expense_total
        or new.net_amount_received is distinct from line_gross - line_deduction - expense_total then
        raise exception using errcode = '23514',
          message = 'Driver reconciliation header totals do not match Order and expense lines';
      end if;
      if new.net_amount_received < 0
        or (new.net_amount_received > 0 and payment_total is distinct from new.net_amount_received)
        or (new.net_amount_received = 0 and payment_count <> 0) then
        raise exception using errcode = '23514',
          message = 'Driver reconciliation payment total does not match net amount received';
      end if;
      if untraceable_payment_count <> 0 then
        raise exception using errcode = '23514',
          message = 'Confirmed Driver reconciliation payments require an actor and payment timestamp';
      end if;
      return new;
    end;
    $$;

    alter table driver_reconciliations
      drop constraint if exists driver_reconciliations_amounts_check;
    alter table driver_reconciliations
      add constraint driver_reconciliations_amounts_check check (
        gross_collections >= 0 and driver_payable_deduction >= 0 and reconciliation_expenses >= 0
        and net_amount_received >= 0
        and net_amount_received = gross_collections - driver_payable_deduction - reconciliation_expenses
      );

    alter table driver_reconciliation_payments
      drop constraint if exists driver_reconciliation_payments_direction_method_check;
    alter table driver_reconciliation_payments
      drop constraint if exists driver_reconciliation_payments_direction_check;
    alter table driver_reconciliation_payments drop column if exists direction;

    alter table driver_reconciliation_orders
      drop constraint if exists driver_reconciliation_orders_collection_payment_method_check;
    alter table driver_reconciliation_orders
      add constraint driver_reconciliation_orders_collection_payment_method_check
      check (collection_payment_method is null or collection_payment_method in ('cash', 'visa'));

    alter table driver_reconciliations
      drop constraint if exists driver_reconciliations_collection_payment_method_check;
    alter table driver_reconciliations
      add constraint driver_reconciliations_collection_payment_method_check
      check (collection_payment_method is null or collection_payment_method in ('cash', 'visa'));
  `.execute(database);
}
