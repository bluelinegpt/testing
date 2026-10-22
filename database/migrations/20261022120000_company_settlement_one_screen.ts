import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * One-screen Trader Settlement, per Company (Aiman, 22 Oct 2026).
 *
 * New Settlement on one screen (orders to pay, Trader fees, Trader credits and
 * 0-due orders in one table, totals at the end), Draft -> preview invoice ->
 * Post, Un-post and adjust, and no "Money Received" confirmation step.
 *
 * Off by default. Switched on for CMP-000001 (Abdulrahman) only, at Aiman's
 * request, so it can be tested there before every Company gets it. Every
 * other Company keeps the existing settlement screen unchanged.
 *
 * Additive: one column. The only data change is that single Company's flag.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table companies
      add column if not exists settlement_one_screen_enabled boolean not null default false
  `.execute(database);
  await sql`
    update companies
       set settlement_one_screen_enabled = true
     where id = 'e7042c01-0480-41c9-b119-7621d158e7f6'::uuid
       and code = 'CMP-000001'
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table companies drop column if exists settlement_one_screen_enabled
  `.execute(database);
}
