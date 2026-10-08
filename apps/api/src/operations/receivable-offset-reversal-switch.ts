/**
 * Kill switch for the single-Receivable offset reversal
 * (`POST operations/trader-receivables/:receivableId/reverse`).
 *
 * DISABLED 8 Oct 2026. Each reversal correctly issues a Trader Credit, but:
 *   1. the Order's fee is then charged AGAIN (createOrderTraderReceivableIfNeeded
 *      does not see the reversed + credited Receivable), and the new charge is
 *      deducted in the next Settlement; and
 *   2. no Settlement ever applies an open Trader Credit.
 * Net effect: the Trader pays the fee twice and the credit never reaches him
 * (AL Fahd: TCR-000001..007, AED 133 owed). See project note
 * `claude/trader-double-fee-after-offset-reversal-2026-10-08.md`.
 *
 * Re-enable only when BOTH the re-charge guard and credit application in
 * Settlements have shipped. The preview stays available (read-only).
 * Settlement-level reversal and collection reversal are NOT affected.
 */
export const RECEIVABLE_OFFSET_REVERSAL_ENABLED = false;

export const RECEIVABLE_OFFSET_REVERSAL_DISABLED_CODE = "receivable_offset_reversal_disabled";

export const RECEIVABLE_OFFSET_REVERSAL_DISABLED_MESSAGE =
  "Reversing a single Trader Receivable is temporarily disabled until Trader Credits can be applied in Settlements. Reverse the whole Settlement instead, or contact the Platform team.";
