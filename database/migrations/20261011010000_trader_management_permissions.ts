import { sql, type Kysely } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Least-privilege Company permissions for Trader master data and Trader
 * Portal logins, so a Company can give someone "add and change Traders" and
 * "create Trader Portal logins" without users_roles.manage (which also lets
 * them manage every user and role). Nothing is granted here: each Company
 * puts these in a Role of its own. users_roles.manage stays the fallback.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into permissions (code, description)
    values
      ('traders.manage', 'Create and edit Company Traders, their status, pricing and bank accounts'),
      ('trader_portal_users.manage', 'Create Trader Portal logins and suspend or restore them')
    on conflict (code) do update set description = excluded.description
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions
    where permission_code in ('traders.manage', 'trader_portal_users.manage')
  `.execute(database);
  await sql`
    delete from permissions
    where code in ('traders.manage', 'trader_portal_users.manage')
  `.execute(database);
}
