import { randomUUID } from "node:crypto";

import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Public, RequireIdentityKinds } from "../authentication/authentication.decorators.js";

import { StorefrontDeliveryService } from "./storefront-delivery.service.js";
import {
  CreateStorefrontDto,
  DeliveryRelationshipUpdateDto,
  SlugAvailabilityQueryDto,
  StorefrontListQueryDto,
  StorefrontStatusActionDto,
  SuspendStorefrontDto,
  UpdateStorefrontDto,
} from "./storefront.dto.js";
import { StorefrontService } from "./storefront.service.js";

/**
 * Authenticated Storefront configuration.
 *
 * Open to Company users and to Trader accounts; which of the two is calling
 * decides what they can reach, and that decision is made in the service
 * against the session — never against a value in the request. Permissions are
 * asserted there rather than by a route decorator because a Trader legitimately
 * manages its own Storefront while holding none of the Company permissions.
 */
@ApiTags("trader-storefronts")
@ApiBearerAuth()
@RequireIdentityKinds("company_user", "trader")
@Controller("operations/trader-storefronts")
export class StorefrontController {
  public constructor(
    @Inject(StorefrontService) private readonly storefronts: StorefrontService,
    @Inject(StorefrontDeliveryService) private readonly delivery: StorefrontDeliveryService,
  ) {}

  @ApiOperation({ summary: "List Storefronts visible to the caller" })
  @Get()
  public list(@Query() query: StorefrontListQueryDto) {
    return this.storefronts.list(query);
  }

  @ApiOperation({ summary: "Show the authenticated Trader's own Storefront" })
  @Get("mine")
  public mine() {
    return this.storefronts.mine();
  }

  @ApiOperation({ summary: "Check whether a Storefront URL can be claimed" })
  @Get("slug-availability")
  public slugAvailability(@Query() query: SlugAvailabilityQueryDto) {
    return this.storefronts.slugAvailability(query);
  }

  @ApiOperation({ summary: "Show one Storefront configuration" })
  @Get(":storefrontId")
  public detail(@Param("storefrontId") storefrontId: string) {
    return this.storefronts.detail(storefrontId);
  }

  @ApiOperation({ summary: "List the Store's Delivery Company relationships" })
  @Get(":storefrontId/delivery-companies")
  public deliveryCompanies(@Param("storefrontId") storefrontId: string) {
    return this.delivery.list(storefrontId);
  }

  @ApiOperation({ summary: "Enable, disable or set the default Delivery Company for Store orders" })
  @Patch(":storefrontId/delivery-companies/:relationshipId")
  public updateDeliveryCompany(
    @Param("storefrontId") storefrontId: string,
    @Param("relationshipId") relationshipId: string,
    @Body() body: DeliveryRelationshipUpdateDto,
  ) {
    return this.delivery.update(storefrontId, relationshipId, body, randomUUID());
  }

  @ApiOperation({ summary: "Show the Storefront's audit history" })
  @Get(":storefrontId/history")
  public history(@Param("storefrontId") storefrontId: string) {
    return this.storefronts.history(storefrontId);
  }

  @ApiOperation({ summary: "Create a Storefront for a Trader" })
  @Post()
  public create(@Body() body: CreateStorefrontDto) {
    return this.storefronts.create(body, randomUUID());
  }

  @ApiOperation({ summary: "Update the Storefront profile" })
  @Patch(":storefrontId")
  public update(@Param("storefrontId") storefrontId: string, @Body() body: UpdateStorefrontDto) {
    return this.storefronts.update(storefrontId, body, randomUUID());
  }

  @ApiOperation({ summary: "Publish the Storefront" })
  @Post(":storefrontId/publish")
  public publish(
    @Param("storefrontId") storefrontId: string,
    @Body() body: StorefrontStatusActionDto,
  ) {
    return this.storefronts.publish(storefrontId, body, randomUUID());
  }

  @ApiOperation({ summary: "Temporarily close the Storefront" })
  @Post(":storefrontId/temporarily-close")
  public temporarilyClose(
    @Param("storefrontId") storefrontId: string,
    @Body() body: StorefrontStatusActionDto,
  ) {
    return this.storefronts.temporarilyClose(storefrontId, body, randomUUID());
  }

  @ApiOperation({ summary: "Reopen a temporarily closed Storefront" })
  @Post(":storefrontId/reopen")
  public reopen(
    @Param("storefrontId") storefrontId: string,
    @Body() body: StorefrontStatusActionDto,
  ) {
    return this.storefronts.reopen(storefrontId, body, randomUUID());
  }

  @ApiOperation({ summary: "Unpublish the Storefront" })
  @Post(":storefrontId/unpublish")
  public unpublish(
    @Param("storefrontId") storefrontId: string,
    @Body() body: StorefrontStatusActionDto,
  ) {
    return this.storefronts.unpublish(storefrontId, body, randomUUID());
  }

  @ApiOperation({ summary: "Suspend the Storefront (Delivery Company only)" })
  @Post(":storefrontId/suspend")
  public suspend(
    @Param("storefrontId") storefrontId: string,
    @Body() body: SuspendStorefrontDto,
  ) {
    return this.storefronts.suspend(storefrontId, body, randomUUID());
  }

  @ApiOperation({ summary: "Remove a suspension (Delivery Company only)" })
  @Post(":storefrontId/remove-suspension")
  public removeSuspension(
    @Param("storefrontId") storefrontId: string,
    @Body() body: StorefrontStatusActionDto,
  ) {
    return this.storefronts.removeSuspension(storefrontId, body, randomUUID());
  }
}

/**
 * Public Storefront resolution.
 *
 * The only unauthenticated Storefront surface. It returns the allow-listed
 * public projection for a published or temporarily closed shop and the same
 * generic not-found for everything else, so a caller cannot enumerate which
 * slugs exist in a draft or suspended state.
 */
@ApiTags("public-storefronts")
@Controller("public/storefronts")
export class PublicStorefrontController {
  public constructor(@Inject(StorefrontService) private readonly storefronts: StorefrontService) {}

  @Public()
  @ApiOperation({ summary: "List published Storefronts for the marketplace" })
  @Get()
  public list() {
    return this.storefronts.listPublic();
  }

  @Public()
  @ApiOperation({ summary: "Resolve a public Storefront by slug" })
  @Get(":slug")
  public resolve(@Param("slug") slug: string) {
    return this.storefronts.resolvePublic(slug);
  }
}
