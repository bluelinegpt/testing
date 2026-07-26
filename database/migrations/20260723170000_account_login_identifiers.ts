import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table accounts
      add column normalized_username text,
      add column email text,
      add column normalized_email text,
      add column mobile_number text,
      add column normalized_mobile_number text;

    update accounts
       set normalized_username = lower(btrim(username));

    update accounts a
       set email = nullif(btrim(cu.email), ''),
           normalized_email = nullif(lower(btrim(cu.email)), ''),
           mobile_number = nullif(btrim(cu.mobile_number), ''),
           normalized_mobile_number = nullif(btrim(cu.mobile_number), '')
      from company_users cu
     where cu.account_id = a.id
       and cu.company_id = a.company_id;

    alter table accounts
      alter column normalized_username set not null,
      add constraint accounts_normalized_username_nonempty
        check (btrim(normalized_username) <> ''),
      add constraint accounts_email_format
        check (
          email is null
          or email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
        ),
      add constraint accounts_normalized_email_consistent
        check (
          (email is null and normalized_email is null)
          or normalized_email = lower(btrim(email))
        ),
      add constraint accounts_mobile_format
        check (mobile_number is null or mobile_number ~ '^9715[0-9]{8}$'),
      add constraint accounts_normalized_mobile_consistent
        check (
          (mobile_number is null and normalized_mobile_number is null)
          or normalized_mobile_number = mobile_number
        );

    create unique index accounts_company_normalized_username_unique
      on accounts (company_id, normalized_username)
      where company_id is not null;
    create unique index accounts_platform_normalized_username_unique
      on accounts (normalized_username)
      where company_id is null;
    create unique index accounts_company_normalized_email_unique
      on accounts (company_id, normalized_email)
      where company_id is not null and normalized_email is not null;
    create unique index accounts_company_normalized_mobile_unique
      on accounts (company_id, normalized_mobile_number)
      where company_id is not null and normalized_mobile_number is not null;

    create function normalize_account_login_identifiers() returns trigger language plpgsql as $$
    begin
      new.username := btrim(new.username);
      new.normalized_username := lower(new.username);
      new.email := nullif(btrim(new.email), '');
      new.normalized_email := lower(new.email);
      new.mobile_number := nullif(btrim(new.mobile_number), '');
      new.normalized_mobile_number := new.mobile_number;
      return new;
    end;
    $$;

    create trigger accounts_login_identifier_normalizer
      before insert or update of username, email, mobile_number on accounts
      for each row execute function normalize_account_login_identifiers();

    create function sync_account_login_identifiers_to_company_user()
      returns trigger language plpgsql as $$
    begin
      if new.account_kind = 'company_user' then
        update company_users
           set email = new.email,
               mobile_number = new.mobile_number,
               updated_at = case
                 when email is distinct from new.email
                   or mobile_number is distinct from new.mobile_number
                 then now()
                 else updated_at
               end,
               version = case
                 when email is distinct from new.email
                   or mobile_number is distinct from new.mobile_number
                 then version + 1
                 else version
               end
         where account_id = new.id
           and company_id = new.company_id
           and (
             email is distinct from new.email
             or mobile_number is distinct from new.mobile_number
           );
      end if;
      return new;
    end;
    $$;

    create trigger accounts_company_user_identifier_sync
      after insert or update of email, mobile_number on accounts
      for each row execute function sync_account_login_identifiers_to_company_user();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists accounts_company_user_identifier_sync on accounts;
    drop function if exists sync_account_login_identifiers_to_company_user();
    drop trigger if exists accounts_login_identifier_normalizer on accounts;
    drop function if exists normalize_account_login_identifiers();
    drop index if exists accounts_company_normalized_mobile_unique;
    drop index if exists accounts_company_normalized_email_unique;
    drop index if exists accounts_platform_normalized_username_unique;
    drop index if exists accounts_company_normalized_username_unique;
    alter table accounts
      drop constraint if exists accounts_normalized_mobile_consistent,
      drop constraint if exists accounts_mobile_format,
      drop constraint if exists accounts_normalized_email_consistent,
      drop constraint if exists accounts_email_format,
      drop constraint if exists accounts_normalized_username_nonempty,
      drop column if exists normalized_mobile_number,
      drop column if exists mobile_number,
      drop column if exists normalized_email,
      drop column if exists email,
      drop column if exists normalized_username;
  `.execute(database);
}
