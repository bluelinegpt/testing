import { Body, Controller, Get, HttpCode, Inject, Ip, Post, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";

// Runtime class values are required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { LoginDto } from "../authentication/authentication.dto.js";
import { Public } from "../authentication/authentication.decorators.js";
import { AuthenticationService } from "../authentication/authentication.service.js";
import { clearSessionCookie, setSessionCookie } from "../authentication/session-cookie.js";
import type { AppConfiguration } from "../configuration/environment.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { correlationIdOf, PlatformAuditService } from "./platform-audit.service.js";
import { RequirePlatformPermissions } from "./platform-authorization.js";
import { PlatformService, type PlatformSessionView } from "./platform.service.js";

/**
 * Response to a successful Platform sign-in.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO TOKEN IN THIS RESPONSE
 * ---------------------------------------------------------------------------
 *
 * Company sign-in returns `accessToken` because API clients that authenticate
 * with a bearer header existed before the cookie did. The Platform Portal has
 * no such history: its only client is a browser, and the session travels in the
 * `HttpOnly` cookie that this endpoint sets.
 *
 * Returning the token anyway would put it in reach of page scripts and invite
 * exactly the `localStorage` persistence the Portal is required never to use.
 * Withholding it is not a limitation — it removes the option.
 */
export interface PlatformLoginResponse {
  readonly expiresAt: string;
  readonly identity: PlatformSessionView;
}

@ApiTags("platform authentication")
@Controller("platform/auth")
export class PlatformAuthController {
  public constructor(
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(PlatformService) private readonly platform: PlatformService,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(ConfigService) private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  /**
   * `Secure` follows the deployment, exactly as Company sign-in does. Forcing
   * it on in local HTTP development would make the browser drop the cookie
   * silently and produce a Portal that can never stay signed in.
   */
  private get secureCookies(): boolean {
    return this.config.get("app.environment", { infer: true }) === "production";
  }

  @Public()
  @ApiOperation({ summary: "Sign in to a Platform Administrator account" })
  @HttpCode(200)
  @Post("login")
  public async login(
    @Body() input: LoginDto,
    @Ip() createdIp: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PlatformLoginResponse> {
    const correlationId = correlationIdOf(request);
    const userAgent = request.headers["user-agent"];
    let result;
    try {
      result = await this.authentication.loginPlatform({
        createdIp,
        identifier: input.identifier,
        password: input.password,
        userAgent,
      });
    } catch (error) {
      // The attempted identifier is recorded; the submitted password never
      // reaches this method's audit path and is never stored.
      await this.audit.recordBestEffort({
        action: "platform.authentication.failed",
        actorAccountId: null,
        subjectType: "account",
        subjectId: null,
        after: { identifier: input.identifier.slice(0, 320) },
        result: "failure",
        // Deliberately generic. The service refuses unknown account, wrong
        // password, disabled account and suspended Company identically, and
        // recording which one it was here would rebuild the enumeration oracle
        // the generic response exists to prevent — in a table anyone with
        // audit access can read.
        failureReason: "invalid_credentials",
        correlationId,
        ipAddress: createdIp,
        userAgent,
      });
      throw error;
    }

    setSessionCookie(response, {
      expiresAt: new Date(result.expiresAt),
      secure: this.secureCookies,
      token: result.accessToken,
    });
    await this.audit.recordBestEffort({
      action: "platform.authentication.succeeded",
      actorAccountId: result.identity.id,
      subjectType: "account",
      subjectId: result.identity.id,
      after: { username: result.identity.username },
      result: "success",
      correlationId,
      ipAddress: createdIp,
      userAgent,
    });

    return {
      expiresAt: result.expiresAt,
      identity: {
        accountId: result.identity.id,
        username: result.identity.username,
        displayName: result.identity.displayName,
        kind: "platform_administrator",
        companyId: null,
        permissions: result.identity.permissions.filter((code) => code.startsWith("platform.")),
        roles: [],
      },
    };
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Return the authenticated Platform Administrator and permissions" })
  @RequirePlatformPermissions()
  @Get("me")
  public me(): Promise<PlatformSessionView> {
    return this.platform.describeSession(this.identities.current());
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke the current Platform session" })
  @RequirePlatformPermissions()
  @HttpCode(204)
  @Post("logout")
  public async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const identity = this.identities.current();
    // Server-side revocation first. If clearing the cookie then failed for any
    // reason the session is already dead rather than merely hidden.
    await this.authentication.logout(identity);
    clearSessionCookie(response, this.secureCookies);
    await this.audit.recordBestEffort({
      action: "platform.authentication.signed_out",
      actorAccountId: identity.identityId,
      subjectType: "account",
      subjectId: identity.identityId,
      correlationId: correlationIdOf(request),
      ipAddress: request.ip ?? null,
      userAgent: request.headers["user-agent"],
    });
  }
}
