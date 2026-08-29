import { sql, type Kysely } from "kysely";

const templateKeys = sql.raw(
  "'corporate','modern','express','local','premium','skyline','minimal','bold','elegant','urban','swift','horizon','nexus','oasis','fleet','commerce','courier','executive','vibrant','classic'",
);

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table company_websites
      drop constraint company_websites_template_check,
      drop constraint company_websites_published_template_check;

    alter table company_websites
      add constraint company_websites_template_check
        check (template_key in (${templateKeys})),
      add constraint company_websites_published_template_check
        check (published_template_key is null or published_template_key in (${templateKeys}));
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table company_websites
      drop constraint company_websites_template_check,
      drop constraint company_websites_published_template_check;

    alter table company_websites
      add constraint company_websites_template_check
        check (template_key in ('corporate','modern','express','local','premium')),
      add constraint company_websites_published_template_check
        check (published_template_key is null or published_template_key in ('corporate','modern','express','local','premium'));
  `.execute(database);
}
