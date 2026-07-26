import { useRef } from "react";

/**
 * Stable idempotency key for one confirmation attempt.
 *
 * A key is minted the first time a payload is submitted and reused for every
 * retry of that same payload — network failure, timeout, or the operator
 * pressing Confirm again. It is replaced only when the material payload
 * changes, because the backend rejects a reused key carrying different details.
 *
 * The key is deliberately NOT cleared on failure: a retry after a transient
 * error must replay rather than create a second reconciliation.
 */
export interface IdempotencyAttempt {
  /** Returns the key for this payload, minting one only on material change. */
  keyFor: (fingerprint: string) => string;
  /** Drops the retained key after a successful confirmation. */
  reset: () => void;
}

export function useIdempotencyKey(
  createKey: () => string = () => globalThis.crypto.randomUUID(),
): IdempotencyAttempt {
  const attempt = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  return {
    keyFor: (fingerprint: string) => {
      if (attempt.current?.fingerprint !== fingerprint) {
        attempt.current = { fingerprint, key: createKey() };
      }
      return attempt.current.key;
    },
    reset: () => {
      attempt.current = undefined;
    },
  };
}

/**
 * Canonical fingerprint of the material confirmation payload.
 *
 * Mirrors the server's material-hash fields: the selection, and the expense and
 * payment lines with amounts normalised and rows sorted, so that reordering rows
 * does not look like a different submission.
 */
export function materialFingerprint(payload: {
  excludedOrderIds?: readonly string[];
  expenses: readonly {
    amount: string;
    expenseTypeId: string;
    notes?: string;
    reference?: string;
  }[];
  orderIds?: readonly string[];
  payments: readonly {
    amount: string;
    bankAccountId?: string;
    bankReference?: string;
    paymentDate?: string;
    paymentMethod: string;
  }[];
  selectionMode: string;
}): string {
  const money = (value: string) => (Math.round(Number(value || 0) * 100) / 100).toFixed(2);
  return JSON.stringify({
    excludedOrderIds: [...(payload.excludedOrderIds ?? [])].sort(),
    expenses: payload.expenses
      .map((expense) =>
        [
          expense.expenseTypeId,
          money(expense.amount),
          expense.notes?.trim() ?? "",
          expense.reference?.trim() ?? "",
        ].join("|"),
      )
      .sort(),
    orderIds: [...(payload.orderIds ?? [])].sort(),
    payments: payload.payments
      .map((payment) =>
        [
          payment.paymentMethod,
          money(payment.amount),
          payment.bankAccountId ?? "",
          payment.bankReference?.trim() ?? "",
          payment.paymentDate ?? "",
        ].join("|"),
      )
      .sort(),
    selectionMode: payload.selectionMode,
  });
}
