import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Final database guard for account-kind-aware Employee, Driver, and Trader links.
 * Operational creation and legacy synchronization validate this before insert;
 * this trigger remains the concurrency-safe final boundary for every writer.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create function validate_user_business_link_account_kind()
    returns trigger language plpgsql as $$
    declare
      actual_kind text;
      required_kind text;
    begin
      select account_kind into actual_kind
        from accounts
       where id = new.account_id and company_id = new.company_id;

      required_kind := case new.entity_type
        when 'employee' then 'company_user'
        when 'driver' then 'driver'
        when 'trader' then 'trader'
      end;

      if actual_kind is null then
        raise exception using
          errcode = '23503',
          constraint = 'user_business_links_account_company_fk';
      end if;
      if actual_kind <> required_kind then
        raise exception using
          errcode = '23514',
          constraint = 'user_business_links_account_kind_check',
          message = 'User business link account kind does not match entity type';
      end if;
      return new;
    end
    $$;

    create trigger user_business_links_account_kind_guard
      before insert or update of company_id, account_id, entity_type
      on user_business_links
      for each row execute function validate_user_business_link_account_kind();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists user_business_links_account_kind_guard on user_business_links;
    drop function if exists validate_user_business_link_account_kind();
  `.execute(database);
}
