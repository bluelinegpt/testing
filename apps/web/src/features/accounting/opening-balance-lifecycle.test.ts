import { describe, expect, it } from "vitest";

import { actionAvailable } from "./AccountingResourcePage.js";

/* The Opening Balance lifecycle gate. A validated batch used to offer Validate
   a second time; pressing it issued a validated -> validated UPDATE that the
   immutability trigger rejected, surfacing a generic integrity conflict. */

const balancedLines = [
  { accountId: "a1", credit: 0, debit: 100 },
  { accountId: "a2", credit: 100, debit: 0 },
];

const batch = (status: string) => ({ id: "b1", lines: balancedLines, status });

describe("opening balance action lifecycle", () => {
  it("offers Validate on a draft batch", () => {
    expect(actionAvailable("opening-balances", batch("draft"), "validate")).toBe(true);
  });

  it("does not offer Validate once the batch is validated", () => {
    expect(actionAvailable("opening-balances", batch("validated"), "validate")).toBe(false);
  });

  it("offers Approve as the next step from validated", () => {
    expect(actionAvailable("opening-balances", batch("validated"), "approve")).toBe(true);
  });

  it("does not offer Approve before the batch is validated", () => {
    expect(actionAvailable("opening-balances", batch("draft"), "approve")).toBe(false);
  });

  it("keeps the rest of the lifecycle intact", () => {
    expect(actionAvailable("opening-balances", batch("approved"), "post")).toBe(true);
    expect(actionAvailable("opening-balances", batch("posted"), "reverse")).toBe(true);
    // Approved is past the point of validating, and posted is past approving.
    expect(actionAvailable("opening-balances", batch("approved"), "validate")).toBe(false);
    expect(actionAvailable("opening-balances", batch("posted"), "approve")).toBe(false);
  });

  it("still withholds Validate from a draft whose lines do not balance", () => {
    // The line check is independent of status and must survive this change.
    const unbalanced = {
      id: "b2",
      lines: [
        { accountId: "a1", credit: 0, debit: 100 },
        { accountId: "a2", credit: 50, debit: 0 },
      ],
      status: "draft",
    };
    expect(actionAvailable("opening-balances", unbalanced, "validate")).toBe(false);
  });

  /* Return to Draft. A Batch that was validated but never approved previously
     had Approve as its only move; the demotion the service performs on every
     edit had no action of its own. */

  it("offers Return to draft on a validated batch", () => {
    expect(actionAvailable("opening-balances", batch("validated"), "return-to-draft")).toBe(true);
  });

  it("does not offer Return to draft on a batch that is already draft", () => {
    expect(actionAvailable("opening-balances", batch("draft"), "return-to-draft")).toBe(false);
  });

  it("withholds Return to draft once the batch is approved or posted", () => {
    // Approved and posted immutability is the whole point of the gate: an
    // approved Batch is re-opened by nothing, and a posted one only by Reverse.
    expect(actionAvailable("opening-balances", batch("approved"), "return-to-draft")).toBe(false);
    expect(actionAvailable("opening-balances", batch("posted"), "return-to-draft")).toBe(false);
    expect(actionAvailable("opening-balances", batch("reversed"), "return-to-draft")).toBe(false);
  });

  /* Delete. Draft only: a Draft has posted nothing, so removing it is not a
     financial act. Anything further along is reached through Return to draft
     first, and a posted Batch is corrected by Reverse. */

  it("offers Delete on a draft batch", () => {
    expect(actionAvailable("opening-balances", batch("draft"), "delete")).toBe(true);
  });

  it("hides Delete for every status that is not draft", () => {
    for (const status of ["validated", "approved", "posted", "reversed"]) {
      expect(actionAvailable("opening-balances", batch(status), "delete")).toBe(false);
    }
  });

  it("still offers Delete on a draft whose lines do not balance", () => {
    /* An abandoned Batch is usually the unbalanced one. The line check gates
       Validate, and must not gate the way out. */
    const unbalanced = {
      id: "b3",
      lines: [
        { accountId: "a1", credit: 0, debit: 100 },
        { accountId: "a2", credit: 50, debit: 0 },
      ],
      status: "draft",
    };
    expect(actionAvailable("opening-balances", unbalanced, "delete")).toBe(true);
    expect(actionAvailable("opening-balances", unbalanced, "validate")).toBe(false);
  });

  it("keeps Delete and Return to draft mutually exclusive across the lifecycle", () => {
    // Exactly one way out at any point: Delete from draft, Return to draft from
    // validated, and neither once approved.
    expect(actionAvailable("opening-balances", batch("draft"), "return-to-draft")).toBe(false);
    expect(actionAvailable("opening-balances", batch("validated"), "delete")).toBe(false);
    expect(actionAvailable("opening-balances", batch("approved"), "delete")).toBe(false);
    expect(actionAvailable("opening-balances", batch("approved"), "return-to-draft")).toBe(false);
  });

  it("leaves the rest of the Opening Balance actions unaffected", () => {
    // Regression guard for the actions that existed before Delete was added.
    expect(actionAvailable("opening-balances", batch("draft"), "validate")).toBe(true);
    expect(actionAvailable("opening-balances", batch("validated"), "approve")).toBe(true);
    expect(actionAvailable("opening-balances", batch("approved"), "post")).toBe(true);
    expect(actionAvailable("opening-balances", batch("posted"), "reverse")).toBe(true);
    expect(actionAvailable("opening-balances", batch("posted"), "delete")).toBe(false);
  });

  it("leaves the Expenses Return to draft gate alone", () => {
    /* Expenses had this action first, on `rejected` only. `actionAvailable`
       gates by status; whether a section offers the action at all is its own
       `actions` list, so there is nothing to assert here for Journals — they
       never declare it. */
    expect(actionAvailable("expenses", { id: "e1", status: "rejected" }, "return-to-draft")).toBe(
      true,
    );
    expect(actionAvailable("expenses", { id: "e2", status: "draft" }, "return-to-draft")).toBe(
      false,
    );
  });

  it("leaves the Journals lifecycle untouched", () => {
    // Journals genuinely do allow validate from `balanced`; only the Opening
    // Balance row changed.
    expect(actionAvailable("journals", { id: "j1", status: "balanced" }, "validate")).toBe(true);
  });
});
