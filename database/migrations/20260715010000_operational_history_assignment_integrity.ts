import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    do $$
    begin
      if exists (
        select 1
        from order_status_history history
        where not (
          (history.status_dimension = 'delivery'
            and history.to_status in ('new', 'processing', 'assigned', 'out_for_delivery', 'delivered', 'returned', 'cancelled')
            and (history.from_status is null or history.from_status in ('new', 'processing', 'assigned', 'out_for_delivery', 'delivered', 'returned', 'cancelled')))
          or (history.status_dimension = 'driver_reconciliation'
            and history.to_status in ('not_applicable', 'pending', 'reconciled', 'reversed')
            and (history.from_status is null or history.from_status in ('not_applicable', 'pending', 'reconciled', 'reversed')))
          or (history.status_dimension = 'trader_settlement'
            and history.to_status in ('not_eligible', 'unsettled', 'settled', 'reversed')
            and (history.from_status is null or history.from_status in ('not_eligible', 'unsettled', 'settled', 'reversed')))
          or (history.status_dimension = 'return'
            and history.to_status in ('not_applicable', 'returned_to_branch', 'returned_to_trader')
            and (history.from_status is null or history.from_status in ('not_applicable', 'returned_to_branch', 'returned_to_trader')))
          or (history.status_dimension = 'accounting'
            and history.to_status in ('unposted', 'posted', 'reversed')
            and (history.from_status is null or history.from_status in ('unposted', 'posted', 'reversed')))
        )
      ) then
        raise exception using
          errcode = '23514',
          message = 'existing Order status history contains a value that is invalid for its dimension';
      end if;

      if exists (
        select 1
        from orders target_order
        left join order_assignments assignment
          on assignment.company_id = target_order.company_id
         and assignment.order_id = target_order.id
         and assignment.unassigned_at is null
        where target_order.assigned_driver_id is distinct from assignment.driver_id
      ) then
        raise exception using
          errcode = '23514',
          message = 'existing Order current Driver does not match active assignment history';
      end if;
    end;
    $$;

    create function is_valid_order_status_value(status_dimension_value text, status_value text)
    returns boolean
    language sql
    immutable
    strict
    parallel safe
    as $$
      select case status_dimension_value
        when 'delivery' then status_value in ('new', 'processing', 'assigned', 'out_for_delivery', 'delivered', 'returned', 'cancelled')
        when 'driver_reconciliation' then status_value in ('not_applicable', 'pending', 'reconciled', 'reversed')
        when 'trader_settlement' then status_value in ('not_eligible', 'unsettled', 'settled', 'reversed')
        when 'return' then status_value in ('not_applicable', 'returned_to_branch', 'returned_to_trader')
        when 'accounting' then status_value in ('unposted', 'posted', 'reversed')
        else false
      end
    $$;

    alter table order_status_history
      add constraint order_status_history_status_values_check check (
        is_valid_order_status_value(status_dimension, to_status)
        and (from_status is null or is_valid_order_status_value(status_dimension, from_status))
      );

    create function reject_order_status_history_mutation() returns trigger language plpgsql as $$
    begin
      raise exception using
        errcode = '23514',
        message = 'Order status history is append-only; existing events cannot be updated or deleted';
    end;
    $$;

    create trigger order_status_history_append_only
      before update or delete on order_status_history
      for each row execute function reject_order_status_history_mutation();

    create function protect_order_assignment_history() returns trigger language plpgsql as $$
    begin
      if tg_op = 'DELETE' then
        raise exception using
          errcode = '23514',
          message = 'Order assignment history cannot be deleted';
      end if;

      if new.id is distinct from old.id
        or new.company_id is distinct from old.company_id
        or new.order_id is distinct from old.order_id
        or new.driver_id is distinct from old.driver_id
        or new.assigned_at is distinct from old.assigned_at
        or new.assigned_by_account_id is distinct from old.assigned_by_account_id then
        raise exception using
          errcode = '23514',
          message = 'Order assignment identity fields are immutable';
      end if;

      if old.unassigned_at is not null and (
        new.unassigned_at is distinct from old.unassigned_at
        or new.reason is distinct from old.reason
      ) then
        raise exception using
          errcode = '23514',
          message = 'A closed Order assignment cannot be changed or reopened';
      end if;

      if old.unassigned_at is null and new.unassigned_at is null
        and new.reason is distinct from old.reason then
        raise exception using
          errcode = '23514',
          message = 'An assignment reason may only be recorded when the active assignment is closed';
      end if;

      return new;
    end;
    $$;

    create trigger order_assignments_history_guard
      before update or delete on order_assignments
      for each row execute function protect_order_assignment_history();

    create function enforce_initial_order_assignment() returns trigger language plpgsql as $$
    declare
      current_driver_id uuid;
      current_delivery_status text;
    begin
      select assigned_driver_id, delivery_status
        into current_driver_id, current_delivery_status
      from orders
      where id = new.order_id and company_id = new.company_id;

      if not found or current_driver_id is distinct from new.driver_id then
        raise exception using
          errcode = '23514',
          message = 'Active assignment Driver must match the Order current Driver';
      end if;

      if current_delivery_status in ('delivered', 'returned', 'cancelled') then
        raise exception using
          errcode = '23514',
          message = 'Final-status Orders cannot receive a new active assignment';
      end if;

      return new;
    end;
    $$;

    create trigger order_assignments_initial_guard
      before insert on order_assignments
      for each row execute function enforce_initial_order_assignment();

    create function reject_final_order_assignment_change() returns trigger language plpgsql as $$
    begin
      if old.delivery_status in ('delivered', 'returned', 'cancelled')
        and new.assigned_driver_id is distinct from old.assigned_driver_id then
        raise exception using
          errcode = '23514',
          message = 'Final-status Order assignment cannot be changed';
      end if;
      return new;
    end;
    $$;

    create trigger orders_final_assignment_guard
      before update of assigned_driver_id on orders
      for each row execute function reject_final_order_assignment_change();

    create function validate_order_assignment_consistency() returns trigger language plpgsql as $$
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

      select assigned_driver_id into current_driver_id
      from orders
      where id = target_order_id and company_id = target_company_id;

      if not found then
        return null;
      end if;

      select driver_id into active_driver_id
      from order_assignments
      where company_id = target_company_id
        and order_id = target_order_id
        and unassigned_at is null;

      if current_driver_id is distinct from active_driver_id then
        raise exception using
          errcode = '23514',
          message = 'Order current Driver must match its active assignment history';
      end if;

      return null;
    end;
    $$;

    create constraint trigger orders_assignment_consistency
      after insert or update or delete on orders
      deferrable initially deferred
      for each row execute function validate_order_assignment_consistency();

    create constraint trigger order_assignments_current_driver_consistency
      after insert or update or delete on order_assignments
      deferrable initially deferred
      for each row execute function validate_order_assignment_consistency();
  `.execute(database);
}
