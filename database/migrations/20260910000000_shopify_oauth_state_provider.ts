import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table commerce_integration_oauth_states
      drop constraint if exists commerce_integration_oauth_states_provider_check;

    alter table commerce_integration_oauth_states
      add constraint commerce_integration_oauth_states_provider_check
        check (provider in ('salla','shopify'));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table commerce_integration_oauth_states
      drop constraint if exists commerce_integration_oauth_states_provider_check;

    alter table commerce_integration_oauth_states
      add constraint commerce_integration_oauth_states_provider_check
        check (provider in ('salla'));
  `.execute(db);
}
