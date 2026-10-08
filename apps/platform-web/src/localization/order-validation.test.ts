import { describe, expect, it } from "vitest";

import {
  ORDER_VALIDATION_COPY_KEYS,
  orderValidationLocalization,
  orderValidationText,
} from "./order-validation";

const ARABIC = /[؀-ۿ]/u;

describe("Order Validation copy", () => {
  it("has a non-empty English and Arabic title and description for every check", () => {
    for (const key of ORDER_VALIDATION_COPY_KEYS) {
      for (const language of ["en", "ar"] as const) {
        const copy = orderValidationLocalization[language][key];
        expect(copy.title.trim(), `${language} ${key} title`).not.toBe("");
        expect(copy.description.trim(), `${language} ${key} description`).not.toBe("");
      }
      expect(orderValidationLocalization.ar[key].title).toMatch(ARABIC);
      expect(orderValidationLocalization.ar[key].description).toMatch(ARABIC);
    }
  });

  it("resolves the API's titleKey and descriptionKey, including the strong V1 variant", () => {
    expect(orderValidationText("platform.orderValidation.F1.title", "en")).toBe("Order amounts");
    expect(orderValidationText("platform.orderValidation.V1.strong.title", "en")).toContain(
      "larger than the service fee",
    );
    expect(orderValidationText("platform.orderValidation.V2.description", "ar")).toMatch(ARABIC);
  });

  it("falls back to the key for anything unknown", () => {
    expect(orderValidationText("platform.orderValidation.Z9.title", "en")).toBe(
      "platform.orderValidation.Z9.title",
    );
    expect(orderValidationText("something.else", "ar")).toBe("something.else");
  });
});
