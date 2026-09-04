import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_agent_settings
      add column avatar_enabled boolean not null default false,
      add column avatar_display_name text not null default 'Yousef',
      add column avatar_title_en text not null default 'Tawseelhub AI Advisor',
      add column avatar_title_ar text not null default 'مستشار توصيل هب الذكي',
      add column avatar_image_url text not null default '/yousef-ai-advisor.svg',
      add column avatar_intro_video_url_en text,
      add column avatar_intro_video_url_ar text,
      add column avatar_intro_transcript_en text not null default 'Hi, I’m Yousef, Tawseelhub’s AI advisor. Ask me anything about Tawseelhub and I’ll guide you.',
      add column avatar_intro_transcript_ar text not null default 'مرحباً، أنا يوسف، المستشار الذكي لمنصة توصيل هب. اسألني عن أي شيء يخص توصيل هب وسأساعدك.',
      add column avatar_show_homepage boolean not null default true,
      add column avatar_show_pricing boolean not null default true,
      add column avatar_show_delivery_company boolean not null default true,
      add column avatar_show_trader boolean not null default true,
      add column avatar_show_send_package boolean not null default true,
      add column avatar_auto_open boolean not null default false,
      add column avatar_provider text not null default 'prerecorded'
        check (avatar_provider in ('prerecorded','heygen','tavus','future_provider')),
      add column avatar_status text not null default 'active'
        check (avatar_status in ('active','offline'));
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_agent_settings
      drop column avatar_status,
      drop column avatar_provider,
      drop column avatar_auto_open,
      drop column avatar_show_send_package,
      drop column avatar_show_trader,
      drop column avatar_show_delivery_company,
      drop column avatar_show_pricing,
      drop column avatar_show_homepage,
      drop column avatar_intro_transcript_ar,
      drop column avatar_intro_transcript_en,
      drop column avatar_intro_video_url_ar,
      drop column avatar_intro_video_url_en,
      drop column avatar_image_url,
      drop column avatar_title_ar,
      drop column avatar_title_en,
      drop column avatar_display_name,
      drop column avatar_enabled;
  `.execute(database);
}
