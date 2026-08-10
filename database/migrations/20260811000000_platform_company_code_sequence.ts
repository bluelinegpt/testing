import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/** Global, concurrency-safe numbering for newly-created Platform Companies. */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`create sequence if not exists platform_company_code_seq as bigint minvalue 1 start with 1 increment by 1 no cycle`.execute(database);
  await sql`
    select setval(
      'platform_company_code_seq',
      greatest(
        coalesce((
          select max(substring(code from '^CMP-([0-9]+)$')::bigint)
            from companies where code ~ '^CMP-[0-9]+$'
        ), 0) + 1,
        (select last_value from platform_company_code_seq)
      ),
      false
    )
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop sequence if exists platform_company_code_seq`.execute(database);
}
