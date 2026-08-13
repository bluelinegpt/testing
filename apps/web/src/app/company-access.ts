const manage = "users_roles.manage";
const accountingAccess = [
  manage,
  "accounting.view",
  "accounting.manage",
  "accounting.approve",
  "accounting.post",
  "accounting.reverse",
  "accounting.configuration.manage",
  "accounting.periods.manage",
  "accounting.chart_of_accounts.manage",
] as const;
const accountingCashBankAccess = [
  manage,
  "accounting.view",
  "accounting.manage",
  "accounting.configuration.manage",
] as const;

const routePermissions: Readonly<Record<string, readonly string[]>> = {
  "/dashboard": [manage, "reports.financial.view"],
  "/orders": [
    manage,
    "orders.edit_before_processing",
    "orders.assign_driver",
    "orders.update_delivery_status",
    // A Driver User's own permission (Driver Order Status Permission fix) --
    // unlocks the List/Detail surface a Driver needs for their own assigned
    // Orders only; the backend narrows visibility and status transitions
    // independently, this only decides whether the nav item/route appears.
    "orders.driver_self_service",
  ],
  "/orders/create": [manage, "orders.create"],
  "/orders/import": [manage, "orders.create"],
  "/trader-settlements": [manage, "settlements.create", "settlements.reverse", "reports.export"],
  "/trader-receivables": [manage, "trader_receivables.create", "trader_receivables.reverse"],
  "/payroll": [
    manage,
    "payroll.view",
    "payroll.manage",
    "payroll.approve",
    "payroll.pay",
    "payroll.reverse",
  ],
  "/accounting": accountingAccess,
  "/accounting/cash-accounts": accountingCashBankAccess,
  "/accounting/bank-accounts": accountingCashBankAccess,
  // Driver Collections (`DriverCollectionsWorkspace`), NOT Driver master-data
  // management (that's `/configuration/drivers`, gated to `manage` only,
  // below). It calls only `operations/cash/*`, which the backend gates on
  // `reconciliations.create`/`reconciliations.reverse`/`manage` -- NEVER on
  // `orders.assign_driver`/`orders.update_delivery_status`. Those two used to
  // be listed here too: they are legitimate Order-list/self-service
  // permissions (see `/orders` below), and a User holding only one of them --
  // e.g. a Driver User whose Role was named "Orders" -- got a route/nav entry
  // into office Driver Collections that the underlying API always rejected,
  // surfacing as a generic "The details could not be loaded." Removing them
  // here does not affect `/orders` at all; each route keeps its own list.
  "/drivers": [manage, "reconciliations.create", "reconciliations.reverse"],
  "/driver-cash-reconciliation": [manage, "reconciliations.create", "reconciliations.reverse"],
  "/operations/driver-reconciliations/new": [manage, "reconciliations.create"],
  "/cash-management": [
    manage,
    "reconciliations.create",
    "reconciliations.reverse",
    "settlements.create",
    "settlements.reverse",
  ],
  "/reports": [manage, "reports.financial.view", "reports.export"],
  "/reports/daily-operations-summary": [manage, "reports.financial.view", "reports.export"],
  "/configuration/company-profile": ["company_profile.manage"],
  // Registered here or the route is unreachable: an unlisted path is denied
  // outright, which is how the Storefront screens ended up showing "Access
  // denied" despite being wired into the workspace and the navigation.
  "/configuration/storefront": [
    manage,
    "storefront.view",
    "storefront.manage",
    "storefront.publish",
  ],
  "/configuration/storefront-products": [
    manage,
    "storefront_products.view",
    "storefront_products.manage",
    "storefront_products.publish",
  ],
  "/configuration/general": [manage],
  "/configuration/traders": [manage],
  "/configuration/customers": [manage],
  "/configuration/areas": [manage],
  "/configuration/bank-accounts": [manage],
  "/configuration/vat": [manage],
  "/configuration/employees": [manage],
  "/configuration/drivers": [manage],
  "/configuration/users": [manage],
  "/configuration/roles": [manage],
  "/support": [manage],
  "/communication": [manage, "communication.operator.read"],
  // Repo/deploy state, not Company business data -- gated the same as
  // Support (`manage` only), not a dedicated permission.
  "/administration/deployment-status": [manage],
};

const landingPriority = ["/dashboard", "/orders", "/orders/create"] as const;

// Every route whose ENTIRE gate is Order-list/self-service permissions --
// today just the Order screens themselves. An identity whose whole
// authorized surface is one of these (a Driver User, or any future
// Orders-only Role) gets no "General Settings is universal" carve-out below:
// their office-facing surface really is Orders alone.
const orderOnlyPaths = new Set(["/orders", "/orders/create", "/orders/import"]);
const hasAnyNonOrderPermission = (permissions: readonly string[]): boolean =>
  Object.entries(routePermissions).some(
    ([path, required]) =>
      !orderOnlyPaths.has(path) && required.some((permission) => permissions.includes(permission)),
  );

export function canAccessCompanyPath(pathname: string, permissions: readonly string[]): boolean {
  const normalized = normalizePath(pathname);
  if (normalized === "/no-access") return true;
  // General Settings is reachable by every OFFICE identity (anyone whose
  // permissions unlock at least one non-Orders route) so they can set their
  // own Search-and-Display preference; the page itself hides the admin-only
  // Company settings from users without the configuration permission (also
  // enforced on the backend). An Orders-only identity -- the Driver User
  // case this carve-out used to leak to -- gets none of that: their whole
  // authorized surface is Orders, so General Settings falls through to its
  // own normal `routePermissions["/configuration/general"]` entry (`manage`
  // only) below, same as every other route.
  if (normalized === "/configuration/general" && hasAnyNonOrderPermission(permissions)) return true;
  const route =
    routePermissions[normalized] === undefined
      ? Object.keys(routePermissions)
          .filter((candidate) => normalized.startsWith(`${candidate}/`))
          .sort((left, right) => right.length - left.length)[0]
      : normalized;
  if (route === undefined) return false;
  const required = routePermissions[route] ?? [];
  return required.some((permission) => permissions.includes(permission));
}

export function firstAuthorizedCompanyPath(permissions: readonly string[]): string {
  for (const path of landingPriority) {
    if (canAccessCompanyPath(path, permissions)) return path;
  }
  // General Settings is reachable by everyone (for personal preferences) but is
  // never a landing page — a user with no operational workspace still lands on
  // the controlled no-access page.
  const first = Object.keys(routePermissions).find(
    (path) => path !== "/configuration/general" && canAccessCompanyPath(path, permissions),
  );
  return first ?? "/no-access";
}

function normalizePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}
