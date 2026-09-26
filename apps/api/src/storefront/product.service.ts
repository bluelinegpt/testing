import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, type Transaction, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

import {
  canTransitionProduct,
  maximumOptionGroupsPerProduct,
  maximumOptionValuesPerGroup,
  maximumProductImages,
  missingRequiredAttributes,
  normaliseInventoryIdentifier,
  normaliseProductCode,
  normaliseProductSlug,
  productSortColumns,
  publicProductSortColumns,
  rejectMediaUrl,
  rejectProductCode,
  rejectProductSlug,
  validateTemplateAttributes,
  type ProductLifecycleStatus,
} from "./product.constants.js";
import type {
  CategoryStatusDto,
  CategoryWriteDto,
  CreateProductDto,
  OptionActiveDto,
  OptionGroupDto,
  OptionGroupUpdateDto,
  OptionValueDto,
  OptionValueUpdateDto,
  ProductAvailabilityDto,
  ProductListQueryDto,
  ProductMediaDto,
  ProductStatusDto,
  PublicProductListQueryDto,
  ReorderDto,
  UpdateCategoryDto,
  UpdateMediaDto,
  UpdateProductDto,
} from "./product.dto.js";
import { FileOwnershipService } from "../files/file-ownership.service.js";

import { accessibleStorefrontIds } from "./storefront-access.js";
import { publiclyResolvableStatuses, type StorefrontTemplate } from "./storefront.constants.js";

/**
 * Trader Storefront Product Catalogue.
 *
 * ---------------------------------------------------------------------------
 * THE STOREFRONT IS THE GATE
 * ---------------------------------------------------------------------------
 *
 * Nothing in this service takes an owner from a request. Every management
 * operation resolves the owning Storefront first — through the actor's Trader
 * Commerce identity, or for a Delivery Company user through that Company's
 * ACTIVE relationship with a Commerce identity — and every subsequent read and
 * write is scoped to the row that resolution returned. A `storefrontId`,
 * `categoryId`, `productId` or `mediaId` in a request is a CLAIM that is
 * checked, never an instruction that is followed.
 *
 * Since 0B-1 the Company is no longer part of that chain. `company_id` survives
 * on these tables as a nullable compatibility reference and must never be read
 * as ownership: a Store with no Delivery Company at all is valid, and scoping a
 * query by `company_id` would make it invisible.
 *
 * Cross-tenant identifiers are reported as not-found rather than forbidden,
 * because a 403 confirms the record exists.
 *
 * ---------------------------------------------------------------------------
 * WHICH LIMITS LIVE WHERE
 * ---------------------------------------------------------------------------
 *
 * One primary image and one active video are partial unique indexes: the
 * database settles those races. Eight images is a COUNT, which no index can
 * express, so it is enforced here inside a transaction that locks the Product
 * row first — two concurrent uploads therefore serialise rather than both
 * reading "seven".
 */

interface StorefrontScope {
  readonly businessTemplate: StorefrontTemplate;
  /** Compatibility reference only. Ownership is the Storefront's Commerce identity. */
  readonly companyId: string | null;
  readonly id: string;
  readonly status: string;
  /** Compatibility reference only. Null for a Store with no Delivery Company. */
  readonly traderId: string | null;
  /** The authoritative owner. Every Commerce file created here belongs to it. */
  readonly traderCommerceId: string;
}

type Executor = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

/** Unaliased twin of `productColumns`, for `returning` where no alias exists. */
const productReturningColumns = sql`
  id, company_id as "companyId", storefront_id as "storefrontId",
  trader_id as "traderId", category_id as "categoryId",
  name, slug, product_code as "productCode",
  sku, barcode, brand,
  marketplace_category_id as "marketplaceCategoryId",
  marketplace_subcategory_id as "marketplaceSubcategoryId",
  seo_title_en as "seoTitleEn", seo_title_ar as "seoTitleAr",
  seo_description_en as "seoDescriptionEn", seo_description_ar as "seoDescriptionAr",
  seo_indexable as "seoIndexable",
  short_description as "shortDescription", full_description as "fullDescription",
  currency, selling_price::text as "sellingPrice",
  previous_price::text as "previousPrice",
  lifecycle_status as "lifecycleStatus", availability_status as "availabilityStatus",
  minimum_quantity as "minimumQuantity", maximum_quantity as "maximumQuantity",
  display_order as "displayOrder", template_attributes as "templateAttributes",
  created_at as "createdAt", updated_at as "updatedAt",
  archived_at as "archivedAt", version::text as version
`;

const productColumns = sql`
  p.id, p.company_id as "companyId", p.storefront_id as "storefrontId",
  p.trader_id as "traderId", p.category_id as "categoryId",
  p.name, p.slug, p.product_code as "productCode",
  p.sku, p.barcode, p.brand,
  p.marketplace_category_id as "marketplaceCategoryId",
  p.marketplace_subcategory_id as "marketplaceSubcategoryId",
  p.seo_title_en as "seoTitleEn", p.seo_title_ar as "seoTitleAr",
  p.seo_description_en as "seoDescriptionEn", p.seo_description_ar as "seoDescriptionAr",
  p.seo_indexable as "seoIndexable",
  p.short_description as "shortDescription", p.full_description as "fullDescription",
  p.currency, p.selling_price::text as "sellingPrice",
  p.previous_price::text as "previousPrice",
  p.lifecycle_status as "lifecycleStatus", p.availability_status as "availabilityStatus",
  p.minimum_quantity as "minimumQuantity", p.maximum_quantity as "maximumQuantity",
  p.display_order as "displayOrder", p.template_attributes as "templateAttributes",
  p.created_at as "createdAt", p.updated_at as "updatedAt",
  p.archived_at as "archivedAt", p.version::text as version
`;

@Injectable()
export class StorefrontProductService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(OperationsHistoryWriter) private readonly auditWriter: OperationsHistoryWriter,
    @Inject(FileOwnershipService) private readonly fileOwnership: FileOwnershipService,
  ) {}

  // ------------------------------------------------------------ categories

  public async listCategories(storefrontId: string) {
    this.assertRead();
    const scope = await this.storefrontScope(this.database, storefrontId);
    const rows = await sql<Record<string, unknown>>`
      select c.id, c.name_en as "nameEn", c.name_ar as "nameAr", c.slug, c.description,
             c.display_order as "displayOrder", c.is_active as "isActive",
             c.image_file_id as "imageFileId", c.version::text as version,
             (select count(*)::int from trader_storefront_products p
               where p.category_id = c.id and p.lifecycle_status <> 'archived') as "productCount"
        from trader_storefront_categories c
       where c.storefront_id = ${scope.id}::uuid
       order by c.display_order, lower(c.name_en)
    `.execute(this.database);
    return { items: rows.rows };
  }

  public async createCategory(storefrontId: string, input: CategoryWriteDto, correlationId: string) {
    this.assertManage();
    const actorId = this.actorId();
    return this.transactions.execute(async (transaction) => {
      const scope = await this.storefrontScope(transaction, storefrontId);
      const slug = normaliseProductSlug(input.slug ?? input.nameEn);
      if (slug.length < 2) {
        throw this.invalid("product_category_slug_invalid", "Enter a valid category URL");
      }
      await this.fileOwnership.assertCommerceFileOwned(
        transaction,
        scope.traderCommerceId,
        input.imageFileId ?? null,
      );
      const inserted = await this.uniqueGuard(async () =>
        sql<Record<string, unknown>>`
          insert into trader_storefront_categories (
            company_id, storefront_id, name_en, name_ar, slug, description,
            display_order, image_file_id, created_by_account_id, updated_by_account_id
          ) values (
            ${scope.companyId}::uuid, ${scope.id}::uuid, ${input.nameEn.trim()},
            ${input.nameAr ?? null}, ${slug}, ${input.description ?? null},
            ${input.displayOrder ?? 0}, ${input.imageFileId ?? null}::uuid,
            ${actorId}::uuid, ${actorId}::uuid
          )
          returning id, slug, name_en as "nameEn", version::text as version
        `.execute(transaction),
      );
      const row = inserted.rows[0]!;
      await this.audit(transaction, scope, "storefront_product.category_created", correlationId, {
        categoryId: String(row.id),
        slug,
      });
      return row;
    });
  }

  public async updateCategory(categoryId: string, input: UpdateCategoryDto, correlationId: string) {
    this.assertManage();
    const actorId = this.actorId();
    return this.transactions.execute(async (transaction) => {
      const current = await this.loadCategory(transaction, categoryId, true);
      this.assertVersion(String(current.version), input.expectedVersion, "product_category_version_conflict");
      const scope = await this.storefrontScope(transaction, String(current.storefrontId));
      const slug =
        input.slug === undefined ? String(current.slug) : normaliseProductSlug(input.slug);
      if (slug.length < 2) {
        throw this.invalid("product_category_slug_invalid", "Enter a valid category URL");
      }
      await this.fileOwnership.assertCommerceFileOwned(
        transaction,
        scope.traderCommerceId,
        input.imageFileId ?? null,
      );
      const updated = await this.uniqueGuard(async () =>
        sql<Record<string, unknown>>`
          update trader_storefront_categories set
            name_en = coalesce(${input.nameEn?.trim() ?? null}, name_en),
            name_ar = ${input.nameAr === undefined ? sql`name_ar` : input.nameAr},
            slug = ${slug},
            description = ${input.description === undefined ? sql`description` : input.description},
            display_order = coalesce(${input.displayOrder ?? null}, display_order),
            image_file_id = ${input.imageFileId === undefined ? sql`image_file_id` : sql`${input.imageFileId}::uuid`},
            updated_by_account_id = ${actorId}::uuid, updated_at = now(), version = version + 1
          where id = ${categoryId}::uuid and storefront_id = ${scope.id}::uuid
          returning id, slug, name_en as "nameEn", version::text as version
        `.execute(transaction),
      );
      const row = updated.rows[0];
      if (row === undefined) throw this.notFound("product_category_not_found");
      await this.audit(transaction, scope, "storefront_product.category_updated", correlationId, {
        categoryId,
        slug,
      });
      return row;
    });
  }

  /**
   * Activate or deactivate a category.
   *
   * Deactivating one that still holds ACTIVE Products is refused rather than
   * silently orphaning them: a live Product whose category is switched off
   * would remain publicly visible under a category the Trader believes is
   * hidden. The Trader reassigns or deactivates those Products first.
   */
  public async setCategoryActive(
    categoryId: string,
    input: CategoryStatusDto,
    correlationId: string,
  ) {
    this.assertManage();
    const actorId = this.actorId();
    return this.transactions.execute(async (transaction) => {
      const current = await this.loadCategory(transaction, categoryId, true);
      this.assertVersion(String(current.version), input.expectedVersion, "product_category_version_conflict");
      const scope = await this.storefrontScope(transaction, String(current.storefrontId));
      if (!input.isActive) {
        const active = await sql<{ count: number }>`
          select count(*)::int as count from trader_storefront_products
           where category_id = ${categoryId}::uuid and lifecycle_status = 'active'
        `.execute(transaction);
        if ((active.rows[0]?.count ?? 0) > 0) {
          throw new ApplicationException(
            "product_category_has_active_products",
            "Reassign or deactivate the active Products in this category first",
            HttpStatus.CONFLICT,
          );
        }
      }
      const updated = await sql<Record<string, unknown>>`
        update trader_storefront_categories
           set is_active = ${input.isActive}, updated_by_account_id = ${actorId}::uuid,
               updated_at = now(), version = version + 1
         where id = ${categoryId}::uuid and storefront_id = ${scope.id}::uuid
        returning id, is_active as "isActive", version::text as version
      `.execute(transaction);
      await this.audit(
        transaction,
        scope,
        input.isActive
          ? "storefront_product.category_activated"
          : "storefront_product.category_deactivated",
        correlationId,
        { categoryId },
      );
      return updated.rows[0]!;
    });
  }

  public async reorderCategories(storefrontId: string, input: ReorderDto, correlationId: string) {
    this.assertManage();
    return this.transactions.execute(async (transaction) => {
      const scope = await this.storefrontScope(transaction, storefrontId);
      for (const entry of input.entries) {
        await sql`
          update trader_storefront_categories set display_order = ${entry.displayOrder},
                 updated_at = now(), version = version + 1
           where id = ${entry.id}::uuid and storefront_id = ${scope.id}::uuid
             and storefront_id = ${scope.id}::uuid
        `.execute(transaction);
      }
      await this.audit(transaction, scope, "storefront_product.categories_reordered", correlationId, {
        count: input.entries.length,
      });
      return { reordered: input.entries.length };
    });
  }

  // -------------------------------------------------------------- products

  public async listProducts(query: ProductListQueryDto) {
    this.assertRead();
    const scope = await this.storefrontScope(this.database, query.storefrontId);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    // Sort column comes from an allow-list; the direction is a literal choice.
    const column = productSortColumns[query.sortBy ?? "displayOrder"] ?? "p.display_order";
    const direction = query.sortDirection === "desc" ? sql`desc` : sql`asc`;
    const search = query.search === undefined ? null : `%${query.search.trim()}%`;
    const rows = await sql<Record<string, unknown>>`
      select ${productColumns},
             c.name_en as "categoryName",
             count(*) over()::int as total,
             (select count(*)::int from trader_storefront_product_media m
               where m.product_id = p.id and m.is_active and m.media_type = 'image') as "imageCount"
        from trader_storefront_products p
        left join trader_storefront_categories c on c.id = p.category_id
       where p.storefront_id = ${scope.id}::uuid
         and (${query.categoryId ?? null}::uuid is null or p.category_id = ${query.categoryId ?? null}::uuid)
         and (${query.lifecycleStatus ?? null}::text is null
              or p.lifecycle_status = ${query.lifecycleStatus ?? null})
         and (${query.availabilityStatus ?? null}::text is null
              or p.availability_status = ${query.availabilityStatus ?? null})
         and (${search}::text is null or p.name ilike ${search}
              or p.product_code ilike ${search} or p.slug ilike ${search})
       order by ${sql.raw(column)} ${direction}, p.id
       limit ${pageSize} offset ${(page - 1) * pageSize}
    `.execute(this.database);
    return {
      items: rows.rows,
      page,
      pageSize,
      total: (rows.rows[0]?.total as number | undefined) ?? 0,
    };
  }

  public async getProduct(productId: string) {
    this.assertRead();
    const product = await this.loadProduct(this.database, productId);
    const [media, options] = await Promise.all([
      this.mediaFor(this.database, productId),
      this.optionsFor(this.database, productId),
    ]);
    return { ...product, media, options };
  }

  public async createProduct(input: CreateProductDto, correlationId: string) {
    this.assertManage();
    const actorId = this.actorId();
    return this.transactions.execute(async (transaction) => {
      const scope = await this.storefrontScope(transaction, input.storefrontId);
      const slug = normaliseProductSlug(input.slug ?? input.name);
      this.assertSlug(slug);
      const code = normaliseProductCode(input.productCode);
      this.assertCode(code);
      if (input.categoryId !== undefined && input.categoryId !== null) {
        await this.assertCategoryInStorefront(transaction, scope, input.categoryId);
      }
      this.assertPreviousPrice(input.sellingPrice, input.previousPrice ?? null);

      const sku = normaliseInventoryIdentifier(input.sku ?? null);
      const barcode = normaliseInventoryIdentifier(input.barcode ?? null);
      const brand = normaliseInventoryIdentifier(input.brand ?? null);

      const inserted = await this.uniqueGuard(async () =>
        sql<Record<string, unknown>>`
          insert into trader_storefront_products (
            company_id, storefront_id, trader_id, category_id, name, slug, product_code,
            sku, barcode, brand,
            short_description, full_description, selling_price, previous_price,
            created_by_account_id, updated_by_account_id
          ) values (
            ${scope.companyId}::uuid, ${scope.id}::uuid, ${scope.traderId}::uuid,
            ${input.categoryId ?? null}::uuid, ${input.name.trim()}, ${slug}, ${code},
            ${sku}, ${barcode}, ${brand},
            ${input.shortDescription ?? null}, ${input.fullDescription ?? null},
            ${input.sellingPrice}::numeric, ${input.previousPrice ?? null}::numeric,
            ${actorId}::uuid, ${actorId}::uuid
          )
          returning ${productReturningColumns}
        `.execute(transaction),
      );
      const row = inserted.rows[0]!;
      await this.audit(transaction, scope, "storefront_product.created", correlationId, {
        productCode: code,
        productId: String(row.id),
        slug,
      });
      return row;
    });
  }

  public async updateProduct(productId: string, input: UpdateProductDto, correlationId: string) {
    this.assertManage();
    const actorId = this.actorId();
    return this.transactions.execute(async (transaction) => {
      const current = await this.loadProduct(transaction, productId, true);
      this.assertVersion(String(current.version), input.expectedVersion, "product_version_conflict");
      const scope = await this.storefrontScope(transaction, String(current.storefrontId));
      if (current.lifecycleStatus === "archived") {
        throw new ApplicationException(
          "product_archived_readonly",
          "An archived Product cannot be edited",
          HttpStatus.CONFLICT,
        );
      }

      const slug = input.slug === undefined ? String(current.slug) : normaliseProductSlug(input.slug);
      this.assertSlug(slug);
      const code =
        input.productCode === undefined
          ? String(current.productCode)
          : normaliseProductCode(input.productCode);
      this.assertCode(code);
      if (input.categoryId !== undefined && input.categoryId !== null) {
        await this.assertCategoryInStorefront(transaction, scope, input.categoryId);
      }
      const sellingPrice = input.sellingPrice ?? String(current.sellingPrice);
      const previousPrice =
        input.previousPrice === undefined
          ? (current.previousPrice as string | null)
          : input.previousPrice;
      this.assertPreviousPrice(sellingPrice, previousPrice);

      const attributes =
        input.templateAttributes === undefined
          ? null
          : this.validatedAttributes(scope.businessTemplate, input.templateAttributes);

      const updated = await this.uniqueGuard(async () =>
        sql<Record<string, unknown>>`
          update trader_storefront_products set
            name = coalesce(${input.name?.trim() ?? null}, name),
            slug = ${slug},
            product_code = ${code},
            category_id = ${input.categoryId === undefined ? sql`category_id` : sql`${input.categoryId}::uuid`},
            sku = ${input.sku === undefined ? sql`sku` : normaliseInventoryIdentifier(input.sku)},
            barcode = ${input.barcode === undefined ? sql`barcode` : normaliseInventoryIdentifier(input.barcode)},
            brand = ${input.brand === undefined ? sql`brand` : normaliseInventoryIdentifier(input.brand)},
            short_description = ${input.shortDescription === undefined ? sql`short_description` : input.shortDescription},
            full_description = ${input.fullDescription === undefined ? sql`full_description` : input.fullDescription},
            selling_price = ${sellingPrice}::numeric,
            previous_price = ${previousPrice}::numeric,
            minimum_quantity = ${input.minimumQuantity === undefined ? sql`minimum_quantity` : input.minimumQuantity},
            maximum_quantity = ${input.maximumQuantity === undefined ? sql`maximum_quantity` : input.maximumQuantity},
            template_attributes = coalesce(${attributes === null ? null : JSON.stringify(attributes)}::jsonb, template_attributes),
            seo_title_en = ${input.seoTitleEn === undefined ? sql`seo_title_en` : input.seoTitleEn},
            seo_title_ar = ${input.seoTitleAr === undefined ? sql`seo_title_ar` : input.seoTitleAr},
            seo_description_en = ${input.seoDescriptionEn === undefined ? sql`seo_description_en` : input.seoDescriptionEn},
            seo_description_ar = ${input.seoDescriptionAr === undefined ? sql`seo_description_ar` : input.seoDescriptionAr},
            seo_social_file_id = ${input.seoSocialFileId === undefined ? sql`seo_social_file_id` : sql`${input.seoSocialFileId}::uuid`},
            seo_indexable = ${input.seoIndexable === undefined ? sql`seo_indexable` : input.seoIndexable},
            updated_by_account_id = ${actorId}::uuid, updated_at = now(), version = version + 1
          where id = ${productId}::uuid and storefront_id = ${scope.id}::uuid
          returning ${productReturningColumns}
        `.execute(transaction),
      );
      const row = updated.rows[0];
      if (row === undefined) throw this.notFound("product_not_found");
      await this.audit(transaction, scope, "storefront_product.updated", correlationId, {
        codeChanged: code !== String(current.productCode),
        priceChanged: sellingPrice !== String(current.sellingPrice),
        productId,
        slugChanged: slug !== String(current.slug),
      });
      return row;
    });
  }

  public activate(productId: string, input: ProductStatusDto, correlationId: string) {
    return this.changeLifecycle(productId, "active", input, correlationId);
  }

  public deactivate(productId: string, input: ProductStatusDto, correlationId: string) {
    return this.changeLifecycle(productId, "inactive", input, correlationId);
  }

  public archive(productId: string, input: ProductStatusDto, correlationId: string) {
    return this.changeLifecycle(productId, "archived", input, correlationId);
  }

  public async setAvailability(
    productId: string,
    input: ProductAvailabilityDto,
    correlationId: string,
  ) {
    this.assertManage();
    const actorId = this.actorId();
    return this.transactions.execute(async (transaction) => {
      const current = await this.loadProduct(transaction, productId, true);
      this.assertVersion(String(current.version), input.expectedVersion, "product_version_conflict");
      const scope = await this.storefrontScope(transaction, String(current.storefrontId));
      if (current.lifecycleStatus === "archived") {
        throw new ApplicationException(
          "product_archived_readonly",
          "An archived Product cannot change availability",
          HttpStatus.CONFLICT,
        );
      }
      const updated = await sql<Record<string, unknown>>`
        update trader_storefront_products
           set availability_status = ${input.availabilityStatus},
               updated_by_account_id = ${actorId}::uuid, updated_at = now(), version = version + 1
         where id = ${productId}::uuid and storefront_id = ${scope.id}::uuid
        returning ${productReturningColumns}
      `.execute(transaction);
      await this.audit(transaction, scope, "storefront_product.availability_changed", correlationId, {
        from: String(current.availabilityStatus),
        productId,
        to: input.availabilityStatus,
      });
      return updated.rows[0]!;
    });
  }

  public async reorderProducts(storefrontId: string, input: ReorderDto, correlationId: string) {
    this.assertManage();
    return this.transactions.execute(async (transaction) => {
      const scope = await this.storefrontScope(transaction, storefrontId);
      for (const entry of input.entries) {
        await sql`
          update trader_storefront_products set display_order = ${entry.displayOrder},
                 updated_at = now(), version = version + 1
           where id = ${entry.id}::uuid and storefront_id = ${scope.id}::uuid
             and storefront_id = ${scope.id}::uuid
        `.execute(transaction);
      }
      await this.audit(transaction, scope, "storefront_product.reordered", correlationId, {
        count: input.entries.length,
      });
      return { reordered: input.entries.length };
    });
  }

  // ----------------------------------------------------------------- media

  public async addMedia(productId: string, input: ProductMediaDto, correlationId: string) {
    this.assertManage();
    const actorId = this.actorId();
    this.assertMediaSource(input);
    return this.transactions.execute(async (transaction) => {
      // Lock the Product first, so two concurrent uploads serialise and the
      // eight-image count below cannot both read "seven".
      const current = await this.loadProduct(transaction, productId, true);
      const scope = await this.storefrontScope(transaction, String(current.storefrontId));
      const counts = await sql<{ images: number; videos: number }>`
        select
          count(*) filter (where media_type = 'image' and is_active)::int as images,
          count(*) filter (where media_type = 'video' and is_active)::int as videos
          from trader_storefront_product_media where product_id = ${productId}::uuid
      `.execute(transaction);
      const existing = counts.rows[0] ?? { images: 0, videos: 0 };
      if (input.mediaType === "image" && existing.images >= maximumProductImages) {
        throw this.invalid(
          "product_media_image_limit",
          `A Product may have at most ${maximumProductImages} images`,
        );
      }
      if (input.mediaType === "video" && existing.videos >= 1) {
        throw this.invalid("product_media_video_limit", "A Product may have only one video");
      }
      // A fileId in the body proves only that SOME file has that id. These two
      // calls prove it is a Commerce file belonging to this Store's Commerce
      // identity — without them, another tenant's image could be attached to
      // this Product and the foreign key would accept it.
      await this.fileOwnership.assertCommerceFileOwned(
        transaction,
        scope.traderCommerceId,
        input.fileId ?? null,
      );
      await this.fileOwnership.assertCommerceFileOwned(
        transaction,
        scope.traderCommerceId,
        input.posterFileId ?? null,
      );

      // The first image becomes primary automatically: a Product with images
      // but no primary cannot be activated, and making the Trader set it by
      // hand only creates a state that fails activation for no reason.
      const primary =
        input.mediaType === "image" && (input.isPrimary === true || existing.images === 0);

      const inserted = await this.uniqueGuard(async () =>
        sql<Record<string, unknown>>`
          insert into trader_storefront_product_media (
            company_id, storefront_id, product_id, media_type, file_id, media_url,
            poster_file_id, poster_url, alt_text, display_order, is_primary,
            created_by_account_id
          ) values (
            ${scope.companyId}::uuid, ${scope.id}::uuid, ${productId}::uuid,
            ${input.mediaType}, ${input.fileId ?? null}::uuid, ${input.mediaUrl ?? null},
            ${input.posterFileId ?? null}::uuid, ${input.posterUrl ?? null},
            ${input.altText ?? null}, ${input.displayOrder ?? existing.images},
            ${primary}, ${actorId}::uuid
          )
          returning id, media_type as "mediaType", is_primary as "isPrimary",
                    display_order as "displayOrder"
        `.execute(transaction),
      );
      await this.audit(transaction, scope, "storefront_product.media_added", correlationId, {
        mediaId: String(inserted.rows[0]!.id),
        mediaType: input.mediaType,
        productId,
      });
      return inserted.rows[0]!;
    });
  }

  public async updateMedia(mediaId: string, input: UpdateMediaDto, correlationId: string) {
    this.assertManage();
    return this.transactions.execute(async (transaction) => {
      const media = await this.loadMedia(transaction, mediaId);
      const scope = await this.storefrontScope(transaction, String(media.storefrontId));
      const updated = await sql<Record<string, unknown>>`
        update trader_storefront_product_media set
          alt_text = ${input.altText === undefined ? sql`alt_text` : input.altText},
          display_order = coalesce(${input.displayOrder ?? null}, display_order),
          updated_at = now()
        where id = ${mediaId}::uuid and storefront_id = ${scope.id}::uuid
        returning id, alt_text as "altText", display_order as "displayOrder"
      `.execute(transaction);
      await this.audit(transaction, scope, "storefront_product.media_updated", correlationId, {
        mediaId,
        productId: String(media.productId),
      });
      return updated.rows[0]!;
    });
  }

  public async setPrimaryImage(mediaId: string, correlationId: string) {
    this.assertManage();
    return this.transactions.execute(async (transaction) => {
      const media = await this.loadMedia(transaction, mediaId);
      if (media.mediaType !== "image") {
        throw this.invalid("product_media_primary_image_only", "Only an image can be primary");
      }
      const scope = await this.storefrontScope(transaction, String(media.storefrontId));
      // Clear first, then set: the partial unique index would otherwise reject
      // the moment two rows are primary, even transiently.
      await sql`
        update trader_storefront_product_media set is_primary = false, updated_at = now()
         where product_id = ${String(media.productId)}::uuid and is_primary
      `.execute(transaction);
      await sql`
        update trader_storefront_product_media set is_primary = true, updated_at = now()
         where id = ${mediaId}::uuid and storefront_id = ${scope.id}::uuid
      `.execute(transaction);
      await this.audit(transaction, scope, "storefront_product.primary_image_changed", correlationId, {
        mediaId,
        productId: String(media.productId),
      });
      return { mediaId, isPrimary: true };
    });
  }

  public async removeMedia(mediaId: string, correlationId: string) {
    this.assertManage();
    return this.transactions.execute(async (transaction) => {
      const media = await this.loadMedia(transaction, mediaId);
      const scope = await this.storefrontScope(transaction, String(media.storefrontId));
      const product = await this.loadProduct(transaction, String(media.productId), true);
      // Removing the last active image from a LIVE Product would leave it
      // publicly visible with nothing to show, and it could not be activated
      // again in that state either.
      if (product.lifecycleStatus === "active" && media.mediaType === "image") {
        const remaining = await sql<{ count: number }>`
          select count(*)::int as count from trader_storefront_product_media
           where product_id = ${String(media.productId)}::uuid and media_type = 'image'
             and is_active and id <> ${mediaId}::uuid
        `.execute(transaction);
        if ((remaining.rows[0]?.count ?? 0) === 0) {
          throw this.invalid(
            "product_media_last_image",
            "An active Product must keep at least one image",
          );
        }
      }
      // Deactivated, never deleted: media is referenced by what a customer saw.
      await sql`
        update trader_storefront_product_media
           set is_active = false, is_primary = false, updated_at = now()
         where id = ${mediaId}::uuid and storefront_id = ${scope.id}::uuid
      `.execute(transaction);
      // Removing the PRIMARY image must not leave the Product with none: that
      // is neither of the two safe outcomes ("blocked" or "another becomes
      // primary") and a live Product would keep its public gallery but lose
      // its hero/thumbnail/OG image silently. The lowest display_order among
      // whatever remains is promoted automatically -- the same rule that
      // already decides which image an Add starts as primary with.
      if (media.isPrimary && media.mediaType === "image") {
        await sql`
          update trader_storefront_product_media
             set is_primary = true, updated_at = now()
           where id = (
             select id from trader_storefront_product_media
              where product_id = ${String(media.productId)}::uuid and media_type = 'image'
                and is_active and id <> ${mediaId}::uuid
              order by display_order, created_at
              limit 1
           )
        `.execute(transaction);
      }
      await this.audit(transaction, scope, "storefront_product.media_removed", correlationId, {
        mediaId,
        productId: String(media.productId),
      });
      return { mediaId, removed: true };
    });
  }

  public async reorderMedia(productId: string, input: ReorderDto, correlationId: string) {
    this.assertManage();
    return this.transactions.execute(async (transaction) => {
      const product = await this.loadProduct(transaction, productId);
      const scope = await this.storefrontScope(transaction, String(product.storefrontId));
      for (const entry of input.entries) {
        await sql`
          update trader_storefront_product_media set display_order = ${entry.displayOrder},
                 updated_at = now()
           where id = ${entry.id}::uuid and product_id = ${productId}::uuid
             and storefront_id = ${scope.id}::uuid
        `.execute(transaction);
      }
      await this.audit(transaction, scope, "storefront_product.media_reordered", correlationId, {
        count: input.entries.length,
        productId,
      });
      return { reordered: input.entries.length };
    });
  }

  // --------------------------------------------------------------- options

  public async addOptionGroup(productId: string, input: OptionGroupDto, correlationId: string) {
    this.assertManage();
    return this.transactions.execute(async (transaction) => {
      const product = await this.loadProduct(transaction, productId, true);
      const scope = await this.storefrontScope(transaction, String(product.storefrontId));
      const count = await sql<{ count: number }>`
        select count(*)::int as count from trader_storefront_product_option_groups
         where product_id = ${productId}::uuid
      `.execute(transaction);
      const existingGroups = count.rows[0]?.count ?? 0;
      if (existingGroups >= maximumOptionGroupsPerProduct) {
        throw this.invalid("product_option_group_limit", "Too many option groups on this Product");
      }
      const inserted = await this.uniqueGuard(async () =>
        sql<Record<string, unknown>>`
          insert into trader_storefront_product_option_groups (
            company_id, storefront_id, product_id, name, display_order, is_required
          ) values (
            ${scope.companyId}::uuid, ${scope.id}::uuid, ${productId}::uuid,
            ${input.name.trim()}, ${input.displayOrder ?? existingGroups}, ${input.isRequired ?? false}
          )
          returning id, name, display_order as "displayOrder", is_active as "isActive",
                    is_required as "isRequired"
        `.execute(transaction),
      );
      await this.audit(transaction, scope, "storefront_product.options_changed", correlationId, {
        optionGroupId: String(inserted.rows[0]!.id),
        productId,
      });
      return inserted.rows[0]!;
    });
  }

  public async addOptionValue(groupId: string, input: OptionValueDto, correlationId: string) {
    this.assertManage();
    return this.transactions.execute(async (transaction) => {
      const group = await this.loadOptionGroup(transaction, groupId);
      const scope = await this.storefrontScope(transaction, String(group.storefrontId));
      const count = await sql<{ count: number }>`
        select count(*)::int as count from trader_storefront_product_option_values
         where option_group_id = ${groupId}::uuid
      `.execute(transaction);
      const existingValues = count.rows[0]?.count ?? 0;
      if (existingValues >= maximumOptionValuesPerGroup) {
        throw this.invalid("product_option_value_limit", "Too many values in this option group");
      }
      const inserted = await this.uniqueGuard(async () =>
        sql<Record<string, unknown>>`
          insert into trader_storefront_product_option_values (
            company_id, storefront_id, option_group_id, value, display_order
          ) values (
            ${scope.companyId}::uuid, ${scope.id}::uuid, ${groupId}::uuid,
            ${input.value.trim()}, ${input.displayOrder ?? existingValues}
          )
          returning id, value, display_order as "displayOrder", is_active as "isActive"
        `.execute(transaction),
      );
      await this.audit(transaction, scope, "storefront_product.options_changed", correlationId, {
        optionGroupId: groupId,
        optionValueId: String(inserted.rows[0]!.id),
      });
      return inserted.rows[0]!;
    });
  }

  public async updateOptionGroup(
    groupId: string,
    input: OptionGroupUpdateDto,
    correlationId: string,
  ) {
    this.assertManage();
    return this.transactions.execute(async (transaction) => {
      const group = await this.loadOptionGroup(transaction, groupId);
      const scope = await this.storefrontScope(transaction, String(group.storefrontId));
      const updated = await this.uniqueGuard(async () =>
        sql<Record<string, unknown>>`
          update trader_storefront_product_option_groups set
            name = coalesce(${input.name?.trim() ?? null}, name),
            is_required = coalesce(${input.isRequired ?? null}, is_required),
            updated_at = now()
          where id = ${groupId}::uuid and storefront_id = ${scope.id}::uuid
          returning id, name, is_required as "isRequired", is_active as "isActive"
        `.execute(transaction),
      );
      await this.audit(transaction, scope, "storefront_product.options_changed", correlationId, {
        optionGroupId: groupId,
        productId: String(group.productId),
      });
      return updated.rows[0]!;
    });
  }

  public async reorderOptionGroups(productId: string, input: ReorderDto, correlationId: string) {
    this.assertManage();
    return this.transactions.execute(async (transaction) => {
      const product = await this.loadProduct(transaction, productId);
      const scope = await this.storefrontScope(transaction, String(product.storefrontId));
      for (const entry of input.entries) {
        await sql`
          update trader_storefront_product_option_groups
             set display_order = ${entry.displayOrder}, updated_at = now()
           where id = ${entry.id}::uuid and product_id = ${productId}::uuid
             and storefront_id = ${scope.id}::uuid
        `.execute(transaction);
      }
      await this.audit(transaction, scope, "storefront_product.options_changed", correlationId, {
        productId,
        reordered: input.entries.length,
      });
      return { reordered: input.entries.length };
    });
  }

  public async reorderOptionValues(groupId: string, input: ReorderDto, correlationId: string) {
    this.assertManage();
    return this.transactions.execute(async (transaction) => {
      const group = await this.loadOptionGroup(transaction, groupId);
      const scope = await this.storefrontScope(transaction, String(group.storefrontId));
      for (const entry of input.entries) {
        await sql`
          update trader_storefront_product_option_values
             set display_order = ${entry.displayOrder}, updated_at = now()
           where id = ${entry.id}::uuid and option_group_id = ${groupId}::uuid
             and storefront_id = ${scope.id}::uuid
        `.execute(transaction);
      }
      await this.audit(transaction, scope, "storefront_product.options_changed", correlationId, {
        optionGroupId: groupId,
        reordered: input.entries.length,
      });
      return { reordered: input.entries.length };
    });
  }

  public async setOptionGroupActive(
    groupId: string,
    input: OptionActiveDto,
    correlationId: string,
  ) {
    this.assertManage();
    return this.transactions.execute(async (transaction) => {
      const group = await this.loadOptionGroup(transaction, groupId);
      const scope = await this.storefrontScope(transaction, String(group.storefrontId));
      await sql`
        update trader_storefront_product_option_groups
           set is_active = ${input.isActive}, updated_at = now()
         where id = ${groupId}::uuid and storefront_id = ${scope.id}::uuid
      `.execute(transaction);
      await this.audit(transaction, scope, "storefront_product.options_changed", correlationId, {
        isActive: input.isActive,
        optionGroupId: groupId,
      });
      return { groupId, isActive: input.isActive };
    });
  }

  /**
   * Rename an option value in place.
   *
   * The value's id -- what a future Store Order snapshot would actually
   * reference -- never changes; only the label does. A future Order that
   * already snapshotted the OLD label keeps it, because a snapshot copies the
   * text at the moment of selection rather than holding a live reference to
   * this row.
   */
  public async updateOptionValue(
    valueId: string,
    input: OptionValueUpdateDto,
    correlationId: string,
  ) {
    this.assertManage();
    return this.transactions.execute(async (transaction) => {
      const value = await this.loadOptionValue(transaction, valueId);
      const scope = await this.storefrontScope(transaction, String(value.storefrontId));
      const updated = await this.uniqueGuard(async () =>
        sql<Record<string, unknown>>`
          update trader_storefront_product_option_values
             set value = ${input.value.trim()}, updated_at = now()
           where id = ${valueId}::uuid and storefront_id = ${scope.id}::uuid
          returning id, value, display_order as "displayOrder", is_active as "isActive"
        `.execute(transaction),
      );
      await this.audit(transaction, scope, "storefront_product.options_changed", correlationId, {
        optionGroupId: String(value.optionGroupId),
        optionValueId: valueId,
      });
      return updated.rows[0]!;
    });
  }

  /**
   * Remove (deactivate) an option value.
   *
   * Deactivated, never deleted -- same rule as Product media and Store
   * Categories: a value a customer already saw (in a future Order snapshot)
   * must not disappear out from under that record. No current-Product
   * completeness check runs here on purpose: unlike an active Product's last
   * image, an option group is never mandatory (T4 activates with zero
   * options), so removing a value can never retroactively break an already-
   * Active Product.
   */
  public async removeOptionValue(valueId: string, correlationId: string) {
    this.assertManage();
    return this.transactions.execute(async (transaction) => {
      const value = await this.loadOptionValue(transaction, valueId);
      const scope = await this.storefrontScope(transaction, String(value.storefrontId));
      await sql`
        update trader_storefront_product_option_values
           set is_active = false, updated_at = now()
         where id = ${valueId}::uuid and storefront_id = ${scope.id}::uuid
      `.execute(transaction);
      await this.audit(transaction, scope, "storefront_product.options_changed", correlationId, {
        optionGroupId: String(value.optionGroupId),
        optionValueId: valueId,
      });
      return { removed: true, valueId };
    });
  }

  // ---------------------------------------------------------------- public

  public async publicCategories(storefrontSlug: string) {
    const storefront = await this.publicStorefront(storefrontSlug);
    const rows = await sql<Record<string, unknown>>`
      select c.name_en as "nameEn", c.name_ar as "nameAr", c.slug,
             c.display_order as "displayOrder"
        from trader_storefront_categories c
       where c.storefront_id = ${storefront.id}::uuid and c.is_active
         and exists (
           select 1 from trader_storefront_products p
            where p.category_id = c.id and p.lifecycle_status = 'active'
         )
       order by c.display_order, lower(c.name_en)
    `.execute(this.database);
    return { items: rows.rows };
  }

  /**
   * Public Product listing.
   *
   * The status filter is the security boundary: only `active` Products under a
   * publicly resolvable Storefront and an active category are visible, so
   * draft, inactive and archived rows are unreachable regardless of what is
   * asked for. Unavailable Products ARE listed, carrying their availability so
   * the page can label them — that is a display decision, not a visibility one.
   */
  public async publicProducts(storefrontSlug: string, query: PublicProductListQueryDto) {
    const storefront = await this.publicStorefront(storefrontSlug);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 24;
    const column = publicProductSortColumns[query.sortBy ?? "displayOrder"] ?? "p.display_order";
    const direction = query.sortDirection === "desc" ? sql`desc` : sql`asc`;
    const search = query.search === undefined ? null : `%${query.search.trim()}%`;
    const rows = await sql<Record<string, unknown>>`
      select p.name, p.slug, p.product_code as "productCode", p.brand,
             p.short_description as "shortDescription",
             p.selling_price::text as "sellingPrice", p.previous_price::text as "previousPrice",
             p.currency, p.availability_status as "availabilityStatus",
             p.template_attributes as "templateAttributes",
             p.seo_indexable as "seoIndexable",
             c.slug as "categorySlug", c.name_en as "categoryName",
             count(*) over()::int as total,
             (select json_build_object(
                       'url', coalesce(m.media_url, '/api/v1/public/commerce-media/' || m.file_id::text),
                       'altText', m.alt_text)
                from trader_storefront_product_media m
               where m.product_id = p.id and m.is_active and m.media_type = 'image'
               order by m.is_primary desc, m.display_order limit 1) as "primaryImage"
        from trader_storefront_products p
        join trader_storefront_categories c
          on c.id = p.category_id and c.is_active
       where p.storefront_id = ${storefront.id}::uuid
         and p.lifecycle_status = 'active'
         and (${query.category ?? null}::text is null or lower(c.slug) = lower(${query.category ?? null}))
         and (${search}::text is null or p.name ilike ${search}
              or p.short_description ilike ${search})
       order by ${sql.raw(column)} ${direction}, p.id
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
      total: (rows.rows[0]?.total as number | undefined) ?? 0,
    };
  }

  public async publicProduct(storefrontSlug: string, productSlug: string) {
    const storefront = await this.publicStorefront(storefrontSlug);
    const result = await sql<Record<string, unknown>>`
      select p.id, p.name, p.slug, p.product_code as "productCode", p.brand,
             p.seo_title_en as "seoTitleEn", p.seo_title_ar as "seoTitleAr",
             p.seo_description_en as "seoDescriptionEn",
             p.seo_description_ar as "seoDescriptionAr",
             p.seo_indexable as "seoIndexable",
             case when p.seo_social_file_id is not null
                  then '/api/v1/public/commerce-media/' || p.seo_social_file_id::text
             end as "socialImageUrl",
             p.short_description as "shortDescription",
             p.full_description as "fullDescription",
             p.selling_price::text as "sellingPrice", p.previous_price::text as "previousPrice",
             p.currency, p.availability_status as "availabilityStatus",
             p.minimum_quantity as "minimumQuantity", p.maximum_quantity as "maximumQuantity",
             p.template_attributes as "templateAttributes",
             c.slug as "categorySlug", c.name_en as "categoryName"
        from trader_storefront_products p
        join trader_storefront_categories c on c.id = p.category_id and c.is_active
       where p.storefront_id = ${storefront.id}::uuid
         and lower(p.slug) = lower(${productSlug}) and p.lifecycle_status = 'active'
    `.execute(this.database);
    const product = result.rows[0];
    if (product === undefined) throw this.notFound("product_not_found");
    const productId = String(product.id);
    const [media, options] = await Promise.all([
      this.mediaFor(this.database, productId, true),
      this.optionsFor(this.database, productId, true),
    ]);
    // `id` is removed AFTER the child lookups: the internal identifier is
    // needed to fetch them and must not travel to the browser.
    const { id, ...safe } = product;
    void id;
    return { ...safe, media, options };
  }

  // ------------------------------------------------------------- internals

  private async changeLifecycle(
    productId: string,
    target: ProductLifecycleStatus,
    input: ProductStatusDto,
    correlationId: string,
  ) {
    this.assertPublish();
    const actorId = this.actorId();
    return this.transactions.execute(async (transaction) => {
      const current = await this.loadProduct(transaction, productId, true);
      this.assertVersion(String(current.version), input.expectedVersion, "product_version_conflict");
      const scope = await this.storefrontScope(transaction, String(current.storefrontId));
      const from = String(current.lifecycleStatus) as ProductLifecycleStatus;
      if (!canTransitionProduct(from, target)) {
        throw new ApplicationException(
          "product_transition_invalid",
          `A Product cannot move from ${from} to ${target}`,
          HttpStatus.CONFLICT,
        );
      }
      if (target === "active") await this.assertActivatable(transaction, scope, current);

      const updated = await sql<Record<string, unknown>>`
        update trader_storefront_products
           set lifecycle_status = ${target},
               archived_at = case when ${target} = 'archived' then now() else null end,
               updated_by_account_id = ${actorId}::uuid, updated_at = now(), version = version + 1
         where id = ${productId}::uuid and storefront_id = ${scope.id}::uuid
        returning ${productReturningColumns}
      `.execute(transaction);
      await this.audit(transaction, scope, `storefront_product.${target}`, correlationId, {
        from,
        productId,
        reason: input.reason ?? null,
      });
      return updated.rows[0]!;
    });
  }

  /** Everything that must hold before a Product becomes publicly visible. */
  private async assertActivatable(
    transaction: Transaction<DatabaseSchema>,
    scope: StorefrontScope,
    product: Record<string, unknown>,
  ): Promise<void> {
    const missing: string[] = [];
    if (scope.status === "suspended") {
      throw new ApplicationException(
        "product_storefront_suspended",
        "A suspended Storefront cannot activate Products",
        HttpStatus.CONFLICT,
      );
    }
    if (product.categoryId === null || product.categoryId === undefined) {
      missing.push("category");
    } else {
      const category = await sql<{ isActive: boolean }>`
        select is_active as "isActive" from trader_storefront_categories
         where id = ${String(product.categoryId)}::uuid
      `.execute(transaction);
      if (category.rows[0]?.isActive !== true) missing.push("activeCategory");
    }
    const media = await sql<{ images: number; primaries: number }>`
      select count(*) filter (where media_type = 'image' and is_active)::int as images,
             count(*) filter (where is_primary and is_active)::int as primaries
        from trader_storefront_product_media where product_id = ${String(product.id)}::uuid
    `.execute(transaction);
    const counts = media.rows[0] ?? { images: 0, primaries: 0 };
    if (counts.images === 0) missing.push("image");
    if (counts.primaries !== 1) missing.push("primaryImage");

    // A REQUIRED option group with nothing to choose from would make the
    // Product impossible to order the moment checkout enforces the choice, so
    // the emptiness is caught here rather than discovered by a customer.
    const emptyRequired = await sql<{ name: string }>`
      select g.name from trader_storefront_product_option_groups g
       where g.product_id = ${String(product.id)}::uuid and g.is_required and g.is_active
         and not exists (
           select 1 from trader_storefront_product_option_values v
            where v.option_group_id = g.id and v.is_active
         )
    `.execute(transaction);
    for (const row of emptyRequired.rows) missing.push(`option:${row.name}`);

    const attributes = (product.templateAttributes ?? {}) as Record<string, unknown>;
    missing.push(...missingRequiredAttributes(scope.businessTemplate, attributes));

    if (missing.length > 0) {
      throw new ApplicationException(
        "product_incomplete_for_activation",
        `Complete these before activating: ${missing.join(", ")}`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        missing,
      );
    }
  }

  private validatedAttributes(
    template: StorefrontTemplate,
    attributes: Record<string, unknown>,
  ): Record<string, string> {
    const problems = validateTemplateAttributes(template, attributes);
    if (problems.length > 0) {
      throw new ApplicationException(
        "product_template_attributes_invalid",
        "One or more template attributes are not valid for this Storefront template",
        HttpStatus.UNPROCESSABLE_ENTITY,
        problems.map((problem) => `${problem.key}:${problem.reason}`),
      );
    }
    return Object.fromEntries(
      Object.entries(attributes).map(([key, value]) => [key, String(value)]),
    );
  }

  private assertMediaSource(input: ProductMediaDto): void {
    const hasFile = input.fileId !== undefined;
    const hasUrl = input.mediaUrl !== undefined;
    if (hasFile === hasUrl) {
      throw this.invalid(
        "product_media_source_required",
        "Provide exactly one of a file reference or a media URL",
      );
    }
    for (const candidate of [input.mediaUrl, input.posterUrl]) {
      if (candidate === undefined) continue;
      const rejection = rejectMediaUrl(candidate);
      if (rejection !== null) {
        throw this.invalid(rejection, "That media reference is not allowed");
      }
    }
  }

  private assertSlug(slug: string): void {
    const rejection = rejectProductSlug(slug);
    if (rejection !== null) throw this.invalid(rejection, "That Product URL cannot be used");
  }

  private assertCode(code: string): void {
    const rejection = rejectProductCode(code);
    if (rejection !== null) throw this.invalid(rejection, "That Product code cannot be used");
  }

  private assertPreviousPrice(sellingPrice: string, previousPrice: string | null): void {
    if (previousPrice === null) return;
    if (Number(previousPrice) <= Number(sellingPrice)) {
      throw this.invalid(
        "product_previous_price_invalid",
        "The comparison price must be higher than the selling price",
      );
    }
  }

  private async assertCategoryInStorefront(
    executor: Executor,
    scope: StorefrontScope,
    categoryId: string,
  ): Promise<void> {
    const result = await sql<{ id: string }>`
      select id from trader_storefront_categories
       where id = ${categoryId}::uuid and storefront_id = ${scope.id}::uuid
         and storefront_id = ${scope.id}::uuid
    `.execute(executor);
    if (result.rows[0] === undefined) {
      throw this.invalid(
        "product_category_not_in_storefront",
        "That category does not belong to this Storefront",
      );
    }
  }

  /**
   * Resolves the Storefront a request may act on.
   *
   * Company comes from the session; a Trader identity is additionally pinned to
   * its own Trader. A Storefront in another Company — or another Trader's, for
   * a Trader session — is reported as not-found.
   */
  private async storefrontScope(
    executor: Executor,
    storefrontId: string,
  ): Promise<StorefrontScope> {
    const result = await sql<StorefrontScope>`
      select id, company_id as "companyId", trader_id as "traderId",
             trader_commerce_id as "traderCommerceId",
             business_template as "businessTemplate", status
        from trader_storefronts
       where id = ${storefrontId}::uuid
         and id in (${this.accessibleStorefronts()})
    `.execute(executor);
    const row = result.rows[0];
    if (row === undefined) throw this.notFound("storefront_not_found");
    return row;
  }

  /**
   * The Storefronts this actor may reach.
   *
   * Every management read and write below funnels through here or through a
   * loader that applies it, so a `storefrontId`, `productId`, `categoryId`,
   * `mediaId` or option id taken from a request can identify a resource but can
   * never assert who owns it.
   */
  private accessibleStorefronts() {
    return accessibleStorefrontIds({
      callerTraderId: this.callerTraderId(),
      companyId: this.tenants.current().companyId,
    });
  }

  private async publicStorefront(slug: string): Promise<{ id: string; template: string }> {
    const result = await sql<{ id: string; template: string }>`
      select id, business_template as template from trader_storefronts
       where lower(slug) = lower(${slug})
         and status = any(${[...publiclyResolvableStatuses]}::text[])
    `.execute(this.database);
    const row = result.rows[0];
    if (row === undefined) throw this.notFound("storefront_not_found");
    return row;
  }

  private async loadProduct(
    executor: Executor,
    productId: string,
    lock = false,
  ): Promise<Record<string, unknown>> {
    const result = await sql<Record<string, unknown>>`
      select ${productColumns} from trader_storefront_products p
       where p.id = ${productId}::uuid
         and p.storefront_id in (${this.accessibleStorefronts()})
       ${lock ? sql`for update` : sql``}
    `.execute(executor);
    const row = result.rows[0];
    if (row === undefined) throw this.notFound("product_not_found");
    return row;
  }

  private async loadCategory(
    executor: Executor,
    categoryId: string,
    lock = false,
  ): Promise<Record<string, unknown>> {
    const result = await sql<Record<string, unknown>>`
      select id, company_id as "companyId", storefront_id as "storefrontId", slug,
             version::text as version
        from trader_storefront_categories
       where id = ${categoryId}::uuid
         and storefront_id in (${this.accessibleStorefronts()})
       ${lock ? sql`for update` : sql``}
    `.execute(executor);
    const row = result.rows[0];
    if (row === undefined) throw this.notFound("product_category_not_found");
    return row;
  }

  private async loadMedia(
    executor: Executor,
    mediaId: string,
  ): Promise<Record<string, unknown>> {
    const result = await sql<Record<string, unknown>>`
      select id, storefront_id as "storefrontId", product_id as "productId",
             media_type as "mediaType", is_primary as "isPrimary"
        from trader_storefront_product_media
       where id = ${mediaId}::uuid
         and storefront_id in (${this.accessibleStorefronts()})
    `.execute(executor);
    const row = result.rows[0];
    if (row === undefined) throw this.notFound("product_media_not_found");
    return row;
  }

  private async loadOptionGroup(
    executor: Executor,
    groupId: string,
  ): Promise<Record<string, unknown>> {
    const result = await sql<Record<string, unknown>>`
      select id, storefront_id as "storefrontId", product_id as "productId"
        from trader_storefront_product_option_groups
       where id = ${groupId}::uuid
         and storefront_id in (${this.accessibleStorefronts()})
    `.execute(executor);
    const row = result.rows[0];
    if (row === undefined) throw this.notFound("product_option_group_not_found");
    return row;
  }

  private async loadOptionValue(
    executor: Executor,
    valueId: string,
  ): Promise<Record<string, unknown>> {
    const result = await sql<Record<string, unknown>>`
      select id, storefront_id as "storefrontId", option_group_id as "optionGroupId"
        from trader_storefront_product_option_values
       where id = ${valueId}::uuid
         and storefront_id in (${this.accessibleStorefronts()})
    `.execute(executor);
    const row = result.rows[0];
    if (row === undefined) throw this.notFound("product_option_value_not_found");
    return row;
  }

  private async mediaFor(executor: Executor, productId: string, publicOnly = false) {
    const rows = await sql<Record<string, unknown>>`
      select ${publicOnly ? sql`` : sql`m.id,`}
             m.media_type as "mediaType", m.alt_text as "altText",
             m.display_order as "displayOrder", m.is_primary as "isPrimary",
             m.is_active as "isActive",
             coalesce(m.media_url, '/api/v1/public/commerce-media/' || m.file_id::text) as url,
             case when m.poster_url is not null then m.poster_url
                  when m.poster_file_id is not null then '/api/v1/public/commerce-media/' || m.poster_file_id::text
                  else null end as "posterUrl"
        from trader_storefront_product_media m
       where m.product_id = ${productId}::uuid ${publicOnly ? sql`and m.is_active` : sql``}
       order by m.is_primary desc, m.display_order, m.id
    `.execute(executor);
    return rows.rows;
  }

  private async optionsFor(executor: Executor, productId: string, publicOnly = false) {
    const rows = await sql<Record<string, unknown>>`
      select ${publicOnly ? sql`` : sql`g.id,`}
             g.name, g.display_order as "displayOrder", g.is_active as "isActive",
             g.is_required as "isRequired",
             coalesce(
               (select json_agg(
                          ${
                            publicOnly
                              ? sql`json_build_object(
                                  'value', v.value, 'displayOrder', v.display_order,
                                  'isActive', v.is_active
                                )`
                              : sql`json_build_object(
                                  'id', v.id, 'value', v.value, 'displayOrder', v.display_order,
                                  'isActive', v.is_active
                                )`
                          }
                          order by v.display_order, v.value)
                  from trader_storefront_product_option_values v
                 where v.option_group_id = g.id
                   ${publicOnly ? sql`and v.is_active` : sql``}),
               '[]'::json) as values
        from trader_storefront_product_option_groups g
       where g.product_id = ${productId}::uuid ${publicOnly ? sql`and g.is_active` : sql``}
       order by g.display_order, lower(g.name)
    `.execute(executor);
    return rows.rows;
  }

  private async uniqueGuard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const code = (error as { code?: string }).code;
      const constraint = String((error as { constraint?: string }).constraint ?? "");
      if (code !== "23505") throw error;
      // Constraint names never reach the caller; each maps to a field error.
      if (constraint.includes("products_slug")) {
        throw this.conflict("product_slug_taken", "That Product URL is already used");
      }
      if (constraint.includes("products_code")) {
        throw this.conflict("product_code_taken", "That Product code is already used");
      }
      if (constraint.includes("products_sku")) {
        throw this.conflict("product_sku_taken", "That SKU is already used in this Storefront");
      }
      if (constraint.includes("categories_slug")) {
        throw this.conflict("product_category_slug_taken", "That category URL is already used");
      }
      if (constraint.includes("media_primary")) {
        throw this.conflict("product_media_primary_conflict", "Another image is already primary");
      }
      if (constraint.includes("media_video")) {
        throw this.conflict("product_media_video_limit", "A Product may have only one video");
      }
      if (constraint.includes("option_groups_name")) {
        throw this.conflict("product_option_group_exists", "That option group already exists");
      }
      if (constraint.includes("option_values")) {
        throw this.conflict("product_option_value_exists", "That option value already exists");
      }
      throw error;
    }
  }

  private callerTraderId(): string | null {
    const identity = this.identities.current();
    if (identity.kind !== "trader") return null;
    const traderId = identity.profileId ?? identity.profileLinkId;
    if (traderId === undefined) {
      throw new ApplicationException(
        "storefront_trader_context_required",
        "This Trader account is not linked to a Trader record",
        HttpStatus.FORBIDDEN,
      );
    }
    return traderId;
  }

  private assertRead(): void {
    if (this.callerTraderId() !== null) return;
    this.assertCompanyPermission("storefront_products.view", "storefront_products.manage");
  }

  private assertManage(): void {
    if (this.callerTraderId() !== null) return;
    this.assertCompanyPermission("storefront_products.manage");
  }

  private assertPublish(): void {
    if (this.callerTraderId() !== null) return;
    this.assertCompanyPermission("storefront_products.publish");
  }

  private assertCompanyPermission(...permissions: readonly string[]): void {
    const held = this.identities.current().permissions;
    if (permissions.some((permission) => held.has(permission))) return;
    // The same administrator escalation `AccountingOperationSupport` applies,
    // so a Company administrator is not locked out of the catalogue alone.
    if (held.has("users_roles.manage")) return;
    throw new ApplicationException(
      "storefront_product_permission_denied",
      "This account cannot perform that Product operation",
      HttpStatus.FORBIDDEN,
    );
  }

  private assertVersion(current: string, expected: number, code: string): void {
    if (Number(current) !== expected) {
      throw new ApplicationException(
        code,
        "This record changed since it was loaded",
        HttpStatus.CONFLICT,
      );
    }
  }

  private actorId(): string {
    return this.tenants.current().identityId;
  }

  private notFound(code: string): ApplicationException {
    return new ApplicationException(code, "The record was not found", HttpStatus.NOT_FOUND);
  }

  private invalid(code: string, message: string): ApplicationException {
    return new ApplicationException(code, message, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  private conflict(code: string, message: string): ApplicationException {
    return new ApplicationException(code, message, HttpStatus.CONFLICT);
  }

  private async audit(
    executor: Executor,
    scope: StorefrontScope,
    action: string,
    correlationId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.auditWriter.audit(executor as Kysely<DatabaseSchema>, {
      action,
      actorId: this.actorId(),
      after: { ...after, storefrontId: scope.id, traderId: scope.traderId },
      // The Company the ACTION happened in, not the Store's owner — operational
      // history is Company-scoped and the Store may have no Company at all.
      companyId: scope.companyId ?? this.tenants.current().companyId,
      correlationId,
      subjectId: String(after.productId ?? after.categoryId ?? scope.id),
      subjectType: "trader_storefront_product",
    });
  }
}
