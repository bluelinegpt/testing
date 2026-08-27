import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { CartProvider, useCart, type AddToCartInput } from "./cart-context.js";

function wrapper({ children }: { children: React.ReactNode }) {
  return <CartProvider>{children}</CartProvider>;
}

const baseInput: AddToCartInput = {
  currency: "AED",
  imageUrl: "https://example.test/abaya.png",
  maximumQuantity: null,
  minimumQuantity: null,
  previousPrice: "249.00",
  productName: "Embroidered Abaya",
  productSlug: "embroidered-abaya",
  quantity: 1,
  selectedOptions: [
    { groupDisplayOrder: 1, groupName: "Size", value: "Medium", valueDisplayOrder: 1 },
  ],
  storeDisplayName: "Ajman Store",
  storeSlug: "ajman-store",
  unitPrice: "179.00",
};

const otherStoreInput: AddToCartInput = {
  ...baseInput,
  productName: "Something Else",
  productSlug: "something-else",
  storeDisplayName: "Sharjah Bazaar",
  storeSlug: "sharjah-bazaar",
};

describe("Cart context", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("starts empty", () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    expect(result.current.cart).toBeNull();
    expect(result.current.itemCount).toBe(0);
  });

  it("adds a Product as one line", () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    act(() => {
      result.current.addToCart(baseInput);
    });
    expect(result.current.cart?.lines).toHaveLength(1);
    expect(result.current.cart?.lines[0]?.quantity).toBe(1);
    expect(result.current.itemCount).toBe(1);
  });

  it("increments quantity when the exact same Product+option configuration is added again", () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    act(() => {
      result.current.addToCart(baseInput);
    });
    act(() => {
      result.current.addToCart(baseInput);
    });
    expect(result.current.cart?.lines).toHaveLength(1);
    expect(result.current.cart?.lines[0]?.quantity).toBe(2);
  });

  it("creates a separate line for a different option selection on the same Product", () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    act(() => {
      result.current.addToCart(baseInput);
    });
    act(() => {
      result.current.addToCart({
        ...baseInput,
        selectedOptions: [
          { groupDisplayOrder: 1, groupName: "Size", value: "Large", valueDisplayOrder: 3 },
        ],
      });
    });
    expect(result.current.cart?.lines).toHaveLength(2);
  });

  it("line identity is independent of selection order (sorted by displayOrder)", () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    const withColorFirst: AddToCartInput = {
      ...baseInput,
      selectedOptions: [
        { groupDisplayOrder: 0, groupName: "Color", value: "Black", valueDisplayOrder: 0 },
        { groupDisplayOrder: 1, groupName: "Size", value: "Medium", valueDisplayOrder: 1 },
      ],
    };
    const withSizeFirst: AddToCartInput = {
      ...baseInput,
      selectedOptions: [
        { groupDisplayOrder: 1, groupName: "Size", value: "Medium", valueDisplayOrder: 1 },
        { groupDisplayOrder: 0, groupName: "Color", value: "Black", valueDisplayOrder: 0 },
      ],
    };
    act(() => {
      result.current.addToCart(withColorFirst);
    });
    act(() => {
      result.current.addToCart(withSizeFirst);
    });
    // Same configuration, options supplied in a different order -- must
    // collapse to one line, not two (C1 §10).
    expect(result.current.cart?.lines).toHaveLength(1);
    expect(result.current.cart?.lines[0]?.quantity).toBe(2);
  });

  it("increases and decreases quantity, never below 1", () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    act(() => {
      result.current.addToCart(baseInput);
    });
    const lineKey = result.current.cart!.lines[0]!.lineKey;
    act(() => {
      result.current.setQuantity(lineKey, 2);
    });
    expect(result.current.cart?.lines[0]?.quantity).toBe(2);
    act(() => {
      result.current.setQuantity(lineKey, 1);
    });
    expect(result.current.cart?.lines[0]?.quantity).toBe(1);
    act(() => {
      result.current.setQuantity(lineKey, 0);
    });
    expect(result.current.cart?.lines[0]?.quantity).toBe(1);
  });

  it("respects a configured maximum quantity", () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    act(() => {
      result.current.addToCart({ ...baseInput, maximumQuantity: 3 });
    });
    const lineKey = result.current.cart!.lines[0]!.lineKey;
    act(() => {
      result.current.setQuantity(lineKey, 10);
    });
    expect(result.current.cart?.lines[0]?.quantity).toBe(3);
  });

  it("removes a line and clears the Cart entirely when it was the last one", () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    act(() => {
      result.current.addToCart(baseInput);
    });
    const lineKey = result.current.cart!.lines[0]!.lineKey;
    act(() => {
      result.current.removeLine(lineKey);
    });
    expect(result.current.cart).toBeNull();
    expect(result.current.itemCount).toBe(0);
  });

  it("clearCart empties the Cart", () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    act(() => {
      result.current.addToCart(baseInput);
    });
    act(() => {
      result.current.clearCart();
    });
    expect(result.current.cart).toBeNull();
  });

  it("persists across a fresh provider mount (reload simulation)", () => {
    const first = renderHook(() => useCart(), { wrapper });
    act(() => {
      first.result.current.addToCart(baseInput);
    });
    const second = renderHook(() => useCart(), { wrapper });
    expect(second.result.current.cart?.lines).toHaveLength(1);
    expect(second.result.current.itemCount).toBe(1);
  });

  describe("Store isolation", () => {
    it("adding from a different Store asks for confirmation and does not touch the current Cart", () => {
      const { result } = renderHook(() => useCart(), { wrapper });
      act(() => {
        result.current.addToCart(baseInput);
      });
      let outcome: string | undefined;
      act(() => {
        outcome = result.current.addToCart(otherStoreInput);
      });
      expect(outcome).toBe("needs_store_confirmation");
      expect(result.current.cart?.storeSlug).toBe("ajman-store");
      expect(result.current.cart?.lines).toHaveLength(1);
      expect(result.current.pendingAdd?.storeSlug).toBe("sharjah-bazaar");
    });

    it("cancelling the replacement leaves the original Cart untouched", () => {
      const { result } = renderHook(() => useCart(), { wrapper });
      act(() => {
        result.current.addToCart(baseInput);
      });
      act(() => {
        result.current.addToCart(otherStoreInput);
      });
      act(() => {
        result.current.cancelStoreReplacement();
      });
      expect(result.current.cart?.storeSlug).toBe("ajman-store");
      expect(result.current.pendingAdd).toBeNull();
    });

    it("confirming the replacement clears the old Cart and starts a new one from the pending Store", () => {
      const { result } = renderHook(() => useCart(), { wrapper });
      act(() => {
        result.current.addToCart(baseInput);
      });
      act(() => {
        result.current.addToCart(otherStoreInput);
      });
      act(() => {
        result.current.confirmStoreReplacement();
      });
      expect(result.current.cart?.storeSlug).toBe("sharjah-bazaar");
      expect(result.current.cart?.lines).toHaveLength(1);
      expect(result.current.cart?.lines[0]?.productSlug).toBe("something-else");
      expect(result.current.pendingAdd).toBeNull();
    });

    it("never produces a Cart containing lines from two different Stores", () => {
      const { result } = renderHook(() => useCart(), { wrapper });
      act(() => {
        result.current.addToCart(baseInput);
      });
      act(() => {
        result.current.addToCart(otherStoreInput);
      });
      const storeSlugs = new Set(
        result.current.cart === null ? [] : [result.current.cart.storeSlug],
      );
      expect(storeSlugs.size).toBeLessThanOrEqual(1);
      act(() => {
        result.current.confirmStoreReplacement();
      });
      const afterConfirm = new Set(
        result.current.cart === null ? [] : [result.current.cart.storeSlug],
      );
      expect(afterConfirm.size).toBe(1);
    });
  });
});
