/**
 * The Customer Cart — a shopping convenience, never a price or ownership
 * authority (Customer Commerce Prompt C1, §4/§62/§67).
 *
 * Every field on `CartLine` is a DISPLAY SNAPSHOT taken at Add-to-Cart time:
 * `unitPrice`, `previousPrice`, `productName`, `imageUrl` and the option
 * labels are all what the storefront showed the Customer at that moment, not
 * what a future Checkout may charge. The only fields Checkout (C2) can trust
 * as lookup input are `storeSlug`, `productSlug` and `selectedOptions`'
 * `groupName`/`value` pairs — everything else exists purely so this app can
 * render the Cart without re-fetching every Product on every paint. See
 * `cart-context.tsx`'s module doc for the full authority boundary.
 */

/** One selected value within one option group, identified by name — the
 * public Product API exposes no group/value database id (see
 * `commerce-types.ts`), so name+value IS the public identity, the same way
 * `slug` is the Product's public identity instead of its internal id. */
export interface CartSelectedOption {
  readonly groupDisplayOrder: number;
  readonly groupName: string;
  readonly value: string;
  readonly valueDisplayOrder: number;
}

export interface CartLine {
  /** Deterministic identity: `buildCartLineKey(productSlug, selectedOptions)`.
   * Two lines share a key only when they are the exact same Product with the
   * exact same option selections (C1 §9) — adding the same configuration
   * again finds this key and increments `quantity` instead of duplicating. */
  readonly lineKey: string;
  readonly imageUrl: string | null;
  /** From the Product's own `maximumQuantity`/`minimumQuantity` at the time
   * this line was added -- never an invented stock count (C1 §16/§25). `null`
   * means the Product declares no maximum/minimum of its own. */
  readonly maximumQuantity: number | null;
  readonly minimumQuantity: number | null;
  readonly previousPrice: string | null;
  readonly productName: string;
  readonly productSlug: string;
  readonly quantity: number;
  readonly selectedOptions: readonly CartSelectedOption[];
  /** Set when a revalidation (§42-45, run on Cart page load) finds the
   * Product gone/inactive/unavailable or a selected option value no longer
   * active. `null` means still valid as far as the last check found. A
   * Customer can still see and remove an invalid line; nothing built in C1
   * lets it proceed to a future Checkout while this is set. */
  readonly invalidReason:
    | "option_removed"
    | "product_inactive"
    | "product_unavailable"
    | null;
  readonly unitPrice: string;
}

export interface Cart {
  readonly currency: string;
  readonly lines: readonly CartLine[];
  readonly storeDisplayName: string;
  readonly storeSlug: string;
}

/** The versioned shape actually written to storage — see cart-storage.ts. */
export interface StoredCartPayload {
  readonly cart: Cart | null;
  readonly cartVersion: 1;
}

export const CART_STORAGE_VERSION = 1;
