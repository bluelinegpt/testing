import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * COD shortfall charged to the Trader, per Company (Aiman, 22 Oct 2026).
 *
 * On a "Pay by Customer" Order whose COD is above 0 but below its fees, the
 * Trader owes the part of the fee the COD does not cover (fees - COD), as a
 * service-charge Trader Receivable deducted in the Trader Settlement.
 * ORD-000023 (CMP-000001): COD 1.00, fee 20.00 -> the Trader owes 19.00.
 *
 * Off by default. Switched on for CMP-000001 (Abdulrahman) only, at Aiman's
 * request, so it can be tested there before every Company gets it.
 *
 * Additive: one column. The only data change is that single Company's flag.
 * No Order or Receivable is touched here.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table companies
      add column if not exists trader_pays_cod_shortfall boolean not null default false
  `.execute(database);
  await sql`
    update companies
       set trader_pays_cod_shortfall = true
     where id = 'e7042c01-0480-41c9-b119-7621d158e7f6'::uuid
       and code = 'CMP-000001'
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table companies drop column if exists trader_pays_cod_shortfall
  `.execute(database);
}
