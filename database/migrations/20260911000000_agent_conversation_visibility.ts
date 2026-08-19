import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table platform_agent_conversations
      add column if not exists hidden_at timestamptz,
      add column if not exists hidden_by_account_id uuid references accounts(id) on delete set null,
      add column if not exists deleted_at timestamptz,
      add column if not exists deleted_by_account_id uuid references accounts(id) on delete set null;

    create index if not exists platform_agent_conversations_visibility_idx
      on platform_agent_conversations(deleted_at, hidden_at, last_message_at desc);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop index if exists platform_agent_conversations_visibility_idx;

    alter table platform_agent_conversations
      drop column if exists deleted_by_account_id,
      drop column if exists deleted_at,
      drop column if exists hidden_by_account_id,
      drop column if exists hidden_at;
  `.execute(db);
}
