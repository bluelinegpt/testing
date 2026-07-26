import { SetMetadata } from "@nestjs/common";

import type { IdentityKind } from "../security/identity-context.js";

export const PUBLIC_ROUTE = "blueline.public-route";
export const REQUIRED_PERMISSIONS = "blueline.required-permissions";
export const REQUIRED_ANY_PERMISSIONS = "blueline.required-any-permissions";
export const REQUIRED_IDENTITY_KINDS = "blueline.required-identity-kinds";
export const PASSWORD_CHANGE_ALLOWED = "blueline.password-change-allowed";

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE, true);
export const AllowPasswordChangeRequired = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PASSWORD_CHANGE_ALLOWED, true);

export const RequirePermissions = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

export const RequireAnyPermission = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ANY_PERMISSIONS, permissions);

export const RequireIdentityKinds = (...kinds: IdentityKind[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_IDENTITY_KINDS, kinds);
