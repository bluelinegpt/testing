import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Permission for Customer Commerce Prompt C4 -- converting a confirmed
 * Store Order into a Delivery Order.
 *
 * Same shape as `20260822000000_company_reset_permission.ts`: a permission
 * nothing enforces is a control that only appears to exist, so this is
 * seeded at the same time the route/guard that checks it is added, not
 * ahead of it. Granted to `platform_super_admin` only -- C4's own prompt
 * (§44) explicitly asks for conversion to start as a system/internal
 * action, not yet exposed to a Company or Delivery Company self-service
 * flow; widening who can call it is a later, separate decision.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into permissions (code, description)
    values ('platform.store_order_conversion.manage', 'Convert a confirmed Customer Commerce Store Order into a Delivery Order')
    on conflict (code) do update set description = excluded.description;

    insert into role_permissions (role_id, permission_code)
    select r.id, 'platform.store_order_conversion.manage' from roles r
     where r.company_id is null and lower(r.code) = 'platform_super_admin'
    on conflict do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code = 'platform.store_order_conversion.manage';
    delete from permissions where code = 'platform.store_order_conversion.manage';
  `.execute(database);
}
