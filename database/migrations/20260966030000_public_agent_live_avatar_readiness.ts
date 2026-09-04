import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_agent_settings
      add column avatar_live_avatar_id text,
      add column avatar_live_voice_id_en text,
      add column avatar_live_voice_id_ar text,
      add column avatar_live_voice_agent_id_en text,
      add column avatar_live_voice_agent_id_ar text,
      add column avatar_live_max_session_seconds integer not null default 300 check (avatar_live_max_session_seconds between 30 and 1800),
      add column avatar_live_idle_timeout_seconds integer not null default 60 check (avatar_live_idle_timeout_seconds between 15 and 300),
      add column avatar_live_max_concurrent_sessions integer not null default 2 check (avatar_live_max_concurrent_sessions between 1 and 100),
      add column avatar_live_start_rate_limit_per_minute integer not null default 3 check (avatar_live_start_rate_limit_per_minute between 1 and 60),
      add column avatar_live_daily_minute_cap integer check (avatar_live_daily_minute_cap is null or avatar_live_daily_minute_cap between 1 and 100000),
      add column avatar_live_cost_per_minute numeric(12,6) check (avatar_live_cost_per_minute is null or avatar_live_cost_per_minute >= 0);

    create table platform_agent_live_avatar_usage (
      id uuid primary key default gen_random_uuid(),
      conversation_id uuid not null references platform_agent_conversations(id) on delete cascade,
      provider text not null,
      language text not null check (language in ('en','ar')),
      ip_hash text,
      started_at timestamptz not null default now(),
      ended_at timestamptz,
      duration_seconds numeric(12,3) not null default 0 check (duration_seconds >= 0),
      response_count integer not null default 0 check (response_count >= 0),
      fallback_count integer not null default 0 check (fallback_count >= 0),
      provider_error_count integer not null default 0 check (provider_error_count >= 0),
      end_reason text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index platform_agent_live_avatar_usage_started_idx on platform_agent_live_avatar_usage(started_at desc);
    create index platform_agent_live_avatar_usage_active_idx on platform_agent_live_avatar_usage(started_at) where ended_at is null;
    create index platform_agent_live_avatar_usage_ip_rate_idx on platform_agent_live_avatar_usage(ip_hash,started_at desc);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop table platform_agent_live_avatar_usage;
    alter table platform_agent_settings
      drop column avatar_live_cost_per_minute,
      drop column avatar_live_daily_minute_cap,
      drop column avatar_live_start_rate_limit_per_minute,
      drop column avatar_live_max_concurrent_sessions,
      drop column avatar_live_idle_timeout_seconds,
      drop column avatar_live_max_session_seconds,
      drop column avatar_live_voice_agent_id_ar,
      drop column avatar_live_voice_agent_id_en,
      drop column avatar_live_voice_id_ar,
      drop column avatar_live_voice_id_en,
      drop column avatar_live_avatar_id;
  `.execute(database);
}
