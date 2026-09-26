import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_blog_articles
      drop constraint if exists platform_blog_articles_slug_check;

    alter table platform_blog_articles
      add constraint platform_blog_articles_slug_international_check check (
        char_length(slug) between 1 and 160
        and slug = btrim(slug)
        and slug !~ '[[:space:][:cntrl:]/?#]'
        and position(E'\\\\' in slug) = 0
        and slug not in ('.', '..')
        and position(chr(8234) in slug) = 0
        and position(chr(8235) in slug) = 0
        and position(chr(8236) in slug) = 0
        and position(chr(8237) in slug) = 0
        and position(chr(8238) in slug) = 0
        and position(chr(8294) in slug) = 0
        and position(chr(8295) in slug) = 0
        and position(chr(8296) in slug) = 0
        and position(chr(8297) in slug) = 0
      );

    update platform_blog_articles set translation_group_id=gen_random_uuid() where translation_group_id is null;
    alter table platform_blog_articles alter column translation_group_id set default gen_random_uuid();
    alter table platform_blog_articles alter column translation_group_id set not null;

    create unique index platform_blog_articles_translation_language_uq
      on platform_blog_articles(translation_group_id, language)
      where translation_group_id is not null;

    alter table platform_blog_categories
      add column translation_group_id uuid not null default gen_random_uuid();

    create unique index platform_blog_categories_translation_language_uq
      on platform_blog_categories(translation_group_id, language)
      where translation_group_id is not null;

    alter table platform_blog_categories
      add constraint platform_blog_categories_slug_international_check check (
        char_length(slug) between 1 and 160
        and slug = btrim(slug)
        and slug !~ '[[:space:][:cntrl:]/?#]'
        and position(E'\\\\' in slug) = 0
        and slug not in ('.', '..')
        and position(chr(8234) in slug) = 0
        and position(chr(8235) in slug) = 0
        and position(chr(8236) in slug) = 0
        and position(chr(8237) in slug) = 0
        and position(chr(8238) in slug) = 0
        and position(chr(8294) in slug) = 0
        and position(chr(8295) in slug) = 0
        and position(chr(8296) in slug) = 0
        and position(chr(8297) in slug) = 0
      );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists platform_blog_categories_translation_language_uq;
    alter table platform_blog_categories
      drop constraint if exists platform_blog_categories_slug_international_check,
      drop column if exists translation_group_id;
    drop index if exists platform_blog_articles_translation_language_uq;
    alter table platform_blog_articles
      alter column translation_group_id drop not null,
      alter column translation_group_id drop default,
      drop constraint if exists platform_blog_articles_slug_international_check;
  `.execute(database);
}
