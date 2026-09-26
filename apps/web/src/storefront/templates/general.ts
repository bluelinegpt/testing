import type { StorefrontTemplate } from "../types.js";

/** General Products: simple, practical grid vocabulary; plain attribute list. */
export const generalTemplate: StorefrontTemplate = {
  attributesAsTable: false,
  attributesHeading: "Product Information",
  key: "general",
  label: "General Products",
  shelves: {
    bestSellers: "Customer Favourites",
    featured: "Picked for You",
    newArrivals: "New in Store",
  },
  warrantyBadge: false,
};
