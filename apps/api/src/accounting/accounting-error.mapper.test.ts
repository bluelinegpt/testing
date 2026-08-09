import { HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { mapAccountingDatabaseError } from "./accounting-error.mapper.js";

/* Every stable constraint code used to collapse to one generic sentence. The
   Opening Balance immutability code now explains the actual state problem;
   everything else must keep both its previous wording and its `errorCode`. */

function capture(message: string) {
  try {
    mapAccountingDatabaseError(new Error(message));
  } catch (error) {
    return error as { errorCode?: string; message: string; status?: number };
  }
  throw new Error("mapAccountingDatabaseError did not throw");
}

describe("mapAccountingDatabaseError", () => {
  it("explains what to do about an already-validated opening balance", () => {
    const error = capture('new row violates "accounting_opening_balance_immutable" check');
    expect(error.message).toBe(
      "This opening balance has already been validated. Approve it or return it to Draft before making changes.",
    );
  });

  it("preserves the stable errorCode alongside the specific message", () => {
    const error = capture("accounting_opening_balance_immutable");
    // The code is the contract; the message is for the User.
    expect(error.errorCode).toBe("accounting_opening_balance_immutable");
    expect(error.status).toBe(HttpStatus.CONFLICT);
  });

  it("leaves other accounting codes on the generic message", () => {
    const error = capture("accounting_opening_balance_not_balanced");
    expect(error.errorCode).toBe("accounting_opening_balance_not_balanced");
    expect(error.message).toBe(
      "The Accounting operation conflicts with the current financial integrity rules",
    );
  });

  it("keeps unrelated stable codes mapping to their own code", () => {
    expect(capture("accounting_cash_bank_history_immutable").errorCode).toBe(
      "accounting_cash_bank_history_immutable",
    );
    expect(capture("accounting_general_expense_lines_immutable").errorCode).toBe(
      "accounting_general_expense_lines_immutable",
    );
  });
});
