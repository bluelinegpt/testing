import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function enforce_profile_account_kind() returns trigger language plpgsql as $$
    declare
      actual_kind text;
      actual_company_id uuid;
    begin
      if tg_table_name in ('drivers', 'traders') and new.account_id is null then
        return new;
      end if;
      select account_kind, company_id into actual_kind, actual_company_id
        from accounts where id = new.account_id;
      if actual_kind is distinct from tg_argv[0]
        or actual_company_id is distinct from new.company_id then
        raise exception 'profile account kind or Company scope is invalid';
      end if;
      return new;
    end;
    $$;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function enforce_profile_account_kind() returns trigger language plpgsql as $$
    declare
      actual_kind text;
      actual_company_id uuid;
    begin
      if tg_table_name = 'traders' and new.account_id is null then
        return new;
      end if;
      select account_kind, company_id into actual_kind, actual_company_id
        from accounts where id = new.account_id;
      if actual_kind is distinct from tg_argv[0]
        or actual_company_id is distinct from new.company_id then
        raise exception 'profile account kind or Company scope is invalid';
      end if;
      return new;
    end;
    $$;
  `.execute(database);
}
