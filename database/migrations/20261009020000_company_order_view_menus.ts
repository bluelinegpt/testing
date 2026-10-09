import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Per-Company Orders menu (Aiman, 9 Oct 2026): which tabs appear above the
 * Orders list, in what order, under which names, and what each custom tab
 * shows.
 *
 * - One row per Company. No row, or `custom_menu_enabled = false`, means the
 *   standard 7-tab menu exactly as before -- existing Companies see no change
 *   until someone switches the custom menu on.
 * - `views` is the whole menu as a JSON array, validated by the API
 *   (`order-views.ts`) on every save and replaced atomically; `version` is
 *   the optimistic-concurrency counter for two admins editing at once.
 * - Pure Company configuration: classified PRESERVE for data resets and
 *   deleted with the Company (see `reset-company-test-data.manifest.ts`).
 * - New permission `order_views.manage` lets a non-administrator role edit
 *   the menu; `users_roles.manage` keeps working as the fallback.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table company_order_view_menus (
      company_id uuid primary key references companies(id) on delete restrict,
      custom_menu_enabled boolean not null default false,
      views jsonb not null default '[]'::jsonb,
      version integer not null default 1,
      updated_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint company_order_view_menus_views_array_check
        check (jsonb_typeof(views) = 'array'),
      constraint company_order_view_menus_version_check check (version >= 1),
      constraint company_order_view_menus_updated_by_fkey
        foreign key (updated_by_account_id, company_id) references accounts(id, company_id)
    );

    insert into permissions (code, description)
    values ('order_views.manage', 'Manage the Company Orders menu (order views)')
    on conflict (code) do update set description = excluded.description;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop table if exists company_order_view_menus;
    delete from role_permissions where permission_code = 'order_views.manage';
    delete from permissions where code = 'order_views.manage';
  `.execute(database);
}
