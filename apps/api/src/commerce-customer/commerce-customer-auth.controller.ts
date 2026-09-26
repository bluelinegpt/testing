import { Body, Controller, HttpCode, Inject, Ip, Post, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";

import { Public, RequireIdentityKinds } from "../authentication/authentication.decorators.js";
import { AuthenticationService, type LoginResult } from "../authentication/authentication.service.js";
import { clearSessionCookie, setSessionCookie } from "../authentication/session-cookie.js";
import type { AppConfiguration } from "../configuration/environment.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import {
  CompleteCommerceCustomerPasswordResetDto,
  LoginCommerceCustomerDto,
  RegisterCommerceCustomerDto,
  RequestCommerceCustomerPasswordResetDto,
} from "./commerce-customer-auth.dto.js";
import { CommerceCustomerAuthService } from "./commerce-customer-auth.service.js";

/**
 * Marketplace Customer authentication (Shared Commerce Foundation Prompt
 * 3A) -- register/login/logout/password-reset for `store.bluelinegpt.com`.
 *
 * Deliberately its own controller/route prefix (`commerce/customer-auth`),
 * not a parameter on the existing `AuthenticationController` (§17/§23):
 * Company sign-in resolves its tenant from the request host, Platform
 * sign-in requires no tenant at all, and Customer sign-in requires neither
 * -- three genuinely different shapes are clearer as three routes than one
 * route branching on a hidden discriminator.
 */
@ApiTags("commerce customer authentication")
@Controller("commerce/customer-auth")
export class CommerceCustomerAuthController {
  public constructor(
    @Inject(CommerceCustomerAuthService) private readonly customerAuth: CommerceCustomerAuthService,
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(ConfigService) private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  private get secureCookies(): boolean {
    return this.config.get("app.environment", { infer: true }) === "production";
  }

  @Public()
  @ApiOperation({ summary: "Register a marketplace Customer account" })
  @HttpCode(201)
  @Post("register")
  public async register(
    @Body() input: RegisterCommerceCustomerDto,
    @Ip() createdIp: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResult> {
    const result = await this.customerAuth.register(input, {
      createdIp,
      userAgent: request.headers["user-agent"],
    });
    setSessionCookie(response, {
      expiresAt: new Date(result.expiresAt),
      secure: this.secureCookies,
      token: result.accessToken,
    });
    return result;
  }

  @Public()
  @ApiOperation({ summary: "Sign in to a marketplace Customer account" })
  @HttpCode(200)
  @Post("login")
  public async login(
    @Body() input: LoginCommerceCustomerDto,
    @Ip() createdIp: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResult> {
    const result = await this.authentication.loginCustomer({
      createdIp,
      identifier: input.identifier,
      password: input.password,
      userAgent: request.headers["user-agent"],
    });
    setSessionCookie(response, {
      expiresAt: new Date(result.expiresAt),
      secure: this.secureCookies,
      token: result.accessToken,
    });
    return result;
  }

  /**
   * `@RequireIdentityKinds("customer")` -- defence in depth beyond the fact
   * that `loginCustomer` only ever issues Customer-kind sessions: a Trader/
   * Company/Platform session presenting its own valid cookie to this exact
   * route (e.g. same browser, different tab, misdirected request) is
   * refused here rather than silently returning that identity's own data
   * under a Customer-branded endpoint.
   */
  @RequireIdentityKinds("customer")
  @ApiOperation({ summary: "Return the authenticated Customer's safe identity fields" })
  @Post("me")
  @HttpCode(200)
  public me(): { readonly companyId: null; readonly id: string; readonly kind: "customer" } {
    const identity = this.identities.current();
    // Intentionally the minimal, non-sensitive shape (§29): the full
    // profile (name/mobile/email/language/status) is
    // `commerce-customer/profile`, not this endpoint -- keeping "am I
    // signed in, and as whom" separate from "what is my profile" mirrors
    // the existing `AuthenticationController.me` vs profile-API split used
    // elsewhere in this codebase.
    return { companyId: null, id: identity.identityId, kind: "customer" };
  }

  @RequireIdentityKinds("customer")
  @ApiOperation({ summary: "Revoke the current Customer session" })
  @HttpCode(204)
  @Post("logout")
  public async logout(@Res({ passthrough: true }) response: Response): Promise<void> {
    const identity = this.identities.current();
    await this.authentication.logout(identity);
    clearSessionCookie(response, this.secureCookies);
  }

  @Public()
  @ApiOperation({ summary: "Request a Customer password reset (enumeration-safe)" })
  @HttpCode(202)
  @Post("password-reset/request")
  public async requestPasswordReset(
    @Body() input: RequestCommerceCustomerPasswordResetDto,
  ): Promise<{ readonly acknowledged: true }> {
    await this.customerAuth.requestPasswordReset(input.identifier);
    // §35/§38: identical response whether or not the identifier matched an
    // account -- the caller cannot distinguish the two from this alone.
    return { acknowledged: true };
  }

  @Public()
  @ApiOperation({ summary: "Complete a Customer password reset" })
  @HttpCode(204)
  @Post("password-reset/complete")
  public async completePasswordReset(
    @Body() input: CompleteCommerceCustomerPasswordResetDto,
  ): Promise<void> {
    await this.customerAuth.completePasswordReset(input);
  }
}
