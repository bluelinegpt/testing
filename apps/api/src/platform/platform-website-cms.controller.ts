import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes } from "@nestjs/swagger";

import { IdentityContextAccessor } from "../security/identity-context.js";
import {
  MediaAltDto,
  NavigationItemDto,
  PricingPlanDto,
  PublishDto,
  WebsiteContactSettingsDto,
  WebsiteFaqDto,
  WebsiteFeatureDto,
  WebsitePageContentDto,
} from "../website-cms/website-cms.dto.js";
import { WebsiteCmsService } from "../website-cms/website-cms.service.js";
import {
  PLATFORM_WEBSITE_MANAGE,
  PLATFORM_WEBSITE_MEDIA_MANAGE,
  PLATFORM_WEBSITE_PUBLISH,
  PLATFORM_WEBSITE_READ,
  RequirePlatformPermissions,
} from "./platform-authorization.js";

type MulterFile = { readonly buffer: Buffer; readonly mimetype: string; readonly originalname: string; readonly size: number };

@Controller("platform/website")
export class PlatformWebsiteCmsController {
  public constructor(
    @Inject(WebsiteCmsService) private readonly cms: WebsiteCmsService,
    @Inject(IdentityContextAccessor) private readonly identity: IdentityContextAccessor,
  ) {}

  private actor() {
    return this.identity.current().identityId;
  }

  @RequirePlatformPermissions(PLATFORM_WEBSITE_READ)
  @Get()
  public bundle() {
    return this.cms.adminBundle();
  }

  @RequirePlatformPermissions(PLATFORM_WEBSITE_MANAGE)
  @Patch("pages/:pageKey/:locale/draft")
  public savePage(@Param("pageKey") pageKey: string, @Param("locale") locale: string, @Body() body: WebsitePageContentDto) {
    return this.cms.savePageDraft({ ...body, pageKey, locale }, this.actor());
  }

  @RequirePlatformPermissions(PLATFORM_WEBSITE_PUBLISH)
  @Post("pages/:pageKey/:locale/publish")
  public publishPage(@Param("pageKey") pageKey: string, @Param("locale") locale: string, @Body() _body: PublishDto) {
    return this.cms.publishPage(pageKey, locale, this.actor());
  }

  @RequirePlatformPermissions(PLATFORM_WEBSITE_MANAGE)
  @Patch("pricing/:planKey/:locale/draft")
  public savePricing(@Param("planKey") planKey: string, @Param("locale") locale: string, @Body() body: PricingPlanDto) {
    return this.cms.savePricingDraft({ ...body, planKey, locale }, this.actor());
  }

  @RequirePlatformPermissions(PLATFORM_WEBSITE_PUBLISH)
  @Post("pricing/:planKey/:locale/publish")
  public publishPricing(@Param("planKey") planKey: string, @Param("locale") locale: string, @Body() _body: PublishDto) {
    return this.cms.publishPricing(planKey, locale, this.actor());
  }

  @RequirePlatformPermissions(PLATFORM_WEBSITE_MANAGE)
  @Patch("features/:slug/:locale")
  public saveFeature(@Param("slug") slug: string, @Param("locale") locale: string, @Body() body: WebsiteFeatureDto) {
    return this.cms.saveFeature({ ...body, slug, locale }, this.actor());
  }

  @RequirePlatformPermissions(PLATFORM_WEBSITE_PUBLISH)
  @Post("features/:slug/:locale/publish")
  public publishFeature(@Param("slug") slug: string, @Param("locale") locale: string, @Body() _body: PublishDto) {
    return this.cms.publishFeature(slug, locale, this.actor());
  }

  @RequirePlatformPermissions(PLATFORM_WEBSITE_MANAGE)
  @Patch("faqs/:faqKey/:locale")
  public saveFaq(@Param("faqKey") faqKey: string, @Param("locale") locale: string, @Body() body: WebsiteFaqDto) {
    return this.cms.saveFaq({ ...body, faqKey, locale }, this.actor());
  }

  @RequirePlatformPermissions(PLATFORM_WEBSITE_PUBLISH)
  @Post("faqs/:faqKey/:locale/publish")
  public publishFaq(@Param("faqKey") faqKey: string, @Param("locale") locale: string, @Body() _body: PublishDto) {
    return this.cms.publishFaq(faqKey, locale, this.actor());
  }

  @RequirePlatformPermissions(PLATFORM_WEBSITE_MANAGE)
  @Patch("contact/draft")
  public saveContact(@Body() body: WebsiteContactSettingsDto) {
    return this.cms.saveContactDraft(body, this.actor());
  }

  @RequirePlatformPermissions(PLATFORM_WEBSITE_PUBLISH)
  @Post("contact/publish")
  public publishContact(@Body() _body: PublishDto) {
    return this.cms.publishContact(this.actor());
  }

  @RequirePlatformPermissions(PLATFORM_WEBSITE_MANAGE)
  @Patch("navigation/:itemKey/:locale")
  public saveNavigation(@Param("itemKey") itemKey: string, @Param("locale") locale: string, @Body() body: NavigationItemDto) {
    return this.cms.saveNavigation({ ...body, itemKey, locale }, this.actor());
  }

  @RequirePlatformPermissions(PLATFORM_WEBSITE_MEDIA_MANAGE)
  @HttpCode(201)
  @Post("media")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  public uploadMedia(@UploadedFile() file: MulterFile | undefined, @Body() body: MediaAltDto) {
    return this.cms.uploadMedia(file, body, this.actor());
  }
}
