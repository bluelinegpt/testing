import { Body, Controller, Get, HttpCode, Inject, Ip, Post, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";

import type { AppConfiguration } from "../configuration/environment.js";

import { DeviceRegistrationService } from "../push/device-registration.service.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";
import { CompanyMobileCodeResolver } from "../tenancy/company-mobile-code-resolver.js";
import { AllowPasswordChangeRequired, Public } from "./authentication.decorators.js";
// Runtime class values are required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ChangePasswordDto, CompanyLoginDto } from "./authentication.dto.js";
import { AuthenticationRepository } from "./authentication.repository.js";
import { AuthenticationService, type LoginResult } from "./authentication.service.js";
import { clearSessionCookie, setSessionCookie } from "./session-cookie.js";

@ApiTags("authentication")
@Controller("auth")
export class AuthenticationController {
  public constructor(
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(CompanyHostResolver) private readonly companyHosts: CompanyHostResolver,
    @Inject(CompanyMobileCodeResolver)
    private readonly companyMobileCodes: CompanyMobileCodeResolver,
    @Inject(DeviceRegistrationService)
    private readonly deviceRegistrations: DeviceRegistrationService,
    @Inject(AuthenticationRepository) private readonly repository: AuthenticationRepository,
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
    // The Company comes from the request's own addressing, never from the
    // login form. An unresolved Company is handled by the service as an
    // ordinary failed sign-in so neither path can be used to probe for
    // Companies. Two addressing schemes, one per client family:
    //
    // `x-blueline-company-code` is the mobile app's six-digit Company Mobile
    // Code, stored on the device at first launch (scanned from a portal QR
    // panel or a printed report). It takes precedence because a device that
    // sends it has explicitly chosen its Company; the API's own host would
    // resolve to the development fallback otherwise.
    //
    // `x-blueline-tenant-host` carries the ORIGINAL portal host when the
    // request travels through the portal's own same-origin `/api` proxy
    // (apps/web and apps/platform-web `serve.mjs`): hosting routers direct
    // upstream requests by the Host header, so the proxy must rewrite Host to
    // the API's own name and forward the tenant host separately. Trusting
    // either header is equivalent to trusting Host itself — all three merely
    // AIM the login at a Company, none grants access.
    const mobileCodeHeader = request.headers["x-blueline-company-code"];
    const mobileCode = Array.isArray(mobileCodeHeader) ? mobileCodeHeader[0] : mobileCodeHeader;
    const tenantHost = request.headers["x-blueline-tenant-host"];
    // A PRESENT code is decisive even when unknown: falling through to host
    // resolution would land a mistyped code on the development fallback
    // Company instead of the generic failure the design promises.
    const companySubdomain =
      mobileCode !== undefined
        ? await this.companyMobileCodes.resolve(mobileCode)
        : this.companyHosts.resolve(
            (Array.isArray(tenantHost) ? tenantHost[0] : tenantHost) ??
              request.headers.host ??
              request.hostname,
          );
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
  public async me(): Promise<object> {
    const identity = this.identities.current();
    // Authoritative "Driver User" signal (Driver Physical Correction, Section
    // A): a `company_user` account can be operationally a Driver — its linked
    // Employee backs a `drivers.employee_id` record — without ever holding a
    // `driver`-kind account. `undefined` here (omitted from the response,
    // never `null`) for every other identity, including a `driver`-kind
    // session itself, which needs no such hint. The client must treat this as
    // the single source of truth for "should this account see a Driver-style
    // experience" and never infer it from a display name or any local check.
    const linkedDriverId = await this.repository.linkedDriverId(
      identity.companyId,
      identity.profileType,
      identity.profileId,
    );
    return {
      ...identity,
      permissions: [...identity.permissions].sort(),
      ...(linkedDriverId === undefined ? {} : { linkedDriverId }),
    };
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke the current authentication session" })
  @HttpCode(204)
  @Post("logout")
  @AllowPasswordChangeRequired()
  public async logout(@Res({ passthrough: true }) response: Response): Promise<void> {
    // Server-side revocation first: if clearing the cookie failed for any
    // reason, the session is already dead rather than merely hidden.
    const identity = this.identities.current();
    await this.authentication.logout(identity);
    // Best-effort: a Push module issue must never block logout completing
    // (Section E, point 3). `identities.current()` still resolves here — it
    // reads the request-scoped identity already established for this
    // request, independent of the session row `authentication.logout` just
    // revoked in the database.
    await this.deviceRegistrations.deregister(undefined, "logout").catch(() => undefined);
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
