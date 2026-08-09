import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * A named contact on the Company profile.
 *
 * `companies` already carries `telephone` and `email` but no person to attach
 * them to, so a Platform Administrator recording who to call had nowhere to put
 * the name. One nullable column closes that.
 *
 * Deliberately narrow. Two other fields the onboarding form could plausibly
 * offer were NOT added:
 *
 *  - **Supported languages.** `company_settings.default_language` exists and is
 *    checked against `en`/`ar`; nothing in the product reads a list of
 *    additional languages, so a column for one would be a field that looks like
 *    configuration and configures nothing.
 *  - **Emirate.** `emirates` is global reference data joined through `areas`,
 *    which is operational geography rather than Company identity. A Company-level
 *    emirate would be a second, unreferenced source of truth.
 *
 * Added as its own migration rather than folded into
 * `20260809100000_platform_company_lifecycle_and_environment`, which is already
 * applied; rewriting applied history to avoid one extra file is the worse trade.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table companies add column contact_name text;
    alter table companies add constraint companies_contact_name_nonempty check (
      contact_name is null or btrim(contact_name) <> ''
    );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table companies drop constraint if exists companies_contact_name_nonempty;
    alter table companies drop column if exists contact_name;
  `.execute(database);
}
