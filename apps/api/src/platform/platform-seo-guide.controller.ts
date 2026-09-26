import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Res, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
// DTO classes must remain runtime imports so Nest validation receives their decorator metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { SaveSeoGuideDto, SeoGuideStatusDto } from "../seo-guides/seo-guide.dto.js";
import { SeoGuideService } from "../seo-guides/seo-guide.service.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { RequirePlatformPermissions } from "./platform-authorization.js";

const READ = "platform.website.read", MANAGE = "platform.website.manage", PUBLISH = "platform.website.publish";
@Controller("platform/seo-guides")
export class PlatformSeoGuideController {
  constructor(@Inject(SeoGuideService) private readonly guides: SeoGuideService, @Inject(IdentityContextAccessor) private readonly identity: IdentityContextAccessor) {}
  private actor() { return this.identity.current().identityId; }
  @RequirePlatformPermissions(READ) @Get() list() { return this.guides.adminList(); }
  @RequirePlatformPermissions(READ) @Get(":id") detail(@Param("id", new ParseUUIDPipe()) id:string) { return this.guides.adminDetail(id); }
  @RequirePlatformPermissions(READ) @Get(":id/preview") preview(@Param("id", new ParseUUIDPipe()) id:string) { return this.guides.preview(id); }
  @RequirePlatformPermissions(READ) @Get(":id/seo-readiness") readiness(@Param("id", new ParseUUIDPipe()) id:string) { return this.guides.readiness(id); }
  @RequirePlatformPermissions(MANAGE) @Post() @HttpCode(201) create(@Body() body:SaveSeoGuideDto) { return this.guides.create(body,this.actor()); }
  @RequirePlatformPermissions(MANAGE) @Patch(":id") update(@Param("id", new ParseUUIDPipe()) id:string,@Body() body:SaveSeoGuideDto) { return this.guides.update(id,body,this.actor()); }
  @RequirePlatformPermissions(PUBLISH) @Patch(":id/status") status(@Param("id", new ParseUUIDPipe()) id:string,@Body() body:SeoGuideStatusDto) { return this.guides.setStatus(id,body,this.actor()); }
  @RequirePlatformPermissions(PUBLISH) @Delete(":id") archive(@Param("id", new ParseUUIDPipe()) id:string) { return this.guides.archive(id,this.actor()); }
  @RequirePlatformPermissions(MANAGE) @Post(":id/sources")
  @UseInterceptors(FileInterceptor("file",{limits:{fileSize:15*1024*1024,files:1}}))
  upload(@Param("id",new ParseUUIDPipe())id:string,@UploadedFile()file:{originalname:string;mimetype:string;size:number;buffer:Buffer}|undefined) { if(!file)throw new BadRequestException("seo_source_file_required");return this.guides.uploadSource(id,file,this.actor()); }
  @RequirePlatformPermissions(READ) @Get(":id/sources/:sourceId/download")
  async download(@Param("id",new ParseUUIDPipe())id:string,@Param("sourceId",new ParseUUIDPipe())sourceId:string,@Res()response:Response) { const source=await this.guides.sourceDownload(id,sourceId);response.setHeader("Content-Type",source.contentType);response.setHeader("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(source.filename)}`);response.status(200).send(Buffer.from(source.bytes)); }
}
