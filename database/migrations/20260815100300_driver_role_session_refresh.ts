import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Forces a fresh login for every account the Driver role backfill/repair
 * touched, so the corrected permission set takes effect immediately rather
 * than waiting for an existing session to expire naturally -- the same
 * `account_sessions.revoked_at` convention `UserAdministrationService`
 * already uses for every other permission-affecting change (lock, role
 * reassignment).
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    update account_sessions
       set revoked_at = coalesce(revoked_at, now())
     where revoked_at is null
       and account_id in (
         select distinct subject_id::uuid
           from audit_events
          where action in (
            'account_role.driver_backfill_assigned',
            'account_role.driver_office_role_removed'
          )
       )
  `.execute(database);
}

export async function down(): Promise<void> {
  // Revoked sessions cannot be un-revoked, nor should they be -- the
  // permission correction they followed from remains in effect.
}
