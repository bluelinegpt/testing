import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table traders alter column account_id drop not null;

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

    do $$
    declare
      candidate record;
    begin
      for candidate in
        select t.id as trader_id, t.company_id, a.id as account_id
          from traders t
          join accounts a on a.id = t.account_id and a.company_id = t.company_id
         where a.account_kind = 'trader'
           and lower(a.username) = 'trader.' || lower(t.code)
           and not exists (
             select 1 from user_business_links l where l.account_id = a.id
           )
           and not exists (
             select 1 from account_sessions s where s.account_id = a.id
           )
           and not exists (
             select 1 from password_reset_tokens p where p.account_id = a.id
           )
           and not exists (
             select 1 from account_roles ar where ar.account_id = a.id
           )
      loop
        update traders
           set account_id = null, updated_at = now(), version = version + 1
         where id = candidate.trader_id and company_id = candidate.company_id;
        begin
          delete from accounts
           where id = candidate.account_id
             and company_id = candidate.company_id
             and account_kind = 'trader';
        exception when foreign_key_violation then
          update traders
             set account_id = candidate.account_id,
                 updated_at = now(),
                 version = version + 1
           where id = candidate.trader_id and company_id = candidate.company_id;
        end;
      end loop;
    end;
    $$;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  const missing = await sql<{ count: string }>`
    select count(*)::text as count from traders where account_id is null
  `.execute(database);
  if (Number(missing.rows[0]?.count ?? "0") > 0) {
    throw new Error(
      "Cannot restore mandatory Trader accounts after on-demand account cleanup",
    );
  }
  await sql`
    alter table traders alter column account_id set not null;
    create or replace function enforce_profile_account_kind() returns trigger language plpgsql as $$
    declare
      actual_kind text;
      actual_company_id uuid;
    begin
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
