import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

// Forward-only repair: recreates integrity functions and triggers when an isolated-schema
// validation shared migration metadata with the development schema. On untouched databases,
// this replaces functions with identical definitions and recreates triggers transactionally.
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function is_valid_order_status_value(status_dimension_value text, status_value text)
    returns boolean language sql immutable strict parallel safe as $$
      select case status_dimension_value
        when 'delivery' then status_value in ('new', 'processing', 'assigned', 'out_for_delivery', 'delivered', 'returned', 'cancelled')
        when 'driver_reconciliation' then status_value in ('not_applicable', 'pending', 'reconciled', 'reversed')
        when 'trader_settlement' then status_value in ('not_eligible', 'unsettled', 'settled', 'reversed')
        when 'return' then status_value in ('not_applicable', 'returned_to_branch', 'returned_to_trader')
        when 'accounting' then status_value in ('unposted', 'posted', 'reversed')
        else false
      end
    $$;

    do $$
    begin
      if not exists (
        select 1 from pg_constraint
        where conname = 'order_status_history_status_values_check'
          and conrelid = 'order_status_history'::regclass
      ) then
        alter table order_status_history
          add constraint order_status_history_status_values_check check (
            is_valid_order_status_value(status_dimension, to_status)
            and (from_status is null or is_valid_order_status_value(status_dimension, from_status))
          );
      end if;
    end;
    $$;

    create or replace function reject_order_status_history_mutation() returns trigger language plpgsql as $$
    begin
      raise exception using errcode = '23514',
        message = 'Order status history is append-only; existing events cannot be updated or deleted';
    end;
    $$;

    create or replace function protect_order_assignment_history() returns trigger language plpgsql as $$
    begin
      if tg_op = 'DELETE' then
        raise exception using errcode = '23514', message = 'Order assignment history cannot be deleted';
      end if;
      if new.id is distinct from old.id
        or new.company_id is distinct from old.company_id
        or new.order_id is distinct from old.order_id
        or new.driver_id is distinct from old.driver_id
        or new.assigned_at is distinct from old.assigned_at
        or new.assigned_by_account_id is distinct from old.assigned_by_account_id then
        raise exception using errcode = '23514', message = 'Order assignment identity fields are immutable';
      end if;
      if old.unassigned_at is not null and (
        new.unassigned_at is distinct from old.unassigned_at or new.reason is distinct from old.reason
      ) then
        raise exception using errcode = '23514', message = 'A closed Order assignment cannot be changed or reopened';
      end if;
      if old.unassigned_at is null and new.unassigned_at is null
        and new.reason is distinct from old.reason then
        raise exception using errcode = '23514',
          message = 'An assignment reason may only be recorded when the active assignment is closed';
      end if;
      return new;
    end;
    $$;

    create or replace function enforce_initial_order_assignment() returns trigger language plpgsql as $$
    declare
      current_driver_id uuid;
      current_delivery_status text;
    begin
      select assigned_driver_id, delivery_status into current_driver_id, current_delivery_status
      from orders where id = new.order_id and company_id = new.company_id;
      if not found or current_driver_id is distinct from new.driver_id then
        raise exception using errcode = '23514',
          message = 'Active assignment Driver must match the Order current Driver';
      end if;
      if current_delivery_status in ('delivered', 'returned', 'cancelled') then
        raise exception using errcode = '23514',
          message = 'Final-status Orders cannot receive a new active assignment';
      end if;
      return new;
    end;
    $$;

    create or replace function reject_final_order_assignment_change() returns trigger language plpgsql as $$
    begin
      if old.delivery_status in ('delivered', 'returned', 'cancelled')
        and new.assigned_driver_id is distinct from old.assigned_driver_id then
        raise exception using errcode = '23514', message = 'Final-status Order assignment cannot be changed';
      end if;
      return new;
    end;
    $$;

    create or replace function validate_order_assignment_consistency() returns trigger language plpgsql as $$
    declare
      target_company_id uuid;
      target_order_id uuid;
      current_driver_id uuid;
      active_driver_id uuid;
    begin
      if tg_table_name = 'orders' then
        target_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
        target_order_id := case when tg_op = 'DELETE' then old.id else new.id end;
      else
        target_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
        target_order_id := case when tg_op = 'DELETE' then old.order_id else new.order_id end;
      end if;
      select assigned_driver_id into current_driver_id from orders
      where id = target_order_id and company_id = target_company_id;
      if not found then return null; end if;
      select driver_id into active_driver_id from order_assignments
      where company_id = target_company_id and order_id = target_order_id and unassigned_at is null;
      if current_driver_id is distinct from active_driver_id then
        raise exception using errcode = '23514',
          message = 'Order current Driver must match its active assignment history';
      end if;
      return null;
    end;
    $$;

    drop trigger if exists order_status_history_append_only on order_status_history;
    create trigger order_status_history_append_only before update or delete on order_status_history
      for each row execute function reject_order_status_history_mutation();
    drop trigger if exists order_assignments_history_guard on order_assignments;
    create trigger order_assignments_history_guard before update or delete on order_assignments
      for each row execute function protect_order_assignment_history();
    drop trigger if exists order_assignments_initial_guard on order_assignments;
    create trigger order_assignments_initial_guard before insert on order_assignments
      for each row execute function enforce_initial_order_assignment();
    drop trigger if exists orders_final_assignment_guard on orders;
    create trigger orders_final_assignment_guard before update of assigned_driver_id on orders
      for each row execute function reject_final_order_assignment_change();
    drop trigger if exists orders_assignment_consistency on orders;
    create constraint trigger orders_assignment_consistency after insert or update or delete on orders
      deferrable initially deferred for each row execute function validate_order_assignment_consistency();
    drop trigger if exists order_assignments_current_driver_consistency on order_assignments;
    create constraint trigger order_assignments_current_driver_consistency
      after insert or update or delete on order_assignments deferrable initially deferred
      for each row execute function validate_order_assignment_consistency();

    create or replace function reject_confirmed_reconciliation_child_mutation() returns trigger language plpgsql as $$
    declare
      parent_id uuid;
      parent_company_id uuid;
      parent_status text;
    begin
      parent_id := case when tg_op = 'DELETE' then old.reconciliation_id else new.reconciliation_id end;
      parent_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
      select status into parent_status from driver_reconciliations
      where id = parent_id and company_id = parent_company_id for update;
      if parent_status = 'confirmed' then
        raise exception using errcode = '23514', message = 'Confirmed Driver reconciliation details are immutable';
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
      select status into parent_status from trader_settlements
      where id = parent_id and company_id = parent_company_id for update;
      if parent_status = 'confirmed' then
        raise exception using errcode = '23514', message = 'Confirmed Trader settlement details are immutable';
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;

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
      if new.status <> 'confirmed' or old.status = 'confirmed' then return new; end if;
      perform 1 from orders target_order
      where target_order.company_id = new.company_id and exists (
        select 1 from trader_settlement_orders line
        where line.company_id = new.company_id and line.settlement_id = new.id
          and line.order_id = target_order.id
      ) order by target_order.id for update;
      if exists (
        select 1 from trader_settlement_orders line
        join orders target_order on target_order.id = line.order_id and target_order.company_id = line.company_id
        where line.company_id = new.company_id and line.settlement_id = new.id and (
          target_order.trader_id is distinct from new.trader_id
          or target_order.delivery_status <> 'delivered'
          or target_order.driver_reconciliation_status not in ('reconciled', 'not_applicable')
          or target_order.trader_settlement_status <> 'unsettled'
        )
      ) then
        raise exception using errcode = '23514',
          message = 'Trader settlement contains an ineligible or wrong-Trader Order';
      end if;
      select count(*), coalesce(sum(gross_payable), 0), coalesce(sum(deductions_and_charges), 0),
             coalesce(sum(adjustments), 0), coalesce(sum(net_payable), 0)
        into line_count, line_gross, line_deductions, line_adjustments, line_net
      from trader_settlement_orders where company_id = new.company_id and settlement_id = new.id;
      select count(*), coalesce(sum(amount), 0),
             count(*) filter (where created_by_account_id is null or payment_at is null)
        into payment_count, payment_total, untraceable_payment_count
      from trader_settlement_payments where company_id = new.company_id and settlement_id = new.id;
      if line_count = 0 or new.gross_payable is distinct from line_gross
        or new.service_fee_deductions + new.other_deductions + new.charges is distinct from line_deductions
        or new.adjustments is distinct from line_adjustments or new.net_payable is distinct from line_net then
        raise exception using errcode = '23514', message = 'Trader settlement header totals do not match Order lines';
      end if;
      if new.net_payable < 0
        or (new.net_payable > 0 and payment_total is distinct from new.net_payable)
        or (new.net_payable = 0 and payment_count <> 0) then
        raise exception using errcode = '23514', message = 'Trader settlement payment total does not match net payable';
      end if;
      if untraceable_payment_count <> 0 then
        raise exception using errcode = '23514',
          message = 'Confirmed Trader settlement payments require an actor and payment timestamp';
      end if;
      return new;
    end;
    $$;

    drop trigger if exists driver_reconciliations_confirmation_guard on driver_reconciliations;
    create trigger driver_reconciliations_confirmation_guard before update of status on driver_reconciliations
      for each row execute function validate_driver_reconciliation_confirmation();
    drop trigger if exists trader_settlements_confirmation_guard on trader_settlements;
    create trigger trader_settlements_confirmation_guard before update of status on trader_settlements
      for each row execute function validate_trader_settlement_confirmation();
  `.execute(database);
}
