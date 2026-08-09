import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table conversations (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      conversation_type text not null,
      order_id uuid,
      participant_context_type text not null,
      subject text,
      status text not null default 'active',
      priority text not null default 'normal',
      assigned_operator_user_id uuid,
      created_by_account_id uuid not null,
      last_message_id uuid,
      last_message_at timestamptz,
      resolved_at timestamptz,
      resolved_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      constraint conversations_type_check check (conversation_type in ('order', 'general_support')),
      constraint conversations_context_check check (participant_context_type in ('trader', 'driver', 'customer')),
      constraint conversations_status_check check (status in ('active', 'waiting_for_office', 'waiting_for_user', 'resolved', 'reopened')),
      constraint conversations_priority_check check (priority in ('normal', 'high', 'urgent')),
      constraint conversations_order_required_check check (
        (conversation_type = 'order' and order_id is not null)
        or (conversation_type = 'general_support' and order_id is null)
      ),
      constraint conversations_order_fk foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint conversations_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint conversations_assignee_fk foreign key (assigned_operator_user_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint conversations_resolver_fk foreign key (resolved_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict
    );

    create unique index conversations_active_order_context_index
      on conversations (company_id, order_id, participant_context_type)
      where conversation_type = 'order' and status <> 'resolved';
    create index conversations_company_activity_index
      on conversations (company_id, coalesce(last_message_at, created_at) desc, id desc);
    create index conversations_order_lookup_index
      on conversations (company_id, order_id, participant_context_type);

    create table conversation_participants (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null,
      conversation_id uuid not null,
      account_id uuid not null,
      participant_role text not null,
      trader_id uuid,
      driver_id uuid,
      customer_id uuid,
      last_read_message_id uuid,
      last_read_at timestamptz,
      joined_at timestamptz not null default now(),
      revoked_at timestamptz,
      is_active boolean not null default true,
      notification_preference text,
      unique (id, company_id),
      unique (company_id, conversation_id, account_id),
      constraint conversation_participants_role_check check (participant_role in ('office', 'trader', 'driver', 'customer')),
      constraint conversation_participants_context_check check (
        (participant_role = 'office' and trader_id is null and driver_id is null and customer_id is null)
        or (participant_role = 'trader' and trader_id is not null and driver_id is null and customer_id is null)
        or (participant_role = 'driver' and driver_id is not null and trader_id is null and customer_id is null)
        or (participant_role = 'customer' and customer_id is not null and trader_id is null and driver_id is null)
      ),
      constraint conversation_participants_conversation_fk foreign key (conversation_id, company_id)
        references conversations(id, company_id) on delete cascade,
      constraint conversation_participants_account_fk foreign key (account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint conversation_participants_trader_fk foreign key (trader_id, company_id)
        references traders(id, company_id) on delete restrict,
      constraint conversation_participants_driver_fk foreign key (driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint conversation_participants_customer_fk foreign key (customer_id, company_id)
        references customers(id, company_id) on delete restrict
    );

    create index conversation_participants_user_index
      on conversation_participants (company_id, account_id, is_active, conversation_id);

    create table messages (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null,
      conversation_id uuid not null,
      sender_account_id uuid,
      sender_role text not null,
      message_type text not null,
      text_body text,
      client_message_id text,
      idempotency_key text,
      reply_to_message_id uuid,
      visibility_type text not null default 'conversation',
      conversation_sequence bigint not null,
      original_client_time timestamptz,
      system_event_type text,
      edited_at timestamptz,
      redacted_at timestamptz,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, conversation_id, conversation_sequence),
      unique (company_id, sender_account_id, client_message_id),
      unique (company_id, idempotency_key),
      constraint messages_type_check check (message_type in ('text', 'system', 'voice_placeholder')),
      constraint messages_sender_role_check check (sender_role in ('office', 'trader', 'driver', 'customer', 'system')),
      constraint messages_visibility_check check (visibility_type in ('conversation')),
      constraint messages_text_shape_check check (
        (message_type = 'text' and text_body is not null and length(text_body) between 1 and 4000 and system_event_type is null)
        or (message_type = 'system' and text_body is null and system_event_type is not null)
        or (message_type = 'voice_placeholder' and text_body is null)
      ),
      constraint messages_conversation_fk foreign key (conversation_id, company_id)
        references conversations(id, company_id) on delete restrict,
      constraint messages_sender_fk foreign key (sender_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint messages_reply_fk foreign key (reply_to_message_id, company_id)
        references messages(id, company_id) on delete restrict
    );

    alter table conversations
      add constraint conversations_last_message_fk foreign key (last_message_id, company_id)
      references messages(id, company_id) on delete set null;

    create index messages_conversation_page_index
      on messages (company_id, conversation_id, conversation_sequence desc, id desc);

    create table realtime_event_log (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      audience_account_id uuid not null,
      event_type text not null,
      entity_type text not null,
      entity_id uuid not null,
      sequence_number bigint generated always as identity,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null default (now() + interval '14 days'),
      unique (company_id, audience_account_id, sequence_number),
      constraint realtime_event_log_audience_fk foreign key (audience_account_id, company_id)
        references accounts(id, company_id) on delete restrict
    );

    create index realtime_event_log_recovery_index
      on realtime_event_log (company_id, audience_account_id, sequence_number, created_at);

    create table communication_notification_outbox (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      conversation_id uuid not null,
      message_id uuid not null,
      recipient_account_id uuid not null,
      event_type text not null default 'communication.message.created',
      payload jsonb not null default '{}'::jsonb,
      status text not null default 'pending',
      created_at timestamptz not null default now(),
      processed_at timestamptz,
      unique (company_id, message_id, recipient_account_id),
      constraint communication_notification_outbox_conversation_fk foreign key (conversation_id, company_id)
        references conversations(id, company_id) on delete restrict,
      constraint communication_notification_outbox_message_fk foreign key (message_id, company_id)
        references messages(id, company_id) on delete restrict,
      constraint communication_notification_outbox_recipient_fk foreign key (recipient_account_id, company_id)
        references accounts(id, company_id) on delete restrict
    );

    create index communication_notification_outbox_pending_index
      on communication_notification_outbox (status, created_at)
      where status = 'pending';
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop table if exists communication_notification_outbox;
    drop table if exists realtime_event_log;
    alter table if exists conversations drop constraint if exists conversations_last_message_fk;
    drop table if exists messages;
    drop table if exists conversation_participants;
    drop table if exists conversations;
  `.execute(database);
}
