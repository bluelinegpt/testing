import { SetMetadata } from "@nestjs/common";

import type { IdentityKind } from "../security/identity-context.js";

export const PUBLIC_ROUTE = "blueline.public-route";
export const OPTIONAL_AUTHENTICATION_ROUTE = "blueline.optional-authentication-route";
export const REQUIRED_PERMISSIONS = "blueline.required-permissions";
export const REQUIRED_ANY_PERMISSIONS = "blueline.required-any-permissions";
export const REQUIRED_IDENTITY_KINDS = "blueline.required-identity-kinds";
export const PASSWORD_CHANGE_ALLOWED = "blueline.password-change-allowed";

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_ROUTE, true);

/**
 * A route that works for both a guest AND a logged-in identity, and needs
 * to actually tell the two apart -- unlike `@Public()`, which makes
 * `AuthenticationGuard` skip session resolution entirely (see that guard's
 * own doc comment on why: a request through a `@Public()` route is NEVER
 * attributed to a session, even a valid one -- correct for anonymous-only
 * surfaces like Store crash reporting, wrong for Customer Commerce Checkout,
 * where a logged-in Customer's saved address and Order history genuinely
 * depend on their identity being resolved when a valid session is present.
 *
 * A missing, invalid, or expired session under this decorator is silently
 * treated as anonymous -- it never causes a 401, unlike a normal protected
 * route. A present-but-CSRF-header-missing cookie is likewise treated as
 * anonymous rather than rejected: the safe behavior for an ambiguous signal
 * on an otherwise-legitimate anonymous request is to degrade to guest, not
 * to fail the request outright.
 */
export const OptionalAuthentication = (): MethodDecorator & ClassDecorator =>
  SetMetadata(OPTIONAL_AUTHENTICATION_ROUTE, true);
export const AllowPasswordChangeRequired = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PASSWORD_CHANGE_ALLOWED, true);

export const RequirePermissions = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

export const RequireAnyPermission = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ANY_PERMISSIONS, permissions);

export const RequireIdentityKinds = (...kinds: IdentityKind[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_IDENTITY_KINDS, kinds);
