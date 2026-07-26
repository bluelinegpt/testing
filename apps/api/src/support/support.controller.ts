import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import {
  RequireIdentityKinds,
  RequirePermissions,
} from "../authentication/authentication.decorators.js";
import { CreateSupportCaseDto, UpdateSupportCaseDto } from "./support.dto.js";
import { type SupportCaseView, SupportService } from "./support.service.js";

@ApiTags("support")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequirePermissions("users_roles.manage")
@Controller("support/cases")
export class SupportController {
  public constructor(@Inject(SupportService) private readonly support: SupportService) {}

  @ApiOperation({ summary: "List support cases for the authenticated Company" })
  @Get()
  public list(): Promise<readonly SupportCaseView[]> {
    return this.support.list();
  }

  @ApiOperation({ summary: "Create a support case for the authenticated Company" })
  @ApiBody({ type: CreateSupportCaseDto })
  @Post()
  public create(
    @Body() input: CreateSupportCaseDto,
    @Req() request: Request,
  ): Promise<SupportCaseView> {
    return this.support.create(input, this.correlationId(request));
  }

  @ApiOperation({ summary: "Update support case status" })
  @ApiBody({ type: UpdateSupportCaseDto })
  @Patch(":caseId")
  public update(
    @Param("caseId", new ParseUUIDPipe()) caseId: string,
    @Body() input: UpdateSupportCaseDto,
    @Req() request: Request,
  ): Promise<SupportCaseView> {
    return this.support.update(caseId, input, this.correlationId(request));
  }

  private correlationId(request: Request): string {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}
