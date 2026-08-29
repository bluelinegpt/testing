import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table company_website_agent_conversations
      add column visitor_contact_number text;

    alter table company_website_agent_conversations
      add constraint company_website_agent_conversations_contact_length
      check (visitor_contact_number is null or char_length(visitor_contact_number) between 5 and 32);
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table company_website_agent_conversations
      drop constraint if exists company_website_agent_conversations_contact_length;
    alter table company_website_agent_conversations
      drop column if exists visitor_contact_number;
  `.execute(database);
}
