import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { sql, type Transaction } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import type { PaymentAccountKind } from "./payment-funding-account.service.js";

/**
 * Row locks on the Cash and Bank accounts a payment is about to draw on.
 *
 * ===========================================================================
 * WHY A LOCK IS NEEDED BEFORE A BALANCE IS READ
 * ===========================================================================
 *
 * A balance read without a lock is a fact about the past. Two payments against
 * the same Cash account can each read "10,000 available", each judge their
 * 6,000 acceptable, and both commit -- leaving the account at -2,000 with no
 * single payment having broken the rule. Serialising on the ACCOUNT ROW is what
 * turns the read into a fact that is still true at commit.
 *
 * The lock is taken on the authoritative account row -- `company_cash_accounts`
 * or `company_bank_accounts` -- rather than on the payment tables, because the
 * account is the one thing every workflow drawing on it has in common. Payroll,
 * outsourced Driver fees, General Expense and Trader Settlements all lock the
 * same row, so they queue behind each other rather than racing.
 *
 * ===========================================================================
 * DETERMINISTIC ORDER IS THE WHOLE POINT OF LOCKING SEVERAL AT ONCE
 * ===========================================================================
 *
 * A General Expense payment can split across a Cash and a Bank account, so a
 * caller may need two locks. Two such payments taking the same two locks in
 * opposite orders is a textbook deadlock: A holds cash and waits for bank, B
 * holds bank and waits for cash, and PostgreSQL resolves it by killing one
 * transaction.
 *
 * So this helper does not lock what it is given, in the order it is given. It
 * SORTS -- cash before bank, then by account id -- and locks sequentially in
 * that order. Every caller in the system therefore acquires any overlapping set
 * of locks in the same sequence, and the cycle that a deadlock requires cannot
 * form. The ordering is a property of this helper, not a rule each caller has
 * to remember, which is the only version of it that stays true.
 *
 * Duplicates are removed first. Asking twice for the same row is harmless in
 * PostgreSQL, but it makes the second lock a no-op that reads like a second
 * acquisition, and a caller counting the returned rows would be misled.
 *
 * ===========================================================================
 * IT LOCKS; IT DOES NOTHING ELSE
 * ===========================================================================
 *
 * No balance is computed, no policy is evaluated, no account row is updated and
 * no payment is written. `select ... for update` takes the lock and discards
 * everything but the identity it confirms. Balance evaluation and enforcement
 * are separate, later steps and remain disabled.
 */

/** Cash before Bank, everywhere. The order itself is arbitrary; its being the
 * SAME arbitrary order in every caller is what prevents the deadlock. */
const kindRank: Readonly<Record<PaymentAccountKind, number>> = { bank: 1, cash: 0 };

export interface FundingAccountLockRequest {
  readonly accountId: string;
  readonly kind: PaymentAccountKind;
}

export interface LockedFundingAccount {
  readonly accountId: string;
  readonly kind: PaymentAccountKind;
}

@Injectable()
export class FundingAccountLockService {
  public constructor(
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
  ) {}

  /**
   * Lock every named account for the rest of the caller's transaction.
   *
   * `transaction` is typed as `Transaction`, not `Kysely`, so a caller cannot
   * pass the pool by accident. A lock taken outside a transaction is released
   * the instant the statement returns, which would leave the caller believing
   * it held something it does not -- worse than not locking at all. The runtime
   * check below covers the cast-away case.
   *
   * Returns the locked accounts in the order they were locked.
   */
  public async lockAll(
    transaction: Transaction<DatabaseSchema>,
    requests: readonly FundingAccountLockRequest[],
  ): Promise<readonly LockedFundingAccount[]> {
    if (!transaction.isTransaction) {
      throw new ApplicationException(
        "funding_account_lock_requires_transaction",
        "The funding account lock requires an active transaction",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    const ordered = this.plan(requests);
    const locked: LockedFundingAccount[] = [];
    // Sequential, deliberately. Issuing these concurrently would let the
    // database acquire them in arrival order rather than the sorted order, and
    // the sorting would buy nothing.
    for (const request of ordered) {
      await this.lockRow(transaction, request);
      locked.push(request);
    }
    return locked;
  }

  /** One account. Same rules; the common case spelled out. */
  public async lock(
    transaction: Transaction<DatabaseSchema>,
    kind: PaymentAccountKind,
    accountId: string,
  ): Promise<LockedFundingAccount> {
    const [locked] = await this.lockAll(transaction, [{ accountId, kind }]);
    return locked!;
  }

  /**
   * The de-duplicated, deterministically ordered lock sequence.
   *
   * Separated from the locking so the ordering rule can be reasoned about on
   * its own: it is pure, and it is what the deadlock argument above rests on.
   */
  private plan(
    requests: readonly FundingAccountLockRequest[],
  ): readonly FundingAccountLockRequest[] {
    const unique = new Map<string, FundingAccountLockRequest>();
    for (const request of requests) {
      const accountId = (request.accountId ?? "").trim();
      if (accountId === "") {
        // A blank id is a caller defect, not a missing account, and is reported
        // as one rather than being folded into the not-found path.
        throw new ApplicationException(
          "funding_account_lock_account_required",
          "A funding account must be identified before it can be locked",
          HttpStatus.BAD_REQUEST,
        );
      }
      unique.set(`${request.kind}:${accountId}`, { accountId, kind: request.kind });
    }
    return [...unique.values()].sort(
      (left, right) =>
        kindRank[left.kind] - kindRank[right.kind] ||
        left.accountId.localeCompare(right.accountId),
    );
  }

  /**
   * `select ... for update` on the one authoritative row.
   *
   * The Company predicate is inside the locking statement, not applied after
   * it: a lock taken first and validated second would briefly hold another
   * tenant's row. A cross-tenant account therefore fails to match and is
   * reported as `not found`, identically to an account that does not exist --
   * distinguishing them would turn this into an existence oracle for another
   * Company's account ids.
   */
  private async lockRow(
    transaction: Transaction<DatabaseSchema>,
    request: FundingAccountLockRequest,
  ): Promise<void> {
    const { companyId } = this.tenants.current();
    const result =
      request.kind === "cash"
        ? await sql<{ id: string }>`
            select id from company_cash_accounts
             where id=${request.accountId}::uuid and company_id=${companyId}::uuid
             for update
          `.execute(transaction)
        : await sql<{ id: string }>`
            select id from company_bank_accounts
             where id=${request.accountId}::uuid and company_id=${companyId}::uuid
             for update
          `.execute(transaction);
    if (result.rows[0] === undefined) {
      throw new ApplicationException(
        "funding_account_lock_not_found",
        "The funding account was not found",
        HttpStatus.NOT_FOUND,
      );
    }
  }
}
