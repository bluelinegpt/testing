import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
// Runtime import is required for Nest constructor injection metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { IdentityContextAccessor } from "../security/identity-context.js";
import type { AddDemoRequestNoteDto, DemoRequestListQueryDto, DemoRequestStatusDto } from "../demo-requests/demo-request.dto.js";
// Runtime import is required for Nest constructor injection metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { DemoRequestService } from "../demo-requests/demo-request.service.js";
import { correlationIdOf } from "./platform-audit.service.js";
import { PLATFORM_LEADS_MANAGE, PLATFORM_LEADS_READ, RequirePlatformPermissions } from "./platform-authorization.js";

@Controller("platform/demo-requests")
export class PlatformDemoRequestController {
  public constructor(@Inject(DemoRequestService) private readonly leads:DemoRequestService,@Inject(IdentityContextAccessor) private readonly identities:IdentityContextAccessor){}
  private actor(request:Request){return {accountId:this.identities.current().identityId,correlationId:correlationIdOf(request),ip:request.ip,userAgent:request.headers["user-agent"]};}
  @RequirePlatformPermissions(PLATFORM_LEADS_READ) @Get() public list(@Query() query:DemoRequestListQueryDto):Promise<object>{return this.leads.list({...query,page:query.page??1,pageSize:query.pageSize??25,sort:query.sort??"newest"});}
  @RequirePlatformPermissions(PLATFORM_LEADS_READ) @Get(":id") public detail(@Param("id") id:string):Promise<object>{return this.leads.detail(id);}
  @RequirePlatformPermissions(PLATFORM_LEADS_MANAGE) @Patch(":id/status") public status(@Param("id") id:string,@Body() input:DemoRequestStatusDto,@Req() request:Request):Promise<object>{return this.leads.transition(id,input.status,{reason:input.reason,demoScheduledAt:input.demoScheduledAt,convertedCompanyId:input.convertedCompanyId},this.actor(request));}
  @RequirePlatformPermissions(PLATFORM_LEADS_MANAGE) @HttpCode(201) @Post(":id/notes") public note(@Param("id") id:string,@Body() input:AddDemoRequestNoteDto,@Req() request:Request):Promise<object>{return this.leads.addNote(id,input.text,this.actor(request));}
  @RequirePlatformPermissions(PLATFORM_LEADS_MANAGE) @Delete() public bulkDelete(@Body() input:{ids?:string[]},@Req() request:Request):Promise<object>{return this.leads.bulkDelete(input.ids??[],this.actor(request));}
}
