/**
 * Storefront permission checks, including the administrator escalation.
 *
 * `users_roles.manage` is the Company administrator super-permission. The API
 * honours it (see `AccountingOperationSupport.assertAnyPermission`, mirrored in
 * the Storefront services) and `company-access.ts` lists it first on every
 * route. The screens must agree: gating a control on the specific permission
 * alone left an administrator looking at a form whose fields were all
 * disabled, with nothing on screen explaining why.
 *
 * A UI check can only ever HIDE an action — the server re-checks every call —
 * so the risk of this helper is a disabled button, never an unauthorised write.
 */
const administrator = "users_roles.manage";

export function hasStorefrontPermission(
  permissions: readonly string[],
  ...required: readonly string[]
): boolean {
  return permissions.includes(administrator) || required.some((one) => permissions.includes(one));
}
