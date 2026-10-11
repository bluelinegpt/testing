import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Trader Credits applied in Trader Settlements (11 Oct 2026; project note
 * `claude/trader-double-fee-after-offset-reversal-2026-10-08.md`).
 *
 * A Trader Credit is money the Company owes the Trader (for example the fee
 * handed back when a Receivable offset was reversed). Until now no Settlement
 * could pay one, so credits sat open forever and the Trader was short.
 *
 * Additive:
 * 1. `trader_settlement_credit_applications`: one row per Credit paid inside
 *    a Settlement, immutable history like `trader_settlement_receivable_offsets`.
 * 2. The confirmation trigger now accepts a Settlement whose header
 *    `adjustments` equals the Credits it applies, with
 *    `net = allocations - receivable offsets + credits`. A Settlement without
 *    Credits is checked exactly as before (adjustments 0).
 *
 * No existing row changes value.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table trader_settlement_credit_applications (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      settlement_id uuid not null,
      credit_id uuid not null,
      amount_applied numeric(18,2) not null,
      created_at timestamptz not null default now(),
      constraint trader_settlement_credit_applications_amount_check check (amount_applied > 0),
      constraint trader_settlement_credit_applications_unique unique (company_id, settlement_id, credit_id),
      constraint trader_settlement_credit_applications_settlement_fk
        foreign key (settlement_id, company_id)
        references trader_settlements(id, company_id) on delete restrict,
      constraint trader_settlement_credit_applications_credit_fk
        foreign key (credit_id, company_id)
        references trader_credits(id, company_id) on delete restrict
    );

    create index trader_settlement_credit_applications_credit_idx
      on trader_settlement_credit_applications(company_id, credit_id);

    create or replace function validate_trader_settlement_confirmation()
    returns trigger language plpgsql as $$
    declare
      line_count bigint;
      line_allocated numeric(18,2);
      offset_total numeric(18,2);
      credit_total numeric(18,2);
      payment_count bigint;
      payment_total numeric(18,2);
      untraceable_payment_count bigint;
    begin
      if new.status <> 'confirmed' or old.status = 'confirmed' then return new; end if;

      perform 1 from orders target_order
       where target_order.company_id=new.company_id
         and exists(select 1 from trader_settlement_orders line
                     where line.company_id=new.company_id and line.settlement_id=new.id
                       and line.order_id=target_order.id)
       order by target_order.id for update;

      if exists(
        select 1 from trader_settlement_orders line
        join orders target_order on target_order.id=line.order_id
          and target_order.company_id=line.company_id
        where line.company_id=new.company_id and line.settlement_id=new.id
          and (target_order.trader_id is distinct from new.trader_id
            or target_order.delivery_status <> 'delivered'
            or target_order.driver_reconciliation_status not in ('reconciled','not_applicable')
            or target_order.trader_settlement_status not in ('unsettled','partially_settled'))
      ) then raise exception using errcode='23514',
        message='Trader settlement contains an ineligible or wrong-Trader Order'; end if;

      if exists(
        select 1 from trader_settlement_receivable_offsets x
        join trader_receivables r on r.id=x.receivable_id and r.company_id=x.company_id
        where x.company_id=new.company_id and x.settlement_id=new.id
          and r.trader_id is distinct from new.trader_id
      ) then raise exception using errcode='23514',
        message='Trader settlement offset contains a wrong-Trader receivable'; end if;

      if exists(
        select 1 from trader_settlement_credit_applications a
        join trader_credits c on c.id=a.credit_id and c.company_id=a.company_id
        where a.company_id=new.company_id and a.settlement_id=new.id
          and c.trader_id is distinct from new.trader_id
      ) then raise exception using errcode='23514',
        message='Trader settlement credit application contains a wrong-Trader credit'; end if;

      select coalesce(sum(amount_applied),0) into credit_total
        from trader_settlement_credit_applications
       where company_id=new.company_id and settlement_id=new.id;

      select count(*),coalesce(sum(allocated_amount),0) into line_count,line_allocated
        from trader_settlement_orders where company_id=new.company_id and settlement_id=new.id;
      select coalesce(sum(amount_allocated),0) into offset_total
        from trader_settlement_receivable_offsets
       where company_id=new.company_id and settlement_id=new.id;
      select count(*),coalesce(sum(amount),0),
             count(*) filter(where created_by_account_id is null or payment_at is null)
        into payment_count,payment_total,untraceable_payment_count
        from trader_settlement_payments where company_id=new.company_id and settlement_id=new.id;

      if line_count=0 or new.gross_payable is distinct from line_allocated
        or new.service_fee_deductions <> 0 or new.other_deductions is distinct from offset_total
        or new.charges <> 0 or new.adjustments is distinct from credit_total
        or new.net_payable is distinct from line_allocated-offset_total+credit_total then
        raise exception using errcode='23514',
          message='Trader settlement header totals do not match allocations, receivable offsets and credit applications';
      end if;
      if new.net_payable < 0
        or (new.net_payable > 0 and payment_total is distinct from new.net_payable)
        or (new.net_payable=0 and payment_count <> 0) then
        raise exception using errcode='23514',
          message='Trader settlement payment total does not match net payable';
      end if;
      if untraceable_payment_count <> 0 then raise exception using errcode='23514',
        message='Confirmed Trader settlement payments require an actor and payment timestamp'; end if;
      return new;
    end;
    $$;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function validate_trader_settlement_confirmation()
    returns trigger language plpgsql as $$
    declare
      line_count bigint;
      line_allocated numeric(18,2);
      offset_total numeric(18,2);
      payment_count bigint;
      payment_total numeric(18,2);
      untraceable_payment_count bigint;
    begin
      if new.status <> 'confirmed' or old.status = 'confirmed' then return new; end if;

      perform 1 from orders target_order
       where target_order.company_id=new.company_id
         and exists(select 1 from trader_settlement_orders line
                     where line.company_id=new.company_id and line.settlement_id=new.id
                       and line.order_id=target_order.id)
       order by target_order.id for update;

      if exists(
        select 1 from trader_settlement_orders line
        join orders target_order on target_order.id=line.order_id
          and target_order.company_id=line.company_id
        where line.company_id=new.company_id and line.settlement_id=new.id
          and (target_order.trader_id is distinct from new.trader_id
            or target_order.delivery_status <> 'delivered'
            or target_order.driver_reconciliation_status not in ('reconciled','not_applicable')
            or target_order.trader_settlement_status not in ('unsettled','partially_settled'))
      ) then raise exception using errcode='23514',
        message='Trader settlement contains an ineligible or wrong-Trader Order'; end if;

      if exists(
        select 1 from trader_settlement_receivable_offsets x
        join trader_receivables r on r.id=x.receivable_id and r.company_id=x.company_id
        where x.company_id=new.company_id and x.settlement_id=new.id
          and r.trader_id is distinct from new.trader_id
      ) then raise exception using errcode='23514',
        message='Trader settlement offset contains a wrong-Trader receivable'; end if;

      select count(*),coalesce(sum(allocated_amount),0) into line_count,line_allocated
        from trader_settlement_orders where company_id=new.company_id and settlement_id=new.id;
      select coalesce(sum(amount_allocated),0) into offset_total
        from trader_settlement_receivable_offsets
       where company_id=new.company_id and settlement_id=new.id;
      select count(*),coalesce(sum(amount),0),
             count(*) filter(where created_by_account_id is null or payment_at is null)
        into payment_count,payment_total,untraceable_payment_count
        from trader_settlement_payments where company_id=new.company_id and settlement_id=new.id;

      if line_count=0 or new.gross_payable is distinct from line_allocated
        or new.service_fee_deductions <> 0 or new.other_deductions is distinct from offset_total
        or new.charges <> 0 or new.adjustments <> 0
        or new.net_payable is distinct from line_allocated-offset_total then
        raise exception using errcode='23514',
          message='Trader settlement header totals do not match allocations and receivable offsets';
      end if;
      if new.net_payable < 0
        or (new.net_payable > 0 and payment_total is distinct from new.net_payable)
        or (new.net_payable=0 and payment_count <> 0) then
        raise exception using errcode='23514',
          message='Trader settlement payment total does not match net payable';
      end if;
      if untraceable_payment_count <> 0 then raise exception using errcode='23514',
        message='Confirmed Trader settlement payments require an actor and payment timestamp'; end if;
      return new;
    end;
    $$;

    drop table trader_settlement_credit_applications;
  `.execute(database);
}
