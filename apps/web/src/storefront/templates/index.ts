import type { StorefrontTemplate, StorefrontTemplateKey } from "../types.js";
import { electronicsTemplate } from "./electronics.js";
import { fashionTemplate } from "./fashion.js";
import { generalTemplate } from "./general.js";
import { jewelryTemplate } from "./jewelry.js";

export const storefrontTemplates: Readonly<
  Record<StorefrontTemplateKey, StorefrontTemplate>
> = {
  electronics: electronicsTemplate,
  fashion: fashionTemplate,
  general: generalTemplate,
  jewelry: jewelryTemplate,
};
