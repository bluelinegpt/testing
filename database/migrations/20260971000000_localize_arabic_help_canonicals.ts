import type { Kysely } from "kysely";
import { sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(db: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_help_articles
      drop constraint platform_help_articles_canonical_path_check,
      add constraint platform_help_articles_canonical_path_check
        check (
          canonical_path is null
          or canonical_path ~ '^/(ar/)?resources/[a-z0-9]+(-[a-z0-9]+)*$'
        );

    update platform_help_articles
       set canonical_path = '/ar/resources/' || slug,
           updated_at = now()
     where locale = 'ar'
       and canonical_path = '/resources/' || slug
  `.execute(db);
}

export async function down(db: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    update platform_help_articles
       set canonical_path = '/resources/' || slug,
           updated_at = now()
     where locale = 'ar'
       and canonical_path = '/ar/resources/' || slug;

    alter table platform_help_articles
      drop constraint platform_help_articles_canonical_path_check,
      add constraint platform_help_articles_canonical_path_check
        check (
          canonical_path is null
          or canonical_path ~ '^/resources/[a-z0-9]+(-[a-z0-9]+)*$'
        )
  `.execute(db);
}
