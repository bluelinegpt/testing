import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * Development-only Commerce seed.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * `dev-validation-store` was created by hand during earlier work and vanished
 * the first time the Company test-data reset ran. Every subsequent piece of
 * Commerce work then needed a Store that no longer existed, and hand-making one
 * again would guarantee the same loss next time.
 *
 * This script creates the minimum Commerce tree needed to exercise the public
 * Store, the Product page and the media upload transport:
 *
 *     Trader Commerce identity
 *       -> Storefront (published)
 *          -> Category
 *             -> Product (active, with a required option group)
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It writes NOTHING to Orders, settlements, reconciliations, receivables,
 * Accounting or Journals. Fabricated delivery or financial history would look
 * exactly like real history to every report in the system, and there is no
 * reason a Commerce fixture should need any.
 *
 * It also creates NO Delivery Company relationship. That is the point: this
 * seed produces a genuinely zero-Delivery-Company shop, which is the case the
 * ownership work exists to support and the hardest one to get right. A Company
 * link can be added through the UI when a one-Company scenario is wanted.
 *
 * Re-running is safe: the Storefront slug is the natural key and an existing
 * one short-circuits the whole script.
 */

const STORE_SLUG = "dev-commerce-store";

async function main(): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });

  try {
    const existing = await sql<{ id: string }>`
      select id from trader_storefronts where slug = ${STORE_SLUG}
    `.execute(database);
    if (existing.rows[0] !== undefined) {
      process.stdout.write(`Commerce seed already present: /${STORE_SLUG}\n`);
      return;
    }

    const commerceId = randomUUID();
    const storefrontId = randomUUID();
    const categoryId = randomUUID();
    const productId = randomUUID();
    const groupId = randomUUID();

    await database.transaction().execute(async (transaction) => {
      await sql`
        insert into trader_commerce_profiles (
          id, public_name, contact_name, mobile_number, registration_source,
          approval_status, is_active
        ) values (
          ${commerceId}::uuid, 'Dev Commerce Store', 'Dev Contact', '971500000000',
          'trader_self_registered', 'approved', true
        )
      `.execute(transaction);

      // No company_id, no trader_id, no delivery relationship.
      await sql`
        insert into trader_storefronts (
          id, trader_commerce_id, display_name, slug, business_template, theme,
          store_description, delivery_information, return_policy, public_mobile,
          business_hours, status, published_at
        ) values (
          ${storefrontId}::uuid, ${commerceId}::uuid, 'Dev Commerce Store', ${STORE_SLUG},
          'fashion', 'modern',
          'Development Commerce store. Not a real merchant.',
          'Next-day delivery across the UAE (development data).',
          'Returns accepted within 7 days (development data).',
          '+971500000000',
          ${JSON.stringify([{ days: "Saturday – Thursday", time: "10:00 - 22:00" }])}::jsonb,
          'published', now()
        )
      `.execute(transaction);

      await sql`
        insert into trader_storefront_categories (id, storefront_id, name_en, name_ar, slug)
        values (${categoryId}::uuid, ${storefrontId}::uuid, 'Dev Abayas', 'عبايات تجريبية', 'dev-abayas')
      `.execute(transaction);

      await sql`
        insert into trader_storefront_products (
          id, storefront_id, category_id, name, slug, product_code, sku, brand,
          short_description, full_description, selling_price, previous_price,
          lifecycle_status, availability_status, template_attributes
        ) values (
          ${productId}::uuid, ${storefrontId}::uuid, ${categoryId}::uuid,
          'Dev Embroidered Abaya', 'dev-embroidered-abaya', 'DEV-ABAYA-0001',
          'ABA-01', 'Dev Brand',
          'Hand-finished development sample.',
          'A development Product used to validate the public Store and media transport.',
          249.00, 299.00, 'active', 'available',
          ${JSON.stringify({ material: "Premium crepe" })}::jsonb
        )
      `.execute(transaction);

      await sql`
        insert into trader_storefront_product_option_groups (
          id, storefront_id, product_id, name, is_required, display_order
        ) values (${groupId}::uuid, ${storefrontId}::uuid, ${productId}::uuid, 'Size', true, 0)
      `.execute(transaction);

      await sql`
        insert into trader_storefront_product_option_values (
          storefront_id, option_group_id, value, display_order
        ) values
          (${storefrontId}::uuid, ${groupId}::uuid, 'S', 0),
          (${storefrontId}::uuid, ${groupId}::uuid, 'M', 1),
          (${storefrontId}::uuid, ${groupId}::uuid, 'L', 2)
      `.execute(transaction);
    });

    process.stdout.write(
      `Commerce seed created.\n  store    /${STORE_SLUG}\n  product  /${STORE_SLUG}/products/dev-embroidered-abaya\n  storefrontId ${storefrontId}\n  productId    ${productId}\n  Delivery Company relationships: 0 (zero-Company shop by design)\n`,
    );
  } finally {
    await database.destroy();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
