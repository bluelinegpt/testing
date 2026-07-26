import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table accounts
      add column force_password_change boolean not null default false,
      add column temporary_password_expires_at timestamptz,
      add column last_failed_login_at timestamptz,
      add column administrative_lock_reason text,
      add column administrative_locked_at timestamptz,
      add column administrative_locked_by_account_id uuid references accounts(id) on delete restrict;

    alter table company_users add column display_name text;
    update company_users set display_name = name_en where display_name is null;
    alter table company_users
      alter column display_name set not null,
      add constraint company_users_display_name_nonempty check (btrim(display_name) <> '');
    create unique index company_users_company_email_unique
      on company_users (company_id, lower(btrim(email))) where email is not null;

    alter table roles add column description text;
    create unique index roles_company_name_unique
      on roles (company_id, lower(btrim(name))) where company_id is not null;
    create unique index roles_platform_name_unique
      on roles (lower(btrim(name))) where company_id is null;

    create unique index employees_company_user_unique
      on employees (company_id, company_user_id) where company_user_id is not null;

    create function protect_administration_identifiers() returns trigger language plpgsql as $$
    begin
      if tg_table_name = 'accounts' then
        if tg_op = 'UPDATE' and new.username is distinct from old.username then
          raise exception using errcode = '23514', message = 'Username is immutable';
        end if;
        if new.username !~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$' then
          raise exception using errcode = '23514', message = 'Username has an invalid format';
        end if;
      elsif tg_table_name = 'roles' and tg_op = 'UPDATE' and new.code is distinct from old.code then
        raise exception using errcode = '23514', message = 'Role code is immutable';
      end if;
      return new;
    end;
    $$;
    create trigger accounts_username_guard
      before insert or update of username on accounts
      for each row execute function protect_administration_identifiers();
    create trigger roles_code_immutable
      before update of code on roles
      for each row execute function protect_administration_identifiers();

    create function validate_company_user_profile() returns trigger language plpgsql as $$
    begin
      new.display_name := btrim(new.display_name);
      if new.display_name = '' then
        raise exception using errcode = '23514', message = 'User Name is required';
      end if;
      if tg_op = 'INSERT' or new.email is distinct from old.email then
        new.email := nullif(lower(btrim(new.email)), '');
        if new.email is not null and new.email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
          raise exception using errcode = '23514', message = 'Email has an invalid format';
        end if;
      end if;
      if tg_op = 'INSERT' or new.mobile_number is distinct from old.mobile_number then
        new.mobile_number := nullif(btrim(new.mobile_number), '');
        if new.mobile_number is not null and new.mobile_number !~ '^9715[0-9]{8}$' then
          raise exception using errcode = '23514', message = 'Mobile must use 9715XXXXXXXX format';
        end if;
      end if;
      return new;
    end;
    $$;
    create trigger company_users_profile_guard
      before insert or update of display_name, email, mobile_number on company_users
      for each row execute function validate_company_user_profile();

    create function validate_employee_user_link() returns trigger language plpgsql as $$
    declare
      linked_user_active boolean;
    begin
      if new.company_user_id is null then return new; end if;
      select cu.is_active into linked_user_active
        from company_users cu
       where cu.id = new.company_user_id and cu.company_id = new.company_id;
      if linked_user_active is null then
        raise exception using errcode = '23514', message = 'Linked User must belong to the Employee Company';
      end if;
      if not new.is_active then
        raise exception using errcode = '23514', message = 'A disabled Employee cannot be newly linked';
      end if;
      return new;
    end;
    $$;
    create trigger employees_user_link_guard
      before insert or update of company_user_id on employees
      for each row execute function validate_employee_user_link();

    create function validate_active_account_roles() returns trigger language plpgsql as $$
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
    create constraint trigger accounts_active_role_guard
      after insert or update of status on accounts deferrable initially deferred
      for each row execute function validate_active_account_roles();
    create constraint trigger account_roles_active_user_guard
      after insert or update or delete on account_roles deferrable initially deferred
      for each row execute function validate_active_account_roles();
    create constraint trigger roles_active_user_guard
      after update of is_active on roles deferrable initially deferred
      for each row execute function validate_active_account_roles();

    create function validate_active_role_permissions() returns trigger language plpgsql as $$
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
    create constraint trigger roles_permission_guard
      after insert or update of is_active on roles deferrable initially deferred
      for each row execute function validate_active_role_permissions();
    create constraint trigger role_permissions_nonempty_guard
      after insert or update or delete on role_permissions deferrable initially deferred
      for each row execute function validate_active_role_permissions();

    create function reject_administration_delete() returns trigger language plpgsql as $$
    begin
      if tg_table_name = 'accounts' and old.account_kind <> 'company_user' then return old; end if;
      raise exception using errcode = '23514', message = 'Administrative identities and Roles cannot be deleted';
    end;
    $$;
    create trigger company_user_accounts_no_delete before delete on accounts
      for each row execute function reject_administration_delete();
    create trigger roles_no_delete before delete on roles
      for each row execute function reject_administration_delete();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists roles_no_delete on roles;
    drop trigger if exists company_user_accounts_no_delete on accounts;
    drop function if exists reject_administration_delete();
    drop trigger if exists role_permissions_nonempty_guard on role_permissions;
    drop trigger if exists roles_permission_guard on roles;
    drop function if exists validate_active_role_permissions();
    drop trigger if exists roles_active_user_guard on roles;
    drop trigger if exists account_roles_active_user_guard on account_roles;
    drop trigger if exists accounts_active_role_guard on accounts;
    drop function if exists validate_active_account_roles();
    drop trigger if exists employees_user_link_guard on employees;
    drop function if exists validate_employee_user_link();
    drop trigger if exists company_users_profile_guard on company_users;
    drop function if exists validate_company_user_profile();
    drop trigger if exists roles_code_immutable on roles;
    drop trigger if exists accounts_username_guard on accounts;
    drop function if exists protect_administration_identifiers();
    drop index if exists employees_company_user_unique;
    drop index if exists roles_platform_name_unique;
    drop index if exists roles_company_name_unique;
    alter table roles drop column if exists description;
    drop index if exists company_users_company_email_unique;
    alter table company_users drop constraint if exists company_users_display_name_nonempty;
    alter table company_users drop column if exists display_name;
    alter table accounts
      drop column if exists administrative_locked_by_account_id,
      drop column if exists administrative_locked_at,
      drop column if exists administrative_lock_reason,
      drop column if exists last_failed_login_at,
      drop column if exists temporary_password_expires_at,
      drop column if exists force_password_change;
  `.execute(database);
}
