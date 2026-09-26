import { sql, type Kysely } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Platform Administration controls over Company WhatsApp.
 *
 * `company_whatsapp_platform_settings` — at most one row per Company holding
 * the Platform's enable/disable decision. ABSENCE of a row means ENABLED:
 * every Company that exists today keeps working without a backfill, and the
 * Platform only writes a row the first time it touches a Company's switch.
 * Disabling is a full stop — no new outbox rows, no test messages, no
 * connect/QR — but deliberately KEEPS the paired session and Trader mappings
 * so re-enabling restores service without re-scanning a QR code.
 *
 * `company_whatsapp_message_templates` — per-Company, per-status overrides of
 * the automatic Order-status message wording. Absence of a row for a status
 * means the built-in default template (`whatsapp-message-templates.ts`)
 * renders that status — defaults live in code, only overrides live here.
 * Both language bodies are always stored together so a Trader whose language
 * is `both` always has a bilingual message to assemble. Placeholders
 * (`{{orderNumber}}`, `{{referenceNumber}}`, `{{status}}`, `{{date}}`,
 * `{{companyName}}`) are substituted at event time; outbox bodies remain
 * snapshots, so editing a template never rewrites history.
 *
 * The editors are PLATFORM accounts (company_id is null), so the
 * updated-by columns use a plain FK to accounts(id) — a composite tenant FK
 * is impossible for a cross-tenant actor, exactly like other
 * platform-administered records.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table company_whatsapp_platform_settings (
      company_id uuid primary key references companies(id) on delete restrict,
      whatsapp_enabled boolean not null default true,
      disabled_reason text,
      updated_by_account_id uuid not null references accounts(id) on delete restrict,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      constraint company_whatsapp_platform_settings_version_positive check (version > 0),
      -- A reason is only meaningful on a disabled row; an enabled row must not
      -- carry a stale one.
      constraint company_whatsapp_platform_settings_reason_shape_check check (
        whatsapp_enabled = false or disabled_reason is null
      )
    )
  `.execute(database);

  await sql`
    create table company_whatsapp_message_templates (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      status text not null,
      body_ar text not null,
      body_en text not null,
      updated_by_account_id uuid not null references accounts(id) on delete restrict,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      unique (company_id, status),
      constraint company_whatsapp_message_templates_status_check check (status in (
        'assigned_to_driver', 'out_for_delivery', 'delivered',
        'returned_to_branch', 'returned_to_trader', 'cancelled'
      )),
      constraint company_whatsapp_message_templates_body_check check (
        length(trim(body_ar)) > 0 and length(trim(body_en)) > 0
        and length(body_ar) <= 2000 and length(body_en) <= 2000
      ),
      constraint company_whatsapp_message_templates_version_positive check (version > 0)
    )
  `.execute(database);

  await sql`
    insert into permissions (code, description)
    values ('platform.company_whatsapp.manage',
            'Enable/disable Company WhatsApp, edit its message templates and view its messages')
    on conflict (code) do update set description = excluded.description;

    insert into role_permissions (role_id, permission_code)
    select r.id, 'platform.company_whatsapp.manage' from roles r
     where r.company_id is null and lower(r.code) = 'platform_super_admin'
    on conflict do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code = 'platform.company_whatsapp.manage';
    delete from permissions where code = 'platform.company_whatsapp.manage';
  `.execute(database);
  await sql`drop table if exists company_whatsapp_message_templates`.execute(database);
  await sql`drop table if exists company_whatsapp_platform_settings`.execute(database);
}
