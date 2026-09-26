import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
alter table platform_agent_conversations
  add column if not exists operational_classification text not null default 'general_enquiry'
    check(operational_classification in(
      'shipment_quote',
      'trader_lead',
      'delivery_company_lead',
      'demo_request',
      'product_question',
      'storefront_commerce',
      'support',
      'general_enquiry',
      'pricing_enquiry',
      'partnership_enquiry'
    )),
  add column if not exists platform_last_read_at timestamptz,
  add column if not exists assigned_by_account_id uuid references accounts(id) on delete set null,
  add column if not exists assigned_at timestamptz;

update platform_agent_conversations
set operational_classification = case
  when linked_quote_request_id is not null or current_intent = 'customer_quote' then 'shipment_quote'
  when linked_trader_application_id is not null or current_intent = 'trader' then 'trader_lead'
  when linked_demo_request_id is not null then 'demo_request'
  when current_intent = 'delivery_company_demo' then 'delivery_company_lead'
  when current_intent in ('product_feature_question','current_feature_status') then 'product_question'
  else operational_classification
end;

update platform_agent_conversations
set assigned_at = coalesce(reviewed_at, updated_at),
    assigned_by_account_id = reviewed_by_account_id
where assigned_to_account_id is not null
  and assigned_at is null;

create index if not exists platform_agent_conversations_daily_group_idx
  on platform_agent_conversations(
    ((last_message_at at time zone 'Asia/Dubai')::date),
    customer_id,
    mobile_number_normalized,
    visitor_id,
    last_message_at desc
  );

create index if not exists platform_agent_conversations_classification_idx
  on platform_agent_conversations(operational_classification, last_message_at desc);

create index if not exists platform_agent_conversations_unread_idx
  on platform_agent_conversations(platform_last_read_at, last_message_at desc);

create index if not exists platform_agent_conversations_assignee_idx
  on platform_agent_conversations(assigned_to_account_id, assigned_at desc)
  where assigned_to_account_id is not null;

create index if not exists platform_customer_quote_requests_mobile_reference_idx
  on platform_customer_quote_requests(regexp_replace(requester_mobile, '\\D', '', 'g'), reference_number, created_at desc);
`.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
drop index if exists platform_customer_quote_requests_mobile_reference_idx;
drop index if exists platform_agent_conversations_assignee_idx;
drop index if exists platform_agent_conversations_unread_idx;
drop index if exists platform_agent_conversations_classification_idx;
drop index if exists platform_agent_conversations_daily_group_idx;
alter table platform_agent_conversations
  drop column if exists assigned_at,
  drop column if exists assigned_by_account_id,
  drop column if exists platform_last_read_at,
  drop column if exists operational_classification;
`.execute(database);
}
