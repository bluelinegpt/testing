import { resolve } from "node:path";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";

const slug = "development-test-what-is-a-delivery-operating-system";
const action = process.argv[2] ?? "draft";
loadEnvironment({ path: resolve(process.cwd(), ".env") });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const database = new Kysely({ dialect: new PostgresDialect({ pool }) });
try {
  await sql`
    insert into platform_blog_articles(slug, language, title, excerpt, content, author_id, category_id, seo_title, meta_description)
    select ${slug}, 'en', '[Development Test] What Is a Delivery Operating System?',
      'A development-only CMS lifecycle article. It must not remain published.',
      ${JSON.stringify([{ type: "paragraph", text: "This temporary article verifies the Tawseelhub Blog publishing lifecycle." }])}::jsonb,
      a.id, c.id, 'What Is a Delivery Operating System? | Tawseelhub',
      'Development-only verification of the Tawseelhub Blog publishing lifecycle.'
    from platform_blog_authors a, platform_blog_categories c
    where a.display_name='Tawseelhub Team' and c.slug='delivery-operations'
    on conflict(language,slug) do nothing
  `.execute(database);
  if (action === "publish" || action === "unpublish") {
    const status = action === "publish" ? "published" : "unpublished";
    await sql`update platform_blog_articles set status=${status},published_at=coalesce(published_at,now()),updated_at=now() where slug=${slug}`.execute(database);
  }
  process.stdout.write(`${slug}:${action}\n`);
} finally { await database.destroy(); }
