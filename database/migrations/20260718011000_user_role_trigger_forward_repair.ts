import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function validate_active_account_roles() returns trigger language plpgsql as $$
    declare
      target_account_id uuid;
      target_role_id uuid;
    begin
      if tg_table_name = 'account_roles' then
        target_account_id := case when tg_op = 'DELETE' then old.account_id else new.account_id end;
      elsif tg_table_name = 'accounts' then
        target_account_id := case when tg_op = 'DELETE' then old.id else new.id end;
      elsif tg_table_name = 'roles' then
        target_role_id := case when tg_op = 'DELETE' then old.id else new.id end;
      end if;

      if target_role_id is not null and exists (
        select 1 from accounts a
        join account_roles ar on ar.account_id = a.id
        where ar.role_id = target_role_id and a.account_kind = 'company_user' and a.status = 'active'
          and not exists (
            select 1 from account_roles ar2 join roles r2 on r2.id = ar2.role_id
             where ar2.account_id = a.id and r2.is_active
          )
      ) then
        raise exception using errcode = '23514', message = 'An Active User must have at least one active Role';
      end if;

      if target_account_id is not null and exists (
        select 1 from accounts a
         where a.id = target_account_id and a.account_kind = 'company_user' and a.status = 'active'
           and not exists (
             select 1 from account_roles ar join roles r on r.id = ar.role_id
              where ar.account_id = a.id and r.is_active
           )
      ) then
        raise exception using errcode = '23514', message = 'An Active User must have at least one active Role';
      end if;
      return null;
    end;
    $$;

    create or replace function validate_active_role_permissions() returns trigger language plpgsql as $$
    declare
      target_role_id uuid;
    begin
      if tg_table_name = 'roles' then
        target_role_id := case when tg_op = 'DELETE' then old.id else new.id end;
      elsif tg_table_name = 'role_permissions' then
        target_role_id := case when tg_op = 'DELETE' then old.role_id else new.role_id end;
      end if;
      if exists (
        select 1 from roles r where r.id = target_role_id and r.is_active
          and not exists (select 1 from role_permissions rp where rp.role_id = r.id)
      ) then
        raise exception using errcode = '23514', message = 'An Active Role must have at least one Permission';
      end if;
      return null;
    end;
    $$;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  // This forward repair intentionally remains in place when rolling back later feature migrations.
  await sql`select 1`.execute(database);
}
