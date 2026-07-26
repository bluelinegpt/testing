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
  Put,
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
import {
  AssignUserRolesDto,
  AuditListQueryDto,
  CreateUserDto,
  EditUserDto,
  ForcePasswordChangeDto,
  ReasonDto,
  SessionActionDto,
  UserIdentifierAvailabilityQueryDto,
  UserListQueryDto,
} from "./user-administration.dto.js";
import { UserAdministrationService } from "./user-administration.service.js";

@ApiTags("users")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequirePermissions("users_roles.manage")
@Controller("users")
export class UserAdministrationController {
  public constructor(
    @Inject(UserAdministrationService) private readonly users: UserAdministrationService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Search and paginate Company users" })
  public list(@Query() query: UserListQueryDto) {
    return this.users.list(query);
  }

  @Get("employees/available")
  public employees(@Query("search") search?: string) {
    return this.users.availableEmployees(search);
  }

  @Get("identifier-availability")
  public identifierAvailability(@Query() query: UserIdentifierAvailabilityQueryDto) {
    return this.users.identifierAvailability(query);
  }

  @Post()
  @HttpCode(201)
  public create(@Body() input: CreateUserDto, @Req() request: Request) {
    return this.users.create({ ...input, correlationId: this.correlationId(request) });
  }

  @Get(":accountId")
  public details(@Param("accountId", new ParseUUIDPipe()) accountId: string) {
    return this.users.details(accountId);
  }

  @Patch(":accountId")
  @HttpCode(204)
  public async edit(
    @Param("accountId", new ParseUUIDPipe()) accountId: string,
    @Body() input: EditUserDto,
    @Req() request: Request,
  ) {
    await this.users.edit(accountId, input, this.correlationId(request));
  }

  @Put(":accountId/roles")
  @HttpCode(204)
  public async assignRoles(
    @Param("accountId", new ParseUUIDPipe()) accountId: string,
    @Body() input: AssignUserRolesDto,
    @Req() request: Request,
  ) {
    await this.users.assignRoles(accountId, input.roleIds, this.correlationId(request));
  }

  @Post(":accountId/disable")
  @HttpCode(204)
  public async disable(
    @Param("accountId", new ParseUUIDPipe()) accountId: string,
    @Body() input: ReasonDto,
    @Req() request: Request,
  ) {
    await this.users.deactivate(accountId, input.reason, this.correlationId(request));
  }

  // Compatibility with the original Administration endpoint.
  @Post(":accountId/deactivate")
  @HttpCode(204)
  public async deactivate(
    @Param("accountId", new ParseUUIDPipe()) accountId: string,
    @Body() input: ReasonDto,
    @Req() request: Request,
  ) {
    await this.users.deactivate(accountId, input.reason, this.correlationId(request));
  }

  @Post(":accountId/reactivate")
  @HttpCode(204)
  public async reactivate(
    @Param("accountId", new ParseUUIDPipe()) accountId: string,
    @Req() request: Request,
  ) {
    await this.users.reactivate(accountId, this.correlationId(request));
  }

  @Post(":accountId/lock")
  @HttpCode(204)
  public async lock(
    @Param("accountId", new ParseUUIDPipe()) accountId: string,
    @Body() input: ReasonDto,
    @Req() request: Request,
  ) {
    await this.users.lock(accountId, input.reason, this.correlationId(request));
  }

  @Post(":accountId/unlock")
  @HttpCode(204)
  public async unlock(
    @Param("accountId", new ParseUUIDPipe()) accountId: string,
    @Req() request: Request,
  ) {
    await this.users.unlock(accountId, this.correlationId(request));
  }

  @Post(":accountId/reset-password")
  public resetPassword(
    @Param("accountId", new ParseUUIDPipe()) accountId: string,
    @Body() input: ReasonDto,
    @Req() request: Request,
  ) {
    return this.users.resetPassword(accountId, input.reason, this.correlationId(request));
  }

  @Post(":accountId/force-password-change")
  @HttpCode(204)
  public async forcePasswordChange(
    @Param("accountId", new ParseUUIDPipe()) accountId: string,
    @Body() input: ForcePasswordChangeDto,
    @Req() request: Request,
  ) {
    await this.users.setForcePasswordChange(
      accountId,
      input.required,
      input.reason,
      this.correlationId(request),
    );
  }

  @Get(":accountId/sessions")
  public sessions(@Param("accountId", new ParseUUIDPipe()) accountId: string) {
    return this.users.sessions(accountId);
  }

  @Post(":accountId/sessions/revoke-all")
  @HttpCode(204)
  public async revokeAll(
    @Param("accountId", new ParseUUIDPipe()) accountId: string,
    @Body() input: SessionActionDto,
    @Req() request: Request,
  ) {
    await this.users.revokeSessions(
      accountId,
      input.preserveCurrentSession === true,
      input.reason,
      this.correlationId(request),
    );
  }

  @Post(":accountId/sessions/:sessionId/revoke")
  @HttpCode(204)
  public async revokeOne(
    @Param("accountId", new ParseUUIDPipe()) accountId: string,
    @Param("sessionId", new ParseUUIDPipe()) sessionId: string,
    @Body() input: SessionActionDto,
    @Req() request: Request,
  ) {
    await this.users.revokeSession(accountId, sessionId, input.reason, this.correlationId(request));
  }

  @Get(":accountId/audit")
  public audit(
    @Param("accountId", new ParseUUIDPipe()) accountId: string,
    @Query() query: AuditListQueryDto,
  ) {
    return this.users.auditHistory(accountId, query.page, query.pageSize);
  }

  private correlationId(request: Request): string {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}
