import type { StorefrontTemplate } from "../types.js";

/**
 * Electronics: technical presentation — the attribute block renders as a
 * bordered specification table and a Warranty attribute surfaces as a badge.
 * No product comparison exists in this phase.
 */
export const electronicsTemplate: StorefrontTemplate = {
  attributesAsTable: true,
  attributesHeading: "Specifications",
  key: "electronics",
  label: "Electronics",
  shelves: {
    bestSellers: "Top Rated",
    featured: "Feature Highlights",
    newArrivals: "Just Launched",
  },
  warrantyBadge: true,
};
