import { type Kysely, sql } from "kysely";
type MigrationDatabase = Record<string, never>;
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table company_website_agent_conversations (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      company_website_id uuid not null references company_websites(id) on delete restrict,
      public_token_hash text not null unique,
      visitor_ip_hash text,
      language text not null check(language in('en','ar')),
      messages jsonb not null default '[]'::jsonb,
      message_count integer not null default 0 check(message_count between 0 and 40),
      handoff_state text not null default 'ai_active' check(handoff_state in('ai_active','offered')),
      source text not null default 'company_website' check(source='company_website'),
      expires_at timestamptz not null default now()+interval '24 hours',
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create index company_website_agent_conversations_company_updated on company_website_agent_conversations(company_id,updated_at desc);
  `.execute(database);
}
export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop table if exists company_website_agent_conversations;`.execute(database);
}
