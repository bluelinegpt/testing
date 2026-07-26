import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

import { ApplicationException } from "../presentation/errors/application.exception.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { AuthenticationService } from "./authentication.service.js";
import type { IdentityKind } from "../security/identity-context.js";
import {
  PUBLIC_ROUTE,
  REQUIRED_IDENTITY_KINDS,
  REQUIRED_PERMISSIONS,
  REQUIRED_ANY_PERMISSIONS,
  PASSWORD_CHANGE_ALLOWED,
} from "./authentication.decorators.js";

@Injectable()
export class AuthenticationGuard implements CanActivate {
  public constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(RequestSecurityContextStore)
    private readonly contextStore: RequestSecurityContextStore,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const accessToken = this.readBearerToken(request.headers.authorization);
    const identity = await this.authentication.authenticate(accessToken);
    const requiredKinds =
      this.reflector.getAllAndOverride<readonly IdentityKind[]>(REQUIRED_IDENTITY_KINDS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (requiredKinds.length > 0 && !requiredKinds.includes(identity.kind)) {
      throw new ApplicationException(
        "identity_kind_denied",
        "This account type cannot access the requested operation",
        HttpStatus.FORBIDDEN,
      );
    }
    const requiredPermissions =
      this.reflector.getAllAndOverride<readonly string[]>(REQUIRED_PERMISSIONS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    const missing = requiredPermissions.filter(
      (permission) => !identity.permissions.has(permission),
    );
    if (missing.length > 0) {
      throw new ApplicationException(
        "permission_denied",
        "The authenticated account does not have permission for this operation",
        HttpStatus.FORBIDDEN,
      );
    }
    const requiredAnyPermissions =
      this.reflector.getAllAndOverride<readonly string[]>(REQUIRED_ANY_PERMISSIONS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (
      requiredAnyPermissions.length > 0 &&
      !requiredAnyPermissions.some((permission) => identity.permissions.has(permission))
    ) {
      throw new ApplicationException(
        "permission_denied",
        "The authenticated account does not have permission for this operation",
        HttpStatus.FORBIDDEN,
      );
    }
    const passwordChangeAllowed = this.reflector.getAllAndOverride<boolean>(
      PASSWORD_CHANGE_ALLOWED,
      [context.getHandler(), context.getClass()],
    );
    if (identity.forcePasswordChange && passwordChangeAllowed !== true) {
      throw new ApplicationException(
        "password_change_required",
        "You must change your temporary password before continuing",
        HttpStatus.FORBIDDEN,
      );
    }

    this.contextStore.enter({
      identity,
      tenant:
        identity.companyId === null
          ? undefined
          : { companyId: identity.companyId, identityId: identity.identityId },
    });
    return true;
  }

  private readBearerToken(header: string | undefined): string {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? "");
    if (match?.[1] === undefined) {
      throw new ApplicationException(
        "authentication_required",
        "A valid Bearer authentication token is required",
        HttpStatus.UNAUTHORIZED,
      );
    }
    return match[1];
  }
}
