import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * `file_objects.owner_type` defaults to 'company'.
 *
 * Four operational paths insert files today — Company branding, general
 * expenses, and two in Operations — and every one of them creates a
 * Company-owned file. Making them all name the owner explicitly would mean
 * editing four Delivery-domain services to restate a fact that has been true
 * since the table existed, which is exactly the kind of unrelated rewrite the
 * Commerce work is supposed to avoid.
 *
 * The default is safe rather than merely convenient, because it cannot mask a
 * mistake in the direction that matters. A Commerce path that forgets to set
 * `owner_type` inherits 'company' and then fails immediately on
 * `file_objects_owner_shape_check`, since a Commerce file has no `company_id`.
 * The default rescues legacy Company inserts and refuses to rescue anything
 * else.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table file_objects alter column owner_type set default 'company'
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table file_objects alter column owner_type drop default
  `.execute(database);
}
