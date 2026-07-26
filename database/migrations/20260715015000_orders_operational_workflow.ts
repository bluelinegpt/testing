import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders add column operational_completed_at timestamptz;

    alter table orders drop constraint orders_delivery_status_check;
    alter table orders drop constraint orders_settlement_status_check;
    alter table orders drop constraint orders_close_return_check;

    update orders
       set operational_completed_at = coalesce(delivered_at, closed_at),
           closed_at = null
     where delivery_status = 'delivered';

    update orders
       set operational_completed_at = coalesce(operational_completed_at, closed_at),
           closed_at = null
     where delivery_status in ('returned', 'cancelled');

    update orders
       set delivery_status = case
         when delivery_status = 'processing' and assigned_driver_id is null then 'new'
         when delivery_status = 'processing' and assigned_driver_id is not null then 'assigned_to_driver'
         when delivery_status = 'assigned' then 'assigned_to_driver'
         when delivery_status = 'returned' then 'returned_to_branch'
         else delivery_status
       end;

    update orders
       set trader_settlement_status = 'money_sent_to_trader'
     where trader_settlement_status = 'settled';

    set constraints all immediate;

    alter table orders add constraint orders_delivery_status_check check (delivery_status in (
      'new', 'assigned_to_driver', 'out_for_delivery', 'delivered',
      'returned_to_branch', 'returned_to_trader', 'cancelled', 'closed'
    ));

    alter table orders add constraint orders_settlement_status_check check (
      trader_settlement_status in (
        'not_eligible', 'unsettled', 'money_sent_to_trader',
        'money_received_by_trader', 'reversed'
      )
    );

    alter table orders add constraint orders_explicit_close_check check (
      (delivery_status = 'closed' and closed_at is not null)
      or (delivery_status <> 'closed' and closed_at is null)
    );
    alter table orders add constraint orders_return_delivery_sync_check check (
      (delivery_status = 'returned_to_branch' and return_status = 'returned_to_branch')
      or (delivery_status = 'returned_to_trader' and return_status = 'returned_to_trader')
      or (delivery_status = 'closed' and return_status in ('not_applicable', 'returned_to_trader'))
      or (delivery_status not in ('returned_to_branch', 'returned_to_trader', 'closed')
          and return_status = 'not_applicable')
    );

    create or replace function is_valid_order_status_value(status_dimension_value text, status_value text)
    returns boolean language sql immutable strict parallel safe as $$
      select case status_dimension_value
        when 'delivery' then status_value in (
          'new', 'processing', 'assigned', 'returned',
          'assigned_to_driver', 'out_for_delivery', 'delivered',
          'returned_to_branch', 'returned_to_trader', 'cancelled', 'closed'
        )
        when 'driver_reconciliation' then status_value in ('not_applicable', 'pending', 'reconciled', 'reversed')
        when 'trader_settlement' then status_value in (
          'not_eligible', 'unsettled', 'settled', 'money_sent_to_trader',
          'money_received_by_trader', 'reversed'
        )
        when 'return' then status_value in ('not_applicable', 'returned_to_branch', 'returned_to_trader')
        when 'accounting' then status_value in ('unposted', 'posted', 'reversed')
        else false
      end
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
      if current_delivery_status <> 'assigned_to_driver' then
        raise exception using errcode = '23514',
          message = 'Only a newly assigned Order can receive an active assignment';
      end if;
      return new;
    end;
    $$;

    create or replace function reject_final_order_assignment_change() returns trigger language plpgsql as $$
    begin
      if old.delivery_status in (
        'delivered', 'returned_to_branch', 'returned_to_trader', 'cancelled', 'closed'
      ) and new.assigned_driver_id is distinct from old.assigned_driver_id then
        raise exception using errcode = '23514', message = 'Final-status Order assignment cannot be changed';
      end if;
      return new;
    end;
    $$;

    create table order_events (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      order_id uuid not null,
      event_type text not null,
      event_category text not null,
      field_name text,
      previous_value jsonb,
      new_value jsonb,
      actor_account_id uuid,
      actor_role text not null,
      source text not null,
      reason text,
      related_driver_id uuid,
      related_reconciliation_id uuid,
      related_settlement_id uuid,
      related_payment_id uuid,
      correlation_id text not null,
      bulk_action_id uuid,
      legacy_status_history_id uuid,
      legacy_audit_event_id uuid,
      occurred_at timestamptz not null default now(),
      unique (id, company_id),
      unique (legacy_status_history_id),
      unique (legacy_audit_event_id),
      constraint order_events_order_fk foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint order_events_actor_fk foreign key (actor_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint order_events_driver_fk foreign key (related_driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint order_events_reconciliation_fk foreign key (related_reconciliation_id, company_id)
        references driver_reconciliations(id, company_id) on delete restrict,
      constraint order_events_settlement_fk foreign key (related_settlement_id, company_id)
        references trader_settlements(id, company_id) on delete restrict,
      constraint order_events_type_nonempty check (btrim(event_type) <> ''),
      constraint order_events_category_check check (event_category in (
        'status_change', 'driver_assignment', 'financial_change', 'attachment',
        'user_action', 'system_action'
      )),
      constraint order_events_actor_role_nonempty check (btrim(actor_role) <> ''),
      constraint order_events_source_check check (source in (
        'web_portal', 'driver_mobile_app', 'trader_mobile_app',
        'import', 'api', 'system', 'legacy_unknown'
      )),
      constraint order_events_correlation_nonempty check (btrim(correlation_id) <> '')
    );
    create index order_events_order_time_index
      on order_events (company_id, order_id, occurred_at desc, id desc);
    create index order_events_bulk_index
      on order_events (company_id, bulk_action_id) where bulk_action_id is not null;

    create function reject_order_event_mutation() returns trigger language plpgsql as $$
    begin
      raise exception using errcode = '23514',
        message = 'Order events are append-only; existing events cannot be updated or deleted';
    end;
    $$;
    create trigger order_events_append_only before update or delete on order_events
      for each row execute function reject_order_event_mutation();

    insert into order_events (
      company_id, order_id, event_type, event_category, field_name,
      previous_value, new_value, actor_account_id, actor_role, source,
      reason, correlation_id, legacy_status_history_id, occurred_at
    )
    select h.company_id, h.order_id, 'order.status_change', 'status_change', h.status_dimension,
           case when h.from_status is null then null else to_jsonb(h.from_status) end,
           to_jsonb(h.to_status), h.changed_by_account_id, 'Legacy/Unknown',
           'legacy_unknown', h.reason, 'legacy-status-history:' || h.id::text, h.id, h.occurred_at
    from order_status_history h;

    insert into order_events (
      company_id, order_id, event_type, event_category,
      previous_value, new_value, actor_account_id, actor_role, source,
      reason, correlation_id, legacy_audit_event_id, occurred_at
    )
    select e.company_id, o.id, e.action,
           case
             when e.action like '%attachment%' then 'attachment'
             when e.action like '%status%' then 'status_change'
             when e.action like '%assignment%' then 'driver_assignment'
             when e.action like '%fee%' or e.action like '%cash%' or e.action like '%settlement%'
               then 'financial_change'
             else 'user_action'
           end,
           e.before_data, e.after_data, e.actor_account_id, 'Legacy/Unknown',
           'legacy_unknown', e.reason, e.correlation_id, e.id, e.occurred_at
    from audit_events e
    join orders o on o.id::text = e.subject_id and o.company_id = e.company_id
    where e.subject_type = 'order';

    insert into order_events (
      company_id, order_id, event_type, event_category, field_name,
      previous_value, new_value, actor_role, source, reason, correlation_id
    )
    select company_id, id, 'system.status_migration', 'system_action', 'delivery_status',
           to_jsonb('assigned'::text), to_jsonb('assigned_to_driver'::text),
           'Legacy/Unknown', 'system', 'Approved operational status migration',
           'migration:20260715015000'
    from orders where delivery_status = 'assigned_to_driver';

    insert into order_events (
      company_id, order_id, event_type, event_category, field_name,
      previous_value, new_value, actor_role, source, reason, correlation_id
    )
    select company_id, id, 'system.status_migration', 'system_action', 'delivery_status',
           to_jsonb('returned'::text), to_jsonb('returned_to_branch'::text),
           'Legacy/Unknown', 'system', 'Approved operational status migration',
           'migration:20260715015000'
    from orders where delivery_status = 'returned_to_branch';

    insert into order_events (
      company_id, order_id, event_type, event_category, field_name,
      previous_value, new_value, actor_role, source, reason, correlation_id
    )
    select company_id, id, 'system.status_migration', 'system_action',
           'trader_settlement_status', to_jsonb('settled'::text),
           to_jsonb('money_sent_to_trader'::text), 'Legacy/Unknown', 'system',
           'Verified legacy Settled meant payment sent without receipt confirmation',
           'migration:20260715015000'
    from orders where trader_settlement_status = 'money_sent_to_trader';
  `.execute(database);
}
