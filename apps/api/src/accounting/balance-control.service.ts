import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { IdentityContextAccessor } from "../security/identity-context.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

/**
 * Decides whether a payment may take a Cash or Bank account below zero.
 *
 * ===========================================================================
 * IT DECIDES; IT DOES NOT ENFORCE
 * ===========================================================================
 *
 * This service returns a VERDICT. It moves no money, writes no payment, and
 * posts nothing. The workflow that called it stays responsible for honouring
 * the answer, and for doing so inside its own transaction.
 *
 * That split is deliberate. A database trigger enforcing the same rule would
 * fire in the middle of somebody else's transaction with no idea what business
 * operation it was interrupting, and could offer nothing better than a
 * constraint-violation error. A caller that asks first can explain the problem,
 * show the shortfall, and offer an override to somebody entitled to give one.
 *
 * ===========================================================================
 * THE BALANCE IS AN INPUT, NOT SOMETHING THIS SERVICE FETCHES
 * ===========================================================================
 *
 * `currentBalance` is supplied by the caller rather than read here, because
 * only the caller knows which balance is authoritative for its operation and
 * which rows it has already locked. Reading it independently would produce a
 * figure from outside the caller's transaction -- correct at the moment of the
 * read and stale by the time the payment commits, which is precisely the race
 * this control exists to prevent.
 *
 * So the honest division is: the caller locks the account and knows the
 * balance; this service knows the policy.
 *
 * ===========================================================================
 * WHY CASH HAS NO OVERDRAFT
 * ===========================================================================
 *
 * A cash drawer cannot hold less than nothing. A negative Cash balance is a
 * counting error -- an unrecorded collection, a double-entered payment -- and
 * the fix is to find it, not to finance it. Bank is different: an overdraft is
 * a real facility a Company arranges, so Bank gets a limit and Cash does not.
 */

export type BalanceAccountKind = "bank" | "cash";

/** Inbound money can only raise a balance, so it is never blocked. */
export type BalanceDirection = "inbound" | "outbound";

export type CashBalancePolicy = "allow" | "allow_with_override" | "block";
export type BankBalancePolicy = CashBalancePolicy | "allow_within_overdraft";

export interface CompanyBalancePolicy {
  readonly bankOverdraftLimit: string;
  readonly bankPolicy: BankBalancePolicy;
  readonly cashPolicy: CashBalancePolicy;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly id: string;
  readonly overridePermission: string;
}

/** One effective-dated rule, as the configuration screen sees it. */
export interface BalanceScheduleEntry extends CompanyBalancePolicy {
  readonly changeReason: string;
  readonly isActive: boolean;
  readonly isCurrent: boolean;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

export interface BalanceCheckInput {
  readonly accountKind: BalanceAccountKind;
  /** The Cash or Bank account id. Carried through to the audit record. */
  readonly accountId: string;
  /** Permissions the actor actually holds, resolved by the caller. */
  readonly actorPermissions: readonly string[];
  /** Balance the CALLER read, inside the CALLER's transaction. */
  readonly currentBalance: string;
  readonly direction: BalanceDirection;
  /** Positive magnitude. Direction carries the sign. */
  readonly amount: string;
  /** Present only when the actor is deliberately overriding. */
  readonly overrideReason?: string;
  /** The date the policy should be read at. Defaults to today. */
  readonly onDate?: string;
}

export interface BalanceCheckResult {
  readonly allowed: boolean;
  readonly amount: string;
  readonly appliedPolicy: BankBalancePolicy;
  readonly currentBalance: string;
  /** Machine-readable reason a blocked check failed. */
  readonly failureCode:
    | "balance_override_not_permitted"
    | "balance_override_reason_required"
    | "balance_would_go_negative"
    | "balance_would_exceed_overdraft"
    | null;
  /** One sentence a person can act on. */
  readonly failureReason: string | null;
  readonly overdraftLimit: string;
  readonly overrideAccepted: boolean;
  readonly overrideRequired: boolean;
  readonly policyId: string;
  readonly projectedBalance: string;
  /** How far past the permitted floor the payment would go. */
  readonly shortfall: string;
}

/** What the workflow was doing when it asked. Extend as workflows are wired. */
export type BalanceOverrideSourceType =
  | "cash_bank_movement"
  | "general_expense_payment"
  | "outsourced_driver_fee_payment"
  | "payroll_payment"
  | "employee_variable_earnings_payment"
  | "employee_salary_advance"
  | "refund"
  | "trader_settlement";

/** The recommended policy, used when a Company somehow has no active rule. */
const fallbackPolicy: CompanyBalancePolicy = {
  bankOverdraftLimit: "0.00",
  bankPolicy: "allow_within_overdraft",
  cashPolicy: "block",
  effectiveFrom: null,
  effectiveTo: null,
  id: "00000000-0000-0000-0000-000000000000",
  overridePermission: "accounting.manage",
};

@Injectable()
export class BalanceControlService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  /**
   * Active policy, anything scheduled ahead of it, and the history behind it.
   *
   * Returned together because a person configuring this needs all three to
   * answer the only question that matters: what is in force now, and what is
   * about to change.
   */
  public async policySchedule(): Promise<{
    readonly active: BalanceScheduleEntry | null;
    readonly history: readonly BalanceScheduleEntry[];
    readonly scheduled: readonly BalanceScheduleEntry[];
  }> {
    const { companyId } = this.tenants.current();
    const result = await sql<BalanceScheduleEntry>`
      select p.id, p.cash_policy as "cashPolicy", p.bank_policy as "bankPolicy",
             p.bank_overdraft_limit::text as "bankOverdraftLimit",
             p.override_permission as "overridePermission",
             p.effective_from::text as "effectiveFrom", p.effective_to::text as "effectiveTo",
             p.is_active as "isActive", p.change_reason as "changeReason",
             p.updated_at::text as "updatedAt", a.username as "updatedBy",
             (p.effective_from <= current_date
              and (p.effective_to is null or current_date < p.effective_to)) as "isCurrent"
        from company_balance_policies p
        left join accounts a on a.id=p.created_by_account_id and a.company_id=p.company_id
       where p.company_id=${companyId}::uuid
       order by p.effective_from desc, p.id
    `.execute(this.database);
    const rows = result.rows;
    return {
      active: rows.find((row) => row.isCurrent && row.isActive) ?? null,
      history: rows.filter(
        (row) => !row.isCurrent && row.effectiveFrom !== null && !this.isFuture(row.effectiveFrom),
      ),
      scheduled: rows.filter(
        (row) => row.isActive && !row.isCurrent && this.isFuture(row.effectiveFrom),
      ),
    };
  }

  /**
   * Schedule a new policy from a date.
   *
   * Supersede, never overwrite. The active rule is CLOSED at the new start date
   * and a new row takes over, so "what was the rule when this payment was
   * blocked" stays answerable. Editing the active row in place would rewrite
   * the past and orphan every override audited under the old terms.
   *
   * Both statements run in one transaction: a closed old rule with no new one
   * would leave the Company with no policy at all, and the service would fall
   * back to blocking everything.
   */
  public async savePolicy(input: {
    readonly bankOverdraftLimit?: string;
    readonly bankPolicy: BankBalancePolicy;
    readonly cashPolicy: CashBalancePolicy;
    readonly changeReason: string;
    readonly effectiveFrom: string;
  }): Promise<BalanceScheduleEntry> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    // Retroactive policy is refused rather than supported. Backdating would
    // change the rule a past decision was judged against, which is the one
    // thing effective dating exists to prevent.
    if (!this.isFuture(input.effectiveFrom, true)) {
      throw new ApplicationException(
        "balance_policy_effective_date_past",
        "A balance policy can start today or later, never in the past",
        HttpStatus.BAD_REQUEST,
      );
    }
    const limit =
      input.bankPolicy === "allow_within_overdraft"
        ? new Decimal(input.bankOverdraftLimit ?? "0").abs().toFixed(2)
        : "0.00";
    return this.transactions.execute(async (transaction) => {
      // Close whatever is in force at the new start date. `effective_to` is
      // EXCLUSIVE, so setting it to the new start leaves no uncovered day and
      // no overlapping one.
      await sql`
        update company_balance_policies
           set effective_to=${input.effectiveFrom}::date, updated_at=now(),
               version=version+1
         where company_id=${companyId}::uuid and is_active
           and effective_from < ${input.effectiveFrom}::date
           and (effective_to is null or effective_to > ${input.effectiveFrom}::date)
      `.execute(transaction);
      // Anything already scheduled at or after the new date is retired rather
      // than left to fight the newcomer for the same period.
      await sql`
        update company_balance_policies
           set is_active=false, updated_at=now(), version=version+1
         where company_id=${companyId}::uuid and is_active
           and effective_from >= ${input.effectiveFrom}::date
      `.execute(transaction);
      const inserted = await sql<BalanceScheduleEntry>`
        insert into company_balance_policies (
          company_id, cash_policy, bank_policy, bank_overdraft_limit,
          effective_from, change_reason, created_by_account_id
        ) values (
          ${companyId}::uuid, ${input.cashPolicy}, ${input.bankPolicy}, ${limit},
          ${input.effectiveFrom}::date, ${input.changeReason.trim()}, ${actorId}::uuid
        )
        returning id, cash_policy as "cashPolicy", bank_policy as "bankPolicy",
                  bank_overdraft_limit::text as "bankOverdraftLimit",
                  override_permission as "overridePermission",
                  effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
                  is_active as "isActive", change_reason as "changeReason",
                  updated_at::text as "updatedAt",
                  null::text as "updatedBy", true as "isCurrent"
      `.execute(transaction);
      return inserted.rows[0]!;
    });
  }

  /** Is this date today or later? `-infinity` never is. */
  private isFuture(date: string | null, includeToday = true): boolean {
    if (date === null || date.startsWith("-")) return false;
    const today = new Date().toISOString().slice(0, 10);
    return includeToday ? date >= today : date > today;
  }

  /** The Company policy in force on a date. */
  public async policyFor(onDate?: string): Promise<CompanyBalancePolicy> {
    const { companyId } = this.tenants.current();
    const result = await sql<CompanyBalancePolicy>`
      select id, cash_policy as "cashPolicy", bank_policy as "bankPolicy",
             bank_overdraft_limit::text as "bankOverdraftLimit",
             override_permission as "overridePermission",
             effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"
        from company_balance_policies
       where company_id=${companyId}::uuid and is_active
         and effective_from <= coalesce(${onDate ?? null}::date, current_date)
         and (effective_to is null
              or coalesce(${onDate ?? null}::date, current_date) < effective_to)
       limit 1
    `.execute(this.database);
    // The exclusion constraint guarantees at most one match, and the seeded
    // '-infinity' row guarantees at least one. The fallback is for a Company
    // created before this migration ran, where blocking is the safe answer.
    return result.rows[0] ?? fallbackPolicy;
  }

  /**
   * Would this payment take the account below its permitted floor?
   *
   * Pure with respect to the database except for reading the policy: it writes
   * nothing, and calling it twice changes nothing.
   */
  public async check(input: BalanceCheckInput): Promise<BalanceCheckResult> {
    const policy = await this.policyFor(input.onDate);
    return this.evaluate(input, policy);
  }

  /**
   * The decision itself, with the policy already resolved.
   *
   * Split out so a caller that already holds the policy -- a batch paying
   * twenty Employees, say -- can decide twenty times without re-reading it.
   */
  public evaluate(input: BalanceCheckInput, policy: CompanyBalancePolicy): BalanceCheckResult {
    const current = new Decimal(input.currentBalance);
    const amount = new Decimal(input.amount).abs();
    const projected = input.direction === "inbound" ? current.plus(amount) : current.minus(amount);
    const applied: BankBalancePolicy =
      input.accountKind === "cash" ? policy.cashPolicy : policy.bankPolicy;
    // Overdraft is a Bank concept only, and only under the one policy that
    // reads it. Reporting it as zero elsewhere keeps the response honest.
    const overdraftLimit =
      input.accountKind === "bank" && applied === "allow_within_overdraft"
        ? new Decimal(policy.bankOverdraftLimit).abs()
        : new Decimal(0);
    const floor = overdraftLimit.negated();

    const base = {
      amount: amount.toFixed(2),
      appliedPolicy: applied,
      currentBalance: current.toFixed(2),
      overdraftLimit: overdraftLimit.toFixed(2),
      policyId: policy.id,
      projectedBalance: projected.toFixed(2),
    };
    const permitted = {
      ...base,
      allowed: true,
      failureCode: null,
      failureReason: null,
      overrideAccepted: false,
      overrideRequired: false,
      shortfall: "0.00",
    } as const;

    // Money coming IN can only raise the balance. Checking it would block a
    // collection that fixes the very shortfall the policy is worried about.
    if (input.direction === "inbound") return permitted;
    // greaterThanOrEqualTo, not greaterThan: landing exactly on the floor is
    // within the limit, not one fil past it.
    if (projected.greaterThanOrEqualTo(floor)) return permitted;
    if (applied === "allow") return permitted;

    const shortfall = floor.minus(projected).toFixed(2);
    const blocked = { ...base, allowed: false, overrideAccepted: false, shortfall };

    if (applied === "block" || applied === "allow_within_overdraft") {
      const overdrawn = applied === "allow_within_overdraft" && overdraftLimit.greaterThan(0);
      return {
        ...blocked,
        failureCode: overdrawn ? "balance_would_exceed_overdraft" : "balance_would_go_negative",
        failureReason: overdrawn
          ? `This payment would take the account to ${projected.toFixed(2)}, which is ${shortfall} beyond the approved overdraft of ${overdraftLimit.toFixed(2)}.`
          : `This payment would take the account to ${projected.toFixed(2)}. The balance cannot go below zero.`,
        overrideRequired: false,
      };
    }

    // allow_with_override: permitted, but only by someone entitled to say so,
    // and only with a reason. Both are required; neither substitutes for the
    // other, because an unexplained authorised override is still unexplained.
    const reason = (input.overrideReason ?? "").trim();
    if (!input.actorPermissions.includes(policy.overridePermission)) {
      return {
        ...blocked,
        failureCode: "balance_override_not_permitted",
        failureReason: `This payment would take the account to ${projected.toFixed(2)}. Only a user with ${policy.overridePermission} can authorise a negative balance.`,
        overrideRequired: true,
      };
    }
    if (reason === "") {
      return {
        ...blocked,
        failureCode: "balance_override_reason_required",
        failureReason: `This payment would take the account to ${projected.toFixed(2)}. A written reason is required to authorise it.`,
        overrideRequired: true,
      };
    }
    return {
      ...base,
      allowed: true,
      failureCode: null,
      failureReason: null,
      overrideAccepted: true,
      overrideRequired: true,
      shortfall,
    };
  }

  /**
   * Record an accepted override.
   *
   * Takes the caller's transaction so the evidence commits with the payment it
   * justifies: an override recorded for a payment that rolled back would be a
   * false accusation, and a payment committed without its override record would
   * be an unexplained one.
   *
   * Everything written is a snapshot of the decision. `check()` already produced
   * these figures, so nothing is recalculated and the record cannot disagree
   * with the verdict that authorised it.
   */
  public async recordOverride(
    database: Kysely<DatabaseSchema>,
    input: {
      readonly accountId: string;
      readonly accountKind: BalanceAccountKind;
      readonly actorId: string;
      readonly direction: BalanceDirection;
      readonly reason: string;
      readonly result: BalanceCheckResult;
      readonly sourceEntityId?: string;
      readonly sourceReference?: string;
      readonly sourceType: BalanceOverrideSourceType;
    },
  ): Promise<string> {
    const { companyId } = this.tenants.current();
    const isCash = input.accountKind === "cash";
    const result = await sql<{ id: string }>`
      insert into balance_override_audits (
        company_id, company_cash_account_id, company_bank_account_id, account_kind,
        source_type, source_reference, source_entity_id, direction,
        transaction_amount, current_balance, projected_balance,
        applied_policy, overdraft_limit_snapshot, policy_id,
        override_reason, override_by_account_id
      ) values (
        ${companyId}::uuid,
        ${isCash ? input.accountId : null}::uuid,
        ${isCash ? null : input.accountId}::uuid,
        ${input.accountKind}, ${input.sourceType}, ${input.sourceReference ?? null},
        ${input.sourceEntityId ?? null}::uuid, ${input.direction},
        ${input.result.amount}, ${input.result.currentBalance},
        ${input.result.projectedBalance}, ${input.result.appliedPolicy},
        ${input.result.overdraftLimit}, ${input.result.policyId}::uuid,
        ${input.reason}, ${input.actorId}::uuid
      )
      returning id
    `.execute(database);
    return result.rows[0]!.id;
  }
}
