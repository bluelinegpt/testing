import { sql, type Kysely } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * WhatsApp operations phase (Prompt 5): a dedicated permission for message
 * RESOLUTION actions — manual retry, duplicate-risk retry confirmation,
 * cancel, mark-resolved. These mutate delivery state and can cause a real
 * WhatsApp group to receive a duplicate message, so they must never ride on
 * the read-only `whatsapp.history.view`.
 *
 * Catalog-only seeding, no `role_permissions` grant — the same
 * `trader_receivables` / `whatsapp.*` precedent: the bootstrap Company
 * Administrator reaches these actions via the `users_roles.manage` fallback,
 * and granting the code to further roles is a Company administration action.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into permissions (code, description)
    values ('whatsapp.messages.manage', 'Resolve, cancel, or retry WhatsApp notification messages')
    on conflict (code) do update set description = excluded.description
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`delete from role_permissions where permission_code = 'whatsapp.messages.manage'`.execute(
    database,
  );
  await sql`delete from permissions where code = 'whatsapp.messages.manage'`.execute(database);
}
