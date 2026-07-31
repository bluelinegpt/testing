import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { AppConfiguration } from "../configuration/environment.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { IdentityContext } from "../security/identity-context.js";
import { normalizeUaeMobile } from "../shared/uae-mobile.js";
import { type AccountLoginRecord, AuthenticationRepository } from "./authentication.repository.js";
import { PasswordHasher } from "./password-hasher.js";
import { SessionTokenService } from "./session-token.service.js";

export interface LoginResult {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly identity: {
    readonly companyId: string | null;
    readonly displayName: string;
    readonly id: string;
    readonly kind: string;
    readonly permissions: readonly string[];
    readonly username: string;
    readonly forcePasswordChange: boolean;
  };
  readonly tokenType: "Bearer";
}

@Injectable()
export class AuthenticationService {
  private readonly lockoutMinutes: number;
  private readonly sessionTtlMinutes: number;

  public constructor(
    @Inject(AuthenticationRepository) private readonly repository: AuthenticationRepository,
    @Inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
    @Inject(SessionTokenService) private readonly sessionTokens: SessionTokenService,
    @Inject(ConfigService) config: ConfigService<AppConfiguration, true>,
  ) {
    this.lockoutMinutes = config.get("auth.lockoutMinutes", { infer: true });
    this.sessionTtlMinutes = config.get("auth.sessionTtlMinutes", { infer: true });
  }

  public async loginCompany(input: {
    companySubdomain: string | undefined;
    createdIp?: string | undefined;
    identifier: string;
    password: string;
    userAgent?: string | undefined;
  }): Promise<LoginResult> {
    // An unresolvable host yields no account, which falls through to the same
    // generic invalid-credentials failure as a wrong username or password.
    // Reporting "unknown Company" here would leak which hosts are tenants.
    const account =
      input.companySubdomain === undefined
        ? undefined
        : await this.repository.findCompanyAccount(
            input.companySubdomain,
            input.identifier.trim(),
            normalizeUaeMobile(input.identifier),
          );
    return this.login(account, input);
  }

  public async loginPlatform(input: {
    createdIp?: string | undefined;
    identifier: string;
    password: string;
    userAgent?: string | undefined;
  }): Promise<LoginResult> {
    const account = await this.repository.findPlatformAccount(input.identifier.trim());
    return this.login(account, input);
  }

  public async authenticate(accessToken: string): Promise<IdentityContext> {
    const session = await this.repository.findActiveSession(this.sessionTokens.hash(accessToken));
    if (session === undefined) {
      throw new ApplicationException(
        "invalid_session",
        "The authentication session is invalid or expired",
        HttpStatus.UNAUTHORIZED,
      );
    }
    const permissions = await this.repository.findPermissions(session.accountId);
    return {
      companyId: session.companyId,
      identityId: session.accountId,
      kind: session.kind,
      permissions,
      sessionId: session.sessionId,
      forcePasswordChange: session.forcePasswordChange,
      ...(session.profileLinkId === null ? {} : { profileLinkId: session.profileLinkId }),
      ...(session.profileType === null ? {} : { profileType: session.profileType }),
      ...(session.profileId === null ? {} : { profileId: session.profileId }),
    };
  }

  public async logout(identity: IdentityContext): Promise<void> {
    await this.repository.revokeSession(identity.sessionId, identity.identityId);
  }

  public async changePassword(
    identity: IdentityContext,
    currentPassword: string,
    newPassword: string,
    correlationId: string,
  ): Promise<void> {
    const currentHash = await this.repository.passwordHash(identity.identityId);
    if (!(await this.passwordHasher.verify(currentPassword, currentHash))) {
      throw new ApplicationException(
        "current_password_invalid",
        "The current password is incorrect",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (await this.passwordHasher.verify(newPassword, currentHash)) {
      throw new ApplicationException(
        "password_reuse_denied",
        "The new password must be different from the current password",
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.repository.changePassword({
      accountId: identity.identityId,
      companyId: identity.companyId,
      correlationId,
      passwordHash: await this.passwordHasher.hash(newPassword),
      sessionId: identity.sessionId,
    });
  }

  private async login(
    account: AccountLoginRecord | undefined,
    input: {
      createdIp?: string | undefined;
      identifier: string;
      password: string;
      userAgent?: string | undefined;
    },
  ): Promise<LoginResult> {
    const passwordMatches = await this.passwordHasher.verify(input.password, account?.passwordHash);
    if (account === undefined || !passwordMatches) {
      if (account !== undefined && !this.isTemporarilyLocked(account)) {
        await this.repository.recordFailedLogin(account.id, this.lockoutMinutes);
      }
      throw this.invalidCredentials();
    }
    if (this.isTemporarilyLocked(account) || account.accountStatus === "locked") {
      throw this.invalidCredentials();
    }
    if (
      account.forcePasswordChange &&
      account.temporaryPasswordExpiresAt !== null &&
      account.temporaryPasswordExpiresAt.getTime() <= Date.now()
    ) {
      throw this.invalidCredentials();
    }
    if (account.accountStatus !== "active" || account.companyStatus === "disabled") {
      throw this.invalidCredentials();
    }

    const expiresAt = new Date(Date.now() + this.sessionTtlMinutes * 60_000);
    const sessionToken = this.sessionTokens.create();
    const profile = await this.repository.activeProfile(
      account.id,
      account.companyId,
      account.kind,
    );
    if ((account.kind === "driver" || account.kind === "trader") && profile === undefined) {
      throw this.invalidCredentials();
    }
    await this.repository.resetLoginSecurity(account.id);
    await this.repository.createSession({
      accountId: account.id,
      companyId: account.companyId,
      createdIp: input.createdIp,
      expiresAt,
      tokenHash: sessionToken.hash,
      userAgent: input.userAgent,
      profile,
    });
    const permissions = await this.repository.findPermissions(account.id);
    return {
      accessToken: sessionToken.token,
      expiresAt: expiresAt.toISOString(),
      identity: {
        companyId: account.companyId,
        displayName: account.displayName ?? account.username,
        id: account.id,
        kind: account.kind,
        permissions: [...permissions].sort(),
        username: account.username,
        forcePasswordChange: account.forcePasswordChange,
      },
      tokenType: "Bearer",
    };
  }

  private isTemporarilyLocked(account: AccountLoginRecord): boolean {
    return account.lockedUntil !== null && account.lockedUntil.getTime() > Date.now();
  }

  private invalidCredentials(): ApplicationException {
    return new ApplicationException(
      "invalid_credentials",
      "The login identifier or password is invalid",
      HttpStatus.UNAUTHORIZED,
    );
  }
}
