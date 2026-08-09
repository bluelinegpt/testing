import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Audit hardening for Platform Phase 1 certification.
 *
 * The Prompt 1 repository audit named three gaps in `audit_events`: no
 * structured result, no failure reason, and no way to tell which application an
 * action came from. All three still existed at the start of Prompt 5. This
 * closes them.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NEW COLUMNS ARE NULLABLE WITH NO DEFAULT
 * ---------------------------------------------------------------------------
 *
 * `audit_events_immutable` rejects every UPDATE and DELETE — the table is
 * genuinely append-only, so the 2,102 existing rows CANNOT be backfilled, by
 * this migration or by anything else. That is the correct behaviour and is not
 * being weakened.
 *
 * A `NOT NULL DEFAULT 'success'` would therefore be a lie: every historical row
 * would silently claim an outcome nobody recorded. Nullable with no default
 * keeps the distinction honest — `result IS NULL` means "written before result
 * tracking existed", which is a true and useful statement.
 *
 * ---------------------------------------------------------------------------
 * WHY `source_application` IS A NEW COLUMN, NOT A CONSTRAINT ON `source`
 * ---------------------------------------------------------------------------
 *
 * `source` already exists and is uncontrolled free text. Its live values are
 * `web`, `web_portal`, `platform_portal`, `customer_configuration`,
 * `order_creation` and null — the last two are ACTIONS, not applications, so
 * the column has drifted into a mixed bag.
 *
 * Constraining it would fail against that data, and the rows cannot be
 * corrected because the table is append-only. So `source` is left exactly as it
 * is for existing writers, and a separate controlled column carries the
 * question Phase 1 actually needs answered: which application did this come
 * from. New Platform writes set both.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table audit_events
      add column result text,
      add column failure_reason text,
      add column source_application text;

    alter table audit_events
      add constraint audit_events_result_check check (
        result is null or result in ('success', 'failure', 'denied')
      ),
      add constraint audit_events_source_application_check check (
        source_application is null or source_application in (
          'platform-web', 'company-web', 'store', 'mobile', 'api', 'system'
        )
      ),
      -- A failure reason without a failure is a contradiction; a failure or a
      -- denial with no reason is an unanswerable audit entry.
      add constraint audit_events_failure_reason_shape check (
        (result in ('failure', 'denied') and btrim(coalesce(failure_reason, '')) <> '')
        or (result not in ('failure', 'denied') and failure_reason is null)
        or result is null
      );

    -- The Platform audit browser reads across every Company, newest first,
    -- filtered to Platform actions. None of the existing indexes serves that:
    -- they lead with company_id, subject or actor. Partial, so it stays small
    -- and costs nothing on the operational write paths.
    create index audit_events_platform_time_index
      on audit_events (occurred_at desc)
      where action like 'platform.%';
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists audit_events_platform_time_index;

    alter table audit_events
      drop constraint if exists audit_events_failure_reason_shape,
      drop constraint if exists audit_events_source_application_check,
      drop constraint if exists audit_events_result_check;

    alter table audit_events
      drop column if exists source_application,
      drop column if exists failure_reason,
      drop column if exists result;
  `.execute(database);
}
