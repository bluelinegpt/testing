import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

/**
 * Validates the Cash or Bank account funding an outgoing payment.
 *
 * ===========================================================================
 * ONE VALIDATOR, THREE WORKFLOWS
 * ===========================================================================
 *
 * Payroll, outsourced Driver fees and General Expense payments all need the
 * same four questions answered: does the account exist, is it this Company's,
 * is it active, and is it the right kind for the payment method?
 *
 * Answering them once here rather than three times in three services is not
 * only less code. It is the difference between a control that holds and one
 * that holds in two places out of three -- and the third is exactly where the
 * negative-balance policy would later be bypassed. `BalanceControlService` is
 * only as reliable as the account reference it is handed.
 *
 * ===========================================================================
 * A CROSS-TENANT ACCOUNT IS "NOT FOUND", NOT "FORBIDDEN"
 * ===========================================================================
 *
 * An account belonging to another Company returns the same `not found` as an
 * account that does not exist. Distinguishing them would turn this endpoint
 * into an existence oracle: a caller could enumerate another tenant's account
 * ids by watching which error came back.
 *
 * The composite foreign keys added alongside this service are the second line
 * of the same defence -- the database rejects a cross-tenant reference even if
 * a future caller skips this check entirely.
 *
 * ===========================================================================
 * IT VALIDATES; IT DOES NOT WRITE
 * ===========================================================================
 *
 * This service reads and throws. It records no payment and enforces no balance
 * policy -- balance enforcement is a separate, later step, and is still
 * deliberately disabled. Confirming an account is real is a precondition for
 * that work, not the work itself.
 */

export type PaymentAccountKind = "bank" | "cash";

export interface ResolvedFundingAccount {
  readonly accountId: string;
  readonly kind: PaymentAccountKind;
  /**
   * The GL account the funding account posts to, read from the account row
   * itself rather than from the caller.
   *
   * A caller that needs a GL account for a Cash or Bank payment must never take
   * one from the client: two ids arriving together are two claims, and the
   * second one is unverifiable. Returning the link here means every caller
   * derives the same GL account the same way -- from the account it already
   * validated.
   *
   * Null only where the column itself is null (a Bank account with no link
   * configured). The caller decides whether that is fatal for its workflow.
   */
  readonly linkedGlAccountId: string | null;
  readonly name: string;
}

@Injectable()
export class PaymentFundingAccountService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
  ) {}

  /**
   * Resolve an account for a payment, or throw a friendly structured error.
   *
   * `required` says which kind the payment method demands: `cash` payments must
   * name a Cash account, `visa`/bank payments a Bank account. Passing the wrong
   * kind is rejected rather than coerced -- a Bank account silently accepted
   * for a cash payment would put the shortfall on the wrong balance.
   */
  public async resolve(
    accountId: string | null | undefined,
    required: PaymentAccountKind,
  ): Promise<ResolvedFundingAccount> {
    const { companyId } = this.tenants.current();
    const id = (accountId ?? "").trim();
    if (id === "") {
      throw new ApplicationException(
        "payment_funding_account_required",
        required === "cash"
          ? "Select the Cash account this payment is funded from"
          : "Select the Bank account this payment is funded from",
        HttpStatus.BAD_REQUEST,
      );
    }

    // Both account tables are queried in one statement rather than one per
    // kind, so a wrong-kind account can be reported as a MISMATCH instead of a
    // misleading "not found" -- the caller has a real id, just the wrong sort.
    const result = await sql<{
      isActive: boolean;
      kind: PaymentAccountKind;
      linkedGlAccountId: string | null;
      name: string;
    }>`
      select 'cash'::text as kind, c.cash_account_name as name, c.is_active as "isActive",
             c.linked_gl_account_id as "linkedGlAccountId"
        from company_cash_accounts c
       where c.id = ${id}::uuid and c.company_id = ${companyId}::uuid
      union all
      select 'bank'::text, b.account_name, b.is_active, b.linked_gl_account_id
        from company_bank_accounts b
       where b.id = ${id}::uuid and b.company_id = ${companyId}::uuid
    `.execute(this.database);

    const account = result.rows[0];
    // Another Company's account lands here, identically to a nonexistent one.
    if (account === undefined) {
      throw new ApplicationException(
        "payment_funding_account_not_found",
        "The selected funding account was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    if (account.kind !== required) {
      throw new ApplicationException(
        "payment_funding_account_kind_mismatch",
        required === "cash"
          ? "A Cash payment must be funded from a Cash account, not a Bank account"
          : "A Bank or Visa payment must be funded from a Bank account, not a Cash account",
        HttpStatus.BAD_REQUEST,
      );
    }
    // Checked at confirmation time rather than at selection time: an account
    // deactivated between the two is not a valid source of funds.
    if (!account.isActive) {
      throw new ApplicationException(
        "payment_funding_account_inactive",
        `${account.name} is not active and cannot fund a payment`,
        HttpStatus.CONFLICT,
      );
    }
    return {
      accountId: id,
      kind: account.kind,
      linkedGlAccountId: account.linkedGlAccountId,
      name: account.name,
    };
  }

  /**
   * Payroll is cash-only, so it gets its own entry point.
   *
   * A caller cannot ask for a Bank account here even by mistake. The narrower
   * signature is the point: the rule that Employee payroll never touches a bank
   * account is expressed in the type, not left to each caller to remember.
   */
  public payrollAccount(accountId: string | null | undefined): Promise<ResolvedFundingAccount> {
    return this.resolve(accountId, "cash");
  }
}
