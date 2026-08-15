/**
 * Standard starter roles, seeded into every new Company alongside its first
 * Company Administrator.
 *
 * Agreed 2026-08-15: a brand-new Company previously started with NO role
 * that could be granted to a Driver or an Accountant — only the bootstrap
 * "Company Administrator" role existed (`platform-company-user.service.ts`'s
 * `ensureCompanyAdminRole`), deliberately minimal so it never presumes a
 * Company's structure. That left every new Company blocked the first time
 * anyone tried to create a Driver's system-access user: the role picker had
 * nothing to offer but "Company Administrator".
 *
 * These two are not a guess at what every Company needs — they are the
 * permission sets Dana Delivery Services' own admin already built by hand
 * for "Driver Operations" and (trimmed here to accounting-floor work, not
 * the broader admin-level set Dana's own "AccoutingAdmin" grew into)
 * "Accountant". Seeding the proven shape removes the first-day friction
 * without removing anything: `is_system` is false on both, so a Company
 * that wants a different structure can rename, reshape or deactivate them
 * immediately, the same as any role it creates itself.
 *
 * NOT seeded here: "Orders" (Dana's office-staff role) and any Accounting
 * Admin-level role. Two starter roles were the ones actually blocking
 * onboarding; more can be added the same way, once asked for.
 */
export interface StandardCompanyRole {
  readonly code: string;
  readonly description: string;
  readonly name: string;
  readonly permissions: readonly string[];
}

export const STANDARD_COMPANY_ROLES: readonly StandardCompanyRole[] = [
  {
    code: "driver_operations",
    description: "Standard starter role for a Driver's own Order updates.",
    name: "Driver Operations",
    permissions: ["orders.driver_self_service"],
  },
  {
    code: "accountant",
    description: "Standard starter role for day-to-day accounting and settlement work.",
    name: "Accountant",
    permissions: [
      "accounting.view",
      "accounting.post",
      "accounting.reverse",
      "journals.create_manual",
      "reconciliations.create",
      "reconciliations.reverse",
      "settlements.create",
      "settlements.reverse",
      "trader_receivables.create",
      "trader_receivables.reverse",
      "payroll.view",
      "payroll.pay",
      "outsourced_driver_fees.view",
      "outsourced_driver_fees.pay",
      "reports.financial.view",
      "reports.export",
    ],
  },
];
