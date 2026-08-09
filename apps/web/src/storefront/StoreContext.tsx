import { createContext, useContext } from "react";

import { storefrontTemplates } from "./templates/index.js";
import { storefrontThemes } from "./themes/index.js";
import type {
  StoreConfig,
  StorefrontProduct,
  StorefrontTemplate,
  StorefrontTheme,
} from "./types.js";

/**
 * The active sample store, provided once by the shell so every shared page and
 * component serves whichever store the URL names — one flow, four stores,
 * never a per-template copy of anything.
 */
export interface ActiveStore {
  readonly base: string;
  readonly config: StoreConfig;
  readonly productBySlug: (slug: string) => StorefrontProduct | undefined;
  readonly template: StorefrontTemplate;
  readonly theme: StorefrontTheme;
}

export const StoreContext = createContext<ActiveStore | undefined>(undefined);

export function useStore(): ActiveStore {
  const store = useContext(StoreContext);
  if (store === undefined) {
    throw new Error("useStore must be used inside a storefront shell");
  }
  return store;
}

export function activeStoreFor(
  config: StoreConfig,
  themeOverrideKey?: StorefrontTheme["key"],
): ActiveStore {
  return {
    base: `/store/${config.profile.slug}`,
    config,
    productBySlug: (slug) => config.products.find((product) => product.slug === slug),
    template: storefrontTemplates[config.templateKey],
    theme: storefrontThemes[themeOverrideKey ?? config.themeKey],
  };
}
