import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table platform_agent_conversations
      add column if not exists visitor_ip_hash text,
      add column if not exists visitor_ip_seen_at timestamptz;

    create index if not exists platform_agent_conversations_ip_identity_idx
      on platform_agent_conversations(visitor_ip_hash, last_message_at desc)
      where visitor_ip_hash is not null;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop index if exists platform_agent_conversations_ip_identity_idx;

    alter table platform_agent_conversations
      drop column if exists visitor_ip_seen_at,
      drop column if exists visitor_ip_hash;
  `.execute(db);
}
