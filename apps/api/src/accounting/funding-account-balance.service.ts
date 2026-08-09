import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { CashBankQueryService } from "./cash-bank-query.service.js";
import type { PaymentAccountKind } from "./payment-funding-account.service.js";

/**
 * The current balance of one Cash or Bank account, for balance control.
 *
 * ===========================================================================
 * IT REUSES THE EXISTING FORMULA; IT DOES NOT RESTATE IT
 * ===========================================================================
 *
 * `CashBankQueryService.balances()` is the authoritative calculation and has
 * been since the Cash/Bank module shipped: opening balances from posted
 * `journal_type='opening_balance'` Journals, plus every confirmed Movement,
 * plus explicit undo legs for reversals, plus -- since the formula was widened
 * -- every confirmed outgoing payment that records the account it drew on. This
 * service calls it and picks one row.
 *
 * The alternative -- a second query computing "the balance of one account" --
 * would be faster and would eventually be wrong. Two formulas for the same
 * money drift the first time one is amended, and nothing would say which was
 * right. A control that blocks payments must agree with the screen the user is
 * looking at, so it reads what that screen reads.
 *
 * The cost is real and bounded: `balances()` computes every account, and this
 * discards all but one. A Company has tens of accounts, not millions, and the
 * work is one SQL statement either way -- no application-memory aggregation and
 * no N+1. Correctness by construction is worth that.
 *
 * ===========================================================================
 * WHAT THIS BALANCE DOES AND DOES NOT COUNT
 * ===========================================================================
 *
 * The formula counts opening balances, `cash_bank_movements`, and every
 * confirmed outgoing payment from the authoritative payment tables: Payroll
 * payments, outsourced Driver fee cash payments, General Expense payment rows
 * (Cash and Bank) and unreversed Trader Settlement payments. None of those
 * write `cash_bank_movements`; they are unioned into the same calculation from
 * the funding account each one records.
 *
 * ONE GAP REMAINS, and it is the reason this stays a separate service rather
 * than an inline call. Payments written before the funding-account columns
 * existed carry a null account. They cannot be attributed without guessing
 * which drawer they drew on, so they are excluded from every account's balance
 * and reported instead as counts on the `coverage` object each balance row
 * carries.
 *
 * A Company with such rows therefore has a balance that is complete for
 * everything recorded since, and short by an unknown amount before. Enforcing a
 * negative-balance policy has to reckon with that -- by reading `coverage` and
 * declining to enforce where it is non-zero, or by accepting the gap
 * explicitly. It must not be assumed away. Balance control remains disabled.
 */

/**
 * Counts of confirmed payments the balance could not attribute, because they
 * were written before the funding-account columns existed.
 *
 * Carried on the balance rather than looked up separately so a caller cannot
 * read the figure without also being handed the size of what it omits.
 */
export interface FundingAccountBalanceCoverage {
  readonly generalExpenseCashRowsWithoutCompanyCashAccount: number;
  readonly outsourcedDriverFeeCashPaymentsWithoutCashAccount: number;
  readonly payrollPaymentsWithoutCashAccount: number;
  readonly traderSettlementCashPaymentsWithoutCashAccount: number;
}

export interface FundingAccountBalance {
  readonly accountId: string;
  readonly balance: string;
  /** How the figure was derived, so a caller can state its basis. */
  readonly basis: "opening_balances_movements_and_confirmed_payments";
  readonly code: string | null;
  readonly companyId: string;
  /** What this figure could not account for. Company-level, never per-account. */
  readonly coverage: FundingAccountBalanceCoverage;
  readonly isActive: boolean;
  readonly kind: PaymentAccountKind;
  readonly name: string | null;
  /** When it was read. The figure is a live read, not a stored snapshot. */
  readonly readAt: string;
}

const emptyCoverage: FundingAccountBalanceCoverage = {
  generalExpenseCashRowsWithoutCompanyCashAccount: 0,
  outsourcedDriverFeeCashPaymentsWithoutCashAccount: 0,
  payrollPaymentsWithoutCashAccount: 0,
  traderSettlementCashPaymentsWithoutCashAccount: 0,
};

@Injectable()
export class FundingAccountBalanceService {
  public constructor(
    @Inject(CashBankQueryService) private readonly cashBank: CashBankQueryService,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
  ) {}

  /**
   * Current balance of one account.
   *
   * `database` should be the CALLER's transaction whenever a payment is about
   * to be written, so the balance read and the payment commit as one unit.
   * Reading outside it would produce a figure that was correct at the read and
   * stale by the commit -- the race this control exists to prevent.
   */
  public async current(
    kind: PaymentAccountKind,
    accountId: string,
    database?: Kysely<DatabaseSchema>,
  ): Promise<FundingAccountBalance> {
    const { companyId } = this.tenants.current();
    const rows = await this.cashBank.balances(database);
    const match = rows.find((row) => row.id === accountId && row.kind === kind);
    // A cross-tenant account is absent from this Company's list, so it lands
    // here identically to a nonexistent one. Distinguishing them would let a
    // caller enumerate another tenant's account ids by watching the error.
    if (match === undefined) {
      throw new ApplicationException(
        "funding_account_balance_not_found",
        "The funding account was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return {
      accountId,
      balance: String(match.balance ?? "0.00"),
      basis: "opening_balances_movements_and_confirmed_payments",
      code: typeof match.code === "string" ? match.code : null,
      companyId,
      coverage: this.coverageOf(match.coverage),
      isActive: match.isActive === true,
      kind,
      name: typeof match.name === "string" ? match.name : null,
      readAt: new Date().toISOString(),
    };
  }

  /**
   * The coverage counts, read defensively.
   *
   * A missing or malformed count becomes zero rather than throwing: refusing to
   * return a balance because its footnote was unreadable would be a worse
   * failure than reporting the footnote as empty. The counts are advisory; the
   * balance is not.
   */
  private coverageOf(value: unknown): FundingAccountBalanceCoverage {
    if (value === null || typeof value !== "object") return emptyCoverage;
    const source = value as Record<string, unknown>;
    const count = (key: keyof FundingAccountBalanceCoverage): number => {
      const raw = Number(source[key]);
      return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
    };
    return {
      generalExpenseCashRowsWithoutCompanyCashAccount: count(
        "generalExpenseCashRowsWithoutCompanyCashAccount",
      ),
      outsourcedDriverFeeCashPaymentsWithoutCashAccount: count(
        "outsourcedDriverFeeCashPaymentsWithoutCashAccount",
      ),
      payrollPaymentsWithoutCashAccount: count("payrollPaymentsWithoutCashAccount"),
      traderSettlementCashPaymentsWithoutCashAccount: count(
        "traderSettlementCashPaymentsWithoutCashAccount",
      ),
    };
  }
}
