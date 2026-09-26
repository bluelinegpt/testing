import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table commerce_integration_oauth_states (
      id uuid primary key default gen_random_uuid(),
      provider text not null,
      state_hash text not null unique,
      company_id uuid not null references companies(id) on delete restrict,
      trader_id uuid not null,
      trader_commerce_id uuid not null references trader_commerce_profiles(id) on delete restrict,
      requested_by_account_id uuid references accounts(id) on delete set null,
      redirect_after text,
      status text not null default 'pending',
      expires_at timestamptz not null,
      consumed_at timestamptz,
      created_at timestamptz not null default now(),
      constraint commerce_integration_oauth_states_provider_check
        check (provider in ('salla')),
      constraint commerce_integration_oauth_states_status_check
        check (status in ('pending','consumed','expired','cancelled')),
      constraint commerce_integration_oauth_states_trader_fk
        foreign key (trader_id, company_id) references traders(id, company_id) on delete restrict,
      constraint commerce_integration_oauth_states_not_expired_on_create
        check (expires_at > created_at)
    );

    create index commerce_integration_oauth_states_lookup_idx
      on commerce_integration_oauth_states(provider, status, expires_at);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table if exists commerce_integration_oauth_states;`.execute(db);
}
