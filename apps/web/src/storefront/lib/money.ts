/**
 * Prototype money helpers — integer fils under the hood, so the cart's local
 * arithmetic can never produce floating-point artefacts on screen. These
 * figures are demo display values only; no financial record is derived from
 * them anywhere.
 */

export const toFils = (aed: string): number => Math.round(Number.parseFloat(aed || "0") * 100);

export const fromFils = (fils: number): string => (fils / 100).toFixed(2);

export const formatAed = (aed: string): string => `AED ${Number.parseFloat(aed).toFixed(2)}`;
