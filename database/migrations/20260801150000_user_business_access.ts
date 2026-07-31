import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table user_business_links (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id),
      account_id uuid not null,
      entity_type text not null,
      entity_id uuid not null,
      access_status text not null default 'active',
      is_primary boolean not null default false,
      created_by_account_id uuid not null references accounts(id),
      created_at timestamptz not null default now(),
      updated_by_account_id uuid references accounts(id),
      updated_at timestamptz not null default now(),
      suspended_by_account_id uuid references accounts(id),
      suspended_at timestamptz,
      suspension_reason text,
      revoked_by_account_id uuid references accounts(id),
      revoked_at timestamptz,
      revocation_reason text,
      version bigint not null default 1,
      unique (id, company_id),
      constraint user_business_links_account_company_fk
        foreign key (account_id, company_id) references accounts(id, company_id),
      constraint user_business_links_creator_company_fk
        foreign key (created_by_account_id, company_id) references accounts(id, company_id),
      constraint user_business_links_updater_company_fk
        foreign key (updated_by_account_id, company_id) references accounts(id, company_id),
      constraint user_business_links_suspender_company_fk
        foreign key (suspended_by_account_id, company_id) references accounts(id, company_id),
      constraint user_business_links_revoker_company_fk
        foreign key (revoked_by_account_id, company_id) references accounts(id, company_id),
      constraint user_business_links_entity_type_check
        check (entity_type in ('employee','driver','trader')),
      constraint user_business_links_access_status_check
        check (access_status in ('invited','active','suspended','revoked')),
      constraint user_business_links_version_positive check (version > 0),
      constraint user_business_links_status_metadata check (
        (access_status <> 'suspended' or (suspended_at is not null and suspension_reason is not null))
        and (access_status <> 'revoked' or (revoked_at is not null and revocation_reason is not null))
      )
    );

    create unique index user_business_links_active_exact_unique
      on user_business_links(company_id, account_id, entity_type, entity_id)
      where access_status in ('invited','active','suspended');
    create unique index user_business_links_employee_active_unique
      on user_business_links(company_id, entity_id)
      where entity_type='employee' and access_status in ('invited','active','suspended');
    create unique index user_business_links_driver_active_unique
      on user_business_links(company_id, entity_id)
      where entity_type='driver' and access_status in ('invited','active','suspended');
    create unique index user_business_links_driver_account_active_unique
      on user_business_links(company_id, account_id)
      where entity_type='driver' and access_status in ('invited','active','suspended');
    create unique index user_business_links_trader_account_active_unique
      on user_business_links(company_id, account_id)
      where entity_type='trader' and access_status in ('invited','active','suspended');
    create index user_business_links_account_lookup
      on user_business_links(company_id, account_id, access_status);
    create index user_business_links_entity_lookup
      on user_business_links(company_id, entity_type, entity_id, access_status);

    create function validate_user_business_link_entity() returns trigger language plpgsql as $$
    begin
      if new.entity_type='employee' and not exists (
        select 1 from employees where id=new.entity_id and company_id=new.company_id
      ) then raise exception using errcode='23503', constraint='user_business_links_employee_company_fk';
      elsif new.entity_type='driver' and not exists (
        select 1 from drivers where id=new.entity_id and company_id=new.company_id
      ) then raise exception using errcode='23503', constraint='user_business_links_driver_company_fk';
      elsif new.entity_type='trader' and not exists (
        select 1 from traders where id=new.entity_id and company_id=new.company_id
      ) then raise exception using errcode='23503', constraint='user_business_links_trader_company_fk';
      end if;
      return new;
    end $$;
    create trigger user_business_links_entity_guard
      before insert or update of company_id,entity_type,entity_id on user_business_links
      for each row execute function validate_user_business_link_entity();

    alter table password_reset_tokens
      add column revoked_at timestamptz,
      add column requested_ip_hash text,
      add column requested_user_agent text,
      add column created_by_source text not null default 'self_service',
      add column version bigint not null default 1,
      add constraint password_reset_tokens_source_check
        check (created_by_source in ('self_service','administrator')),
      add constraint password_reset_tokens_version_positive check (version > 0);
    create index password_reset_tokens_active_lookup
      on password_reset_tokens(token_hash, expires_at)
      where used_at is null and revoked_at is null;
    create index password_reset_tokens_account_history
      on password_reset_tokens(account_id, created_at desc);

    alter table account_sessions
      add column profile_link_id uuid,
      add column profile_type text,
      add column profile_id uuid,
      add constraint account_sessions_profile_link_company_fk
        foreign key (profile_link_id, company_id) references user_business_links(id, company_id),
      add constraint account_sessions_profile_type_check
        check (profile_type in ('employee','driver','trader')),
      add constraint account_sessions_profile_metadata_complete check (
        (profile_link_id is null and profile_type is null and profile_id is null)
        or (profile_link_id is not null and profile_type is not null and profile_id is not null)
      );
    create index account_sessions_profile_active
      on account_sessions(company_id,profile_link_id,expires_at)
      where revoked_at is null and profile_link_id is not null;
    create function validate_account_session_profile() returns trigger language plpgsql as $$
    begin
      if new.profile_link_id is not null and not exists (
        select 1 from user_business_links l
         where l.id=new.profile_link_id and l.company_id=new.company_id
           and l.account_id=new.account_id and l.entity_type=new.profile_type
           and l.entity_id=new.profile_id and l.access_status='active'
      ) then
        raise exception using errcode='23514', constraint='account_sessions_profile_link_valid';
      end if;
      return new;
    end $$;
    create trigger account_sessions_profile_guard
      before insert or update of account_id,company_id,profile_link_id,profile_type,profile_id
      on account_sessions for each row execute function validate_account_session_profile();

    create function suspend_disabled_business_profile_access() returns trigger language plpgsql as $$
    declare
      profile_kind text;
      should_suspend boolean;
    begin
      profile_kind := case tg_table_name
        when 'employees' then 'employee'
        when 'drivers' then 'driver'
        when 'traders' then 'trader'
      end;
      should_suspend := case tg_table_name
        when 'employees' then not new.is_active
        else new.account_status = 'disabled'
      end;
      if should_suspend then
        update user_business_links
           set access_status='suspended',
               suspended_at=coalesce(suspended_at,now()),
               suspension_reason=coalesce(suspension_reason,'Business record disabled'),
               updated_at=now(),
               version=version+1
         where company_id=new.company_id and entity_type=profile_kind and entity_id=new.id
           and access_status in ('invited','active');
        update account_sessions s
           set revoked_at=coalesce(s.revoked_at,now())
          from user_business_links l
         where l.id=s.profile_link_id and l.company_id=new.company_id
           and l.entity_type=profile_kind and l.entity_id=new.id and s.revoked_at is null;
      end if;
      return new;
    end $$;
    create trigger employee_business_access_suspend
      after update of is_active on employees for each row
      when (old.is_active and not new.is_active)
      execute function suspend_disabled_business_profile_access();
    create trigger driver_business_access_suspend
      after update of account_status on drivers for each row
      when (old.account_status is distinct from new.account_status and new.account_status='disabled')
      execute function suspend_disabled_business_profile_access();
    create trigger trader_business_access_suspend
      after update of account_status on traders for each row
      when (old.account_status is distinct from new.account_status and new.account_status='disabled')
      execute function suspend_disabled_business_profile_access();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists trader_business_access_suspend on traders;
    drop trigger if exists driver_business_access_suspend on drivers;
    drop trigger if exists employee_business_access_suspend on employees;
    drop function if exists suspend_disabled_business_profile_access();
    drop trigger if exists account_sessions_profile_guard on account_sessions;
    drop function if exists validate_account_session_profile();
    drop index if exists account_sessions_profile_active;
    alter table account_sessions
      drop constraint if exists account_sessions_profile_metadata_complete,
      drop constraint if exists account_sessions_profile_type_check,
      drop constraint if exists account_sessions_profile_link_company_fk,
      drop column if exists profile_id,
      drop column if exists profile_type,
      drop column if exists profile_link_id;
    drop index if exists password_reset_tokens_account_history;
    drop index if exists password_reset_tokens_active_lookup;
    alter table password_reset_tokens
      drop constraint if exists password_reset_tokens_version_positive,
      drop constraint if exists password_reset_tokens_source_check,
      drop column if exists version,
      drop column if exists created_by_source,
      drop column if exists requested_user_agent,
      drop column if exists requested_ip_hash,
      drop column if exists revoked_at;
    drop trigger if exists user_business_links_entity_guard on user_business_links;
    drop function if exists validate_user_business_link_entity();
    drop table if exists user_business_links;
  `.execute(database);
}
