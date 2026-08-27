import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import { buildCartLineKey } from "./cart-line-key.js";
import { readCart, writeCart } from "./cart-storage.js";
import type { Cart, CartLine, CartSelectedOption } from "./cart-types.js";

/**
 * The Customer Cart, client-side for C1 (Customer Commerce Prompt C1, §3).
 *
 * ---------------------------------------------------------------------------
 * WHY CLIENT-SIDE, NOT A NEW DATABASE DOMAIN
 * ---------------------------------------------------------------------------
 *
 * No Cart table, API or Customer-cart relationship existed before this file
 * (confirmed by inspection — `/cart` was a disabled header control and a
 * `ReservedRoutePage`). A guest Customer has no account row to attach server
 * state to, and building one now would mean inventing session-linked guest
 * identity just to hold a shopping list that Checkout (C2) must re-validate
 * against the Product tables anyway. `localStorage`, versioned, is the
 * smallest architecture that supports guest + logged-in + a future Checkout
 * without a migration (§79) — see `cart-storage.ts`.
 *
 * ---------------------------------------------------------------------------
 * THE AUTHORITY BOUNDARY (§4, §62, §67)
 * ---------------------------------------------------------------------------
 *
 * Everything this Cart holds is a display convenience: Product name, image,
 * price, option labels. A Customer can open devtools and edit every one of
 * them. That is fine, because nothing downstream may ever trust it — a
 * future Checkout looks Product data up FRESH by `storeSlug` +
 * `productSlug` + `selectedOptions` and re-prices from there. This file
 * enforces none of that itself (there is no Checkout yet); it exists so the
 * shape of what gets handed to Checkout is unambiguous from day one.
 *
 * ---------------------------------------------------------------------------
 * LOGIN / LOGOUT (§34-37)
 * ---------------------------------------------------------------------------
 *
 * The Cart is intentionally NOT keyed to the Customer session at all: it is
 * one `localStorage` entry per browser, independent of `useCustomerSession`.
 * A guest who logs in keeps the exact same Cart (nothing to merge — there is
 * no separate "logged-in Cart" to merge it with), and logging out does not
 * clear it, because a shopping list is not sensitive account data. This is a
 * deliberate simplification a server-backed Cart could one day replace, not
 * an oversight.
 */

export interface AddToCartInput {
  readonly currency: string;
  readonly imageUrl: string | null;
  readonly maximumQuantity: number | null;
  readonly minimumQuantity: number | null;
  readonly previousPrice: string | null;
  readonly productName: string;
  readonly productSlug: string;
  readonly quantity: number;
  readonly selectedOptions: readonly CartSelectedOption[];
  readonly storeDisplayName: string;
  readonly storeSlug: string;
  readonly unitPrice: string;
}

interface CartContextValue {
  /** Adds a line, or — if the Cart already holds a different Store — returns
   * "needs_store_confirmation" and stashes the request in `pendingAdd`
   * without touching the current Cart (§8, §38-41). Call
   * `confirmStoreReplacement()` or `cancelStoreReplacement()` next. */
  readonly addToCart: (input: AddToCartInput) => "added" | "needs_store_confirmation";
  readonly cancelStoreReplacement: () => void;
  readonly cart: Cart | null;
  readonly clearCart: () => void;
  readonly confirmStoreReplacement: () => void;
  /** Sum of every line's quantity (§46) — the header badge count. */
  readonly itemCount: number;
  readonly pendingAdd: AddToCartInput | null;
  readonly removeLine: (lineKey: string) => void;
  /** Replaces one line wholesale -- used by Cart-page revalidation (§42-45)
   * to mark a line invalid without touching quantity/options. */
  readonly replaceLine: (lineKey: string, line: CartLine) => void;
  readonly setQuantity: (lineKey: string, quantity: number) => void;
}

const CartContext = createContext<CartContextValue | undefined>(undefined);

function addLineToCart(cart: Cart, input: AddToCartInput): Cart {
  const lineKey = buildCartLineKey(input.productSlug, input.selectedOptions);
  const existing = cart.lines.find((line) => line.lineKey === lineKey);
  if (existing !== undefined) {
    const max = existing.maximumQuantity;
    const nextQuantity =
      max === null ? existing.quantity + input.quantity : Math.min(max, existing.quantity + input.quantity);
    return {
      ...cart,
      lines: cart.lines.map((line) =>
        line.lineKey === lineKey ? { ...line, quantity: nextQuantity } : line,
      ),
    };
  }
  const newLine: CartLine = {
    imageUrl: input.imageUrl,
    invalidReason: null,
    lineKey,
    maximumQuantity: input.maximumQuantity,
    minimumQuantity: input.minimumQuantity,
    previousPrice: input.previousPrice,
    productName: input.productName,
    productSlug: input.productSlug,
    quantity: input.quantity,
    selectedOptions: input.selectedOptions,
    unitPrice: input.unitPrice,
  };
  return { ...cart, lines: [...cart.lines, newLine] };
}

export function CartProvider({ children }: { readonly children: ReactNode }) {
  const [cart, setCartState] = useState<Cart | null>(() => readCart());
  const [pendingAdd, setPendingAdd] = useState<AddToCartInput | null>(null);

  const setCart = useCallback((next: Cart | null) => {
    setCartState(next);
    writeCart(next);
  }, []);

  const addToCart = useCallback(
    (input: AddToCartInput): "added" | "needs_store_confirmation" => {
      if (cart !== null && cart.storeSlug !== input.storeSlug) {
        setPendingAdd(input);
        return "needs_store_confirmation";
      }
      const base: Cart =
        cart ?? {
          currency: input.currency,
          lines: [],
          storeDisplayName: input.storeDisplayName,
          storeSlug: input.storeSlug,
        };
      setCart(addLineToCart(base, input));
      return "added";
    },
    [cart, setCart],
  );

  const confirmStoreReplacement = useCallback(() => {
    if (pendingAdd === null) return;
    const fresh: Cart = {
      currency: pendingAdd.currency,
      lines: [],
      storeDisplayName: pendingAdd.storeDisplayName,
      storeSlug: pendingAdd.storeSlug,
    };
    setCart(addLineToCart(fresh, pendingAdd));
    setPendingAdd(null);
  }, [pendingAdd, setCart]);

  const cancelStoreReplacement = useCallback(() => {
    setPendingAdd(null);
  }, []);

  const setQuantity = useCallback(
    (lineKey: string, quantity: number) => {
      if (cart === null) return;
      setCart({
        ...cart,
        lines: cart.lines.map((line) => {
          if (line.lineKey !== lineKey) return line;
          const floor = Math.max(1, line.minimumQuantity ?? 1);
          const clamped = Math.max(floor, quantity);
          const bounded = line.maximumQuantity === null ? clamped : Math.min(line.maximumQuantity, clamped);
          return { ...line, quantity: bounded };
        }),
      });
    },
    [cart, setCart],
  );

  const removeLine = useCallback(
    (lineKey: string) => {
      if (cart === null) return;
      const remaining = cart.lines.filter((line) => line.lineKey !== lineKey);
      setCart(remaining.length === 0 ? null : { ...cart, lines: remaining });
    },
    [cart, setCart],
  );

  const replaceLine = useCallback(
    (lineKey: string, replacement: CartLine) => {
      if (cart === null) return;
      setCart({
        ...cart,
        lines: cart.lines.map((line) => (line.lineKey === lineKey ? replacement : line)),
      });
    },
    [cart, setCart],
  );

  const clearCart = useCallback(() => {
    setCart(null);
  }, [setCart]);

  const itemCount = useMemo(
    () => (cart?.lines.reduce((total, line) => total + line.quantity, 0) ?? 0),
    [cart],
  );

  const value = useMemo<CartContextValue>(
    () => ({
      addToCart,
      cancelStoreReplacement,
      cart,
      clearCart,
      confirmStoreReplacement,
      itemCount,
      pendingAdd,
      removeLine,
      replaceLine,
      setQuantity,
    }),
    [
      addToCart,
      cancelStoreReplacement,
      cart,
      clearCart,
      confirmStoreReplacement,
      itemCount,
      pendingAdd,
      removeLine,
      replaceLine,
      setQuantity,
    ],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (context === undefined) throw new Error("useCart must be used within a CartProvider");
  return context;
}
