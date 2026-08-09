import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { publiclyResolvableStatuses } from "../storefront/storefront.constants.js";

/**
 * Platform Marketplace taxonomy — reads.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC RESOLUTION ACCOUNTS FOR THE PARENT, ALWAYS
 * ---------------------------------------------------------------------------
 *
 * An active Subcategory under an INACTIVE Category must not appear publicly.
 * Deactivating "Fashion" has to take "Abayas" off the marketplace with it, or
 * the Platform would have to remember to walk the children by hand and would
 * eventually forget.
 *
 * The child rows are deliberately NOT rewritten when a parent is deactivated:
 * their own `is_active` still records what the Platform decided about them
 * individually, so reactivating the parent restores exactly the previous shape
 * rather than a flattened one. Every public query therefore joins the parent
 * and tests both flags.
 *
 * ---------------------------------------------------------------------------
 * ORDERING IS EXPLICIT
 * ---------------------------------------------------------------------------
 *
 * `display_order` then lowercased name. Never insertion order: a marketplace
 * whose navigation reshuffles when a row is updated looks broken, and
 * PostgreSQL offers no ordering guarantee without an ORDER BY.
 */
@Injectable()
export class MarketplaceTaxonomyService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  /** Active Categories for public navigation. No internal identifiers. */
  public async publicCategories() {
    const rows = await sql<{
      descriptionAr: string | null;
      descriptionEn: string | null;
      displayOrder: number;
      nameAr: string | null;
      nameEn: string;
      slug: string;
      subcategoryCount: number;
    }>`
      select category.name_en as "nameEn", category.name_ar as "nameAr", category.slug,
             category.description_en as "descriptionEn", category.description_ar as "descriptionAr",
             category.seo_title_en as "seoTitleEn", category.seo_title_ar as "seoTitleAr",
             category.seo_description_en as "seoDescriptionEn",
             category.seo_description_ar as "seoDescriptionAr",
             category.seo_indexable as "seoIndexable",
             category.display_order as "displayOrder",
             (select count(*)::int from marketplace_subcategories child
               where child.marketplace_category_id = category.id and child.is_active)
               as "subcategoryCount"
        from marketplace_categories category
       where category.is_active
       order by category.display_order, lower(category.name_en)
    `.execute(this.database);
    return { items: rows.rows };
  }

  /** One active Category with its active Subcategories. */
  public async publicCategory(slug: string) {
    const found = await sql<{
      descriptionAr: string | null;
      descriptionEn: string | null;
      nameAr: string | null;
      nameEn: string;
      slug: string;
    }>`
      select name_en as "nameEn", name_ar as "nameAr", slug,
             description_en as "descriptionEn", description_ar as "descriptionAr",
             seo_title_en as "seoTitleEn", seo_title_ar as "seoTitleAr",
             seo_description_en as "seoDescriptionEn", seo_description_ar as "seoDescriptionAr",
             seo_indexable as "seoIndexable"
        from marketplace_categories
       where lower(slug) = lower(${slug}) and is_active
    `.execute(this.database);
    const category = found.rows[0];
    if (category === undefined) throw this.notFound();

    const children = await sql<{
      displayOrder: number;
      nameAr: string | null;
      nameEn: string;
      slug: string;
    }>`
      select child.name_en as "nameEn", child.name_ar as "nameAr", child.slug,
             child.display_order as "displayOrder"
        from marketplace_subcategories child
        join marketplace_categories parent on parent.id = child.marketplace_category_id
       where lower(parent.slug) = lower(${slug})
         and parent.is_active and child.is_active
       order by child.display_order, lower(child.name_en)
    `.execute(this.database);
    return { ...category, subcategories: children.rows };
  }

  /** One active Subcategory, resolved through its active parent. */
  public async publicSubcategory(categorySlug: string, subcategorySlug: string) {
    const found = await sql<{
      categoryNameAr: string | null;
      categoryNameEn: string;
      categorySlug: string;
      nameAr: string | null;
      nameEn: string;
      slug: string;
    }>`
      select child.name_en as "nameEn", child.name_ar as "nameAr", child.slug,
             child.seo_title_en as "seoTitleEn", child.seo_title_ar as "seoTitleAr",
             child.seo_description_en as "seoDescriptionEn",
             child.seo_description_ar as "seoDescriptionAr",
             child.seo_indexable as "seoIndexable",
             parent.name_en as "categoryNameEn", parent.name_ar as "categoryNameAr",
             parent.slug as "categorySlug"
        from marketplace_subcategories child
        join marketplace_categories parent on parent.id = child.marketplace_category_id
       where lower(parent.slug) = lower(${categorySlug})
         and lower(child.slug) = lower(${subcategorySlug})
         and parent.is_active and child.is_active
    `.execute(this.database);
    const row = found.rows[0];
    if (row === undefined) throw this.notFound();
    return row;
  }

  /**
   * Published Stores classified under a Category.
   *
   * Store visibility is decided by the SAME `publiclyResolvableStatuses` list
   * the rest of the public surface uses, so a draft or suspended shop cannot
   * become visible merely by acquiring a marketplace classification.
   */
  public async publicStoresInCategory(categorySlug: string) {
    const rows = await sql<{
      displayName: string;
      isPrimary: boolean;
      logoFileId: string | null;
      slug: string;
      status: string;
      storeDescription: string | null;
    }>`
      select storefront.display_name as "displayName", storefront.slug,
             storefront.status, storefront.store_description as "storeDescription",
             storefront.logo_file_id as "logoFileId", mapping.is_primary as "isPrimary"
        from storefront_marketplace_categories mapping
        join trader_storefronts storefront on storefront.id = mapping.storefront_id
        join marketplace_categories category
          on category.id = mapping.marketplace_category_id
       where lower(category.slug) = lower(${categorySlug})
         and category.is_active
         and storefront.status = any(${[...publiclyResolvableStatuses]}::text[])
       order by mapping.is_primary desc, lower(storefront.display_name)
       limit 48
    `.execute(this.database);
    return {
      items: rows.rows.map((row) => ({
        displayName: row.displayName,
        logoUrl:
          row.logoFileId === null ? null : `/api/v1/public/commerce-media/${row.logoFileId}`,
        slug: row.slug,
        status: row.status === "temporarily_closed" ? "temporarily_closed" : "published",
        storeDescription: row.storeDescription,
      })),
    };
  }

  /**
   * Published Products in a Category, optionally narrowed to one Subcategory.
   *
   * Server-side paged. There is deliberately no "return every Product" shape:
   * a marketplace that ships the whole catalogue to the browser stops working
   * at the first shop with a real inventory, and by then the client-side filter
   * is load-bearing.
   *
   * A Subcategory filter matches ONLY that Subcategory — never a sibling, and
   * never the Category's unclassified remainder.
   */
  public async publicProductsInCategory(input: {
    readonly categorySlug: string;
    readonly page?: number;
    readonly pageSize?: number;
    readonly subcategorySlug?: string;
  }) {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(Math.max(1, input.pageSize ?? 24), 48);
    const subcategorySlug = input.subcategorySlug ?? null;

    const rows = await sql<{
      availabilityStatus: string;
      brand: string | null;
      currency: string;
      name: string;
      previousPrice: string | null;
      primaryImage: { altText: string | null; url: string } | null;
      sellingPrice: string;
      slug: string;
      storeName: string;
      storeSlug: string;
      total: number;
    }>`
      select product.name, product.slug,
             product.selling_price::text as "sellingPrice",
             product.previous_price::text as "previousPrice",
             product.currency, product.brand,
             product.availability_status as "availabilityStatus",
             storefront.slug as "storeSlug", storefront.display_name as "storeName",
             count(*) over()::int as total,
             (select json_build_object(
                       'url', coalesce(media.media_url,
                              '/api/v1/public/commerce-media/' || media.file_id::text),
                       'altText', media.alt_text)
                from trader_storefront_product_media media
               where media.product_id = product.id and media.is_active
                 and media.media_type = 'image'
               order by media.is_primary desc, media.display_order limit 1) as "primaryImage"
        from trader_storefront_products product
        join trader_storefronts storefront on storefront.id = product.storefront_id
        join marketplace_categories category
          on category.id = product.marketplace_category_id
        left join marketplace_subcategories subcategory
          on subcategory.id = product.marketplace_subcategory_id
       where lower(category.slug) = lower(${input.categorySlug})
         and category.is_active
         and product.lifecycle_status = 'active'
         and storefront.status = any(${[...publiclyResolvableStatuses]}::text[])
         and (
           ${subcategorySlug}::text is null
           or (subcategory.id is not null
               and lower(subcategory.slug) = lower(${subcategorySlug})
               and subcategory.is_active)
         )
       order by lower(product.name), product.id
       limit ${pageSize} offset ${(page - 1) * pageSize}
    `.execute(this.database);

    return {
      items: rows.rows.map((row) => {
        const { total, ...rest } = row;
        void total;
        return rest;
      }),
      page,
      pageSize,
      total: rows.rows[0]?.total ?? 0,
    };
  }

  /**
   * The taxonomy an authenticated Trader may classify against.
   *
   * Active rows only — a Trader must not be able to pick a Category the
   * Platform has retired — and ids ARE returned here, because management writes
   * address rows by id. The public surface returns none.
   */
  public async managementTaxonomy() {
    const rows = await sql<{
      categoryId: string;
      categoryNameAr: string | null;
      categoryNameEn: string;
      categorySlug: string;
      displayOrder: number;
      subcategories: unknown;
    }>`
      select category.id as "categoryId", category.name_en as "categoryNameEn",
             category.name_ar as "categoryNameAr", category.slug as "categorySlug",
             category.display_order as "displayOrder",
             coalesce((
               select json_agg(json_build_object(
                        'id', child.id, 'nameEn', child.name_en,
                        'nameAr', child.name_ar, 'slug', child.slug,
                        'displayOrder', child.display_order)
                      order by child.display_order, lower(child.name_en))
                 from marketplace_subcategories child
                where child.marketplace_category_id = category.id and child.is_active
             ), '[]'::json) as subcategories
        from marketplace_categories category
       where category.is_active
       order by category.display_order, lower(category.name_en)
    `.execute(this.database);
    return { items: rows.rows };
  }

  private notFound(): ApplicationException {
    return new ApplicationException(
      "marketplace_category_not_found",
      "Category not found",
      HttpStatus.NOT_FOUND,
    );
  }
}
