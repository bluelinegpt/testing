import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_demo_requests
      alter column emirate drop not null;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    update platform_demo_requests
      set emirate = 'dubai'
      where emirate is null;

    alter table platform_demo_requests
      alter column emirate set not null;
  `.execute(database);
}
