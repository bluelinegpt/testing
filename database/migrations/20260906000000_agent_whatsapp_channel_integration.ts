import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_agent_settings
      add column if not exists whatsapp_provider text not null default 'meta_cloud' check (whatsapp_provider in ('meta_cloud','sandbox','disabled')),
      add column if not exists whatsapp_business_number text,
      add column if not exists whatsapp_business_number_normalized text,
      add column if not exists whatsapp_phone_number_id_hint text,
      add column if not exists whatsapp_public_cta_enabled boolean not null default true,
      add column if not exists whatsapp_last_webhook_at timestamptz,
      add column if not exists whatsapp_last_outbound_at timestamptz,
      add column if not exists whatsapp_last_error_code text,
      add column if not exists whatsapp_configuration_note text;

    update platform_agent_settings
    set whatsapp_business_number = coalesce(whatsapp_business_number, '+971 50 689 8604'),
        whatsapp_business_number_normalized = coalesce(whatsapp_business_number_normalized, '971506898604'),
        whatsapp_configuration_note = coalesce(whatsapp_configuration_note, 'WhatsApp Cloud API credentials are configured through environment variables; secrets are never displayed in Platform.')
    where id = true;

    alter table platform_agent_conversations
      add column if not exists provider text,
      add column if not exists provider_thread_id text,
      add column if not exists conversation_mode text not null default 'ai_active' check (conversation_mode in ('ai_active','human_active','paused','ai_resume')),
      add column if not exists mode_changed_by_account_id uuid references accounts(id) on delete set null,
      add column if not exists mode_changed_at timestamptz,
      add column if not exists last_customer_message_at timestamptz,
      add column if not exists last_outbound_message_at timestamptz,
      add column if not exists last_channel text;

    update platform_agent_conversations
    set last_channel = coalesce(last_channel, channel),
        last_customer_message_at = coalesce(last_customer_message_at, last_message_at),
        provider = case when channel in ('whatsapp','simulator') then coalesce(provider, 'sandbox') else provider end
    where last_channel is null or last_customer_message_at is null or provider is null;

    alter table platform_agent_messages
      add column if not exists channel text,
      add column if not exists provider text,
      add column if not exists provider_message_id text,
      add column if not exists provider_event_id text,
      add column if not exists direction text not null default 'internal' check (direction in ('inbound','outbound','internal')),
      add column if not exists delivery_status text not null default 'recorded' check (delivery_status in ('recorded','queued','sent','delivered','read','failed')),
      add column if not exists sender_account_id uuid references accounts(id) on delete set null,
      add column if not exists media_type text,
      add column if not exists failure_code text,
      add column if not exists failure_detail text,
      add column if not exists delivered_at timestamptz,
      add column if not exists read_at timestamptz;

    update platform_agent_messages m
    set channel = coalesce(m.channel, c.channel),
        direction = case when m.sender_type = 'user' then 'inbound' when m.sender_type = 'assistant' then 'outbound' else 'internal' end,
        provider = case when c.channel in ('whatsapp','simulator') then coalesce(m.provider, c.provider, 'sandbox') else m.provider end
    from platform_agent_conversations c
    where c.id = m.conversation_id and (m.channel is null or m.provider is null);

    do $$
    declare
      constraint_name text;
    begin
      for constraint_name in
        select conname
        from pg_constraint
        where conrelid='platform_agent_messages'::regclass
          and contype='c'
          and pg_get_constraintdef(oid) like '%sender_type%'
      loop
        execute format('alter table platform_agent_messages drop constraint %I', constraint_name);
      end loop;
    end $$;

    alter table platform_agent_messages
      add constraint platform_agent_messages_sender_type_check
        check(sender_type in('user','assistant','system','platform_staff'));

    create unique index if not exists platform_agent_messages_provider_message_uidx
      on platform_agent_messages(provider, provider_message_id)
      where provider_message_id is not null;

    create index if not exists platform_agent_messages_channel_idx
      on platform_agent_messages(channel, direction, created_at desc);

    create table if not exists platform_agent_whatsapp_webhooks(
      id uuid primary key default gen_random_uuid(),
      provider text not null,
      provider_event_id text not null,
      event_type text not null,
      processing_status text not null default 'received' check(processing_status in('received','processed','duplicate','ignored','failed','unauthorized')),
      conversation_id uuid references platform_agent_conversations(id) on delete set null,
      provider_message_id text,
      sender_mobile_normalized text,
      safe_error_code text,
      received_at timestamptz not null default now(),
      processed_at timestamptz,
      unique(provider, provider_event_id)
    );

    create index if not exists platform_agent_whatsapp_webhooks_received_idx
      on platform_agent_whatsapp_webhooks(received_at desc, processing_status);

    insert into permissions(code, description) values
      ('platform.agent.whatsapp.read','View WhatsApp Agent integration status and conversations'),
      ('platform.agent.whatsapp.reply','Reply to WhatsApp customers from Platform'),
      ('platform.agent.whatsapp.takeover','Take over or return WhatsApp conversations to Yousef'),
      ('platform.agent.whatsapp.manage','Manage WhatsApp Agent integration settings')
    on conflict(code) do update set description=excluded.description;

    insert into role_permissions(role_id, permission_code)
    select r.id, p.code
    from roles r
    cross join(values
      ('platform.agent.whatsapp.read'),
      ('platform.agent.whatsapp.reply'),
      ('platform.agent.whatsapp.takeover'),
      ('platform.agent.whatsapp.manage')
    ) p(code)
    where r.company_id is null and lower(r.code)='platform_super_admin'
    on conflict do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code like 'platform.agent.whatsapp.%';
    delete from permissions where code like 'platform.agent.whatsapp.%';
    drop table if exists platform_agent_whatsapp_webhooks;
    drop index if exists platform_agent_messages_channel_idx;
    drop index if exists platform_agent_messages_provider_message_uidx;
    alter table platform_agent_messages
      drop constraint if exists platform_agent_messages_sender_type_check,
      add constraint platform_agent_messages_sender_type_check check(sender_type in('user','assistant','system')),
      drop column if exists read_at,
      drop column if exists delivered_at,
      drop column if exists failure_detail,
      drop column if exists failure_code,
      drop column if exists media_type,
      drop column if exists sender_account_id,
      drop column if exists delivery_status,
      drop column if exists direction,
      drop column if exists provider_event_id,
      drop column if exists provider_message_id,
      drop column if exists provider,
      drop column if exists channel;
    alter table platform_agent_conversations
      drop column if exists last_channel,
      drop column if exists last_outbound_message_at,
      drop column if exists last_customer_message_at,
      drop column if exists mode_changed_at,
      drop column if exists mode_changed_by_account_id,
      drop column if exists conversation_mode,
      drop column if exists provider_thread_id,
      drop column if exists provider;
    alter table platform_agent_settings
      drop column if exists whatsapp_configuration_note,
      drop column if exists whatsapp_last_error_code,
      drop column if exists whatsapp_last_outbound_at,
      drop column if exists whatsapp_last_webhook_at,
      drop column if exists whatsapp_public_cta_enabled,
      drop column if exists whatsapp_phone_number_id_hint,
      drop column if exists whatsapp_business_number_normalized,
      drop column if exists whatsapp_business_number,
      drop column if exists whatsapp_provider;
  `.execute(database);
}
