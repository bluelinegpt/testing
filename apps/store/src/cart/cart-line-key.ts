import type { CartSelectedOption } from "./cart-types.js";

/**
 * Deterministic Cart-line identity (C1 §9-10).
 *
 * Sorted by `groupDisplayOrder` then `valueDisplayOrder` — the stable order
 * the Trader configured — never by the display label. Two lines with the
 * same Product and the same selections always produce the same key
 * regardless of the order the Customer happened to click them in.
 */
export function buildCartLineKey(
  productSlug: string,
  selectedOptions: readonly CartSelectedOption[],
): string {
  const sorted = [...selectedOptions].sort((a, b) =>
    a.groupDisplayOrder !== b.groupDisplayOrder
      ? a.groupDisplayOrder - b.groupDisplayOrder
      : a.valueDisplayOrder - b.valueDisplayOrder,
  );
  const optionPart = sorted.map((option) => `${option.groupName}:${option.value}`).join("|");
  return `${productSlug}::${optionPart}`;
}
