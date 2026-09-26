import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { BlogService } from "./blog.service.js";

/**
 * Public Blog category visibility: a category with zero published articles
 * must never appear in the public category list, even though it stays
 * fully intact in the CMS for editors. Gated the same way as the other
 * `.database.test.ts` files in this repo -- run explicitly against a real
 * Postgres instance, not part of the default fast unit run.
 */
const runTests = process.env.RUN_BLOG_PUBLIC_CATEGORIES_DATABASE === "true";

describe.skipIf(!runTests)("Public Blog category visibility", () => {
  const settings = configuration();
  const pool = new Pool({ connectionString: settings.database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const service = new BlogService(database as never);
  let authorId = "";
  let publishedCategoryId = "";
  let emptyCategoryId = "";
  const suffix = Date.now().toString(36);

  beforeAll(async () => {
    authorId = (
      await sql<{ id: string }>`
        insert into platform_blog_authors (display_name) values (${`Test Author ${suffix}`}) returning id
      `.execute(database)
    ).rows[0]!.id;
    publishedCategoryId = (
      await sql<{ id: string }>`
        insert into platform_blog_categories (name, slug, language)
        values (${`Has Articles ${suffix}`}, ${`has-articles-${suffix}`}, 'en') returning id
      `.execute(database)
    ).rows[0]!.id;
    emptyCategoryId = (
      await sql<{ id: string }>`
        insert into platform_blog_categories (name, slug, language)
        values (${`Draft Only ${suffix}`}, ${`draft-only-${suffix}`}, 'en') returning id
      `.execute(database)
    ).rows[0]!.id;
    // One PUBLISHED article in the first category.
    await sql`
      insert into platform_blog_articles (slug, language, title, excerpt, author_id, category_id, status, published_at)
      values (${`published-article-${suffix}`}, 'en', 'Published Article', 'An excerpt.', ${authorId}::uuid, ${publishedCategoryId}::uuid, 'published', now())
    `.execute(database);
    // Only a DRAFT article in the second category -- it must not count.
    await sql`
      insert into platform_blog_articles (slug, language, title, excerpt, author_id, category_id, status)
      values (${`draft-article-${suffix}`}, 'en', 'Draft Article', 'An excerpt.', ${authorId}::uuid, ${emptyCategoryId}::uuid, 'draft')
    `.execute(database);
  });

  afterAll(async () => {
    await sql`delete from platform_blog_articles where slug in (${`published-article-${suffix}`}, ${`draft-article-${suffix}`})`.execute(database);
    await sql`delete from platform_blog_categories where id in (${publishedCategoryId}::uuid, ${emptyCategoryId}::uuid)`.execute(database);
    await sql`delete from platform_blog_authors where id = ${authorId}::uuid`.execute(database);
    await database.destroy();
  });

  it("returns a category with a published article but hides a Draft-only category", async () => {
    const categories = await service.categories("en");
    const slugs = categories.map((category: { slug: string }) => category.slug);
    expect(slugs).toContain(`has-articles-${suffix}`);
    expect(slugs).not.toContain(`draft-only-${suffix}`);
  });
});
