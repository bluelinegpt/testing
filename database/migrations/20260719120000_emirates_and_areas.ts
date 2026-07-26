import { type Kysely, sql } from "kysely";

/**
 * UAE Emirate master, and the Area -> Emirate relationship.
 *
 * Emirates are national reference data, not tenant data, so the table carries
 * no company_id: every Company sees the same seven Emirates and none can create,
 * rename or delete one. There is deliberately no write endpoint for this table.
 *
 * Area names become unique per (Company, Emirate) rather than per Company, so
 * the same name may legitimately exist in two Emirates.
 */
export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    create table emirates (
      id uuid primary key default gen_random_uuid(),
      code text not null,
      name_en text not null,
      name_ar text not null,
      display_order integer not null,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint emirates_code_format check (code ~ '^[A-Z]{3}$'),
      constraint emirates_name_en_nonempty check (btrim(name_en) <> ''),
      constraint emirates_name_ar_nonempty check (btrim(name_ar) <> '')
    );
    create unique index emirates_code_unique on emirates (code);
    create unique index emirates_display_order_unique on emirates (display_order);
  `.execute(database);

  // Idempotent seed: re-running leaves existing rows untouched, so a partially
  // provisioned database converges instead of failing.
  await sql`
    insert into emirates (code, name_en, name_ar, display_order)
    values ('AUH', 'Abu Dhabi', 'أبوظبي', 1),
           ('DXB', 'Dubai', 'دبي', 2),
           ('SHJ', 'Sharjah', 'الشارقة', 3),
           ('AJM', 'Ajman', 'عجمان', 4),
           ('UAQ', 'Umm Al Quwain', 'أم القيوين', 5),
           ('RAK', 'Ras Al Khaimah', 'رأس الخيمة', 6),
           ('FUJ', 'Fujairah', 'الفجيرة', 7)
    on conflict (code) do nothing;
  `.execute(database);

  /*
   * The seeded rows are fixed: amending or removing an Emirate would silently
   * reinterpret every Area pointing at it. INSERT stays permitted so the seed
   * above remains idempotent and re-provisioning converges; nothing can create
   * an Emirate through the application because the table is not tenant-scoped
   * and no write endpoint exists.
   */
  await sql`
    create or replace function reject_emirate_mutation() returns trigger as $$
    begin
      raise exception 'Emirates are system-managed reference data'
        using errcode = 'restrict_violation';
    end;
    $$ language plpgsql;

    create trigger emirates_immutable
      before update or delete on emirates
      for each row execute function reject_emirate_mutation();
  `.execute(database);

  await sql`
    alter table areas add column emirate_id uuid references emirates(id) on delete restrict;
    alter table areas add column notes text;
  `.execute(database);

  /*
   * Safety gate. The development database has no Areas, so there is nothing to
   * map and no Legacy/Unknown Emirate is created. If Areas are unexpectedly
   * present the migration aborts rather than inventing an Emirate for them,
   * which would silently falsify operational data.
   */
  await sql`
    do $$
    declare unmapped bigint;
    begin
      select count(*) into unmapped from areas where emirate_id is null;
      if unmapped > 0 then
        raise exception
          'Refusing to migrate: % Area row(s) have no Emirate. Assign emirate_id via a controlled data migration before re-running.',
          unmapped
          using errcode = 'data_exception';
      end if;
    end $$;
  `.execute(database);

  await sql`alter table areas alter column emirate_id set not null;`.execute(database);

  // Area names are unique per Emirate, not per Company.
  await sql`
    drop index if exists areas_name_en_unique;
    create unique index areas_emirate_name_en_unique
      on areas (company_id, emirate_id, lower(btrim(name_en)));
    create index areas_company_emirate_index on areas (company_id, emirate_id);
  `.execute(database);

  // Reject whitespace-only names at the boundary the application cannot bypass.
  await sql`
    alter table areas add constraint areas_name_en_nonempty check (btrim(name_en) <> '');
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table areas drop constraint if exists areas_name_en_nonempty;
    drop index if exists areas_company_emirate_index;
    drop index if exists areas_emirate_name_en_unique;
    create unique index areas_name_en_unique on areas (company_id, lower(name_en));
    alter table areas drop column if exists notes;
    alter table areas drop column if exists emirate_id;
  `.execute(database);

  await sql`
    drop trigger if exists emirates_immutable on emirates;
    drop function if exists reject_emirate_mutation();
    drop table if exists emirates;
  `.execute(database);
}
