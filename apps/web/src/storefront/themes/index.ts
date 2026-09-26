import type { StorefrontTheme, StorefrontThemeKey } from "../types.js";
import { cleanLightTheme } from "./clean-light.js";
import { luxuryMinimalTheme } from "./luxury-minimal.js";
import { modernTheme } from "./modern.js";

export const storefrontThemes: Readonly<Record<StorefrontThemeKey, StorefrontTheme>> = {
  "clean-light": cleanLightTheme,
  "luxury-minimal": luxuryMinimalTheme,
  modern: modernTheme,
};
