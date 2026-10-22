import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Trader Settlement options on for the test Companies (Aiman, 22 Oct 2026).
 *
 * After testing on CMP-000001, both switches -- one-screen settlement and
 * Trader pays COD shortfall -- go on for the Companies Aiman named as test
 * Companies: aiman (CMP-000002), AL Fahd Al Maliky (CMP-000007), Dana (Test)
 * and TawsolExpress. None has an open draft, a settlement waiting for Money
 * Received, or an old Order with COD below its fee (checked 22 Oct 2026).
 *
 * Lahthza (CMP-000003) is deliberately NOT here: it is the live Company and is
 * switched on from Platform Administration -> Company -> Trader Settlement
 * when Aiman decides. Every Company can be switched back off there at any time.
 *
 * Only the two switches change; no Order, settlement or money is touched. Each
 * row is matched by id AND code, so a reused id can never be switched.
 */
const companies: readonly (readonly [string, string])[] = [
  ["8cd21cb3-831b-4278-940a-84ad42f4a9ab", "CMP-000002"],
  ["2f0703c3-2b3b-45ef-a6ab-de9b3694c0a1", "CMP-000007"],
  ["dd28829b-2b7c-4851-a0be-181b92673e84", "DEV-DD28829B"],
  ["a12a5183-c072-4a2a-b632-1aa62405a894", "TAW-1"],
];

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  for (const [id, code] of companies) {
    await sql`
      update companies
         set settlement_one_screen_enabled = true,
             trader_pays_cod_shortfall = true
       where id = ${id}::uuid and code = ${code}
    `.execute(database);
  }
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  for (const [id, code] of companies) {
    await sql`
      update companies
         set settlement_one_screen_enabled = false,
             trader_pays_cod_shortfall = false
       where id = ${id}::uuid and code = ${code}
    `.execute(database);
  }
}
