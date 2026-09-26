import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { IdentityContextAccessor } from "../security/identity-context.js";
import { correlationIdOf } from "./platform-audit.service.js";
import {
  PLATFORM_USERS_MANAGE,
  PLATFORM_USERS_READ,
  RequirePlatformPermissions,
} from "./platform-authorization.js";
// Runtime class values are required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AccountReasonDto,
  CreateCompanyAdministratorDto,
  DeleteCompanyUserDto,
} from "./platform-company-user.dto.js";
import { PlatformUserDeletionService } from "./platform-user-deletion.service.js";
import { PlatformCompanyUserService, type PlatformActor } from "./platform-company-user.service.js";
import { PlatformTargetCompanyGuard } from "./platform-target-company.guard.js";

/**
 * Company user administration from the Platform Portal.
 *
 * Every route names `:companyId`, so `PlatformTargetCompanyGuard` applies to
 * the whole controller: the Company is re-resolved from the database on each
 * request and the tenant context is set from THAT row, never from the body.
 * The delegated services then scope every statement by it.
 *
 * This is an onboarding and support surface, not a replacement for the Company
 * portal's own user administration. It exists because a Company with no users
 * has nobody who could use that portal.
 */
@ApiTags("platform company users")
@Controller("platform/companies/:companyId/users")
@UseGuards(PlatformTargetCompanyGuard)
export class PlatformCompanyUserController {
  public constructor(
    @Inject(PlatformCompanyUserService) private readonly users: PlatformCompanyUserService,
    @Inject(PlatformUserDeletionService) private readonly deletion: PlatformUserDeletionService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  private actor(request: Request): PlatformActor {
    return {
      accountId: this.identities.current().identityId,
      correlationId: correlationIdOf(request),
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    };
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "List the Company's users and administrators" })
  @RequirePlatformPermissions(PLATFORM_USERS_READ)
  @Get()
  public async list(@Param("companyId") companyId: string): Promise<object> {
    return { items: await this.users.list(companyId) };
  }

  /**
   * Creates a Company Administrator and returns a ONE-TIME setup link.
   *
   * The link is in this response and nowhere else: not in the database as
   * plaintext, not in the audit trail, not in any later read of the user. If
   * the administrator loses it, the correct action is to issue a new one, which
   * revokes this one.
   */
  @ApiBearerAuth()
  @ApiOperation({ summary: "Create a Company Administrator and issue a setup link" })
  @RequirePlatformPermissions(PLATFORM_USERS_MANAGE)
  @HttpCode(201)
  @Post("administrators")
  public create(
    @Param("companyId") companyId: string,
    @Body() input: CreateCompanyAdministratorDto,
    @Req() request: Request,
  ): Promise<object> {
    return this.users.createAdministrator(
      companyId,
      {
        displayName: input.displayName,
        username: input.username,
        email: input.email,
        mobileNumber: input.mobileNumber,
        preferredLanguage: input.preferredLanguage,
      },
      this.actor(request),
    );
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Issue a fresh account-activation link" })
  @RequirePlatformPermissions(PLATFORM_USERS_MANAGE)
  @HttpCode(200)
  @Post(":accountId/activation")
  public activation(
    @Param("companyId") companyId: string,
    @Param("accountId") accountId: string,
    @Req() request: Request,
  ): Promise<object> {
    return this.users.issueLink(companyId, accountId, "activation", this.actor(request));
  }

  /**
   * Starts password recovery. No password is set here and none is returned —
   * the user chooses their own through the link.
   */
  @ApiBearerAuth()
  @ApiOperation({ summary: "Issue a password-reset link and end existing sessions" })
  @RequirePlatformPermissions(PLATFORM_USERS_MANAGE)
  @HttpCode(200)
  @Post(":accountId/password-reset")
  public passwordReset(
    @Param("companyId") companyId: string,
    @Param("accountId") accountId: string,
    @Req() request: Request,
  ): Promise<object> {
    return this.users.issueLink(companyId, accountId, "reset", this.actor(request));
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Clear a failed-login lock" })
  @RequirePlatformPermissions(PLATFORM_USERS_MANAGE)
  @HttpCode(204)
  @Post(":accountId/unlock")
  public unlock(
    @Param("companyId") companyId: string,
    @Param("accountId") accountId: string,
    @Req() request: Request,
  ): Promise<void> {
    return this.users.unlock(companyId, accountId, this.actor(request));
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Deactivate a user and end its sessions" })
  @RequirePlatformPermissions(PLATFORM_USERS_MANAGE)
  @HttpCode(204)
  @Post(":accountId/deactivate")
  public deactivate(
    @Param("companyId") companyId: string,
    @Param("accountId") accountId: string,
    @Body() input: AccountReasonDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.users.setActive(companyId, accountId, false, input.reason, this.actor(request));
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Reactivate a deactivated user" })
  @RequirePlatformPermissions(PLATFORM_USERS_MANAGE)
  @HttpCode(204)
  @Post(":accountId/reactivate")
  public reactivate(
    @Param("companyId") companyId: string,
    @Param("accountId") accountId: string,
    @Body() input: AccountReasonDto,
    @Req() request: Request,
  ): Promise<void> {
    return this.users.setActive(companyId, accountId, true, input.reason, this.actor(request));
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "List a user's sessions" })
  @RequirePlatformPermissions(PLATFORM_USERS_READ)
  @Get(":accountId/sessions")
  public async sessions(
    @Param("companyId") companyId: string,
    @Param("accountId") accountId: string,
  ): Promise<object> {
    return { items: await this.users.sessions(companyId, accountId) };
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke one session" })
  @RequirePlatformPermissions(PLATFORM_USERS_MANAGE)
  @HttpCode(204)
  @Post(":accountId/sessions/:sessionId/revoke")
  public revokeSession(
    @Param("companyId") companyId: string,
    @Param("accountId") accountId: string,
    @Param("sessionId") sessionId: string,
    @Req() request: Request,
  ): Promise<void> {
    return this.users.revokeSession(companyId, accountId, sessionId, this.actor(request));
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke every active session for a user" })
  @RequirePlatformPermissions(PLATFORM_USERS_MANAGE)
  @HttpCode(200)
  @Post(":accountId/sessions/revoke-all")
  public revokeAll(
    @Param("companyId") companyId: string,
    @Param("accountId") accountId: string,
    @Req() request: Request,
  ): Promise<object> {
    return this.users.revokeAllSessions(companyId, accountId, this.actor(request));
  }

  /**
   * Whether this user can be permanently deleted, and why not if not.
   *
   * A read, gated by `platform.users.read`: it answers a question about the
   * user and changes nothing. The UI uses it to decide whether Delete is
   * offered, but the same check runs again inside the deletion transaction --
   * the server never trusts the screen that produced the click.
   */
  @ApiBearerAuth()
  @ApiOperation({ summary: "Report whether a user can be permanently deleted" })
  @RequirePlatformPermissions(PLATFORM_USERS_READ)
  @Get(":accountId/deletion-eligibility")
  public deletionEligibility(
    @Param("companyId") companyId: string,
    @Param("accountId") accountId: string,
  ): Promise<object> {
    return this.deletion.eligibility(companyId, accountId);
  }

  /**
   * Permanently deletes a user who has no history.
   *
   * Expressed as an explicit POST action rather than an HTTP DELETE, matching
   * every other state change in this controller, because it carries a required
   * body -- the typed confirmation challenge -- and a DELETE with a mandatory
   * body is a request shape that intermediaries handle inconsistently.
   *
   * `platform.users.manage` rather than a new `platform.users.delete`: manage
   * already permits deactivating any Company user, resetting their password and
   * revoking their sessions -- that is, taking over or disabling any account in
   * the Company. Deletion here is strictly NARROWER, because by construction it
   * only ever reaches an account with no history at all. The control that makes
   * this safe is the eligibility engine, not a second permission, and a
   * permission that adds no real boundary mostly adds a thing to forget to
   * grant. Company deletion is different and does get its own permission: it
   * destroys a tenant rather than an unused login.
   */
  @ApiBearerAuth()
  @ApiOperation({ summary: "Permanently delete a user that has no history" })
  @RequirePlatformPermissions(PLATFORM_USERS_MANAGE)
  @HttpCode(200)
  @Post(":accountId/delete")
  public deleteUser(
    @Param("companyId") companyId: string,
    @Param("accountId") accountId: string,
    @Body() input: DeleteCompanyUserDto,
    @Req() request: Request,
  ): Promise<object> {
    const actor = this.actor(request);
    return this.deletion.delete(companyId, accountId, input.confirmation, {
      accountId: actor.accountId,
      correlationId: actor.correlationId,
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    });
  }
}
