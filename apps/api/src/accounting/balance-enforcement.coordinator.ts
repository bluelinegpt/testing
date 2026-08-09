import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import type { Transaction } from "kysely";
import { sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import {
  BalanceControlService,
  type BalanceCheckResult,
  type BalanceOverrideSourceType,
  type CompanyBalancePolicy,
} from "./balance-control.service.js";
import {
  FundingAccountBalanceService,
  type FundingAccountBalanceCoverage,
} from "./funding-account-balance.service.js";
import { FundingAccountLockService } from "./funding-account-lock.service.js";
import type { PaymentAccountKind } from "./payment-funding-account.service.js";

/**
 * Lock, read, decide -- once, for every account a payment draws on.
 *
 * ===========================================================================
 * WHY THE THREE STEPS BELONG IN ONE PLACE
 * ===========================================================================
 *
 * Three services already exist and each is correct on its own: one takes the
 * row locks, one reads the authoritative balance, one knows the policy. What
 * none of them can enforce is the ORDER, and the order is the whole control.
 *
 * Read before lock, and the balance is a fact about the past -- two payments
 * each see 10,000, each approve their 6,000, and the account lands at -2,000
 * with neither payment having broken the rule. Lock after deciding, and the
 * decision was made against a figure that could still move. Only lock, then
 * read, then decide, inside one transaction, produces a verdict that is still
 * true when the payment commits.
 *
 * Leaving that sequence to each payment workflow would mean four workflows
 * getting it right four times, and the one that got it wrong would be the one
 * nobody tested under concurrency. So it is written once, here.
 *
 * ===========================================================================
 * IT DECIDES; IT DOES NOT PAY, POST, OR OVERRIDE
 * ===========================================================================
 *
 * This coordinator writes NOTHING in `evaluate()`. No payment, no Event, no
 * Journal, no account update, and -- deliberately -- no override audit either.
 *
 * The audit is separated into `recordOverrides()` because an override record is
 * evidence about a payment that happened. Written during evaluation it would
 * survive a rolled-back payment as an accusation about money that never moved,
 * and a caller previewing a payment twice would leave two. So the audit is the
 * caller's last step, after the insert it justifies has succeeded.
 *
 * ===========================================================================
 * THE COVERAGE GAP IS REPORTED, NOT ENFORCED ON
 * ===========================================================================
 *
 * Payments written before the funding-account columns existed cannot be
 * attributed to an account, so the balance is short by an unknown amount in any
 * Company that has them. This coordinator surfaces that as
 * `balanceCoverageIncomplete` with the underlying counts, and does NOT block on
 * it.
 *
 * Blocking on it would refuse every payment in a Company with any history at
 * all. Silently ignoring it would present an incomplete figure as a complete
 * one. Reporting it hands the judgement to the workflow and the person, which
 * is where it belongs until the gap is closed.
 */

export interface FundingAccountDeduction {
  readonly accountId: string;
  /** Positive magnitude of the money leaving the account. */
  readonly amount: string;
  readonly kind: PaymentAccountKind;
}

export interface BalanceEnforcementRequest {
  readonly actorId: string;
  /** Permissions the actor actually holds, resolved by the caller. */
  readonly actorPermissions: readonly string[];
  readonly deductions: readonly FundingAccountDeduction[];
  /** The date the policy should be read at. Defaults to today. */
  readonly onDate?: string;
  readonly overrideReason?: string;
  // The three source fields below are NOT read by `evaluate()`, which writes
  // nothing. They are declared here so one request object describes the whole
  // operation and can be handed straight to `recordOverrides()` afterwards,
  // rather than the caller assembling the same identity twice and risking two
  // different answers to "what was this payment".
  /** The record being paid, once it exists. Required to record an audit. */
  readonly sourceEntityId?: string;
  /** Human-facing number, so the audit is legible without a join. */
  readonly sourceReference?: string;
  readonly sourceType: BalanceOverrideSourceType;
}

/** One account's verdict, with the account it is about attached. */
export interface BalanceEnforcementAccountResult extends BalanceCheckResult {
  readonly accountId: string;
  readonly kind: PaymentAccountKind;
}

export interface BalanceEnforcementResult {
  readonly accounts: readonly BalanceEnforcementAccountResult[];
  /** Every account passed. One failure fails the whole payment. */
  readonly allowed: boolean;
  /**
   * The balance omits confirmed payments that never recorded their account.
   * ADVISORY: it does not affect `allowed`.
   */
  readonly balanceCoverageIncomplete: boolean;
  readonly coverage: FundingAccountBalanceCoverage;
  /** First failure in deterministic lock order, or null. */
  readonly failureCode: BalanceCheckResult["failureCode"];
  readonly failureReason: string | null;
  readonly overrideAccepted: boolean;
  readonly overrideRequired: boolean;
  readonly policy: CompanyBalancePolicy;
  /**
   * True when a committed payment MUST be followed by `recordOverrides()`.
   * False when nothing was overridden and there is nothing to record.
   */
  readonly requiresOverrideAudit: boolean;
}

@Injectable()
export class BalanceEnforcementCoordinator {
  public constructor(
    @Inject(FundingAccountLockService) private readonly locks: FundingAccountLockService,
    @Inject(FundingAccountBalanceService)
    private readonly balances: FundingAccountBalanceService,
    @Inject(BalanceControlService) private readonly control: BalanceControlService,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
  ) {}

  /**
   * Lock every account, read every balance, judge every deduction.
   *
   * `transaction` is required and typed as `Transaction`: the locks this takes
   * are released the moment a non-transactional statement returns, which would
   * leave the caller holding a verdict it believes is protected and is not.
   *
   * Writes nothing. Calling it twice changes nothing.
   */
  public async evaluate(
    transaction: Transaction<DatabaseSchema>,
    request: BalanceEnforcementRequest,
  ): Promise<BalanceEnforcementResult> {
    if (!transaction.isTransaction) {
      throw new ApplicationException(
        "balance_enforcement_requires_transaction",
        "The balance check requires an active transaction",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    if (request.deductions.length === 0) {
      throw new ApplicationException(
        "balance_enforcement_deduction_required",
        "A balance check needs at least one funding account",
        HttpStatus.BAD_REQUEST,
      );
    }

    // STEP 1 -- lock. Deduplicated and deterministically ordered by the lock
    // service, so two concurrent split payments over the same pair of accounts
    // queue instead of deadlocking. Account existence and Company ownership are
    // settled here; nothing below has to re-check them.
    const locked = await this.locks.lockAll(
      transaction,
      request.deductions.map((deduction) => ({
        accountId: deduction.accountId,
        kind: deduction.kind,
      })),
    );

    // Several deductions may name the SAME account -- two General Expense rows
    // from one drawer. They are judged against their combined total, because
    // judging them separately would pass two 6,000 payments against a 10,000
    // balance by never asking about the 12,000.
    const totals = new Map<string, Decimal>();
    for (const deduction of request.deductions) {
      const amount = this.money(deduction.amount);
      const key = `${deduction.kind}:${deduction.accountId.trim()}`;
      totals.set(key, (totals.get(key) ?? new Decimal(0)).plus(amount));
    }

    // The policy is read once for every account. Re-reading it per account
    // could straddle an effective-date boundary and judge two halves of one
    // payment under two different rules.
    const policy = await this.control.policyFor(request.onDate);

    const accounts: BalanceEnforcementAccountResult[] = [];
    let coverage: FundingAccountBalanceCoverage | undefined;
    // Iterated in LOCK order, so `failureCode` below is deterministic: the same
    // request always reports the same account as the blocking one.
    for (const account of locked) {
      // STEP 2 -- read, inside the caller's transaction and behind the lock
      // just taken. The authoritative calculation is reused, never restated.
      const balance = await this.balances.current(account.kind, account.accountId, transaction);
      coverage ??= balance.coverage;
      const amount = totals.get(`${account.kind}:${account.accountId}`) ?? new Decimal(0);
      // STEP 3 -- decide. The policy is already resolved, so this is pure.
      const verdict = this.control.evaluate(
        {
          accountId: account.accountId,
          accountKind: account.kind,
          actorPermissions: request.actorPermissions,
          amount: amount.toFixed(2),
          currentBalance: balance.balance,
          direction: "outbound",
          // Spread conditionally rather than passed as undefined: under
          // exactOptionalPropertyTypes an absent option and an explicitly
          // undefined one are different things.
          ...(request.onDate === undefined ? {} : { onDate: request.onDate }),
          ...(request.overrideReason === undefined
            ? {}
            : { overrideReason: request.overrideReason }),
        },
        policy,
      );
      accounts.push({ ...verdict, accountId: account.accountId, kind: account.kind });
    }

    const blocked = accounts.find((account) => !account.allowed);
    const resolvedCoverage = coverage ?? {
      generalExpenseCashRowsWithoutCompanyCashAccount: 0,
      outsourcedDriverFeeCashPaymentsWithoutCashAccount: 0,
      payrollPaymentsWithoutCashAccount: 0,
      traderSettlementCashPaymentsWithoutCashAccount: 0,
    };
    const overrideAccepted = accounts.some((account) => account.overrideAccepted);
    return {
      accounts,
      // Every account must pass. A split payment half-permitted is not
      // permitted -- the caller cannot pay half of it.
      allowed: blocked === undefined,
      balanceCoverageIncomplete: Object.values(resolvedCoverage).some((count) => count > 0),
      coverage: resolvedCoverage,
      failureCode: blocked?.failureCode ?? null,
      failureReason: blocked?.failureReason ?? null,
      overrideAccepted,
      overrideRequired: accounts.some((account) => account.overrideRequired),
      policy,
      // Only an ALLOWED payment that leaned on an override has anything to
      // record. A blocked one never happened.
      requiresOverrideAudit: blocked === undefined && overrideAccepted,
    };
  }

  /**
   * Record the override audits for a payment that has just been inserted.
   *
   * Call this LAST, in the same transaction as the payment, and only when
   * `requiresOverrideAudit` is true. It writes one row per overridden account
   * and nothing else.
   *
   * `sourceEntityId` is mandatory here even though the audit column is
   * nullable: it is what makes the record attributable, and what makes the
   * duplicate check below possible. An audit that cannot name what it justifies
   * cannot be deduplicated and cannot be audited.
   *
   * Returns the audit ids written, which is empty when they already existed.
   */
  public async recordOverrides(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly actorId: string;
      readonly overrideReason: string;
      readonly result: BalanceEnforcementResult;
      readonly sourceEntityId: string;
      readonly sourceReference?: string;
      readonly sourceType: BalanceOverrideSourceType;
    },
  ): Promise<readonly string[]> {
    if (!transaction.isTransaction) {
      throw new ApplicationException(
        "balance_enforcement_requires_transaction",
        "Recording a balance override requires an active transaction",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    if (!input.result.allowed) {
      // A blocked payment did not happen, so there is nothing to justify.
      throw new ApplicationException(
        "balance_override_audit_not_permitted",
        "A blocked payment cannot record a balance override",
        HttpStatus.CONFLICT,
      );
    }
    const reason = input.overrideReason.trim();
    if (reason === "") {
      throw new ApplicationException(
        "balance_override_reason_required",
        "A written reason is required to record a balance override",
        HttpStatus.BAD_REQUEST,
      );
    }
    const overridden = input.result.accounts.filter((account) => account.overrideAccepted);
    if (overridden.length === 0) return [];

    const written: string[] = [];
    for (const account of overridden) {
      // Idempotent retry guard. `reserveIdempotency` already replays a repeated
      // request without re-running the body, so this covers the narrower case:
      // a caller invoking finalisation twice for one payment inside one
      // transaction. There is no unique index to lean on, and adding one is a
      // migration this step does not own -- so the check is explicit, and it is
      // inside the transaction that holds the account lock, which is what makes
      // it a check rather than a race.
      const existing = await sql<{ id: string }>`
        select id from balance_override_audits
         where company_id=${this.tenants.current().companyId}::uuid
           and source_type=${input.sourceType}
           and source_entity_id=${input.sourceEntityId}::uuid
           and account_kind=${account.kind}
           and ${account.kind === "cash" ? sql`company_cash_account_id` : sql`company_bank_account_id`}
               =${account.accountId}::uuid
         limit 1
      `.execute(transaction);
      if (existing.rows[0] !== undefined) continue;
      written.push(
        await this.control.recordOverride(transaction, {
          accountId: account.accountId,
          accountKind: account.kind,
          actorId: input.actorId,
          direction: "outbound",
          reason,
          // The verdict is passed through unchanged, so the record cannot
          // disagree with the decision that authorised it.
          result: account,
          sourceEntityId: input.sourceEntityId,
          ...(input.sourceReference === undefined
            ? {}
            : { sourceReference: input.sourceReference }),
          sourceType: input.sourceType,
        }),
      );
    }
    return written;
  }

  /**
   * The human-facing detail lines for a blocked result.
   *
   * Formatting lives here rather than in each workflow because the figures come
   * from here: a workflow that formatted its own would be free to omit the
   * overdraft limit, or to report a different account than the one that
   * actually blocked, and nothing would catch it.
   *
   * ONE LINE PER ACCOUNT, kind-labelled. A split payment blocked on its Bank
   * account while its Cash account was fine must say which was which -- a
   * single unlabelled set of figures would send someone to look at the wrong
   * drawer.
   *
   * Deliberately business facts only: the User's own balance, what they tried
   * to pay, where it would land, and the rule that stopped it. No account ids,
   * no policy row id, no coverage internals beyond the count.
   *
   * Payroll, outsourced Driver fees and Trader Settlements still each carry a
   * local copy of an earlier, single-account version of this. Migrating them is
   * mechanical and belongs in its own change; they are untouched here.
   */
  public blockedDetails(result: BalanceEnforcementResult): readonly string[] {
    const details = result.accounts.flatMap((account) => {
      const label = account.kind === "cash" ? "Cash account" : "Bank account";
      return [
        `${label} — current balance: ${account.currentBalance}`,
        `${label} — payment amount: ${account.amount}`,
        `${label} — projected balance: ${account.projectedBalance}`,
        `${label} — applied policy: ${account.appliedPolicy}`,
        `${label} — overdraft limit: ${account.overdraftLimit}`,
        ...(account.failureReason === null
          ? []
          : [`${label} — ${account.failureReason}`]),
      ];
    });
    if (result.balanceCoverageIncomplete) {
      // Stated even when blocking. Someone told their balance is too low is
      // entitled to know the figure is itself understated.
      const total = Object.values(result.coverage).reduce((sum, count) => sum + count, 0);
      details.push(
        `Balance coverage incomplete: ${total} earlier confirmed payments do not record which account funded them and are excluded from these balances.`,
      );
    }
    return details;
  }

  /** A deduction must be a real, positive, finite amount. */
  private money(value: string): Decimal {
    let amount: Decimal;
    try {
      amount = new Decimal(value);
    } catch {
      throw new ApplicationException(
        "balance_enforcement_amount_invalid",
        "The payment amount is not a valid figure",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!amount.isFinite() || !amount.greaterThan(0)) {
      throw new ApplicationException(
        "balance_enforcement_amount_invalid",
        "The payment amount is not a valid figure",
        HttpStatus.BAD_REQUEST,
      );
    }
    return amount;
  }
}
