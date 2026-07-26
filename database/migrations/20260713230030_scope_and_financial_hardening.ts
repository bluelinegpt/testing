import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create function enforce_account_role_scope() returns trigger language plpgsql as $$
    declare
      account_company_id uuid;
      role_company_id uuid;
    begin
      select company_id into account_company_id from accounts where id = new.account_id;
      select company_id into role_company_id from roles where id = new.role_id;
      if account_company_id is distinct from role_company_id
        or new.company_id is distinct from account_company_id then
        raise exception 'account and role must belong to the same scope';
      end if;
      return new;
    end;
    $$;
    create trigger account_roles_scope_guard
      before insert or update on account_roles
      for each row execute function enforce_account_role_scope();

    create function enforce_profile_account_kind() returns trigger language plpgsql as $$
    declare
      actual_kind text;
      actual_company_id uuid;
    begin
      select account_kind, company_id into actual_kind, actual_company_id
        from accounts where id = new.account_id;
      if actual_kind is distinct from tg_argv[0]
        or actual_company_id is distinct from new.company_id then
        raise exception 'profile account kind or Company scope is invalid';
      end if;
      return new;
    end;
    $$;
    create trigger company_users_account_kind_guard
      before insert or update of account_id, company_id on company_users
      for each row execute function enforce_profile_account_kind('company_user');
    create trigger traders_account_kind_guard
      before insert or update of account_id, company_id on traders
      for each row execute function enforce_profile_account_kind('trader');
    create trigger drivers_account_kind_guard
      before insert or update of account_id, company_id on drivers
      for each row execute function enforce_profile_account_kind('driver');

    create function enforce_audit_actor_scope() returns trigger language plpgsql as $$
    declare
      actor_company_id uuid;
      actor_kind text;
    begin
      if new.actor_account_id is null then
        return new;
      end if;
      select company_id, account_kind into actor_company_id, actor_kind
        from accounts where id = new.actor_account_id;
      if actor_kind <> 'platform_administrator'
        and actor_company_id is distinct from new.company_id then
        raise exception 'audit actor cannot record an event outside its Company';
      end if;
      return new;
    end;
    $$;
    create trigger audit_events_actor_scope_guard
      before insert on audit_events
      for each row execute function enforce_audit_actor_scope();

    create function enforce_international_order() returns trigger language plpgsql as $$
    begin
      if not exists (
        select 1 from orders
        where id = new.order_id and company_id = new.company_id and delivery_mode = 'international'
      ) then
        raise exception 'international shipment requires an international Order in the same Company';
      end if;
      return new;
    end;
    $$;
    create trigger international_shipments_order_guard
      before insert or update of order_id, company_id on international_shipments
      for each row execute function enforce_international_order();

    create function enforce_reconciliation_order_driver() returns trigger language plpgsql as $$
    begin
      if not exists (
        select 1
        from driver_reconciliations reconciliation
        join orders target_order
          on target_order.id = new.order_id and target_order.company_id = new.company_id
        where reconciliation.id = new.reconciliation_id
          and reconciliation.company_id = new.company_id
          and target_order.assigned_driver_id = reconciliation.driver_id
      ) then
        raise exception 'reconciliation Order must be assigned to the reconciliation Driver';
      end if;
      return new;
    end;
    $$;
    create trigger driver_reconciliation_orders_driver_guard
      before insert or update of reconciliation_id, order_id, company_id on driver_reconciliation_orders
      for each row execute function enforce_reconciliation_order_driver();

    create function enforce_settlement_order_trader() returns trigger language plpgsql as $$
    begin
      if not exists (
        select 1
        from trader_settlements settlement
        join orders target_order
          on target_order.id = new.order_id and target_order.company_id = new.company_id
        where settlement.id = new.settlement_id
          and settlement.company_id = new.company_id
          and target_order.trader_id = settlement.trader_id
      ) then
        raise exception 'settlement Order must belong to the settlement Trader';
      end if;
      return new;
    end;
    $$;
    create trigger trader_settlement_orders_trader_guard
      before insert or update of settlement_id, order_id, company_id on trader_settlement_orders
      for each row execute function enforce_settlement_order_trader();

    create function reject_confirmed_reconciliation_child_mutation() returns trigger language plpgsql as $$
    declare
      parent_id uuid;
      parent_company_id uuid;
    begin
      parent_id := case when tg_op = 'DELETE' then old.reconciliation_id else new.reconciliation_id end;
      parent_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
      if exists (
        select 1 from driver_reconciliations
        where id = parent_id and company_id = parent_company_id and status = 'confirmed'
      ) then
        raise exception 'confirmed reconciliation details are immutable';
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;
    create trigger driver_reconciliation_orders_immutable
      before insert or update or delete on driver_reconciliation_orders
      for each row execute function reject_confirmed_reconciliation_child_mutation();
    create trigger driver_reconciliation_expenses_immutable
      before insert or update or delete on driver_reconciliation_expenses
      for each row execute function reject_confirmed_reconciliation_child_mutation();
    create trigger driver_reconciliation_payments_immutable
      before insert or update or delete on driver_reconciliation_payments
      for each row execute function reject_confirmed_reconciliation_child_mutation();

    create function reject_confirmed_settlement_child_mutation() returns trigger language plpgsql as $$
    declare
      parent_id uuid;
      parent_company_id uuid;
    begin
      parent_id := case when tg_op = 'DELETE' then old.settlement_id else new.settlement_id end;
      parent_company_id := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
      if exists (
        select 1 from trader_settlements
        where id = parent_id and company_id = parent_company_id and status = 'confirmed'
      ) then
        raise exception 'confirmed settlement details are immutable';
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;
    create trigger trader_settlement_orders_immutable
      before insert or update or delete on trader_settlement_orders
      for each row execute function reject_confirmed_settlement_child_mutation();
    create trigger trader_settlement_payments_immutable
      before insert or update or delete on trader_settlement_payments
      for each row execute function reject_confirmed_settlement_child_mutation();
  `.execute(database);
}
