import { type Kysely, sql } from "kysely";
type MigrationDatabase = Record<string, never>;
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table company_website_domains (
      id uuid primary key default gen_random_uuid(),
      company_website_id uuid not null references company_websites(id) on delete restrict,
      company_id uuid not null references companies(id) on delete restrict,
      hostname text not null,
      status text not null default 'pending_verification' check (status in ('pending_verification','verified','pending_ssl','active','failed','disabled')),
      verification_status text not null default 'pending' check (verification_status in ('pending','verified','failed')),
      ssl_status text not null default 'pending' check (ssl_status in ('pending','active','failed')),
      is_primary boolean not null default false,
      verification_method text not null default 'txt' check (verification_method in ('txt','cname')),
      verification_records jsonb not null default '[]'::jsonb,
      provider text not null,
      provider_reference text,
      last_error text,
      version integer not null default 1,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      verified_at timestamptz, activated_at timestamptz, disabled_at timestamptz,
      last_updated_by_account_id uuid not null references accounts(id) on delete restrict,
      constraint company_website_domain_hostname check (hostname=lower(btrim(hostname)) and length(hostname)<=253 and hostname ~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$')
    );
    create unique index company_website_domains_hostname_unique on company_website_domains(lower(hostname));
    create unique index company_website_domains_one_primary on company_website_domains(company_website_id) where is_primary;
    create index company_website_domains_company on company_website_domains(company_id,created_at desc);
    alter table company_website_delivery_requests add column source_hostname text;
    alter table company_website_agent_conversations add column source_hostname text;
  `.execute(database);
}
export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`alter table company_website_agent_conversations drop column if exists source_hostname; alter table company_website_delivery_requests drop column if exists source_hostname; drop table if exists company_website_domains;`.execute(
    database,
  );
}
