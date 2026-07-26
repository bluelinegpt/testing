import { Body, Controller, Get, HttpCode, Inject, Ip, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { IdentityContextAccessor } from "../security/identity-context.js";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";
import { AllowPasswordChangeRequired, Public } from "./authentication.decorators.js";
// Runtime class values are required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ChangePasswordDto, CompanyLoginDto, LoginDto } from "./authentication.dto.js";
import { AuthenticationService, type LoginResult } from "./authentication.service.js";

@ApiTags("authentication")
@Controller("auth")
export class AuthenticationController {
  public constructor(
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(CompanyHostResolver) private readonly companyHosts: CompanyHostResolver,
  ) {}

  @Public()
  @ApiOperation({ summary: "Sign in to a Company account" })
  @HttpCode(200)
  @Post("login")
  public loginCompany(
    @Body() input: CompanyLoginDto,
    @Ip() createdIp: string,
    @Req() request: Request,
  ): Promise<LoginResult> {
    // The Company comes from the host the request arrived on, never from the
    // client. An unresolved host is handled by the service as an ordinary
    // failed sign-in so it cannot be used to probe for Companies.
    const companySubdomain = this.companyHosts.resolve(request.headers.host ?? request.hostname);
    return this.authentication.loginCompany({
      companySubdomain,
      createdIp,
      identifier: input.identifier,
      password: input.password,
      userAgent: request.headers["user-agent"],
    });
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Return the authenticated account and effective permissions" })
  @Get("me")
  @AllowPasswordChangeRequired()
  public me(): object {
    const identity = this.identities.current();
    return { ...identity, permissions: [...identity.permissions].sort() };
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke the current authentication session" })
  @HttpCode(204)
  @Post("logout")
  @AllowPasswordChangeRequired()
  public async logout(): Promise<void> {
    await this.authentication.logout(this.identities.current());
  }

  @ApiBearerAuth()
  @AllowPasswordChangeRequired()
  @ApiOperation({ summary: "Change the authenticated account password" })
  @HttpCode(204)
  @Post("change-password")
  public async changePassword(
    @Body() input: ChangePasswordDto,
    @Req() request: Request,
  ): Promise<void> {
    await this.authentication.changePassword(
      this.identities.current(),
      input.currentPassword,
      input.newPassword,
      String(request.id ?? request.headers["x-correlation-id"] ?? "unknown"),
    );
  }
}

@ApiTags("platform authentication")
@Controller("platform/auth")
export class PlatformAuthenticationController {
  public constructor(
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
  ) {}

  @Public()
  @ApiOperation({ summary: "Sign in to a platform administrator account" })
  @HttpCode(200)
  @Post("login")
  public loginPlatform(
    @Body() input: LoginDto,
    @Ip() createdIp: string,
    @Req() request: Request,
  ): Promise<LoginResult> {
    return this.authentication.loginPlatform({
      createdIp,
      identifier: input.identifier,
      password: input.password,
      userAgent: request.headers["user-agent"],
    });
  }
}
