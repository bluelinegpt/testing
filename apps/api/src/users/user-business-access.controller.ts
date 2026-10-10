import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
  RequirePermissions,
} from "../authentication/authentication.decorators.js";
// Imported as values, not types: `emitDecoratorMetadata` can only record a
// DTO class for the global ValidationPipe when the symbol survives to runtime,
// so these query/body contracts are actually validated.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  BusinessAccessReasonDto,
  CreateBusinessUserDto,
  EligibleBusinessUsersQueryDto,
  LegacyBusinessLinkSyncDto,
  LinkBusinessUserDto,
} from "./user-business-access.dto.js";
import { UserBusinessAccessService } from "./user-business-access.service.js";

const correlation = (request: Request) =>
  String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");

@ApiTags("business-system-access")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequirePermissions("users_roles.manage")
@Controller("configuration")
export class BusinessSystemAccessController {
  public constructor(
    @Inject(UserBusinessAccessService) private readonly access: UserBusinessAccessService,
  ) {}

  @Get("employees/:id/system-access") employee(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.access.list("employee", id);
  }
  @Get("employees/:id/system-access/eligible-users") employeeEligible(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() query: EligibleBusinessUsersQueryDto,
  ) {
    return this.access.eligible("employee", id, query.search);
  }
  @Post("employees/:id/system-access/create-user") employeeCreate(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: CreateBusinessUserDto,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() req: Request,
  ) {
    return this.access.createAndLink("employee", id, body, key, correlation(req));
  }
  @Post("employees/:id/system-access/link-user") employeeLink(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: LinkBusinessUserDto,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() req: Request,
  ) {
    return this.access.link("employee", id, body.accountId, correlation(req), key);
  }
  @Get("drivers/:id/system-access") driver(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.access.list("driver", id);
  }
  @Get("drivers/:id/system-access/eligible-users") driverEligible(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() query: EligibleBusinessUsersQueryDto,
  ) {
    return this.access.eligible("driver", id, query.search);
  }
  @Post("drivers/:id/system-access/create-user") driverCreate(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: CreateBusinessUserDto,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() req: Request,
  ) {
    return this.access.createAndLink("driver", id, body, key, correlation(req));
  }
  @Post("drivers/:id/system-access/link-user") driverLink(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: LinkBusinessUserDto,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() req: Request,
  ) {
    return this.access.link("driver", id, body.accountId, correlation(req), key);
  }
  @Post("business-access/:linkId/suspend") suspend(
    @Param("linkId", new ParseUUIDPipe()) id: string,
    @Body() body: BusinessAccessReasonDto,
    @Req() req: Request,
  ) {
    return this.access.transition(id, "suspended", body.reason, correlation(req));
  }
  @Post("business-access/:linkId/restore") restore(
    @Param("linkId", new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.access.transition(id, "active", undefined, correlation(req));
  }
  @Post("business-access/:linkId/revoke") revoke(
    @Param("linkId", new ParseUUIDPipe()) id: string,
    @Body() body: BusinessAccessReasonDto,
    @Req() req: Request,
  ) {
    return this.access.transition(id, "revoked", body.reason, correlation(req));
  }
  @Post("business-access/:linkId/revoke-sessions") sessions(
    @Param("linkId", new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.access.revokeProfileSessions(id, correlation(req));
  }
}

/**
 * Trader Portal logins, for administrators or a Role given
 * trader_portal_users.manage. Its own class because the staff/driver access
 * controller requires users_roles.manage for every route. Trader Portal
 * accounts are trader-kind only and never carry Company roles, so this cannot
 * be used to create or reach a staff login. Suspend/restore here only accept a
 * link that belongs to this Trader; revoking access, password resets and the
 * user account itself stay with users_roles.manage.
 */
@ApiTags("business-system-access")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequireAnyPermission("trader_portal_users.manage", "users_roles.manage")
@Controller("configuration")
export class TraderPortalAccessController {
  public constructor(
    @Inject(UserBusinessAccessService) private readonly access: UserBusinessAccessService,
  ) {}

  @Get("traders/:id/portal-users") trader(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.access.list("trader", id);
  }
  @Get("traders/:id/portal-users/eligible-users") traderEligible(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query() query: EligibleBusinessUsersQueryDto,
  ) {
    return this.access.eligible("trader", id, query.search);
  }
  @Post("traders/:id/portal-users/create") traderPortalCreate(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() req: Request,
  ) {
    return this.access.createTraderPortalUser(id, key, correlation(req));
  }
  @Post("traders/:id/portal-users/create-user") traderCreate(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: CreateBusinessUserDto,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() req: Request,
  ) {
    return this.access.createAndLink("trader", id, body, key, correlation(req));
  }
  @Post("traders/:id/portal-users/link") traderLink(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: LinkBusinessUserDto,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() req: Request,
  ) {
    return this.access.link("trader", id, body.accountId, correlation(req), key);
  }
  @Post("traders/:id/portal-users/:linkId/suspend") traderSuspend(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("linkId", new ParseUUIDPipe()) linkId: string,
    @Body() body: BusinessAccessReasonDto,
    @Req() req: Request,
  ) {
    return this.access.transition(linkId, "suspended", body.reason, correlation(req), {
      entityId: id,
      profileType: "trader",
    });
  }
  @Post("traders/:id/portal-users/:linkId/restore") traderRestore(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("linkId", new ParseUUIDPipe()) linkId: string,
    @Req() req: Request,
  ) {
    return this.access.transition(linkId, "active", undefined, correlation(req), {
      entityId: id,
      profileType: "trader",
    });
  }
}

@ApiTags("business-link-migration")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequirePermissions("users_roles.manage")
@Controller("users/business-links")
export class LegacyBusinessLinkController {
  public constructor(
    @Inject(UserBusinessAccessService) private readonly access: UserBusinessAccessService,
  ) {}
  @Get("legacy-preview") preview(@Req() req: Request) {
    return this.access.legacyPreview(correlation(req));
  }
  @Post("legacy-sync") sync(
    @Body() body: LegacyBusinessLinkSyncDto,
    @Headers("x-idempotency-key") key: string | undefined,
    @Req() req: Request,
  ) {
    return this.access.legacySync(body, key, correlation(req));
  }
}
