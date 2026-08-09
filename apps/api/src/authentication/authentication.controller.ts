import { Body, Controller, Get, HttpCode, Inject, Ip, Post, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";

import type { AppConfiguration } from "../configuration/environment.js";

import { IdentityContextAccessor } from "../security/identity-context.js";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";
import { AllowPasswordChangeRequired, Public } from "./authentication.decorators.js";
// Runtime class values are required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ChangePasswordDto, CompanyLoginDto } from "./authentication.dto.js";
import { AuthenticationService, type LoginResult } from "./authentication.service.js";
import { clearSessionCookie, setSessionCookie } from "./session-cookie.js";

@ApiTags("authentication")
@Controller("auth")
export class AuthenticationController {
  public constructor(
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(CompanyHostResolver) private readonly companyHosts: CompanyHostResolver,
    @Inject(ConfigService) private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  /**
   * `Secure` follows the deployment.
   *
   * Forcing it on in local HTTP development would make the browser drop the
   * cookie silently, reproducing the very "reload signs me out" behaviour this
   * exists to fix; leaving it off in production would let the session ride an
   * unencrypted request.
   */
  private get secureCookies(): boolean {
    return this.config.get("app.environment", { infer: true }) === "production";
  }

  @Public()
  @ApiOperation({ summary: "Sign in to a Company account" })
  @HttpCode(200)
  @Post("login")
  public async loginCompany(
    @Body() input: CompanyLoginDto,
    @Ip() createdIp: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResult> {
    // The Company comes from the host the request arrived on, never from the
    // client. An unresolved host is handled by the service as an ordinary
    // failed sign-in so it cannot be used to probe for Companies.
    const companySubdomain = this.companyHosts.resolve(request.headers.host ?? request.hostname);
    const result = await this.authentication.loginCompany({
      companySubdomain,
      createdIp,
      identifier: input.identifier,
      password: input.password,
      userAgent: request.headers["user-agent"],
    });
    // The SAME token the response body carries, additionally issued as an
    // HttpOnly cookie so a reload, a pasted URL or a new tab keeps the session.
    setSessionCookie(response, {
      expiresAt: new Date(result.expiresAt),
      secure: this.secureCookies,
      token: result.accessToken,
    });
    return result;
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
  public async logout(@Res({ passthrough: true }) response: Response): Promise<void> {
    // Server-side revocation first: if clearing the cookie failed for any
    // reason, the session is already dead rather than merely hidden.
    await this.authentication.logout(this.identities.current());
    clearSessionCookie(response, this.secureCookies);
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

// Platform sign-in moved to `platform/platform-auth.controller.ts` when the
// Platform Administration module was introduced. It did not simply move: the
// endpoint here never issued the HttpOnly session cookie that Company sign-in
// issues, which would have forced the Platform Portal to hold its token in
// browser storage. The replacement sets the cookie and returns no token at all.
