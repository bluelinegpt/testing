import type { StorefrontTemplate } from "../types.js";

/**
 * Jewelry: luxury treatment with certificate/material details and an explicit
 * high-value Cash on Delivery notice. No appointment booking, no online
 * payment.
 */
export const jewelryTemplate: StorefrontTemplate = {
  attributesAsTable: false,
  attributesHeading: "Material & Certificate",
  highValueCodNotice:
    "High-value order notice: for Cash on Delivery, our team confirms every order by phone before dispatch, and the courier may request identification on delivery.",
  key: "jewelry",
  label: "Jewelry",
  shelves: {
    bestSellers: "Most Loved",
    featured: "Signature Pieces",
    newArrivals: "New This Season",
  },
  warrantyBadge: false,
};
