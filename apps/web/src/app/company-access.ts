const manage = "users_roles.manage";

const routePermissions: Readonly<Record<string, readonly string[]>> = {
  "/dashboard": [manage, "reports.financial.view"],
  "/orders": [
    manage,
    "orders.edit_before_processing",
    "orders.assign_driver",
    "orders.update_delivery_status",
  ],
  "/orders/create": [manage, "orders.create"],
  "/orders/import": [manage, "orders.create"],
  "/traders": [manage, "settlements.create", "settlements.reverse"],
  "/trader-settlements": [manage, "settlements.create", "settlements.reverse"],
  "/drivers": [manage, "orders.assign_driver", "orders.update_delivery_status"],
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
};

const landingPriority = ["/dashboard", "/orders", "/orders/create"] as const;

export function canAccessCompanyPath(pathname: string, permissions: readonly string[]): boolean {
  const normalized = normalizePath(pathname);
  if (normalized === "/no-access") return true;
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
  const first = Object.keys(routePermissions).find((path) =>
    canAccessCompanyPath(path, permissions),
  );
  return first ?? "/no-access";
}

function normalizePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}
