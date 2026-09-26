import type { Transaction } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";
import {
  BalanceControlService,
  type CompanyBalancePolicy,
} from "./balance-control.service.js";
import {
  BalanceEnforcementCoordinator,
  type FundingAccountDeduction,
} from "./balance-enforcement.coordinator.js";
import type { FundingAccountBalanceService } from "./funding-account-balance.service.js";
import type { FundingAccountLockService } from "./funding-account-lock.service.js";
import type { PaymentAccountKind } from "./payment-funding-account.service.js";

/**
 * Coordinator behaviour, with the three collaborators stubbed.
 *
 * The ORDER of the three steps is the control, and it is invisible in a test
 * that only checks the verdict: a coordinator that read the balance before
 * taking the lock would return exactly the same answer here, and be wrong in
 * production. So every stub appends to one shared `calls` log and the tests
 * assert on that sequence directly.
 *
 * `BalanceControlService` is the REAL service with only `policyFor` stubbed --
 * the override permission and reason rules are the thing under test, and a
 * stubbed decider would test the stub.
 */

const companyId = "11111111-1111-4111-8111-111111111111";
const cashOne = "aaaaaaaa-1111-4111-8111-111111111111";
const cashTwo = "aaaaaaaa-2222-4111-8111-111111111111";
const bankOne = "bbbbbbbb-1111-4111-8111-111111111111";

const zeroCoverage = {
  generalExpenseCashRowsWithoutCompanyCashAccount: 0,
  outsourcedDriverFeeCashPaymentsWithoutCashAccount: 0,
  payrollPaymentsWithoutCashAccount: 0,
  traderSettlementCashPaymentsWithoutCashAccount: 0,
};

const basePolicy: CompanyBalancePolicy = {
  bankOverdraftLimit: "0.00",
  bankPolicy: "allow_within_overdraft",
  cashPolicy: "block",
  effectiveFrom: null,
  effectiveTo: null,
  id: "99999999-9999-4999-8999-999999999999",
  overridePermission: "accounting.manage",
};

const transaction = { isTransaction: true } as unknown as Transaction<DatabaseSchema>;
const pool = { isTransaction: false } as unknown as Transaction<DatabaseSchema>;

function build(options: {
  readonly balances?: Readonly<Record<string, string>>;
  readonly coverage?: typeof zeroCoverage;
  readonly policy?: CompanyBalancePolicy;
}) {
  const calls: string[] = [];
  const balances = options.balances ?? {};

  // Mirrors the real lock service's contract: deduplicated, cash before bank,
  // then by account id. The real implementation is covered against a live
  // database in balance-enforcement.database.test.ts.
  const locks = {
    lockAll: async (
      _transaction: unknown,
      requests: readonly { accountId: string; kind: PaymentAccountKind }[],
    ) => {
      const unique = new Map(requests.map((r) => [`${r.kind}:${r.accountId}`, r]));
      const ordered = [...unique.values()].sort(
        (left, right) =>
          (left.kind === "cash" ? 0 : 1) - (right.kind === "cash" ? 0 : 1) ||
          left.accountId.localeCompare(right.accountId),
      );
      calls.push(`lock:${ordered.map((r) => `${r.kind}/${r.accountId.slice(0, 8)}`).join(",")}`);
      return ordered;
    },
  } as unknown as FundingAccountLockService;

  const balanceService = {
    current: async (kind: PaymentAccountKind, accountId: string) => {
      calls.push(`balance:${kind}/${accountId.slice(0, 8)}`);
      return {
        accountId,
        balance: balances[`${kind}:${accountId}`] ?? "0.00",
        basis: "opening_balances_movements_and_confirmed_payments" as const,
        code: "CODE",
        companyId,
        coverage: options.coverage ?? zeroCoverage,
        isActive: true,
        kind,
        name: "Account",
        readAt: new Date(0).toISOString(),
      };
    },
  } as unknown as FundingAccountBalanceService;

  const control = new BalanceControlService(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
  );
  const policy = options.policy ?? basePolicy;
  Object.assign(control, {
    policyFor: async () => {
      calls.push("policy");
      return policy;
    },
  });
  const realEvaluate = control.evaluate.bind(control);
  Object.assign(control, {
    evaluate: (input: Parameters<BalanceControlService["evaluate"]>[0], resolved: CompanyBalancePolicy) => {
      calls.push(`evaluate:${input.accountKind}/${input.accountId.slice(0, 8)}/${input.amount}`);
      return realEvaluate(input, resolved);
    },
  });

  const tenants = { current: () => ({ companyId }) } as unknown as TenantContextAccessor;
  const coordinator = new BalanceEnforcementCoordinator(locks, balanceService, control, tenants);
  return { calls, control, coordinator };
}

const request = (deductions: readonly FundingAccountDeduction[], extra: Record<string, unknown> = {}) => ({
  actorId: "22222222-2222-4222-8222-222222222222",
  actorPermissions: [] as readonly string[],
  deductions,
  sourceType: "payroll_payment" as const,
  ...extra,
});

describe("BalanceEnforcementCoordinator.evaluate", () => {
  it("locks the account before reading its balance, and reads before deciding", async () => {
    const { calls, coordinator } = build({ balances: { [`cash:${cashOne}`]: "1000.00" } });
    await coordinator.evaluate(transaction, request([{ accountId: cashOne, amount: "10.00", kind: "cash" }]));
    const lock = calls.findIndex((entry) => entry.startsWith("lock:"));
    const balance = calls.findIndex((entry) => entry.startsWith("balance:"));
    const decide = calls.findIndex((entry) => entry.startsWith("evaluate:"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(balance);
    expect(balance).toBeLessThan(decide);
  });

  it("requires a transaction and refuses the pool", async () => {
    const { calls, coordinator } = build({});
    await expect(
      coordinator.evaluate(pool, request([{ accountId: cashOne, amount: "10.00", kind: "cash" }])),
    ).rejects.toMatchObject({ errorCode: "balance_enforcement_requires_transaction" });
    // Nothing was locked or read: it refused before touching anything.
    expect(calls).toEqual([]);
  });

  it("refuses a request with no deductions", async () => {
    const { coordinator } = build({});
    await expect(coordinator.evaluate(transaction, request([]))).rejects.toMatchObject({
      errorCode: "balance_enforcement_deduction_required",
    });
  });

  it("allows a payment the balance covers", async () => {
    const { coordinator } = build({ balances: { [`cash:${cashOne}`]: "1000.00" } });
    const result = await coordinator.evaluate(
      transaction,
      request([{ accountId: cashOne, amount: "250.00", kind: "cash" }]),
    );
    expect(result.allowed).toBe(true);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.currentBalance).toBe("1000.00");
    expect(result.accounts[0]?.projectedBalance).toBe("750.00");
    expect(result.failureCode).toBeNull();
    expect(result.requiresOverrideAudit).toBe(false);
  });

  it("blocks a payment that would take Cash below zero", async () => {
    const { coordinator } = build({ balances: { [`cash:${cashOne}`]: "100.00" } });
    const result = await coordinator.evaluate(
      transaction,
      request([{ accountId: cashOne, amount: "250.00", kind: "cash" }]),
    );
    expect(result.allowed).toBe(false);
    expect(result.failureCode).toBe("balance_would_go_negative");
    expect(result.accounts[0]?.projectedBalance).toBe("-150.00");
    expect(result.accounts[0]?.shortfall).toBe("150.00");
    expect(result.requiresOverrideAudit).toBe(false);
  });

  it("allows a multi-account payment when every account covers its share", async () => {
    const { coordinator } = build({
      balances: { [`bank:${bankOne}`]: "500.00", [`cash:${cashOne}`]: "1000.00" },
    });
    const result = await coordinator.evaluate(
      transaction,
      request([
        { accountId: bankOne, amount: "100.00", kind: "bank" },
        { accountId: cashOne, amount: "200.00", kind: "cash" },
      ]),
    );
    expect(result.allowed).toBe(true);
    expect(result.accounts).toHaveLength(2);
  });

  it("blocks the whole request when a single account fails", async () => {
    const { coordinator } = build({
      balances: { [`bank:${bankOne}`]: "10.00", [`cash:${cashOne}`]: "1000.00" },
    });
    const result = await coordinator.evaluate(
      transaction,
      request([
        { accountId: bankOne, amount: "100.00", kind: "bank" },
        { accountId: cashOne, amount: "200.00", kind: "cash" },
      ]),
    );
    expect(result.allowed).toBe(false);
    // The Cash half is still reported as permitted; the REQUEST is refused.
    expect(result.accounts.find((a) => a.kind === "cash")?.allowed).toBe(true);
    expect(result.accounts.find((a) => a.kind === "bank")?.allowed).toBe(false);
  });

  it("sums repeated deductions on one account instead of judging them apart", async () => {
    const { calls, coordinator } = build({ balances: { [`cash:${cashOne}`]: "10000.00" } });
    const result = await coordinator.evaluate(
      transaction,
      request([
        { accountId: cashOne, amount: "6000.00", kind: "cash" },
        { accountId: cashOne, amount: "6000.00", kind: "cash" },
      ]),
    );
    // Judged separately both 6,000 rows would pass against 10,000. Together
    // they are 12,000 and must not.
    expect(result.allowed).toBe(false);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.amount).toBe("12000.00");
    expect(calls.filter((entry) => entry.startsWith("evaluate:"))).toHaveLength(1);
  });

  it("applies the Cash policy to Cash and the Bank policy to Bank", async () => {
    const { coordinator } = build({
      balances: { [`bank:${bankOne}`]: "0.00", [`cash:${cashOne}`]: "0.00" },
      policy: { ...basePolicy, bankOverdraftLimit: "500.00", cashPolicy: "block" },
    });
    const result = await coordinator.evaluate(
      transaction,
      request([
        { accountId: bankOne, amount: "100.00", kind: "bank" },
        { accountId: cashOne, amount: "100.00", kind: "cash" },
      ]),
    );
    const cash = result.accounts.find((a) => a.kind === "cash");
    const bank = result.accounts.find((a) => a.kind === "bank");
    // Cash cannot hold less than nothing; Bank may, within an arranged facility.
    expect(cash?.allowed).toBe(false);
    expect(cash?.appliedPolicy).toBe("block");
    expect(cash?.overdraftLimit).toBe("0.00");
    expect(bank?.allowed).toBe(true);
    expect(bank?.appliedPolicy).toBe("allow_within_overdraft");
    expect(bank?.overdraftLimit).toBe("500.00");
  });

  it("returns the coverage counts and does not block on them", async () => {
    const { coordinator } = build({
      balances: { [`cash:${cashOne}`]: "1000.00" },
      coverage: { ...zeroCoverage, payrollPaymentsWithoutCashAccount: 4 },
    });
    const result = await coordinator.evaluate(
      transaction,
      request([{ accountId: cashOne, amount: "10.00", kind: "cash" }]),
    );
    expect(result.balanceCoverageIncomplete).toBe(true);
    expect(result.coverage.payrollPaymentsWithoutCashAccount).toBe(4);
    // Advisory only. An incomplete balance is reported, never enforced on.
    expect(result.allowed).toBe(true);
  });

  it("reports complete coverage when every count is zero", async () => {
    const { coordinator } = build({ balances: { [`cash:${cashOne}`]: "1000.00" } });
    const result = await coordinator.evaluate(
      transaction,
      request([{ accountId: cashOne, amount: "10.00", kind: "cash" }]),
    );
    expect(result.balanceCoverageIncomplete).toBe(false);
  });

  it("accepts an override only with both the permission and a reason", async () => {
    const { coordinator } = build({
      balances: { [`cash:${cashOne}`]: "100.00" },
      policy: { ...basePolicy, cashPolicy: "allow_with_override" },
    });
    const result = await coordinator.evaluate(
      transaction,
      request([{ accountId: cashOne, amount: "250.00", kind: "cash" }], {
        actorPermissions: ["accounting.manage"],
        overrideReason: "Approved by Finance Director",
      }),
    );
    expect(result.allowed).toBe(true);
    expect(result.overrideAccepted).toBe(true);
    expect(result.overrideRequired).toBe(true);
    expect(result.requiresOverrideAudit).toBe(true);
  });

  it("rejects an override from an actor without the permission", async () => {
    const { coordinator } = build({
      balances: { [`cash:${cashOne}`]: "100.00" },
      policy: { ...basePolicy, cashPolicy: "allow_with_override" },
    });
    const result = await coordinator.evaluate(
      transaction,
      request([{ accountId: cashOne, amount: "250.00", kind: "cash" }], {
        actorPermissions: ["payroll.pay"],
        overrideReason: "Approved by Finance Director",
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.failureCode).toBe("balance_override_not_permitted");
    expect(result.requiresOverrideAudit).toBe(false);
  });

  it("rejects an override with no reason, even from an authorised actor", async () => {
    const { coordinator } = build({
      balances: { [`cash:${cashOne}`]: "100.00" },
      policy: { ...basePolicy, cashPolicy: "allow_with_override" },
    });
    const blank = await coordinator.evaluate(
      transaction,
      request([{ accountId: cashOne, amount: "250.00", kind: "cash" }], {
        actorPermissions: ["accounting.manage"],
        overrideReason: "   ",
      }),
    );
    expect(blank.allowed).toBe(false);
    expect(blank.failureCode).toBe("balance_override_reason_required");
    const absent = await coordinator.evaluate(
      transaction,
      request([{ accountId: cashOne, amount: "250.00", kind: "cash" }], {
        actorPermissions: ["accounting.manage"],
      }),
    );
    expect(absent.failureCode).toBe("balance_override_reason_required");
  });

  it("rejects a deduction that is not a positive finite amount", async () => {
    const { coordinator } = build({ balances: { [`cash:${cashOne}`]: "1000.00" } });
    for (const amount of ["0.00", "-5.00", "not-a-number"]) {
      await expect(
        coordinator.evaluate(transaction, request([{ accountId: cashOne, amount, kind: "cash" }])),
      ).rejects.toMatchObject({ errorCode: "balance_enforcement_amount_invalid" });
    }
  });
});

describe("BalanceEnforcementCoordinator.recordOverrides", () => {
  const allowed = {
    accounts: [
      {
        accountId: cashOne,
        allowed: true,
        amount: "250.00",
        appliedPolicy: "allow_with_override" as const,
        currentBalance: "100.00",
        failureCode: null,
        failureReason: null,
        kind: "cash" as const,
        overdraftLimit: "0.00",
        overrideAccepted: true,
        overrideRequired: true,
        policyId: basePolicy.id,
        projectedBalance: "-150.00",
        shortfall: "150.00",
      },
    ],
    allowed: true,
    balanceCoverageIncomplete: false,
    coverage: zeroCoverage,
    failureCode: null,
    failureReason: null,
    overrideAccepted: true,
    overrideRequired: true,
    policy: basePolicy,
    requiresOverrideAudit: true,
  };

  it("writes nothing when no account was overridden", async () => {
    const { coordinator } = build({});
    const written = await coordinator.recordOverrides(transaction, {
      actorId: "22222222-2222-4222-8222-222222222222",
      overrideReason: "reason",
      result: {
        ...allowed,
        accounts: [{ ...allowed.accounts[0]!, overrideAccepted: false, overrideRequired: false }],
        overrideAccepted: false,
        requiresOverrideAudit: false,
      },
      sourceEntityId: "33333333-3333-4333-8333-333333333333",
      sourceType: "payroll_payment",
    });
    expect(written).toEqual([]);
  });

  it("refuses to justify a payment that was blocked", async () => {
    const { coordinator } = build({});
    await expect(
      coordinator.recordOverrides(transaction, {
        actorId: "22222222-2222-4222-8222-222222222222",
        overrideReason: "reason",
        result: { ...allowed, allowed: false },
        sourceEntityId: "33333333-3333-4333-8333-333333333333",
        sourceType: "payroll_payment",
      }),
    ).rejects.toMatchObject({ errorCode: "balance_override_audit_not_permitted" });
  });

  it("refuses a blank reason", async () => {
    const { coordinator } = build({});
    await expect(
      coordinator.recordOverrides(transaction, {
        actorId: "22222222-2222-4222-8222-222222222222",
        overrideReason: "   ",
        result: allowed,
        sourceEntityId: "33333333-3333-4333-8333-333333333333",
        sourceType: "payroll_payment",
      }),
    ).rejects.toMatchObject({ errorCode: "balance_override_reason_required" });
  });

  it("requires a transaction", async () => {
    const { coordinator } = build({});
    await expect(
      coordinator.recordOverrides(pool, {
        actorId: "22222222-2222-4222-8222-222222222222",
        overrideReason: "reason",
        result: allowed,
        sourceEntityId: "33333333-3333-4333-8333-333333333333",
        sourceType: "payroll_payment",
      }),
    ).rejects.toMatchObject({ errorCode: "balance_enforcement_requires_transaction" });
  });
});

describe("BalanceEnforcementCoordinator.blockedDetails", () => {
  it("labels each account so a split payment says which one failed", async () => {
    const { coordinator } = build({
      balances: { [`bank:${bankOne}`]: "10.00", [`cash:${cashTwo}`]: "1000.00" },
    });
    const result = await coordinator.evaluate(
      transaction,
      request([
        { accountId: bankOne, amount: "100.00", kind: "bank" },
        { accountId: cashTwo, amount: "200.00", kind: "cash" },
      ]),
    );
    const details = coordinator.blockedDetails(result);
    expect(details.some((line) => line.startsWith("Cash account —"))).toBe(true);
    expect(details.some((line) => line.startsWith("Bank account —"))).toBe(true);
    expect(details.some((line) => line.includes("projected balance: -90.00"))).toBe(true);
    // No identifiers leak into a message a User reads.
    expect(details.some((line) => line.includes(bankOne))).toBe(false);
    expect(details.some((line) => line.includes(basePolicy.id))).toBe(false);
  });

  it("states the coverage gap when the balances are known to be understated", async () => {
    const { coordinator } = build({
      balances: { [`cash:${cashOne}`]: "0.00" },
      coverage: { ...zeroCoverage, payrollPaymentsWithoutCashAccount: 4, traderSettlementCashPaymentsWithoutCashAccount: 20 },
    });
    const result = await coordinator.evaluate(
      transaction,
      request([{ accountId: cashOne, amount: "1.00", kind: "cash" }]),
    );
    const details = coordinator.blockedDetails(result);
    expect(details.some((line) => line.includes("24 earlier confirmed payments"))).toBe(true);
  });
});
