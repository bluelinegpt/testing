import { CART_STORAGE_VERSION, type Cart, type StoredCartPayload } from "./cart-types.js";

/**
 * `localStorage` persistence for the Cart — client-side only, non-sensitive
 * (C1 §30-33).
 *
 * Never stores an auth token, a password, a tracking token or any private
 * Customer profile field — the payload is exactly `Cart` (Store slug,
 * Product slugs, option labels, display prices, quantities) and nothing
 * else, so there is nothing here worth protecting beyond "don't crash on
 * garbage".
 */
const STORAGE_KEY = "blueline.store.cart.v1";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Malformed/corrupt storage is ignored and reset, never thrown (C1 §33). */
export function readCart(): Cart | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage inaccessible (private browsing, disabled, quota) -- behave as
    // if there is simply no Cart yet rather than crashing the Store.
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed)) return null;
    const payload = parsed as Partial<StoredCartPayload>;
    // A version mismatch is a future-schema payload this build does not
    // understand, or a stale one from a shape that no longer applies -- in
    // either case, dropping it safely beats guessing at a translation.
    if (payload.cartVersion !== CART_STORAGE_VERSION) return null;
    if (payload.cart === null || payload.cart === undefined) return null;
    if (!isValidCartShape(payload.cart)) return null;
    return payload.cart;
  } catch {
    return null;
  }
}

function isValidCartShape(value: unknown): value is Cart {
  if (!isPlainRecord(value)) return false;
  if (typeof value.storeSlug !== "string" || typeof value.storeDisplayName !== "string") {
    return false;
  }
  if (typeof value.currency !== "string" || !Array.isArray(value.lines)) return false;
  return value.lines.every(
    (line) =>
      isPlainRecord(line) &&
      typeof line.lineKey === "string" &&
      typeof line.productSlug === "string" &&
      typeof line.productName === "string" &&
      typeof line.unitPrice === "string" &&
      typeof line.quantity === "number" &&
      Number.isFinite(line.quantity) &&
      Array.isArray(line.selectedOptions),
  );
}

export function writeCart(cart: Cart | null): void {
  const payload: StoredCartPayload = { cart, cartVersion: CART_STORAGE_VERSION };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota exceeded or storage disabled -- the Cart still works for the rest
    // of this tab session via in-memory state; it just will not survive a
    // reload. Not worth surfacing as an error to the Customer.
  }
}
