import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Repair Center Phase 5, Prompt 1 -- Payroll repair audit.
 *
 * The Platform Repair Center now repairs ONE Payroll period at a time (payment
 * state reconciliation, draft line amounts, draft period totals -- each through
 * the Payroll domain's own `PayrollOperationalRepository`). Its immutable
 * success record (`platform_repair_executions`) and its durable REFUSED /
 * FAILED / REPLAYED attempt record (`platform_repair_attempts`) must accept
 * the new entity type `payroll_period`. Nothing else changes: both tables stay
 * append-only, every existing row stays valid, and no existing value is
 * removed from either list.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_repair_executions drop constraint if exists platform_repair_executions_entity_type_check;
    alter table platform_repair_executions add constraint platform_repair_executions_entity_type_check
      check (entity_type in ('order', 'trader_receivable', 'accounting_event', 'payroll_period'));
    alter table platform_repair_attempts drop constraint if exists platform_repair_attempts_entity_type_check;
    alter table platform_repair_attempts add constraint platform_repair_attempts_entity_type_check
      check (entity_type in ('order', 'trader_receivable', 'accounting_event', 'payroll_period'));
  `.execute(database);
}

/** Forward-only in practice: payroll repair audit rows would violate the old list. */
export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_repair_executions drop constraint if exists platform_repair_executions_entity_type_check;
    alter table platform_repair_executions add constraint platform_repair_executions_entity_type_check
      check (entity_type in ('order', 'trader_receivable', 'accounting_event', 'payroll_period'));
    alter table platform_repair_attempts drop constraint if exists platform_repair_attempts_entity_type_check;
    alter table platform_repair_attempts add constraint platform_repair_attempts_entity_type_check
      check (entity_type in ('order', 'trader_receivable', 'accounting_event', 'payroll_period'));
  `.execute(database);
}
