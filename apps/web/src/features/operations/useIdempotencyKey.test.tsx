import { act, render } from "@testing-library/react";

import { materialFingerprint, useIdempotencyKey } from "./useIdempotencyKey.js";

function Harness({
  onReady,
}: {
  onReady: (attempt: ReturnType<typeof useIdempotencyKey>) => void;
}) {
  let sequence = 0;
  const attempt = useIdempotencyKey(() => `key-${++sequence}`);
  onReady(attempt);
  return null;
}

function mountAttempt() {
  let attempt!: ReturnType<typeof useIdempotencyKey>;
  render(<Harness onReady={(value) => (attempt = value)} />);
  return attempt;
}

const basePayload = {
  excludedOrderIds: [],
  expenses: [{ amount: "10.00", expenseTypeId: "type-a", notes: "Fuel" }],
  orderIds: ["order-a", "order-b"],
  payments: [{ amount: "90.00", paymentMethod: "cash" }],
  selectionMode: "ids",
};

describe("useIdempotencyKey", () => {
  it("reuses one key across retries of an unchanged payload", () => {
    const attempt = mountAttempt();
    const fingerprint = materialFingerprint(basePayload);
    const first = attempt.keyFor(fingerprint);
    // A network failure, a timeout, and a second Confirm click must all replay.
    expect(attempt.keyFor(fingerprint)).toBe(first);
    expect(attempt.keyFor(fingerprint)).toBe(first);
  });

  it("mints a new key only after a material payload change", () => {
    const attempt = mountAttempt();
    const first = attempt.keyFor(materialFingerprint(basePayload));
    const changed = materialFingerprint({
      ...basePayload,
      payments: [{ amount: "80.00", paymentMethod: "cash" }],
    });
    const second = attempt.keyFor(changed);
    expect(second).not.toBe(first);
    // The new key is then itself stable.
    expect(attempt.keyFor(changed)).toBe(second);
  });

  it("does not mint a new key when rows are merely reordered", () => {
    const attempt = mountAttempt();
    const first = attempt.keyFor(materialFingerprint(basePayload));
    const reordered = materialFingerprint({
      ...basePayload,
      orderIds: ["order-b", "order-a"],
    });
    expect(attempt.keyFor(reordered)).toBe(first);
  });

  it("treats equivalent money formatting as the same payload", () => {
    const attempt = mountAttempt();
    const first = attempt.keyFor(materialFingerprint(basePayload));
    const equivalent = materialFingerprint({
      ...basePayload,
      expenses: [{ amount: "10", expenseTypeId: "type-a", notes: "  Fuel  " }],
      payments: [{ amount: "90", paymentMethod: "cash" }],
    });
    expect(attempt.keyFor(equivalent)).toBe(first);
  });

  it("retains the key until reset, then issues a fresh one", () => {
    const attempt = mountAttempt();
    const fingerprint = materialFingerprint(basePayload);
    const first = attempt.keyFor(fingerprint);
    // Failure must NOT clear the key, or a retry would duplicate.
    expect(attempt.keyFor(fingerprint)).toBe(first);
    act(() => attempt.reset());
    expect(attempt.keyFor(fingerprint)).not.toBe(first);
  });

  it("distinguishes selection mode and exclusions", () => {
    const attempt = mountAttempt();
    const explicit = attempt.keyFor(materialFingerprint(basePayload));
    const byFilter = attempt.keyFor(
      materialFingerprint({ ...basePayload, selectionMode: "filter" }),
    );
    expect(byFilter).not.toBe(explicit);
    const withExclusion = attempt.keyFor(
      materialFingerprint({
        ...basePayload,
        excludedOrderIds: ["order-c"],
        selectionMode: "filter",
      }),
    );
    expect(withExclusion).not.toBe(byFilter);
  });
});
