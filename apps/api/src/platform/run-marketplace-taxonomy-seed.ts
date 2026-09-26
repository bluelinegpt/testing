import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * Development-only Marketplace taxonomy seed.
 *
 * A DELIBERATELY TINY vocabulary — two Categories and three Subcategories —
 * sized to exercise navigation, the parent-consistency rule and the Arabic
 * fallback, and nothing more.
 *
 * It is not an attempt at a real marketplace taxonomy. Guessing a production
 * category tree here would be worse than useless: it would look authoritative,
 * it would end up in screenshots, and someone would eventually build on it. The
 * real vocabulary is a Platform decision made with the business.
 *
 * `Electronics` intentionally has NO `name_ar`, so the Arabic Store app has a
 * genuine English-fallback case to exercise rather than a synthetic one.
 *
 * Idempotent: existing slugs short-circuit. Touches no Delivery or financial
 * table.
 */
async function main(): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });

  try {
    const existing = await sql<{ total: string }>`
      select count(*)::text as total from marketplace_categories
    `.execute(database);
    if (existing.rows[0]?.total !== "0") {
      process.stdout.write("Marketplace taxonomy already seeded.\n");
      return;
    }

    await database.transaction().execute(async (transaction) => {
      const fashion = await sql<{ id: string }>`
        insert into marketplace_categories (name_en, name_ar, slug, description_en, display_order)
        values ('Fashion', 'أزياء', 'fashion', 'Clothing, abayas and accessories.', 1)
        returning id
      `.execute(transaction);
      const fashionId = fashion.rows[0]!.id;

      const electronics = await sql<{ id: string }>`
        insert into marketplace_categories (name_en, slug, description_en, display_order)
        values ('Electronics', 'electronics', 'Phones, computers and audio.', 2)
        returning id
      `.execute(transaction);
      const electronicsId = electronics.rows[0]!.id;

      await sql`
        insert into marketplace_subcategories (
          marketplace_category_id, name_en, name_ar, slug, display_order
        ) values
          (${fashionId}::uuid, 'Abayas', 'عبايات', 'abayas', 1),
          (${fashionId}::uuid, 'Women', 'نساء', 'women', 2),
          (${electronicsId}::uuid, 'Mobile Phones', null, 'mobile-phones', 1)
      `.execute(transaction);

      // Classify the Prompt 2A Commerce seed, if it is present, so the Category
      // pages have something real to show. Nothing is invented: the Store and
      // Product already exist, and only their marketplace classification is set.
      const storefront = await sql<{ id: string }>`
        select id from trader_storefronts where slug = 'dev-commerce-store'
      `.execute(transaction);
      const storefrontId = storefront.rows[0]?.id;
      if (storefrontId !== undefined) {
        await sql`
          insert into storefront_marketplace_categories (
            storefront_id, marketplace_category_id, is_primary
          ) values (${storefrontId}::uuid, ${fashionId}::uuid, true)
        `.execute(transaction);
        const abayas = await sql<{ id: string }>`
          select id from marketplace_subcategories
           where marketplace_category_id = ${fashionId}::uuid and slug = 'abayas'
        `.execute(transaction);
        await sql`
          update trader_storefront_products
             set marketplace_category_id = ${fashionId}::uuid,
                 marketplace_subcategory_id = ${abayas.rows[0]!.id}::uuid
           where storefront_id = ${storefrontId}::uuid
        `.execute(transaction);
      }
    });

    process.stdout.write(
      "Marketplace taxonomy seeded.\n  /categories/fashion (Abayas, Women)\n  /categories/electronics (Mobile Phones)\n  Electronics has no Arabic name on purpose - English fallback case.\n",
    );
  } finally {
    await database.destroy();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
