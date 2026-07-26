import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

// Phase A schema (driver side): the driver money-collection payment method is Cash or Visa
// (Visa = the customer paid by card/bank rather than physical cash). One method per collection,
// stored on the collection and on each linked Order for the audit trail. Also adds a required
// reason to driver-collection expenses. Columns are nullable so the current collection flow keeps
// working until Phase 3 sets them; Phase 3 enforces presence in the application layer.
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table driver_reconciliations
      add column collection_payment_method text
      constraint driver_reconciliations_collection_payment_method_check
      check (collection_payment_method is null or collection_payment_method in ('cash', 'visa'));

    alter table driver_reconciliation_orders
      add column collection_payment_method text
      constraint driver_reconciliation_orders_collection_payment_method_check
      check (collection_payment_method is null or collection_payment_method in ('cash', 'visa'));

    alter table driver_reconciliation_expenses
      add column reason text;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table driver_reconciliation_expenses drop column reason;
    alter table driver_reconciliation_orders drop column collection_payment_method;
    alter table driver_reconciliations drop column collection_payment_method;
  `.execute(database);
}
