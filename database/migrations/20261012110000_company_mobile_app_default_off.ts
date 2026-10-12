import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Mobile app access is Off by default (Aiman, 12 Oct 2026).
 *
 * - New Companies start with the mobile app Off; the Platform turns it On
 *   per Company (Platform -> Company -> Mobile app).
 * - Every existing Company is switched Off now, by Aiman's decision. App
 *   users are stopped on their next request until their Company is turned
 *   On. The web portal is not affected.
 *
 * `down` restores the On default but does not turn Companies back on: which
 * Companies the Platform has since enabled is a decision, not schema.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table companies alter column mobile_app_enabled set default false
  `.execute(database);
  await sql`
    update companies
       set mobile_app_enabled = false,
           mobile_app_changed_at = now()
     where mobile_app_enabled
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table companies alter column mobile_app_enabled set default true
  `.execute(database);
}
