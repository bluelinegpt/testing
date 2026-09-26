import { sql, type Kysely } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Per-Company selection of WHICH Order statuses send automatic Trader
 * WhatsApp notifications (approved 2026-09-03: e.g. a Company that wants
 * "Delivered only").
 *
 * `enabled_statuses` on `company_whatsapp_platform_settings`:
 * - NULL means ALL notifiable statuses send — the default, and what every
 *   existing Company keeps without a backfill. Storing "all six" as NULL
 *   (rather than a full array) also means a future seventh status is
 *   automatically enabled for Companies that never restricted anything.
 * - A non-null array is the closed allowlist: only those statuses write
 *   outbox intents. It may be empty (no automatic notifications at all,
 *   while the connection and test messages keep working).
 *
 * The CHECK pins every element to the notifiable-status catalogue so a typo
 * can never silently disable a status.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table company_whatsapp_platform_settings
      add column enabled_statuses text[],
      add constraint company_whatsapp_platform_settings_statuses_check check (
        enabled_statuses is null
        or (
          array_position(enabled_statuses, null) is null
          and enabled_statuses <@ array[
            'assigned_to_driver', 'out_for_delivery', 'delivered',
            'returned_to_branch', 'returned_to_trader', 'cancelled'
          ]::text[]
        )
      )
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table company_whatsapp_platform_settings
      drop constraint if exists company_whatsapp_platform_settings_statuses_check,
      drop column if exists enabled_statuses
  `.execute(database);
}
