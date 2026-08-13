import { applyDecorators } from "@nestjs/common";

import {
  RequireIdentityKinds,
  RequirePermissions,
} from "../authentication/authentication.decorators.js";

/**
 * Platform permission catalogue and the single way to protect a Platform route.
 *
 * ---------------------------------------------------------------------------
 * WHY `platform.*` AND NOTHING ELSE
 * ---------------------------------------------------------------------------
 *
 * The Company role service already refuses to show, or let a Company
 * Administrator assign, any permission whose code begins `platform.`
 * (`roles/role.service.ts`, `where code not like 'platform.%'`). That filter
 * predates this module and is the reason a separate Platform permission table
 * is unnecessary: the namespace IS the boundary. Every code below therefore
 * carries the prefix, without exception, and the test
 * `platform-authorization.test.ts` fails if one ever does not.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO CHECKS AND NOT ONE
 * ---------------------------------------------------------------------------
 *
 * `identity.kind === "platform_administrator"` says who is calling. It does not
 * say what they may do, and a Platform account with no roles authenticates
 * perfectly well while holding an empty permission set. Conversely a permission
 * check alone would admit any account that somehow held a `platform.*` code.
 *
 * So `RequirePlatformPermissions` always applies BOTH, plus `platform.access`
 * on every route. A Platform account that has been suspended from the Portal by
 * removing that one permission then loses every Platform route at once, rather
 * than losing them one code at a time.
 *
 * Both checks are enforced by the existing global `AuthenticationGuard`, which
 * is deny-by-default: a route with no decorator still requires a valid session,
 * and a route with this decorator additionally requires the kind and every
 * listed code. Nothing here is a frontend concern; the Platform SPA reads
 * permissions only to decide what to render.
 */
export const PLATFORM_ACCESS = "platform.access";
export const PLATFORM_COMPANIES_READ = "platform.companies.read";
export const PLATFORM_COMPANIES_MANAGE = "platform.companies.manage";
export const PLATFORM_COMPANIES_DELETE = "platform.companies.delete";
export const PLATFORM_USERS_READ = "platform.users.read";
export const PLATFORM_USERS_MANAGE = "platform.users.manage";
export const PLATFORM_AUDIT_READ = "platform.audit.read";
export const PLATFORM_ERRORS_READ = "platform.errors.read";
export const PLATFORM_ERRORS_MANAGE = "platform.errors.manage";
// Read-only detector only -- no "platform.integrity.manage"/auto-fix
// permission exists yet, deliberately, matching this file's own rule that a
// seeded permission must have real behaviour behind it. Auto-repair is a
// later, separate decision per the three-tier remediation policy agreed
// 2026-08-04, not something to seed ahead of actually building it.
export const PLATFORM_INTEGRITY_READ = "platform.integrity.read";
// Guards the Company test-data reset (wipe transactional data, keep the
// Company shell). The reset itself additionally refuses any Company whose
// own environment is 'production' — the permission grants the button, the
// environment decides whether the button can ever fire.
export const PLATFORM_COMPANIES_RESET = "platform.companies.reset";

/**
 * The Phase 1 permission set, in the order the seed migration writes them.
 *
 * Deliberately small. Codes for billing, Company data reset, WhatsApp,
 * Storefront, Mobile and integrity auto-fix are NOT here: seeding a permission
 * that nothing enforces creates the impression of a control that does not
 * exist, and each belongs to the phase that implements its behaviour.
 */
export const PLATFORM_PERMISSIONS: readonly { code: string; description: string }[] = [
  { code: PLATFORM_ACCESS, description: "Sign in to the Platform Administration Portal" },
  { code: PLATFORM_COMPANIES_READ, description: "View Companies on the Platform" },
  { code: PLATFORM_COMPANIES_MANAGE, description: "Create and manage Companies on the Platform" },
  { code: PLATFORM_COMPANIES_DELETE, description: "Preview and permanently delete eligible Companies" },
  { code: PLATFORM_USERS_READ, description: "View the users of a Company from the Platform" },
  { code: PLATFORM_USERS_MANAGE, description: "Manage the users of a Company from the Platform" },
  { code: PLATFORM_AUDIT_READ, description: "View Platform and Company audit history" },
  { code: PLATFORM_ERRORS_READ, description: "View captured application errors on the Platform" },
  {
    code: PLATFORM_ERRORS_MANAGE,
    description: "Triage and resolve captured application errors",
  },
  {
    code: PLATFORM_INTEGRITY_READ,
    description: "View cross-module data integrity findings on the Platform",
  },
  {
    code: PLATFORM_COMPANIES_RESET,
    description: "Reset a development or demo Company's transactional data",
  },
];

/** Code of the system Platform role the bootstrap administrator receives. */
export const PLATFORM_SUPER_ADMIN_ROLE_CODE = "platform_super_admin";
export const PLATFORM_SUPER_ADMIN_ROLE_NAME = "Platform Super Administrator";

export const PLATFORM_PERMISSION_PREFIX = "platform.";

/**
 * Protects a Platform route.
 *
 * Applies the Platform identity kind, the always-required `platform.access`
 * code, and whichever granular codes the route needs. Passing no granular code
 * is valid for routes that only prove the caller may use the Portal at all
 * (session bootstrap, logout).
 */
export const RequirePlatformPermissions = (
  ...permissions: string[]
): MethodDecorator & ClassDecorator =>
  applyDecorators(
    RequireIdentityKinds("platform_administrator"),
    RequirePermissions(PLATFORM_ACCESS, ...permissions),
  );
