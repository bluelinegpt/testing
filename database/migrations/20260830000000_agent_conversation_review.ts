import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
alter table platform_agent_conversations
  add column if not exists review_status text not null default 'new' check(review_status in('new','reviewing','action_required','contacted','resolved','closed')),
  add column if not exists review_comment text,
  add column if not exists review_action text,
  add column if not exists reviewed_by_account_id uuid references accounts(id) on delete set null,
  add column if not exists reviewed_at timestamptz;

create index if not exists platform_agent_conversations_review_idx
  on platform_agent_conversations(review_status,updated_at desc);
`.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
drop index if exists platform_agent_conversations_review_idx;
alter table platform_agent_conversations
  drop column if exists reviewed_at,
  drop column if exists reviewed_by_account_id,
  drop column if exists review_action,
  drop column if exists review_comment,
  drop column if exists review_status;
`.execute(database);
}
