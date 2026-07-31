import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function suspend_disabled_business_profile_access()
    returns trigger language plpgsql as $$
    declare
      profile_kind text;
      should_suspend boolean;
    begin
      if tg_table_name = 'employees' then
        profile_kind := 'employee';
        should_suspend := not new.is_active;
      elsif tg_table_name = 'drivers' then
        profile_kind := 'driver';
        should_suspend := new.account_status = 'disabled';
      elsif tg_table_name = 'traders' then
        profile_kind := 'trader';
        should_suspend := new.account_status = 'disabled';
      else
        return new;
      end if;

      if should_suspend then
        update user_business_links
           set access_status='suspended',
               suspended_at=coalesce(suspended_at,now()),
               suspension_reason=coalesce(suspension_reason,'Business record disabled'),
               updated_at=now(),
               version=version+1
         where company_id=new.company_id
           and entity_type=profile_kind
           and entity_id=new.id
           and access_status in ('invited','active');

        update account_sessions s
           set revoked_at=coalesce(s.revoked_at,now())
          from user_business_links l
         where l.id=s.profile_link_id
           and l.company_id=new.company_id
           and l.entity_type=profile_kind
           and l.entity_id=new.id
           and s.revoked_at is null;
      end if;

      return new;
    end $$;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function suspend_disabled_business_profile_access()
    returns trigger language plpgsql as $$
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
  `.execute(database);
}
