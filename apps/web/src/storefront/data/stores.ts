import type { StoreConfig } from "../types.js";
import { electronicsStore } from "./electronics-store.js";
import { fashionStore } from "./fashion-store.js";
import { generalStore } from "./general-store.js";
import { jewelryStore } from "./jewelry-store.js";

/**
 * The static sample-store registry. Slug → configuration; an unknown slug
 * resolves to nothing and the shell shows its safe not-found state — it never
 * falls through to any application page.
 */
export const sampleStores: readonly StoreConfig[] = [
  fashionStore,
  electronicsStore,
  jewelryStore,
  generalStore,
];

export const storeBySlug = (slug: string): StoreConfig | undefined =>
  sampleStores.find((store) => store.profile.slug === slug);
