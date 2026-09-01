import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { IdentityContextAccessor } from "../security/identity-context.js";
import { correlationIdOf } from "./platform-audit.service.js";
import {
  PLATFORM_COMPANY_WHATSAPP_MANAGE,
  RequirePlatformPermissions,
} from "./platform-authorization.js";
// Runtime DTO imports are required so Nest can emit validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ListCompanyWhatsAppMessagesQueryDto,
  SetCompanyWhatsAppEnabledDto,
  UpdateCompanyWhatsAppTemplateDto,
} from "./platform-company-whatsapp.dto.js";
import { PlatformCompanyWhatsAppService } from "./platform-company-whatsapp.service.js";
import { PlatformTargetCompanyGuard } from "./platform-target-company.guard.js";

/** Platform Administration → Company → WhatsApp: the per-Company enable /
 *  disable switch, message-template overrides and the message history. */
@ApiTags("platform company whatsapp")
@ApiBearerAuth()
@Controller("platform/companies/:companyId/whatsapp")
@UseGuards(PlatformTargetCompanyGuard)
export class PlatformCompanyWhatsAppController {
  public constructor(
    @Inject(PlatformCompanyWhatsAppService)
    private readonly whatsapp: PlatformCompanyWhatsAppService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  private actor(request: Request) {
    return {
      accountId: this.identities.current().identityId,
      correlationId: correlationIdOf(request),
    };
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WHATSAPP_MANAGE)
  @Get()
  public overview(@Param("companyId") companyId: string) {
    return this.whatsapp.overview(companyId);
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WHATSAPP_MANAGE)
  @Put("enabled")
  public setEnabled(
    @Param("companyId") companyId: string,
    @Body() input: SetCompanyWhatsAppEnabledDto,
    @Req() request: Request,
  ) {
    return this.whatsapp.setEnabled(companyId, input, this.actor(request));
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WHATSAPP_MANAGE)
  @Put("templates/:status")
  public updateTemplate(
    @Param("companyId") companyId: string,
    @Param("status") status: string,
    @Body() input: UpdateCompanyWhatsAppTemplateDto,
    @Req() request: Request,
  ) {
    return this.whatsapp.updateTemplate(companyId, status, input, this.actor(request));
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WHATSAPP_MANAGE)
  @Delete("templates/:status")
  @HttpCode(200)
  public resetTemplate(
    @Param("companyId") companyId: string,
    @Param("status") status: string,
    @Req() request: Request,
  ) {
    return this.whatsapp.resetTemplate(companyId, status, this.actor(request));
  }

  @RequirePlatformPermissions(PLATFORM_COMPANY_WHATSAPP_MANAGE)
  @Get("messages")
  public listMessages(
    @Param("companyId") companyId: string,
    @Query() query: ListCompanyWhatsAppMessagesQueryDto,
  ) {
    return this.whatsapp.listMessages(companyId, query);
  }
}
