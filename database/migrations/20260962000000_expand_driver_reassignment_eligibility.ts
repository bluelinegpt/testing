import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * `enforce_initial_order_assignment` used to permit a new active
 * `order_assignments` row only while the Order was Assigned-to-Driver,
 * Hold, or a Collect Order — matching `orders-workflow.service.ts`'s own
 * `assignmentIneligibilityReason`, which blocked reassigning an
 * already-assigned Driver everywhere else, including New, In-Branch, and
 * Out for Delivery.
 *
 * The Driver may now be assigned or reassigned any time an Order is not
 * yet Delivered and not in a terminal state (Cancelled, Closed, or either
 * Returned status stay excluded — those are finished states where
 * reassigning a Driver has no operational meaning). This widens the
 * trigger to match, adding New, In-Branch, and Out for Delivery to the
 * set it already allowed.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
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
      if current_delivery_status not in (
        'new', 'in_branch', 'assigned_to_driver', 'out_for_delivery', 'hold', 'collect_order'
      ) then
        raise exception using errcode = '23514',
          message = 'An Order must not yet be Delivered, Cancelled, Closed, or Returned to receive an active assignment';
      end if;
      return new;
    end;
    $$;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    do $$
    begin
      if exists (
        select 1 from order_assignments a
        join orders o on o.id = a.order_id and o.company_id = a.company_id
        where a.unassigned_at is null
          and o.delivery_status in ('new', 'in_branch', 'out_for_delivery')
      ) then
        raise exception 'Cannot restore the narrower assignment trigger while an active assignment exists on a New, In-Branch, or Out for Delivery Order';
      end if;
    end $$;

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
      if current_delivery_status not in ('assigned_to_driver', 'hold', 'collect_order') then
        raise exception using errcode = '23514',
          message = 'Only a newly assigned, held, or Collect Order can receive an active assignment';
      end if;
      return new;
    end;
    $$;
  `.execute(database);
}
