import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
create sequence platform_agent_conversation_reference_seq;
create sequence platform_agent_handoff_reference_seq;

create table platform_agent_settings(
  id boolean primary key default true check(id),
  agent_enabled boolean not null default true,
  website_chat_enabled boolean not null default true,
  whatsapp_agent_enabled boolean not null default false,
  assistant_display_name text not null default 'Tawseelhub Assistant',
  default_language text not null default 'en' check(default_language in('en','ar')),
  human_handoff_enabled boolean not null default true,
  general_fallback_message text not null default 'I do not have confirmed information for that yet. I can pass this to the Tawseelhub team if you would like.',
  supported_public_intents text[] not null default array['customer_quote','trader','delivery_company_demo','general_question','handoff'],
  model_provider text not null default 'rules',
  model_identifier text not null default 'tawseelhub-rules-v1',
  max_response_length integer not null default 900 check(max_response_length between 200 and 2000),
  handoff_failure_threshold integer not null default 3 check(handoff_failure_threshold between 1 and 10),
  updated_by_account_id uuid references accounts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into platform_agent_settings(id) values(true);

create table platform_agent_knowledge(
  id uuid primary key default gen_random_uuid(),
  language text not null default 'en' check(language in('en','ar')),
  title text not null check(length(trim(title)) between 2 and 200),
  content text not null check(length(trim(content)) between 2 and 4000 and content !~* '<\\s*script'),
  category text not null default 'general' check(length(trim(category)) between 2 and 80),
  status text not null default 'draft' check(status in('draft','published','archived')),
  sort_order integer not null default 100,
  created_by_account_id uuid references accounts(id) on delete set null,
  updated_by_account_id uuid references accounts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index platform_agent_knowledge_public_idx on platform_agent_knowledge(language,status,sort_order,title);

create table platform_agent_conversations(
  id uuid primary key default gen_random_uuid(),
  reference_number text not null unique,
  public_session_token_hash text not null unique,
  channel text not null check(channel in('website','whatsapp','simulator')),
  channel_subject_hash text,
  language text not null default 'en' check(language in('en','ar')),
  current_intent text not null default 'unknown',
  status text not null default 'active' check(status in('active','waiting_for_user','action_pending','handoff_requested','handed_off','completed','abandoned','closed')),
  requester_type text check(requester_type in('customer','trader','delivery_company','unknown')),
  state jsonb not null default '{}',
  failure_count integer not null default 0,
  linked_quote_request_id uuid references platform_customer_quote_requests(id) on delete set null,
  linked_trader_application_id uuid references platform_trader_applications(id) on delete set null,
  linked_demo_request_id uuid references platform_demo_requests(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index platform_agent_conversations_admin_idx on platform_agent_conversations(created_at desc,channel,current_intent,status);
create index platform_agent_conversations_channel_idx on platform_agent_conversations(channel,channel_subject_hash) where channel_subject_hash is not null;

create table platform_agent_messages(
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references platform_agent_conversations(id) on delete restrict,
  sender_type text not null check(sender_type in('user','assistant','system')),
  content text not null check(length(content) <= 4000),
  structured_payload jsonb,
  created_at timestamptz not null default now()
);
create index platform_agent_messages_conversation_idx on platform_agent_messages(conversation_id,created_at);

create table platform_agent_actions(
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references platform_agent_conversations(id) on delete restrict,
  action_type text not null,
  status text not null check(status in('pending_confirmation','completed','failed','rejected')),
  request_snapshot jsonb not null default '{}',
  response_snapshot jsonb not null default '{}',
  safe_error_code text,
  created_at timestamptz not null default now()
);
create index platform_agent_actions_conversation_idx on platform_agent_actions(conversation_id,created_at desc);

create table platform_agent_handoffs(
  id uuid primary key default gen_random_uuid(),
  reference_number text not null unique,
  conversation_id uuid not null references platform_agent_conversations(id) on delete restrict,
  reason text not null,
  contact_name text,
  mobile text,
  email text,
  status text not null default 'new' check(status in('new','reviewing','contacted','resolved','closed')),
  assigned_to uuid references accounts(id) on delete set null,
  internal_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index platform_agent_handoffs_admin_idx on platform_agent_handoffs(created_at desc,status);

create table platform_agent_handoff_history(
  id uuid primary key default gen_random_uuid(),
  handoff_id uuid not null references platform_agent_handoffs(id) on delete restrict,
  old_status text,
  new_status text,
  actor_account_id uuid references accounts(id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

create function reject_agent_handoff_history_mutation() returns trigger language plpgsql as $$begin raise exception 'Agent handoff history is append-only' using errcode='55000'; end;$$;
create trigger agent_handoff_history_append_only before update or delete on platform_agent_handoff_history for each row execute function reject_agent_handoff_history_mutation();

insert into platform_agent_knowledge(language,title,content,category,status,sort_order) values
('en','What Tawseelhub does','Tawseelhub is a Delivery Operating System for UAE delivery companies. It helps manage orders, drivers, COD collections, Trader settlements, accounting, payroll, reports, Trader relationships, customer quote opportunities and planned commerce integrations.','general','published',10),
('en','Planned commerce integrations','Salla, Shopify and WooCommerce are planned integrations. Tawseelhub should not describe them as live until the backend integration is actually available.','integrations','published',20),
('en','Delivery company privacy','Tawseelhub does not expose a public Delivery Company directory in customer quote or Trader application conversations. Relationships are verified by the Platform team.','privacy','published',30),
('ar','ما هو Tawseelhub؟','Tawseelhub نظام تشغيل لشركات التوصيل في دولة الإمارات لإدارة الطلبات والسائقين والتحصيل والتسويات والتقارير وعلاقات التجار.','general','published',10);

insert into permissions(code,description) values
('platform.agent.read','View Agent conversations, handoffs and knowledge'),
('platform.agent.manage','Manage Agent settings, knowledge and handoffs')
on conflict(code) do update set description=excluded.description;
insert into role_permissions(role_id,permission_code)
select r.id,p.code from roles r cross join(values('platform.agent.read'),('platform.agent.manage')) p(code)
where r.company_id is null and lower(r.code)='platform_super_admin' on conflict do nothing;
`.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
delete from role_permissions where permission_code in('platform.agent.read','platform.agent.manage');
delete from permissions where code in('platform.agent.read','platform.agent.manage');
drop trigger agent_handoff_history_append_only on platform_agent_handoff_history;
drop function reject_agent_handoff_history_mutation();
drop table platform_agent_handoff_history;
drop table platform_agent_handoffs;
drop table platform_agent_actions;
drop table platform_agent_messages;
drop table platform_agent_conversations;
drop table platform_agent_knowledge;
drop table platform_agent_settings;
drop sequence platform_agent_handoff_reference_seq;
drop sequence platform_agent_conversation_reference_seq;
`.execute(database);
}
