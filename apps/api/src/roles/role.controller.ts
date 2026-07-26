import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import {
  RequireIdentityKinds,
  RequirePermissions,
} from "../authentication/authentication.decorators.js";
// Runtime values are required by Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CreateRoleDto, DuplicateRoleDto, RoleListQueryDto, UpdateRoleDto } from "./role.dto.js";
import { RoleService } from "./role.service.js";

@ApiTags("roles")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequirePermissions("users_roles.manage")
@Controller("roles")
export class RoleController {
  public constructor(@Inject(RoleService) private readonly roles: RoleService) {}
  @Get() @ApiOperation({ summary: "Search and paginate Company Roles" }) public list(
    @Query() query: RoleListQueryDto,
  ) {
    return this.roles.list(query);
  }
  @Get("permissions") public permissions() {
    return this.roles.listPermissions();
  }
  @Post() @HttpCode(201) public create(@Body() input: CreateRoleDto, @Req() request: Request) {
    return this.roles.create({ ...input, correlationId: this.correlationId(request) });
  }
  @Get(":roleId") public details(@Param("roleId", new ParseUUIDPipe()) roleId: string) {
    return this.roles.details(roleId);
  }
  @Patch(":roleId") public update(
    @Param("roleId", new ParseUUIDPipe()) roleId: string,
    @Body() input: UpdateRoleDto,
    @Req() request: Request,
  ) {
    return this.roles.update(roleId, { ...input, correlationId: this.correlationId(request) });
  }
  @Post(":roleId/duplicate") @HttpCode(201) public duplicate(
    @Param("roleId", new ParseUUIDPipe()) roleId: string,
    @Body() input: DuplicateRoleDto,
    @Req() request: Request,
  ) {
    return this.roles.duplicate(roleId, input.name, this.correlationId(request));
  }
  private correlationId(request: Request) {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}
