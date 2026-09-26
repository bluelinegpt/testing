import { beforeEach, describe, expect, it } from "vitest";

import { readCart, writeCart } from "./cart-storage.js";
import type { Cart } from "./cart-types.js";

const sampleCart: Cart = {
  currency: "AED",
  lines: [
    {
      imageUrl: null,
      invalidReason: null,
      lineKey: "embroidered-abaya::Size:Medium",
      maximumQuantity: null,
      minimumQuantity: null,
      previousPrice: null,
      productName: "Embroidered Abaya",
      productSlug: "embroidered-abaya",
      quantity: 1,
      selectedOptions: [
        { groupDisplayOrder: 1, groupName: "Size", value: "Medium", valueDisplayOrder: 1 },
      ],
      unitPrice: "179.00",
    },
  ],
  storeDisplayName: "Ajman Store",
  storeSlug: "ajman-store",
};

describe("Cart storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips a Cart through localStorage", () => {
    writeCart(sampleCart);
    expect(readCart()).toEqual(sampleCart);
  });

  it("returns null when nothing has been stored yet", () => {
    expect(readCart()).toBeNull();
  });

  it("clears to null when explicitly written null", () => {
    writeCart(sampleCart);
    writeCart(null);
    expect(readCart()).toBeNull();
  });

  it("ignores and resets safely on malformed JSON rather than throwing", () => {
    window.localStorage.setItem("blueline.store.cart.v1", "{not json");
    expect(() => readCart()).not.toThrow();
    expect(readCart()).toBeNull();
  });

  it("ignores a payload with no cartVersion field", () => {
    window.localStorage.setItem("blueline.store.cart.v1", JSON.stringify({ cart: sampleCart }));
    expect(readCart()).toBeNull();
  });

  it("ignores a payload from a future/different schema version", () => {
    window.localStorage.setItem(
      "blueline.store.cart.v1",
      JSON.stringify({ cart: sampleCart, cartVersion: 2 }),
    );
    expect(readCart()).toBeNull();
  });

  it("ignores a Cart shape missing required line fields", () => {
    window.localStorage.setItem(
      "blueline.store.cart.v1",
      JSON.stringify({
        cart: { currency: "AED", lines: [{ productSlug: "x" }], storeDisplayName: "X", storeSlug: "x" },
        cartVersion: 1,
      }),
    );
    expect(readCart()).toBeNull();
  });

  it("ignores a top-level payload that is not an object at all", () => {
    window.localStorage.setItem("blueline.store.cart.v1", JSON.stringify([1, 2, 3]));
    expect(readCart()).toBeNull();
  });
});
