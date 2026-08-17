import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_demo_requests
      add column if not exists country text;

    update platform_demo_requests
      set country = 'United Arab Emirates'
      where country is null;

    alter table platform_demo_requests
      alter column country set not null;

    do $$
    declare
      constraint_name text;
    begin
      for constraint_name in
        select conname
        from pg_constraint
        where conrelid = 'platform_demo_requests'::regclass
          and contype = 'c'
          and pg_get_constraintdef(oid) like '%mobile_number%'
      loop
        execute format('alter table platform_demo_requests drop constraint %I', constraint_name);
      end loop;

      for constraint_name in
        select conname
        from pg_constraint
        where conrelid = 'platform_demo_requests'::regclass
          and contype = 'c'
          and pg_get_constraintdef(oid) like '%emirate%'
      loop
        execute format('alter table platform_demo_requests drop constraint %I', constraint_name);
      end loop;
    end $$;

    alter table platform_demo_requests
      add constraint platform_demo_requests_country_check check (char_length(country) between 2 and 120),
      add constraint platform_demo_requests_mobile_number_check check (char_length(mobile_number) between 7 and 30),
      add constraint platform_demo_requests_emirate_check check (emirate is null or emirate in ('abu_dhabi','dubai','sharjah','ajman','umm_al_quwain','ras_al_khaimah','fujairah'));

    create index if not exists platform_demo_requests_country_created_idx on platform_demo_requests (country, created_at desc);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists platform_demo_requests_country_created_idx;

    alter table platform_demo_requests
      drop constraint if exists platform_demo_requests_country_check,
      drop constraint if exists platform_demo_requests_mobile_number_check,
      drop constraint if exists platform_demo_requests_emirate_check;

    update platform_demo_requests
      set emirate = 'dubai'
      where emirate is null;

    alter table platform_demo_requests
      alter column emirate set not null,
      add constraint platform_demo_requests_mobile_number_check check (mobile_number ~ '^\\+971[0-9]{9}$'),
      add constraint platform_demo_requests_emirate_check check (emirate in ('abu_dhabi','dubai','sharjah','ajman','umm_al_quwain','ras_al_khaimah','fujairah'));

    alter table platform_demo_requests
      drop column if exists country;
  `.execute(database);
}
