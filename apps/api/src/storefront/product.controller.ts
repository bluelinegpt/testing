import { randomUUID } from "node:crypto";

import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";

import { Public, RequireIdentityKinds } from "../authentication/authentication.decorators.js";

import {
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
import { StorefrontProductService } from "./product.service.js";

/**
 * Authenticated Product Catalogue management.
 *
 * Open to Company users and Trader accounts; which one is calling decides what
 * they can reach, and that is settled in the service against the session rather
 * than by a route decorator — a Trader manages its own catalogue while holding
 * none of the Company permissions.
 */
@ApiTags("trader-storefront-products")
@ApiBearerAuth()
@RequireIdentityKinds("company_user", "trader")
@Controller("operations/trader-storefront-products")
export class StorefrontProductController {
  public constructor(
    @Inject(StorefrontProductService) private readonly products: StorefrontProductService,
  ) {}

  // categories

  @ApiOperation({ summary: "List categories for a Storefront" })
  @Get("storefronts/:storefrontId/categories")
  public listCategories(@Param("storefrontId") storefrontId: string) {
    return this.products.listCategories(storefrontId);
  }

  @ApiOperation({ summary: "Create a category" })
  @Post("storefronts/:storefrontId/categories")
  public createCategory(
    @Param("storefrontId") storefrontId: string,
    @Body() body: CategoryWriteDto,
  ) {
    return this.products.createCategory(storefrontId, body, randomUUID());
  }

  @ApiOperation({ summary: "Update a category" })
  @Patch("categories/:categoryId")
  public updateCategory(
    @Param("categoryId") categoryId: string,
    @Body() body: UpdateCategoryDto,
  ) {
    return this.products.updateCategory(categoryId, body, randomUUID());
  }

  @ApiOperation({ summary: "Activate or deactivate a category" })
  @Post("categories/:categoryId/active")
  public setCategoryActive(
    @Param("categoryId") categoryId: string,
    @Body() body: CategoryStatusDto,
  ) {
    return this.products.setCategoryActive(categoryId, body, randomUUID());
  }

  @ApiOperation({ summary: "Reorder categories" })
  @Post("storefronts/:storefrontId/categories/reorder")
  public reorderCategories(
    @Param("storefrontId") storefrontId: string,
    @Body() body: ReorderDto,
  ) {
    return this.products.reorderCategories(storefrontId, body, randomUUID());
  }

  // products

  @ApiOperation({ summary: "List Products for Storefront management" })
  @Get()
  public list(@Query() query: ProductListQueryDto) {
    return this.products.listProducts(query);
  }

  @ApiOperation({ summary: "Show one Product with its media and options" })
  @Get(":productId")
  public detail(@Param("productId") productId: string) {
    return this.products.getProduct(productId);
  }

  @ApiOperation({ summary: "Create a Product" })
  @Post()
  public create(@Body() body: CreateProductDto) {
    return this.products.createProduct(body, randomUUID());
  }

  @ApiOperation({ summary: "Update a Product" })
  @Patch(":productId")
  public update(@Param("productId") productId: string, @Body() body: UpdateProductDto) {
    return this.products.updateProduct(productId, body, randomUUID());
  }

  @ApiOperation({ summary: "Activate a Product" })
  @Post(":productId/activate")
  public activate(@Param("productId") productId: string, @Body() body: ProductStatusDto) {
    return this.products.activate(productId, body, randomUUID());
  }

  @ApiOperation({ summary: "Deactivate a Product" })
  @Post(":productId/deactivate")
  public deactivate(@Param("productId") productId: string, @Body() body: ProductStatusDto) {
    return this.products.deactivate(productId, body, randomUUID());
  }

  @ApiOperation({ summary: "Archive a Product" })
  @Post(":productId/archive")
  public archive(@Param("productId") productId: string, @Body() body: ProductStatusDto) {
    return this.products.archive(productId, body, randomUUID());
  }

  @ApiOperation({ summary: "Set Product availability" })
  @Post(":productId/availability")
  public availability(
    @Param("productId") productId: string,
    @Body() body: ProductAvailabilityDto,
  ) {
    return this.products.setAvailability(productId, body, randomUUID());
  }

  @ApiOperation({ summary: "Reorder Products" })
  @Post("storefronts/:storefrontId/reorder")
  public reorder(@Param("storefrontId") storefrontId: string, @Body() body: ReorderDto) {
    return this.products.reorderProducts(storefrontId, body, randomUUID());
  }

  // media

  @ApiOperation({ summary: "Add a Product media reference" })
  @Post(":productId/media")
  public addMedia(@Param("productId") productId: string, @Body() body: ProductMediaDto) {
    return this.products.addMedia(productId, body, randomUUID());
  }

  @ApiOperation({ summary: "Update media alt text or order" })
  @Patch("media/:mediaId")
  public updateMedia(@Param("mediaId") mediaId: string, @Body() body: UpdateMediaDto) {
    return this.products.updateMedia(mediaId, body, randomUUID());
  }

  @ApiOperation({ summary: "Set the primary image" })
  @Post("media/:mediaId/primary")
  public setPrimary(@Param("mediaId") mediaId: string) {
    return this.products.setPrimaryImage(mediaId, randomUUID());
  }

  @ApiOperation({ summary: "Remove (deactivate) a media reference" })
  @Post("media/:mediaId/remove")
  public removeMedia(@Param("mediaId") mediaId: string) {
    return this.products.removeMedia(mediaId, randomUUID());
  }

  @ApiOperation({ summary: "Reorder Product media" })
  @Post(":productId/media/reorder")
  public reorderMedia(@Param("productId") productId: string, @Body() body: ReorderDto) {
    return this.products.reorderMedia(productId, body, randomUUID());
  }

  // options

  @ApiOperation({ summary: "Add an option group" })
  @Post(":productId/option-groups")
  public addOptionGroup(@Param("productId") productId: string, @Body() body: OptionGroupDto) {
    return this.products.addOptionGroup(productId, body, randomUUID());
  }

  @ApiOperation({ summary: "Add an option value" })
  @Post("option-groups/:groupId/values")
  public addOptionValue(@Param("groupId") groupId: string, @Body() body: OptionValueDto) {
    return this.products.addOptionValue(groupId, body, randomUUID());
  }

  @ApiOperation({ summary: "Rename an option group or mark it required" })
  @Patch("option-groups/:groupId")
  public updateOptionGroup(
    @Param("groupId") groupId: string,
    @Body() body: OptionGroupUpdateDto,
  ) {
    return this.products.updateOptionGroup(groupId, body, randomUUID());
  }

  @ApiOperation({ summary: "Reorder option groups" })
  @Post(":productId/option-groups/reorder")
  public reorderOptionGroups(
    @Param("productId") productId: string,
    @Body() body: ReorderDto,
  ) {
    return this.products.reorderOptionGroups(productId, body, randomUUID());
  }

  @ApiOperation({ summary: "Reorder option values" })
  @Post("option-groups/:groupId/values/reorder")
  public reorderOptionValues(@Param("groupId") groupId: string, @Body() body: ReorderDto) {
    return this.products.reorderOptionValues(groupId, body, randomUUID());
  }

  @ApiOperation({ summary: "Activate or deactivate an option group" })
  @Post("option-groups/:groupId/active")
  public setOptionActive(@Param("groupId") groupId: string, @Body() body: OptionActiveDto) {
    return this.products.setOptionGroupActive(groupId, body, randomUUID());
  }

  @ApiOperation({ summary: "Rename an option value" })
  @Patch("option-values/:valueId")
  public updateOptionValue(
    @Param("valueId") valueId: string,
    @Body() body: OptionValueUpdateDto,
  ) {
    return this.products.updateOptionValue(valueId, body, randomUUID());
  }

  @ApiOperation({ summary: "Remove (deactivate) an option value" })
  @Post("option-values/:valueId/remove")
  public removeOptionValue(@Param("valueId") valueId: string) {
    return this.products.removeOptionValue(valueId, randomUUID());
  }
}

/**
 * Public, read-only catalogue.
 *
 * Rate-limited more tightly than the authenticated surface because search is
 * reachable from the open internet, and every response is the allow-listed
 * public projection: no Company, Trader, Storefront or Product identifier, no
 * actor or audit metadata, no storage credentials.
 */
@ApiTags("public-storefront-products")
@Controller("public/storefronts/:slug")
export class PublicStorefrontProductController {
  public constructor(
    @Inject(StorefrontProductService) private readonly products: StorefrontProductService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: "List public categories for a Storefront" })
  @Get("categories")
  public categories(@Param("slug") slug: string) {
    return this.products.publicCategories(slug);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: "List public Products for a Storefront" })
  @Get("products")
  public list(@Param("slug") slug: string, @Query() query: PublicProductListQueryDto) {
    return this.products.publicProducts(slug, query);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: "Show one public Product by slug" })
  @Get("products/:productSlug")
  public detail(@Param("slug") slug: string, @Param("productSlug") productSlug: string) {
    return this.products.publicProduct(slug, productSlug);
  }
}
