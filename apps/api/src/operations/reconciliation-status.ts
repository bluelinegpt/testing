/**
 * Dimension-specific display labels.
 *
 * Stored database values are unchanged. These maps exist because a single shared
 * status map mislabels unrelated dimensions — `pending` means "Pending
 * Collection" for Driver Cash but nothing of the sort for delivery or
 * settlement, so each dimension carries its own vocabulary.
 */
export const driverCashStatusLabels: Readonly<Record<string, string>> = {
  not_applicable: "Not Required",
  pending: "Pending Collection",
  reconciled: "Money Received from Driver",
  // Present only on historical records; no Reverse action is exposed.
  reversed: "Reversed",
};

export const reconciliationStatusLabels: Readonly<Record<string, string>> = {
  confirmed: "Confirmed",
  draft: "Draft",
};

export const paymentMethodLabels: Readonly<Record<string, string>> = {
  bank_transfer: "Bank Transfer",
  cash: "Cash",
};

/** Value used wherever historical provenance was never recorded. */
export const legacyUnknown = "Legacy/Unknown";

export function driverCashStatusLabel(value: string): string {
  return driverCashStatusLabels[value] ?? value;
}

export function reconciliationStatusLabel(value: string): string {
  return reconciliationStatusLabels[value] ?? value;
}

export function paymentMethodLabel(value: string): string {
  return paymentMethodLabels[value] ?? value;
}
