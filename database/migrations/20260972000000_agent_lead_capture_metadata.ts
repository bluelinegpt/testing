import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table platform_agent_conversations
      add column source_hostname text,
      add column source_page text,
      add column landing_page text,
      add column referrer_domain text,
      add column utm_source text,
      add column utm_medium text,
      add column utm_campaign text,
      add column country_code char(2),
      add column country_name text,
      add column device_category text,
      add column browser_family text,
      add column operating_system_family text,
      add column widget_opened_at timestamptz,
      add column conversation_started_at timestamptz,
      add column contact_requested_at timestamptz,
      add column contact_captured_at timestamptz,
      add column handoff_requested_at timestamptz,
      add column qualified_lead_at timestamptz,
      add column lead_status text not null default 'not_lead',
      add constraint platform_agent_conversations_source_hostname_check
        check (source_hostname is null or (length(source_hostname) between 1 and 253 and source_hostname ~ '^[A-Za-z0-9.-]+$')),
      add constraint platform_agent_conversations_source_page_check
        check (source_page is null or (length(source_page) between 1 and 500 and source_page ~ '^/[A-Za-z0-9/_?&=.%+-]*$')),
      add constraint platform_agent_conversations_landing_page_check
        check (landing_page is null or (length(landing_page) between 1 and 500 and landing_page ~ '^/[A-Za-z0-9/_?&=.%+-]*$')),
      add constraint platform_agent_conversations_referrer_domain_check
        check (referrer_domain is null or (length(referrer_domain) between 1 and 253 and referrer_domain ~ '^[A-Za-z0-9.-]+$')),
      add constraint platform_agent_conversations_country_code_check
        check (country_code is null or country_code ~ '^[A-Z]{2}$'),
      add constraint platform_agent_conversations_device_category_check
        check (device_category is null or device_category in ('desktop','mobile','tablet','bot','unknown')),
      add constraint platform_agent_conversations_campaign_lengths_check
        check ((utm_source is null or length(utm_source) <= 120) and (utm_medium is null or length(utm_medium) <= 120) and (utm_campaign is null or length(utm_campaign) <= 120)),
      add constraint platform_agent_conversations_client_family_lengths_check
        check ((browser_family is null or length(browser_family) <= 40) and (operating_system_family is null or length(operating_system_family) <= 40)),
      add constraint platform_agent_conversations_lead_status_check
        check (lead_status in ('not_lead','new','qualified','contacted','closed','spam'));

    update platform_agent_conversations
    set widget_opened_at = created_at,
        landing_page = source_page
    where channel = 'website';

    update platform_agent_conversations c
    set conversation_started_at = first_message.created_at
    from (
      select conversation_id, min(created_at) created_at
      from platform_agent_messages
      where sender_type = 'user'
      group by conversation_id
    ) first_message
    where first_message.conversation_id = c.id;

    update platform_agent_conversations c
    set contact_requested_at = coalesce(c.contact_requested_at, c.updated_at),
        contact_captured_at = coalesce(c.contact_captured_at, c.updated_at)
    where c.customer_name is not null
       or c.mobile_number is not null
       or c.email is not null;

    update platform_agent_conversations c
    set handoff_requested_at = coalesce(c.handoff_requested_at, h.created_at, c.updated_at)
    from platform_agent_handoffs h
    where h.conversation_id = c.id;

    update platform_agent_conversations
    set qualified_lead_at = coalesce(qualified_lead_at, handoff_requested_at, contact_captured_at, updated_at),
        lead_status = 'qualified'
    where lead_status = 'not_lead'
      and (
        handoff_requested_at is not null
        or linked_quote_request_id is not null
        or linked_trader_application_id is not null
        or linked_demo_request_id is not null
        or (
          contact_captured_at is not null
          and customer_name is not null
          and mobile_number is not null
          and current_intent in ('customer_quote','trader','delivery_company_demo','handoff')
        )
      );

    create index platform_agent_conversations_contact_filter_idx
      on platform_agent_conversations(contact_requested_at, language, last_message_at desc);
    create index platform_agent_conversations_analytics_idx
      on platform_agent_conversations(conversation_started_at, contact_captured_at, handoff_requested_at, qualified_lead_at);

    create table platform_agent_analytics_events (
      id uuid primary key default gen_random_uuid(),
      conversation_id uuid not null references platform_agent_conversations(id) on delete cascade,
      event_name text not null check (event_name in ('agent_opened','agent_message_sent','agent_conversation_started','agent_contact_requested','agent_contact_captured','agent_handoff_requested','agent_lead_created')),
      dedupe_key text not null check (length(dedupe_key) between 1 and 120),
      safe_metadata jsonb not null default '{}',
      created_at timestamptz not null default now(),
      unique(conversation_id,event_name,dedupe_key)
    );
    create index platform_agent_analytics_events_reporting_idx
      on platform_agent_analytics_events(event_name,created_at desc);

    create function capture_platform_agent_conversation_analytics() returns trigger language plpgsql as $$
    begin
      if tg_op = 'UPDATE' then
        if old.conversation_started_at is null and new.conversation_started_at is not null then
          insert into platform_agent_analytics_events(conversation_id,event_name,dedupe_key,created_at) values(new.id,'agent_conversation_started',new.id::text,new.conversation_started_at) on conflict do nothing;
        end if;
        if old.contact_requested_at is null and new.contact_requested_at is not null then
          insert into platform_agent_analytics_events(conversation_id,event_name,dedupe_key,created_at) values(new.id,'agent_contact_requested',new.id::text,new.contact_requested_at) on conflict do nothing;
        end if;
        if old.contact_captured_at is null and new.contact_captured_at is not null then
          insert into platform_agent_analytics_events(conversation_id,event_name,dedupe_key,safe_metadata,created_at)
          values(new.id,'agent_contact_captured',new.id::text,jsonb_build_object('has_name',new.customer_name is not null,'has_mobile',new.mobile_number is not null,'has_email',new.email is not null),new.contact_captured_at) on conflict do nothing;
        end if;
        if old.handoff_requested_at is null and new.handoff_requested_at is not null then
          insert into platform_agent_analytics_events(conversation_id,event_name,dedupe_key,created_at) values(new.id,'agent_handoff_requested',new.id::text,new.handoff_requested_at) on conflict do nothing;
        end if;
        if old.qualified_lead_at is null and new.qualified_lead_at is not null then
          insert into platform_agent_analytics_events(conversation_id,event_name,dedupe_key,created_at) values(new.id,'agent_lead_created',new.id::text,new.qualified_lead_at) on conflict do nothing;
        end if;
      end if;
      return new;
    end $$;
    create trigger platform_agent_conversation_analytics
      after insert or update on platform_agent_conversations
      for each row execute function capture_platform_agent_conversation_analytics();

    create function capture_platform_agent_message_analytics() returns trigger language plpgsql as $$
    begin
      if new.sender_type = 'user' then
        insert into platform_agent_analytics_events(conversation_id,event_name,dedupe_key,created_at)
        values(new.conversation_id,'agent_message_sent',new.id::text,new.created_at) on conflict do nothing;
      end if;
      return new;
    end $$;
    create trigger platform_agent_message_analytics
      after insert on platform_agent_messages
      for each row execute function capture_platform_agent_message_analytics();

    insert into platform_agent_analytics_events(conversation_id,event_name,dedupe_key,safe_metadata,created_at)
    select id,'agent_opened',id::text,'{}'::jsonb,widget_opened_at from platform_agent_conversations where widget_opened_at is not null
    union all
    select id,'agent_conversation_started',id::text,'{}'::jsonb,conversation_started_at from platform_agent_conversations where conversation_started_at is not null
    union all
    select id,'agent_contact_requested',id::text,'{}'::jsonb,contact_requested_at from platform_agent_conversations where contact_requested_at is not null
    union all
    select id,'agent_contact_captured',id::text,jsonb_build_object('has_name',customer_name is not null,'has_mobile',mobile_number is not null,'has_email',email is not null),contact_captured_at from platform_agent_conversations where contact_captured_at is not null
    union all
    select id,'agent_handoff_requested',id::text,'{}'::jsonb,handoff_requested_at from platform_agent_conversations where handoff_requested_at is not null
    union all
    select id,'agent_lead_created',id::text,'{}'::jsonb,qualified_lead_at from platform_agent_conversations where qualified_lead_at is not null
    union all
    select m.conversation_id,'agent_message_sent',m.id::text,'{}'::jsonb,m.created_at from platform_agent_messages m where m.sender_type='user'
    on conflict do nothing;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    drop trigger if exists platform_agent_message_analytics on platform_agent_messages;
    drop function if exists capture_platform_agent_message_analytics();
    drop trigger if exists platform_agent_conversation_analytics on platform_agent_conversations;
    drop function if exists capture_platform_agent_conversation_analytics();
    drop table if exists platform_agent_analytics_events;
    drop index if exists platform_agent_conversations_contact_filter_idx;
    drop index if exists platform_agent_conversations_analytics_idx;
    alter table platform_agent_conversations
      drop constraint if exists platform_agent_conversations_lead_status_check,
      drop constraint if exists platform_agent_conversations_client_family_lengths_check,
      drop constraint if exists platform_agent_conversations_campaign_lengths_check,
      drop constraint if exists platform_agent_conversations_device_category_check,
      drop constraint if exists platform_agent_conversations_country_code_check,
      drop constraint if exists platform_agent_conversations_referrer_domain_check,
      drop constraint if exists platform_agent_conversations_landing_page_check,
      drop constraint if exists platform_agent_conversations_source_page_check,
      drop constraint if exists platform_agent_conversations_source_hostname_check,
      drop column if exists lead_status,
      drop column if exists qualified_lead_at,
      drop column if exists handoff_requested_at,
      drop column if exists contact_captured_at,
      drop column if exists contact_requested_at,
      drop column if exists conversation_started_at,
      drop column if exists widget_opened_at,
      drop column if exists operating_system_family,
      drop column if exists browser_family,
      drop column if exists device_category,
      drop column if exists country_name,
      drop column if exists country_code,
      drop column if exists utm_campaign,
      drop column if exists utm_medium,
      drop column if exists utm_source,
      drop column if exists referrer_domain,
      drop column if exists landing_page,
      drop column if exists source_page,
      drop column if exists source_hostname;
  `.execute(db);
}
