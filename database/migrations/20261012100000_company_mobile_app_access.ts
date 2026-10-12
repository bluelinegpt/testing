import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Mobile app access per Company (Aiman, 12 Oct 2026): one On/Off switch on
 * the Platform for all of a Company's mobile users. The web portal is not
 * affected.
 *
 * - `companies.mobile_app_enabled` (default true, so nothing changes for
 *   existing Companies) and when it last changed.
 * - `account_sessions.client_channel`: `mobile` when the session was opened
 *   from the app (signed in with the Company Mobile Code), otherwise `web`.
 *   Live sessions opened by the app before this migration (the app's HTTP
 *   client identifies itself as `Dart/...`) are marked `mobile` so the switch
 *   covers them too.
 *
 * Additive only.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table companies
      add column if not exists mobile_app_enabled boolean not null default true,
      add column if not exists mobile_app_changed_at timestamptz
  `.execute(database);
  await sql`
    alter table account_sessions
      add column if not exists client_channel text not null default 'web'
  `.execute(database);
  await sql`
    alter table account_sessions drop constraint if exists account_sessions_client_channel_check
  `.execute(database);
  await sql`
    alter table account_sessions
      add constraint account_sessions_client_channel_check
      check (client_channel in ('web', 'mobile'))
  `.execute(database);
  await sql`
    update account_sessions
       set client_channel = 'mobile'
     where revoked_at is null
       and expires_at > now()
       and user_agent like 'Dart/%'
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table account_sessions
      drop constraint if exists account_sessions_client_channel_check,
      drop column if exists client_channel
  `.execute(database);
  await sql`
    alter table companies
      drop column if exists mobile_app_changed_at,
      drop column if exists mobile_app_enabled
  `.execute(database);
}
