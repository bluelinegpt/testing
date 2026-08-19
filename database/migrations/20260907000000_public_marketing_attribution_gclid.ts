import { sql, type Kysely } from "kysely";

type MigrationDatabase = Record<string, unknown>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_demo_requests
      add column if not exists gclid text check (gclid is null or char_length(gclid) <= 200);

    alter table platform_customer_quote_requests
      add column if not exists utm_term text check (utm_term is null or char_length(utm_term) <= 120),
      add column if not exists utm_content text check (utm_content is null or char_length(utm_content) <= 120),
      add column if not exists gclid text check (gclid is null or char_length(gclid) <= 200);

    alter table platform_trader_applications
      add column if not exists gclid text check (gclid is null or char_length(gclid) <= 200);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_trader_applications drop column if exists gclid;
    alter table platform_customer_quote_requests
      drop column if exists gclid,
      drop column if exists utm_content,
      drop column if exists utm_term;
    alter table platform_demo_requests drop column if exists gclid;
  `.execute(database);
}
