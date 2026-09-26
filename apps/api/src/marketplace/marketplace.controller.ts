import { randomUUID } from "node:crypto";

import { Body, Controller, Get, Inject, Param, Patch, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsArray, IsInt, IsOptional, IsUUID, Min } from "class-validator";

import { Public, RequireIdentityKinds } from "../authentication/authentication.decorators.js";

import { MarketplaceMappingService } from "./marketplace-mapping.service.js";
import { MarketplaceTaxonomyService } from "./marketplace-taxonomy.service.js";

export class StoreCategoriesDto {
  @IsArray()
  @IsUUID("4", { each: true })
  public categoryIds!: string[];

  @IsOptional()
  @IsUUID()
  public primaryCategoryId?: string | null;
}

export class ProductClassificationDto {
  @IsOptional()
  @IsUUID()
  public marketplaceCategoryId?: string | null;

  @IsOptional()
  @IsUUID()
  public marketplaceSubcategoryId?: string | null;
}

export class CategoryProductQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public pageSize?: number;
}

/**
 * Public marketplace taxonomy.
 *
 * Anonymous and allow-listed. Categories and Subcategories are addressed by
 * SLUG, and the responses carry no database identifier — a customer browsing
 * `/categories/fashion` has no reason to learn a UUID, and not returning one
 * means the Store frontend cannot accidentally start depending on it.
 *
 * Inactive taxonomy is absent rather than forbidden, and a Subcategory under an
 * inactive parent is absent too, so deactivating a Category genuinely removes
 * that branch from the marketplace.
 */
@ApiTags("public-marketplace")
@Controller("public/marketplace")
export class PublicMarketplaceController {
  public constructor(
    @Inject(MarketplaceTaxonomyService) private readonly taxonomy: MarketplaceTaxonomyService,
  ) {}

  @Public()
  @ApiOperation({ summary: "List active marketplace Categories" })
  @Get("categories")
  public categories() {
    return this.taxonomy.publicCategories();
  }

  @Public()
  @ApiOperation({ summary: "Resolve one active Category with its Subcategories" })
  @Get("categories/:categorySlug")
  public category(@Param("categorySlug") categorySlug: string) {
    return this.taxonomy.publicCategory(categorySlug);
  }

  @Public()
  @ApiOperation({ summary: "Resolve one active Subcategory" })
  @Get("categories/:categorySlug/subcategories/:subcategorySlug")
  public subcategory(
    @Param("categorySlug") categorySlug: string,
    @Param("subcategorySlug") subcategorySlug: string,
  ) {
    return this.taxonomy.publicSubcategory(categorySlug, subcategorySlug);
  }

  @Public()
  @ApiOperation({ summary: "Published Stores classified under a Category" })
  @Get("categories/:categorySlug/stores")
  public stores(@Param("categorySlug") categorySlug: string) {
    return this.taxonomy.publicStoresInCategory(categorySlug);
  }

  @Public()
  @ApiOperation({ summary: "Published Products in a Category (paged)" })
  @Get("categories/:categorySlug/products")
  public products(
    @Param("categorySlug") categorySlug: string,
    @Query() query: CategoryProductQueryDto,
  ) {
    return this.taxonomy.publicProductsInCategory({
      categorySlug,
      ...(query.page === undefined ? {} : { page: query.page }),
      ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
    });
  }

  @Public()
  @ApiOperation({ summary: "Published Products in one Subcategory (paged)" })
  @Get("categories/:categorySlug/subcategories/:subcategorySlug/products")
  public subcategoryProducts(
    @Param("categorySlug") categorySlug: string,
    @Param("subcategorySlug") subcategorySlug: string,
    @Query() query: CategoryProductQueryDto,
  ) {
    return this.taxonomy.publicProductsInCategory({
      categorySlug,
      subcategorySlug,
      ...(query.page === undefined ? {} : { page: query.page }),
      ...(query.pageSize === undefined ? {} : { pageSize: query.pageSize }),
    });
  }
}

/**
 * Authenticated marketplace classification.
 *
 * Read the taxonomy, assign it. There is no create, rename or deactivate route
 * on this controller and none anywhere in the Delivery Portal — Platform
 * taxonomy administration is Platform-owned, and putting a form for it beside
 * the Trader screens because those screens already exist is how ownership
 * boundaries quietly dissolve.
 */
@ApiTags("marketplace-classification")
@ApiBearerAuth()
@RequireIdentityKinds("company_user", "trader")
@Controller("operations/marketplace")
export class MarketplaceClassificationController {
  public constructor(
    @Inject(MarketplaceTaxonomyService) private readonly taxonomy: MarketplaceTaxonomyService,
    @Inject(MarketplaceMappingService) private readonly mapping: MarketplaceMappingService,
  ) {}

  @ApiOperation({ summary: "Active taxonomy available for classification" })
  @Get("taxonomy")
  public taxonomyTree() {
    return this.taxonomy.managementTaxonomy();
  }

  @ApiOperation({ summary: "Show a Store's marketplace Categories" })
  @Get("storefronts/:storefrontId/categories")
  public storeCategories(@Param("storefrontId") storefrontId: string) {
    return this.mapping.storeCategories(storefrontId);
  }

  @ApiOperation({ summary: "Replace a Store's marketplace Categories" })
  @Put("storefronts/:storefrontId/categories")
  public setStoreCategories(
    @Param("storefrontId") storefrontId: string,
    @Body() body: StoreCategoriesDto,
  ) {
    return this.mapping.setStoreCategories(
      storefrontId,
      { categoryIds: body.categoryIds, primaryCategoryId: body.primaryCategoryId ?? null },
      randomUUID(),
    );
  }

  @ApiOperation({ summary: "Set a Product's marketplace classification" })
  @Patch("products/:productId/classification")
  public setProductClassification(
    @Param("productId") productId: string,
    @Body() body: ProductClassificationDto,
  ) {
    return this.mapping.setProductClassification(
      productId,
      {
        marketplaceCategoryId: body.marketplaceCategoryId ?? null,
        marketplaceSubcategoryId: body.marketplaceSubcategoryId ?? null,
      },
      randomUUID(),
    );
  }
}
