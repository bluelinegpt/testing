import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

// Corrects two gaps left by the earlier partial-payment migration (Phase 4 Checkpoint 4A):
//
// 1. `enforce_settlement_order_trader()` (fires on INSERT into trader_settlement_orders) was
//    already relaxed to accept an Order that is 'unsettled' OR 'partially_settled', but the
//    sibling confirmation-guard trigger `validate_trader_settlement_confirmation()` (fires on
//    UPDATE OF status ... TO 'confirmed') was never updated to match, and still demanded every
//    linked Order be exactly 'unsettled'. A second partial payment on an already-partially-settled
//    Order could therefore be inserted but never confirmed.
//
// 2. The header-total check compared the payment total against each line's FULL `net_payable`
//    (every Order's total original payable), not this settlement's own `allocated_amount` — the
//    column partial payments actually rely on. That full-amount comparison is also the ONLY
//    shape the *unconditional* `trader_settlements_amounts_check` CHECK constraint (defined at
//    table-creation time, in force on every insert/update regardless of status) can satisfy,
//    since it requires `net_payable = gross_payable - deductions + adjustments` using the SAME
//    header columns. A settlement that pays less than an Order's full amount therefore cannot
//    report the Order's full gross/deductions at the header level at all — the header is
//    redefined here to describe THIS settlement's own payment total only (gross_payable =
//    net_payable = the amount actually allocated now; deductions/charges/adjustments = 0 at the
//    header level), which is always constraint-satisfiable regardless of how partial the payment
//    is. Each Order's full original gross/deductions/adjustments/net_payable remain fully
//    preserved, unaffected, on its own `trader_settlement_orders` line and on `orders` itself.
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function validate_trader_settlement_confirmation() returns trigger language plpgsql as $$
    declare
      line_count bigint;
      line_allocated numeric(18,2);
      payment_count bigint;
      payment_total numeric(18,2);
      untraceable_payment_count bigint;
    begin
      if new.status <> 'confirmed' or old.status = 'confirmed' then
        return new;
      end if;

      perform 1
      from orders target_order
      where target_order.company_id = new.company_id
        and exists (
          select 1 from trader_settlement_orders line
          where line.company_id = new.company_id
            and line.settlement_id = new.id
            and line.order_id = target_order.id
        )
      order by target_order.id
      for update;

      if exists (
        select 1
        from trader_settlement_orders line
        join orders target_order
          on target_order.id = line.order_id and target_order.company_id = line.company_id
        where line.company_id = new.company_id
          and line.settlement_id = new.id
          and (
            target_order.trader_id is distinct from new.trader_id
            or target_order.delivery_status <> 'delivered'
            or target_order.driver_reconciliation_status not in ('reconciled', 'not_applicable')
            -- Was: <> 'unsettled'. An Order already partially settled by an earlier,
            -- independently confirmed settlement must remain includable in a further one.
            or target_order.trader_settlement_status not in ('unsettled', 'partially_settled')
          )
      ) then
        raise exception using
          errcode = '23514',
          message = 'Trader settlement contains an ineligible or wrong-Trader Order';
      end if;

      select count(*), coalesce(sum(allocated_amount), 0)
        into line_count, line_allocated
      from trader_settlement_orders
      where company_id = new.company_id and settlement_id = new.id;

      select count(*), coalesce(sum(amount), 0),
             count(*) filter (where created_by_account_id is null or payment_at is null)
        into payment_count, payment_total, untraceable_payment_count
      from trader_settlement_payments
      where company_id = new.company_id and settlement_id = new.id;

      -- The header describes THIS settlement's own payment only: gross_payable and
      -- net_payable both equal the sum of allocations, with no separate deductions/charges/
      -- adjustments attributed at the header level (see the migration comment above).
      if line_count = 0
        or new.gross_payable is distinct from line_allocated
        or new.service_fee_deductions <> 0 or new.other_deductions <> 0 or new.charges <> 0
        or new.adjustments <> 0
        or new.net_payable is distinct from line_allocated then
        raise exception using
          errcode = '23514',
          message = 'Trader settlement header totals do not match this settlement''s allocations';
      end if;

      if new.net_payable < 0
        or (new.net_payable > 0 and payment_total is distinct from new.net_payable)
        or (new.net_payable = 0 and payment_count <> 0) then
        raise exception using
          errcode = '23514',
          message = 'Trader settlement payment total does not match net payable';
      end if;

      if untraceable_payment_count <> 0 then
        raise exception using
          errcode = '23514',
          message = 'Confirmed Trader settlement payments require an actor and payment timestamp';
      end if;

      return new;
    end;
    $$;

    create unique index trader_settlement_payments_bank_reference_unique
      on trader_settlement_payments (company_id, upper(btrim(bank_reference)))
      where bank_reference is not null;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists trader_settlement_payments_bank_reference_unique;

    create or replace function validate_trader_settlement_confirmation() returns trigger language plpgsql as $$
    declare
      line_count bigint;
      line_gross numeric(18,2);
      line_deductions numeric(18,2);
      line_adjustments numeric(18,2);
      line_net numeric(18,2);
      payment_count bigint;
      payment_total numeric(18,2);
      untraceable_payment_count bigint;
    begin
      if new.status <> 'confirmed' or old.status = 'confirmed' then
        return new;
      end if;

      perform 1
      from orders target_order
      where target_order.company_id = new.company_id
        and exists (
          select 1 from trader_settlement_orders line
          where line.company_id = new.company_id
            and line.settlement_id = new.id
            and line.order_id = target_order.id
        )
      order by target_order.id
      for update;

      if exists (
        select 1
        from trader_settlement_orders line
        join orders target_order
          on target_order.id = line.order_id and target_order.company_id = line.company_id
        where line.company_id = new.company_id
          and line.settlement_id = new.id
          and (
            target_order.trader_id is distinct from new.trader_id
            or target_order.delivery_status <> 'delivered'
            or target_order.driver_reconciliation_status not in ('reconciled', 'not_applicable')
            or target_order.trader_settlement_status <> 'unsettled'
          )
      ) then
        raise exception using
          errcode = '23514',
          message = 'Trader settlement contains an ineligible or wrong-Trader Order';
      end if;

      select count(*), coalesce(sum(gross_payable), 0),
             coalesce(sum(deductions_and_charges), 0), coalesce(sum(adjustments), 0),
             coalesce(sum(net_payable), 0)
        into line_count, line_gross, line_deductions, line_adjustments, line_net
      from trader_settlement_orders
      where company_id = new.company_id and settlement_id = new.id;

      select count(*), coalesce(sum(amount), 0),
             count(*) filter (where created_by_account_id is null or payment_at is null)
        into payment_count, payment_total, untraceable_payment_count
      from trader_settlement_payments
      where company_id = new.company_id and settlement_id = new.id;

      if line_count = 0
        or new.gross_payable is distinct from line_gross
        or new.service_fee_deductions + new.other_deductions + new.charges is distinct from line_deductions
        or new.adjustments is distinct from line_adjustments
        or new.net_payable is distinct from line_net then
        raise exception using
          errcode = '23514',
          message = 'Trader settlement header totals do not match Order lines';
      end if;

      if new.net_payable < 0
        or (new.net_payable > 0 and payment_total is distinct from new.net_payable)
        or (new.net_payable = 0 and payment_count <> 0) then
        raise exception using
          errcode = '23514',
          message = 'Trader settlement payment total does not match net payable';
      end if;

      if untraceable_payment_count <> 0 then
        raise exception using
          errcode = '23514',
          message = 'Confirmed Trader settlement payments require an actor and payment timestamp';
      end if;

      return new;
    end;
    $$;
  `.execute(database);
}
