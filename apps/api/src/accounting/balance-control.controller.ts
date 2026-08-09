import { Body, Controller, Get, HttpStatus, Inject, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { IsIn, IsNumberString, IsOptional, Matches, MaxLength, MinLength } from "class-validator";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { BankBalancePolicy, CashBalancePolicy } from "./balance-control.service.js";
import { BalanceControlService } from "./balance-control.service.js";

/**
 * ENFORCEMENT IS NOW WIRED INTO ALL FIVE OUTGOING WORKFLOWS.
 *
 * This gate was closed while the policy was configurable but inert: the tables,
 * the validation service and the Company Profile panel existed, and no payment
 * consulted any of them. Letting a Company schedule "Block negative Cash" then
 * would have recorded a decision the system could not honour, and a control
 * that is configurable but inert manufactures assurance rather than providing
 * it.
 *
 * Every outgoing path now calls `BalanceEnforcementCoordinator` before it
 * writes: Payroll Payments, Outsourced Driver Fee cash payments, Trader
 * Settlements, General Expense Payments and Cash/Bank Movements. A scheduled
 * policy is therefore honoured, so scheduling one is open again.
 *
 * The flag is kept rather than deleted, and it stays HERE rather than in the UI
 * alone, because the UI is not the only caller: a script or an API client can
 * reach this endpoint directly. If enforcement ever has to be withdrawn, one
 * value closes writes for every caller at once.
 *
 * Reads were never closed. Existing policies stayed visible, unmodified and
 * part of the audit trail throughout.
 *
 * ONE LIMITATION REMAINS, and it is not a reason to keep writes closed: the
 * balance the policy is judged against excludes confirmed payments written
 * before the funding-account columns existed. Those cannot be attributed
 * without guessing, so they are reported as `coverage` counts on every verdict
 * rather than silently assumed away.
 */
const balanceControlEnforcementReady = true;

export const cashBalancePolicies = ["allow", "allow_with_override", "block"] as const;
export const bankBalancePolicies = [
  "allow",
  "allow_with_override",
  "allow_within_overdraft",
  "block",
] as const;

export class SaveBalancePolicyDto {
  @IsIn(cashBalancePolicies)
  public cashPolicy!: CashBalancePolicy;

  @IsIn(bankBalancePolicies)
  public bankPolicy!: BankBalancePolicy;

  /**
   * Money as a string, like everywhere else in this codebase.
   *
   * A float would round a limit of 1000.10 into something a Company never
   * agreed to, and an overdraft limit is exactly the number nobody wants
   * silently adjusted.
   */
  @ApiPropertyOptional({ example: "5000.00" })
  @IsOptional()
  @IsNumberString()
  public bankOverdraftLimit?: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "effectiveFrom must be YYYY-MM-DD" })
  public effectiveFrom!: string;

  @MinLength(3)
  @MaxLength(500)
  public changeReason!: string;
}

/**
 * Read and schedule the Company's negative-balance policy.
 *
 * Separate from the report controllers because this one WRITES — a new
 * effective-dated rule. It still touches no payment and no financial record;
 * the policy only describes what future payments will be allowed to do.
 */
@ApiTags("accounting")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("company-profile/balance-controls")
export class BalanceControlController {
  public constructor(
    @Inject(BalanceControlService) private readonly balances: BalanceControlService,
  ) {}

  /** Active policy, any future scheduled ones, and the full history. */
  @Get()
  @RequireAnyPermission("accounting.view", "accounting.manage", "company_profile.manage")
  public policies() {
    return this.balances.policySchedule();
  }

  /**
   * Schedule a new policy from a date.
   *
   * Never an UPDATE of the active rule and never a DELETE: the current policy
   * is closed at the new start date and the new one takes over. That is what
   * makes "what was the rule when this payment was blocked" answerable later.
   */
  @Post()
  // `users_roles.manage` is the codebase's established first-administrator
  // bootstrap allowance -- every sibling accounting/configuration write route
  // (cash and bank accounts, VAT, general settings, opening balances, journal
  // entries, ...) accepts it as an alternative to the module's own manage
  // permission, so the Platform-created Company Administrator can finish
  // setting the Company up before granting anyone the narrower operational
  // roles. This route was the one exception: it required `accounting.manage`
  // only, so a first administrator could VIEW the policy (the GET above
  // already allows `company_profile.manage`) but never set one, with no
  // indication that the gap was accidental rather than intended. Matching the
  // pattern here is a one-line fix that applies to every Company immediately,
  // present and future, because it changes what the route accepts rather than
  // what any Company's role happens to hold.
  @RequireAnyPermission("accounting.manage", "users_roles.manage")
  public async save(@Body() body: SaveBalancePolicyDto) {
    // Retained as the single kill switch. Still checked before validation and
    // before any write, so that if it is ever closed again a caller cannot tell
    // a well-formed request from a malformed one, and nothing touches the
    // database on this path.
    if (!balanceControlEnforcementReady) {
      throw new ApplicationException(
        "balance_controls_enforcement_not_ready",
        "Balance control activation is temporarily disabled.",
        HttpStatus.CONFLICT,
      );
    }
    if (body.bankPolicy === "allow_within_overdraft") {
      const limit = Number(body.bankOverdraftLimit ?? "0");
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new ApplicationException(
          "balance_overdraft_limit_required",
          "An overdraft limit greater than zero is required when Bank overdraft is enabled",
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    return this.balances.savePolicy(body);
  }
}
