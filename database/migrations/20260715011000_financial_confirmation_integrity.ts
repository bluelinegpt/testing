import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    do $$
    begin
      if exists (
        select 1
        from driver_reconciliations reconciliation
        left join lateral (
          select coalesce(sum(customer_collection_amount), 0) as gross,
                 coalesce(sum(driver_payable_deduction), 0) as deduction
          from driver_reconciliation_orders
          where company_id = reconciliation.company_id
            and reconciliation_id = reconciliation.id
        ) order_totals on true
        left join lateral (
          select coalesce(sum(amount), 0) as expenses
          from driver_reconciliation_expenses
          where company_id = reconciliation.company_id
            and reconciliation_id = reconciliation.id
        ) expense_totals on true
        left join lateral (
          select coalesce(sum(amount), 0) as payments, count(*) as payment_count
          from driver_reconciliation_payments
          where company_id = reconciliation.company_id
            and reconciliation_id = reconciliation.id
        ) payment_totals on true
        where reconciliation.status = 'confirmed' and (
          reconciliation.gross_collections <> order_totals.gross
          or reconciliation.driver_payable_deduction <> order_totals.deduction
          or reconciliation.reconciliation_expenses <> expense_totals.expenses
          or reconciliation.net_amount_received <> order_totals.gross - order_totals.deduction - expense_totals.expenses
          or (reconciliation.net_amount_received > 0 and payment_totals.payments <> reconciliation.net_amount_received)
          or (reconciliation.net_amount_received = 0 and payment_totals.payment_count <> 0)
          or reconciliation.net_amount_received < 0
        )
      ) then
        raise exception using
          errcode = '23514',
          message = 'existing confirmed Driver reconciliation totals are inconsistent';
      end if;

      if exists (
        select 1
        from trader_settlements settlement
        left join lateral (
          select coalesce(sum(gross_payable), 0) as gross,
                 coalesce(sum(deductions_and_charges), 0) as deductions,
                 coalesce(sum(adjustments), 0) as adjustments,
                 coalesce(sum(net_payable), 0) as net
          from trader_settlement_orders
          where company_id = settlement.company_id
            and settlement_id = settlement.id
        ) order_totals on true
        left join lateral (
          select coalesce(sum(amount), 0) as payments, count(*) as payment_count
          from trader_settlement_payments
          where company_id = settlement.company_id
            and settlement_id = settlement.id
        ) payment_totals on true
        where settlement.status = 'confirmed' and (
          settlement.gross_payable <> order_totals.gross
          or settlement.service_fee_deductions + settlement.other_deductions + settlement.charges <> order_totals.deductions
          or settlement.adjustments <> order_totals.adjustments
          or settlement.net_payable <> order_totals.net
          or (settlement.net_payable > 0 and payment_totals.payments <> settlement.net_payable)
          or (settlement.net_payable = 0 and payment_totals.payment_count <> 0)
          or settlement.net_payable < 0
        )
      ) then
        raise exception using
          errcode = '23514',
          message = 'existing confirmed Trader settlement totals are inconsistent';
      end if;
    end;
    $$;

    alter table driver_reconciliation_payments
      add column created_by_account_id uuid,
      add column payment_at timestamptz;
    -- ALTER TABLE holds an exclusive lock; disable only the existing child immutability trigger
    -- for this deterministic timestamp backfill, then restore it in the same migration transaction.
    alter table driver_reconciliation_payments
      disable trigger driver_reconciliation_payments_immutable;
    update driver_reconciliation_payments set payment_at = created_at where payment_at is null;
    alter table driver_reconciliation_payments
      enable trigger driver_reconciliation_payments_immutable;
    alter table driver_reconciliation_payments
      alter column payment_at set not null,
      add constraint driver_reconciliation_payments_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict;

    alter table trader_settlement_payments
      add column created_by_account_id uuid,
      add column payment_at timestamptz;
    alter table trader_settlement_payments
      disable trigger trader_settlement_payments_immutable;
    update trader_settlement_payments set payment_at = created_at where payment_at is null;
    alter table trader_settlement_payments
      enable trigger trader_settlement_payments_immutable;
    alter table trader_settlement_payments
      alter column payment_at set not null,
      add constraint trader_settlement_payments_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict;

    create index driver_reconciliation_payments_parent_index
      on driver_reconciliation_payments (company_id, reconciliation_id);
    create index driver_reconciliation_expenses_parent_index
      on driver_reconciliation_expenses (company_id, reconciliation_id);
    create index trader_settlement_payments_parent_index
      on trader_settlement_payments (company_id, settlement_id);

    create or replace function reject_confirmed_reconciliation_child_mutation() returns trigger language plpgsql as $$
    declare
      parent_id uuid;
      parent_company_id uuid;
      parent_status text;
    begin
      parent_id := case when tg_op = 'DELETE' then old.reconciliation_id else new.reconciliation_id end;
      parent_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;

      select status into parent_status
      from driver_reconciliations
      where id = parent_id and company_id = parent_company_id
      for update;

      if parent_status = 'confirmed' then
        raise exception using
          errcode = '23514',
          message = 'Confirmed Driver reconciliation details are immutable';
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;

    create or replace function reject_confirmed_settlement_child_mutation() returns trigger language plpgsql as $$
    declare
      parent_id uuid;
      parent_company_id uuid;
      parent_status text;
    begin
      parent_id := case when tg_op = 'DELETE' then old.settlement_id else new.settlement_id end;
      parent_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;

      select status into parent_status
      from trader_settlements
      where id = parent_id and company_id = parent_company_id
      for update;

      if parent_status = 'confirmed' then
        raise exception using
          errcode = '23514',
          message = 'Confirmed Trader settlement details are immutable';
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;

    create function validate_driver_reconciliation_confirmation() returns trigger language plpgsql as $$
    declare
      line_count bigint;
      line_gross numeric(18,2);
      line_deduction numeric(18,2);
      expense_total numeric(18,2);
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
          select 1 from driver_reconciliation_orders line
          where line.company_id = new.company_id
            and line.reconciliation_id = new.id
            and line.order_id = target_order.id
        )
      order by target_order.id
      for update;

      if exists (
        select 1
        from driver_reconciliation_orders line
        join orders target_order
          on target_order.id = line.order_id and target_order.company_id = line.company_id
        where line.company_id = new.company_id
          and line.reconciliation_id = new.id
          and (
            target_order.assigned_driver_id is distinct from new.driver_id
            or target_order.delivery_status <> 'delivered'
            or target_order.driver_reconciliation_status <> 'pending'
          )
      ) then
        raise exception using
          errcode = '23514',
          message = 'Driver reconciliation contains an ineligible or wrong-Driver Order';
      end if;

      select count(*), coalesce(sum(customer_collection_amount), 0),
             coalesce(sum(driver_payable_deduction), 0)
        into line_count, line_gross, line_deduction
      from driver_reconciliation_orders
      where company_id = new.company_id and reconciliation_id = new.id;

      select coalesce(sum(amount), 0) into expense_total
      from driver_reconciliation_expenses
      where company_id = new.company_id and reconciliation_id = new.id;

      select count(*), coalesce(sum(amount), 0),
             count(*) filter (where created_by_account_id is null or payment_at is null)
        into payment_count, payment_total, untraceable_payment_count
      from driver_reconciliation_payments
      where company_id = new.company_id and reconciliation_id = new.id;

      if line_count = 0
        or new.gross_collections is distinct from line_gross
        or new.driver_payable_deduction is distinct from line_deduction
        or new.reconciliation_expenses is distinct from expense_total
        or new.net_amount_received is distinct from line_gross - line_deduction - expense_total then
        raise exception using
          errcode = '23514',
          message = 'Driver reconciliation header totals do not match Order and expense lines';
      end if;

      if new.net_amount_received < 0
        or (new.net_amount_received > 0 and payment_total is distinct from new.net_amount_received)
        or (new.net_amount_received = 0 and payment_count <> 0) then
        raise exception using
          errcode = '23514',
          message = 'Driver reconciliation payment total does not match net amount received';
      end if;

      if untraceable_payment_count <> 0 then
        raise exception using
          errcode = '23514',
          message = 'Confirmed Driver reconciliation payments require an actor and payment timestamp';
      end if;

      return new;
    end;
    $$;

    create trigger driver_reconciliations_confirmation_guard
      before update of status on driver_reconciliations
      for each row execute function validate_driver_reconciliation_confirmation();

    create function validate_trader_settlement_confirmation() returns trigger language plpgsql as $$
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

    create trigger trader_settlements_confirmation_guard
      before update of status on trader_settlements
      for each row execute function validate_trader_settlement_confirmation();
  `.execute(database);
}
