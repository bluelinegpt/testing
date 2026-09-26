import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * The Company Mobile Code — how the mobile app names a Company.
 *
 * The web portals identify the Company from the subdomain of the address the
 * request arrived on. The mobile app has no address: one installed app serves
 * every Company, so the user must supply the Company themselves, and a
 * subdomain is the wrong thing to ask a Driver to type mid-route. This column
 * is the answer agreed 2026-08-15: six random digits, unique, printed under
 * the Company's QR code on the portal screen and on report corners.
 *
 * RANDOM, not sequential, deliberately: a sequential number lets anyone
 * enumerate neighbouring Companies (37, 38, 39...) and probe who is on the
 * platform. Six random digits leave the space 99.99%+ empty at any realistic
 * Company count. The code is still NOT a secret — resolving a wrong code at
 * login answers with the same generic invalid-credentials as a wrong
 * password, and no endpoint confirms a Company name from a code alone.
 *
 * `generate_company_mobile_code()` is the single generation path, wired as
 * the column DEFAULT so every INSERT — the Platform service, the development
 * bootstrap, a future importer — gets a code without remembering to make one.
 * The backfill uses the same function, so existing Companies (Dana and the
 * rest) are covered in this same transaction. Two simultaneous INSERTs could
 * in principle draw the same code between check and commit; the unique index
 * turns that one-in-a-million race into a loud insert failure rather than a
 * silent duplicate.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function generate_company_mobile_code() returns text
    language plpgsql
    as $$
    declare candidate text;
    begin
      loop
        candidate := lpad(floor(random() * 1000000)::int::text, 6, '0');
        exit when not exists (select 1 from companies where mobile_code = candidate);
      end loop;
      return candidate;
    end
    $$;

    alter table companies add column mobile_code text;

    update companies set mobile_code = generate_company_mobile_code() where mobile_code is null;

    alter table companies alter column mobile_code set default generate_company_mobile_code();
    alter table companies alter column mobile_code set not null;
    alter table companies
      add constraint companies_mobile_code_format check (mobile_code ~ '^[0-9]{6}$');
    create unique index companies_mobile_code_unique on companies (mobile_code);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists companies_mobile_code_unique;
    alter table companies drop constraint if exists companies_mobile_code_format;
    alter table companies alter column mobile_code drop default;
    alter table companies drop column if exists mobile_code;
    drop function if exists generate_company_mobile_code();
  `.execute(database);
}
