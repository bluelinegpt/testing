import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";

const runDatabaseTests = process.env.RUN_DATABASE_INTEGRATION === "true";
const rollbackMarker = Symbol("rollback Help canonical migration test");

type MigrationModule = {
  up: (database: Kysely<Record<string, never>>) => Promise<void>;
};

describe.skipIf(!runDatabaseTests)("Arabic Help canonical migration database behavior", () => {
  it("migrates legacy Arabic rows while enforcing the bilingual path allowlist", async () => {
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<Record<string, never>>({
      dialect: new PostgresDialect({ pool }),
    });
    const migrationUrl = pathToFileURL(
      resolve(
        process.cwd(),
        "../../database/migrations/20260971000000_localize_arabic_help_canonicals.ts",
      ),
    ).href;
    const migration = (await import(migrationUrl)) as MigrationModule;

    try {
      await database.transaction().execute(async (transaction) => {
        await sql`
          create temporary table platform_help_articles (
            slug text not null,
            locale text not null,
            canonical_path text,
            updated_at timestamptz not null default now(),
            constraint platform_help_articles_canonical_path_check
              check (
                canonical_path is null
                or canonical_path ~ '^/resources/[a-z0-9]+(-[a-z0-9]+)*$'
              )
          ) on commit drop
        `.execute(transaction);
        await sql`
          insert into platform_help_articles (slug, locale, canonical_path) values
            ('what-is-tawseelhub', 'en', '/resources/what-is-tawseelhub'),
            ('what-is-tawseelhub', 'ar', '/resources/what-is-tawseelhub')
        `.execute(transaction);

        await migration.up(transaction);

        const rows = await sql<{ locale: string; canonical_path: string }>`
          select locale, canonical_path
          from platform_help_articles
          order by locale
        `.execute(transaction);
        expect(rows.rows).toEqual([
          { locale: "ar", canonical_path: "/ar/resources/what-is-tawseelhub" },
          { locale: "en", canonical_path: "/resources/what-is-tawseelhub" },
        ]);

        await expect(
          sql`
            insert into platform_help_articles (slug, locale, canonical_path)
            values ('another-guide', 'en', '/resources/another-guide')
          `.execute(transaction),
        ).resolves.toBeDefined();
        await expect(
          sql`
            insert into platform_help_articles (slug, locale, canonical_path)
            values ('another-arabic-guide', 'ar', '/ar/resources/another-arabic-guide')
          `.execute(transaction),
        ).resolves.toBeDefined();

        await sql`savepoint invalid_canonical`.execute(transaction);
        try {
          await expect(
            sql`
              insert into platform_help_articles (slug, locale, canonical_path)
              values ('bad-guide', 'en', '/admin/bad-guide')
            `.execute(transaction),
          ).rejects.toMatchObject({ code: "23514" });
        } finally {
          await sql`rollback to savepoint invalid_canonical`.execute(transaction);
          await sql`release savepoint invalid_canonical`.execute(transaction);
        }

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    } finally {
      await database.destroy();
    }
  });
});
