import { readFileSync } from "node:fs";
import { sql, type Kysely } from "kysely";

// Content-only forward correction. Apply only after the normal backup/schema gates.
// Preserve authored CMS edits: replace only the exact original published English seed.
const content = JSON.parse(readFileSync(new URL("./content/order-statuses-en.json", import.meta.url), "utf8"));
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`update platform_help_articles
    set title=${content.title}, summary=${content.summary}, body=${JSON.stringify(content.body)}::jsonb,
        seo_title=${content.seoTitle}, meta_description=${content.metaDescription},
        related_slugs=${content.relatedSlugs}::text[], canonical_path='/resources/order-statuses', updated_at=now()
    where slug='order-statuses' and locale='en' and status='published'
      and title='Understand order statuses'
      and summary='Order statuses show where each shipment is in the delivery workflow.'
      and (canonical_path is null or canonical_path='/resources/order-statuses')
      and body=${JSON.stringify(content.expectedSeedBody)}::jsonb
  `.execute(db);
}
// Do not erase improved or subsequently edited content on rollback.
export async function down(): Promise<void> {}
