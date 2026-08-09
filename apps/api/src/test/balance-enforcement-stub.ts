import { BalanceEnforcementCoordinator } from "../accounting/balance-enforcement.coordinator.js";

/**
 * A BalanceEnforcementCoordinator that permits everything and records nothing.
 *
 * Payment services now take the coordinator as a constructor dependency, so
 * every harness that builds one by hand has to supply something. Supplying a
 * permissive stub rather than the real service is deliberate: those harnesses
 * assert settlement, concurrency and allocation behaviour, and none of them
 * seeds a Cash balance. The real coordinator would block them on the seeded
 * `cash_policy = 'block'` default and they would fail for a reason they were
 * never written to test.
 *
 * Balance enforcement itself needs its own tests, against its own fixtures.
 * This stub exists so that gap stays visible as a gap, rather than being half
 * covered by unrelated suites.
 */
export function permissiveBalanceEnforcement(): BalanceEnforcementCoordinator {
  return {
    evaluate: async () => ({
      accounts: [],
      allowed: true,
      balanceCoverageIncomplete: false,
      coverage: {
        generalExpenseCashRowsWithoutCompanyCashAccount: 0,
        outsourcedDriverFeeCashPaymentsWithoutCashAccount: 0,
        payrollPaymentsWithoutCashAccount: 0,
        traderSettlementCashPaymentsWithoutCashAccount: 0,
      },
      failureCode: null,
      failureReason: null,
      overrideAccepted: false,
      overrideRequired: false,
      requiresOverrideAudit: false,
    }),
    recordOverrides: async () => [],
  } as unknown as BalanceEnforcementCoordinator;
}
