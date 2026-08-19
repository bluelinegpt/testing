import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from "@nestjs/common";
import {
  ArticleStatusDto,
  CategoryDto,
  PublicSiteSettingsDto,
  SaveBlogArticleDto,
} from "../blog/blog.dto.js";
import { BlogService } from "../blog/blog.service.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { RequirePlatformPermissions } from "./platform-authorization.js";
const READ = "platform.blog.read",
  CREATE = "platform.blog.create",
  EDIT = "platform.blog.edit",
  PUBLISH = "platform.blog.publish",
  CATEGORIES = "platform.blog.categories.manage",
  SETTINGS = "platform.public_site_settings.manage";
@Controller("platform/blog")
export class PlatformBlogController {
  constructor(
    @Inject(BlogService) private readonly blog: BlogService,
    @Inject(IdentityContextAccessor) private readonly identity: IdentityContextAccessor,
  ) {}
  private actor() {
    return this.identity.current().identityId;
  }
  @RequirePlatformPermissions(READ) @Get() list() {
    return this.blog.adminList();
  }
  @RequirePlatformPermissions(READ) @Get("references") references() {
    return this.blog.references();
  }
  @RequirePlatformPermissions(SETTINGS) @Get("settings") settings() {
    return this.blog.adminSettings();
  }
  @RequirePlatformPermissions(SETTINGS) @Patch("settings") updateSettings(
    @Body() body: PublicSiteSettingsDto,
  ) {
    return this.blog.updateSettings(body, this.actor());
  }
  @RequirePlatformPermissions(READ) @Get(":id") detail(@Param("id") id: string) {
    return this.blog.adminDetail(id);
  }
  @RequirePlatformPermissions(READ) @Get(":id/preview") preview(@Param("id") id: string) {
    return this.blog.adminPreview(id);
  }
  @RequirePlatformPermissions(CREATE) @HttpCode(201) @Post() create(
    @Body() body: SaveBlogArticleDto,
  ) {
    return this.blog.create(body, this.actor());
  }
  @RequirePlatformPermissions(EDIT) @Patch(":id") update(
    @Param("id") id: string,
    @Body() body: SaveBlogArticleDto,
  ) {
    return this.blog.update(id, body, this.actor());
  }
  @RequirePlatformPermissions(PUBLISH) @Patch(":id/status") status(
    @Param("id") id: string,
    @Body() body: ArticleStatusDto,
  ) {
    return this.blog.status(id, body, this.actor());
  }
  @RequirePlatformPermissions(CATEGORIES) @Post("categories") createCategory(
    @Body() body: CategoryDto,
  ) {
    return this.blog.createCategory(body);
  }
}
