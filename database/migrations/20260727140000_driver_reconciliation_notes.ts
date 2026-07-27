import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Adds an optional Notes field to a Driver collection/reconciliation (Phase 4
 * §6/§9/§10: "Add notes where appropriate", shown on the detail page and the
 * Driver Collection Report). Additive and reversible; nullable so every existing
 * confirmed reconciliation is unaffected and the immutable-once-confirmed
 * trigger (`driver_reconciliations_immutable`) is untouched.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table driver_reconciliations add column notes text;
    alter table driver_reconciliations add constraint driver_reconciliations_notes_length
      check (notes is null or length(notes) <= 1000);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table driver_reconciliations drop constraint if exists driver_reconciliations_notes_length;
    alter table driver_reconciliations drop column if exists notes;
  `.execute(database);
}
