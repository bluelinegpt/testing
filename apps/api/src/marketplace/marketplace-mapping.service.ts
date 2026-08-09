import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { accessibleStorefrontIds } from "../storefront/storefront-access.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

/**
 * Store and Product marketplace classification — writes.
 *
 * ---------------------------------------------------------------------------
 * A TRADER CLASSIFIES; ONLY THE PLATFORM DEFINES
 * ---------------------------------------------------------------------------
 *
 * Everything here assigns an EXISTING Platform Category to a Store or Product.
 * There is no create, rename, reslug or deactivate anywhere in this service,
 * and none is exposed to a Trader or a Delivery Company user. A marketplace
 * whose vocabulary any Trader could extend is not a marketplace vocabulary; it
 * is a second set of Trader Store Categories with a confusing name.
 *
 * Which Stores an actor may touch is decided by `accessibleStorefrontIds` — the
 * same predicate the rest of Commerce uses since 0B-1. A Trader reaches its own
 * Commerce identity's Stores; a Delivery Company user reaches only Stores its
 * Company has an ACTIVE relationship with; everybody else reaches nothing. No
 * new authorization concept is introduced here, deliberately.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE DATABASE ENFORCES AND WHAT THIS SERVICE ENFORCES
 * ---------------------------------------------------------------------------
 *
 * "Subcategory belongs to Category" is a composite foreign key, so this service
 * does not re-check it — a mismatched pair fails at the write regardless of
 * what any caller believes. What the database CANNOT see is whether the rows
 * are still `is_active`, since a foreign key does not test a column value. That
 * check lives here, and it is why classification is validated against active
 * taxonomy before the write rather than trusted from the request.
 */
@Injectable()
export class MarketplaceMappingService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(OperationsHistoryWriter) private readonly auditWriter: OperationsHistoryWriter,
  ) {}

  /** The Store's current marketplace classification. */
  public async storeCategories(storefrontId: string) {
    this.assertRead();
    await this.authorisedStorefront(storefrontId);
    const rows = await sql<{
      isPrimary: boolean;
      marketplaceCategoryId: string;
      nameEn: string;
      slug: string;
    }>`
      select mapping.marketplace_category_id as "marketplaceCategoryId",
             mapping.is_primary as "isPrimary",
             category.name_en as "nameEn", category.slug
        from storefront_marketplace_categories mapping
        join marketplace_categories category on category.id = mapping.marketplace_category_id
       where mapping.storefront_id = ${storefrontId}::uuid
       order by mapping.is_primary desc, lower(category.name_en)
    `.execute(this.database);
    return { items: rows.rows };
  }

  /**
   * Replace the Store's classification.
   *
   * Sent whole rather than as add/remove deltas: the screen shows the complete
   * set and "exactly one primary" is a property of the SET, not of any single
   * row. Applying deltas would mean passing through states with zero or two
   * primaries, which the partial unique index would reject anyway.
   */
  public async setStoreCategories(
    storefrontId: string,
    input: { readonly categoryIds: readonly string[]; readonly primaryCategoryId: string | null },
    correlationId: string,
  ) {
    this.assertManage();
    const scope = await this.authorisedStorefront(storefrontId);
    const unique = [...new Set(input.categoryIds)];
    if (input.primaryCategoryId !== null && !unique.includes(input.primaryCategoryId)) {
      throw this.invalid(
        "marketplace_primary_not_selected",
        "The primary Category must be one of the selected Categories",
      );
    }
    await this.assertActiveCategories(unique);

    await this.transactions.execute(async (transaction) => {
      await sql`
        delete from storefront_marketplace_categories
         where storefront_id = ${storefrontId}::uuid
      `.execute(transaction);
      for (const categoryId of unique) {
        await sql`
          insert into storefront_marketplace_categories (
            storefront_id, marketplace_category_id, is_primary, created_by_account_id
          ) values (
            ${storefrontId}::uuid, ${categoryId}::uuid,
            ${categoryId === input.primaryCategoryId}, ${this.actorId()}::uuid
          )
        `.execute(transaction);
      }
      await this.auditWriter.audit(transaction as unknown as Kysely<DatabaseSchema>, {
        action: "storefront.marketplace_categories_changed",
        actorId: this.actorId(),
        after: {
          categoryCount: unique.length,
          primaryCategoryId: input.primaryCategoryId,
          storefrontId,
        },
        companyId: scope.companyId ?? this.tenants.current().companyId,
        correlationId,
        subjectId: storefrontId,
        subjectType: "trader_storefront",
      });
    });
    return this.storeCategories(storefrontId);
  }

  /**
   * Classify one Product.
   *
   * Passing a null Category clears the classification entirely — an
   * "unclassified for marketplace" Product is a legitimate state, not an error,
   * and every Product started there.
   *
   * The Product's Trader Store Category is never read or written here. The two
   * classifications are independent by design, and this service touching
   * `category_id` would be the exact confusion the separate tables exist to
   * prevent.
   */
  public async setProductClassification(
    productId: string,
    input: {
      readonly marketplaceCategoryId: string | null;
      readonly marketplaceSubcategoryId: string | null;
    },
    correlationId: string,
  ) {
    this.assertManage();
    const product = await sql<{ storefrontId: string }>`
      select storefront_id as "storefrontId" from trader_storefront_products
       where id = ${productId}::uuid
         and storefront_id in (${this.accessibleStorefronts()})
    `.execute(this.database);
    const row = product.rows[0];
    if (row === undefined) throw this.notFound("product_not_found", "Product not found");
    const scope = await this.authorisedStorefront(row.storefrontId);

    if (input.marketplaceCategoryId === null && input.marketplaceSubcategoryId !== null) {
      throw this.invalid(
        "marketplace_subcategory_without_category",
        "A Subcategory requires its Category",
      );
    }
    if (input.marketplaceCategoryId !== null) {
      await this.assertActiveCategories([input.marketplaceCategoryId]);
    }
    if (input.marketplaceSubcategoryId !== null) {
      // Active-state check only. That the Subcategory belongs to the named
      // Category is settled by the composite foreign key on the write below.
      const active = await sql<{ id: string }>`
        select id from marketplace_subcategories
         where id = ${input.marketplaceSubcategoryId}::uuid and is_active
      `.execute(this.database);
      if (active.rows[0] === undefined) {
        throw this.invalid(
          "marketplace_subcategory_unavailable",
          "That Subcategory is not available",
        );
      }
    }

    await this.transactions.execute(async (transaction) => {
      await sql`
        update trader_storefront_products
           set marketplace_category_id = ${input.marketplaceCategoryId}::uuid,
               marketplace_subcategory_id = ${input.marketplaceSubcategoryId}::uuid,
               updated_by_account_id = ${this.actorId()}::uuid,
               updated_at = now(), version = version + 1
         where id = ${productId}::uuid
      `.execute(transaction);
      await this.auditWriter.audit(transaction as unknown as Kysely<DatabaseSchema>, {
        action: "storefront_product.marketplace_classification_changed",
        actorId: this.actorId(),
        after: {
          marketplaceCategoryId: input.marketplaceCategoryId,
          marketplaceSubcategoryId: input.marketplaceSubcategoryId,
          productId,
        },
        companyId: scope.companyId ?? this.tenants.current().companyId,
        correlationId,
        subjectId: productId,
        subjectType: "trader_storefront_product",
      });
    });

    const updated = await sql<{
      marketplaceCategoryId: string | null;
      marketplaceSubcategoryId: string | null;
    }>`
      select marketplace_category_id as "marketplaceCategoryId",
             marketplace_subcategory_id as "marketplaceSubcategoryId"
        from trader_storefront_products where id = ${productId}::uuid
    `.execute(this.database);
    return updated.rows[0];
  }

  // ------------------------------------------------------------- internals

  private async assertActiveCategories(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await sql<{ total: string }>`
      select count(*)::text as total from marketplace_categories
       where id = any(${[...ids]}::uuid[]) and is_active
    `.execute(this.database);
    if (Number(found.rows[0]?.total ?? 0) !== ids.length) {
      throw this.invalid(
        "marketplace_category_unavailable",
        "One or more Categories are not available",
      );
    }
  }

  private async authorisedStorefront(storefrontId: string) {
    const found = await sql<{ companyId: string | null; id: string }>`
      select id, company_id as "companyId" from trader_storefronts
       where id = ${storefrontId}::uuid
         and id in (${this.accessibleStorefronts()})
    `.execute(this.database);
    const row = found.rows[0];
    if (row === undefined) throw this.notFound("storefront_not_found", "Storefront not found");
    return row;
  }

  private accessibleStorefronts() {
    return accessibleStorefrontIds({
      callerTraderId: this.callerTraderId(),
      companyId: this.tenants.current().companyId,
    });
  }

  private callerTraderId(): string | null {
    const identity = this.identities.current();
    if (identity.kind !== "trader") return null;
    return identity.profileId ?? identity.profileLinkId ?? null;
  }

  private actorId(): string {
    return this.tenants.current().identityId;
  }

  private assertRead(): void {
    if (this.callerTraderId() !== null) return;
    this.assertPermission("storefront.view", "storefront.manage", "storefront_products.view");
  }

  private assertManage(): void {
    if (this.callerTraderId() !== null) return;
    this.assertPermission("storefront.manage", "storefront_products.manage");
  }

  private assertPermission(...permissions: readonly string[]): void {
    const held = this.identities.current().permissions;
    if (permissions.some((permission) => held.has(permission))) return;
    if (held.has("users_roles.manage")) return;
    throw new ApplicationException(
      "storefront_permission_denied",
      "This account cannot perform that Storefront operation",
      HttpStatus.FORBIDDEN,
    );
  }

  private notFound(code: string, message: string): ApplicationException {
    return new ApplicationException(code, message, HttpStatus.NOT_FOUND);
  }

  private invalid(code: string, message: string): ApplicationException {
    return new ApplicationException(code, message, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}
