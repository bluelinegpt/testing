import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Throttle } from "@nestjs/throttler";
import { BlogImportService, IMPORT_MAX_BYTES, type ArticleImportFile } from "../blog/blog-import.service.js";
import { BlogImportDto } from "../blog/blog-import.dto.js";
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
    @Inject(BlogImportService) private readonly importer: BlogImportService,
  ) {}
  private actor() {
    return this.identity.current().identityId;
  }
  @RequirePlatformPermissions(CREATE)
  @Post("import") @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: IMPORT_MAX_BYTES, files: 1, fields: 1 } }))
  importArticle(@UploadedFile() file: ArticleImportFile | undefined, @Body() body: BlogImportDto) {
    return this.importer.propose(file, body.googleDocUrl);
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
  @RequirePlatformPermissions(PUBLISH) @Delete(":id") @HttpCode(204)
  deleteArticle(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.blog.deleteArticle(id, this.actor());
  }
  @RequirePlatformPermissions(CATEGORIES) @Post("categories") createCategory(
    @Body() body: CategoryDto,
  ) {
    return this.blog.createCategory(body);
  }
}
