import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Widens `client_error_reports_source_app_check` to allow `'public-web'`.
 *
 * `apps/public-web` already attempts to report its own browser crashes
 * (`installCrashReporting()`, wired in since before this migration existed),
 * but every report it sends has always failed: the CHECK constraint this
 * migration updates never allowed `'public-web'` as a `source_app` value, so
 * every insert attempt was rejected and the report lost — see the Error
 * Handler follow-up prompt's own finding. Purely additive: the existing five
 * values (`web`, `api`, `platform-web`, `store`, `mobile`) are preserved
 * exactly, `public-web` is the only value being added.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table client_error_reports
      drop constraint client_error_reports_source_app_check;

    alter table client_error_reports
      add constraint client_error_reports_source_app_check
        check (source_app in ('web', 'api', 'platform-web', 'store', 'mobile', 'public-web'));
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table client_error_reports
      drop constraint client_error_reports_source_app_check;

    alter table client_error_reports
      add constraint client_error_reports_source_app_check
        check (source_app in ('web', 'api', 'platform-web', 'store', 'mobile'));
  `.execute(database);
}
