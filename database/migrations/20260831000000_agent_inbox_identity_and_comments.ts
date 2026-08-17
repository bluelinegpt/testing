import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
alter table platform_agent_conversations
  add column if not exists visitor_id uuid not null default gen_random_uuid(),
  add column if not exists customer_id uuid,
  add column if not exists customer_name text,
  add column if not exists mobile_number text,
  add column if not exists mobile_number_normalized text,
  add column if not exists email text,
  add column if not exists audience text not null default 'unknown' check(audience in('customer','trader','delivery_company','unknown')),
  add column if not exists last_message_at timestamptz,
  add column if not exists assigned_to_account_id uuid references accounts(id) on delete set null;

update platform_agent_conversations
set last_message_at=coalesce(
  (select max(created_at) from platform_agent_messages where conversation_id=platform_agent_conversations.id),
  updated_at,
  created_at
)
where last_message_at is null;

update platform_agent_conversations
set review_status = case review_status
  when 'reviewing' then 'in_progress'
  when 'action_required' then 'follow_up'
  when 'contacted' then 'waiting_for_customer'
  else review_status
end;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid='platform_agent_conversations'::regclass
      and contype='c'
      and pg_get_constraintdef(oid) like '%review_status%'
  loop
    execute format('alter table platform_agent_conversations drop constraint %I', constraint_name);
  end loop;
end $$;

alter table platform_agent_conversations
  alter column review_status set default 'new',
  add constraint platform_agent_conversations_review_status_check
    check(review_status in('new','open','in_progress','waiting_for_customer','follow_up','resolved','closed','spam'));

create index if not exists platform_agent_conversations_inbox_idx
  on platform_agent_conversations(last_message_at desc,review_status,audience);
create index if not exists platform_agent_conversations_identity_idx
  on platform_agent_conversations(mobile_number_normalized,customer_name,reference_number);

create table if not exists platform_agent_conversation_comments(
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references platform_agent_conversations(id) on delete restrict,
  author_account_id uuid references accounts(id) on delete set null,
  comment text not null check(length(trim(comment)) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists platform_agent_conversation_comments_idx
  on platform_agent_conversation_comments(conversation_id,created_at);

create table if not exists platform_agent_conversation_status_history(
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references platform_agent_conversations(id) on delete restrict,
  old_status text,
  new_status text not null,
  old_assigned_to_account_id uuid references accounts(id) on delete set null,
  new_assigned_to_account_id uuid references accounts(id) on delete set null,
  actor_account_id uuid references accounts(id) on delete set null,
  comment text,
  created_at timestamptz not null default now()
);
create index if not exists platform_agent_conversation_status_history_idx
  on platform_agent_conversation_status_history(conversation_id,created_at desc);
`.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
drop table if exists platform_agent_conversation_status_history;
drop table if exists platform_agent_conversation_comments;
drop index if exists platform_agent_conversations_identity_idx;
drop index if exists platform_agent_conversations_inbox_idx;
alter table platform_agent_conversations
  drop constraint if exists platform_agent_conversations_review_status_check;
alter table platform_agent_conversations
  drop column if exists assigned_to_account_id,
  drop column if exists last_message_at,
  drop column if exists audience,
  drop column if exists email,
  drop column if exists mobile_number_normalized,
  drop column if exists mobile_number,
  drop column if exists customer_name,
  drop column if exists customer_id,
  drop column if exists visitor_id;
`.execute(database);
}
