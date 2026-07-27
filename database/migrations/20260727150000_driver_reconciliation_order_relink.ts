import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Allows an Order to be linked to a Driver collection again after a valid
 * reversal (Phase 4 §8: "restoration of Order eligibility where financially
 * safe"). `driver_reconciliation_orders_order_unique` originally made an Order
 * linkable exactly once, for the system's entire lifetime — correct before
 * reversal existed, too strict now: `reverse()` intentionally never deletes or
 * rewrites the original (immutable, confirmed) link row, so a plain per-Order
 * uniqueness permanently blocks re-collecting a reversed Order.
 *
 * The replacement invariant is "at most one Driver-collection link per Order
 * whose owning reconciliation has not itself been reversed" — the same
 * protective intent (no Order claimed by two ACTIVE collections at once),
 * correctly scoped. Because "reversed" is a fact recorded on a *different,
 * later* row (a reconciliation with `reversal_of_id` pointing at this one), a
 * plain partial unique index cannot express it (partial index predicates may
 * not reference other rows/tables); a deferrable constraint trigger can, and
 * the same pattern already exists in this schema (e.g.
 * `orders_customer_scope_guard`).
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index driver_reconciliation_orders_order_unique;
    create index driver_reconciliation_orders_order_lookup_index
      on driver_reconciliation_orders (company_id, order_id);

    create function enforce_single_active_reconciliation_link() returns trigger
    language plpgsql as $$
    declare
      conflicting_count integer;
    begin
      select count(*) into conflicting_count
        from driver_reconciliation_orders existing
        join driver_reconciliations existing_reconciliation
          on existing_reconciliation.id = existing.reconciliation_id
         and existing_reconciliation.company_id = existing.company_id
       where existing.company_id = new.company_id
         and existing.order_id = new.order_id
         and existing.id <> new.id
         and not exists (
           select 1 from driver_reconciliations reversal
            where reversal.company_id = existing_reconciliation.company_id
              and reversal.reversal_of_id = existing_reconciliation.id
         );
      if conflicting_count > 0 then
        raise exception using errcode = '23514',
          message = 'Order is already linked to an active (non-reversed) Driver collection';
      end if;
      return new;
    end;
    $$;

    create constraint trigger driver_reconciliation_orders_single_active_link
      after insert on driver_reconciliation_orders
      deferrable initially immediate
      for each row execute function enforce_single_active_reconciliation_link();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists driver_reconciliation_orders_single_active_link
      on driver_reconciliation_orders;
    drop function if exists enforce_single_active_reconciliation_link();
    drop index if exists driver_reconciliation_orders_order_lookup_index;
    create unique index driver_reconciliation_orders_order_unique
      on driver_reconciliation_orders (company_id, order_id);
  `.execute(database);
}
