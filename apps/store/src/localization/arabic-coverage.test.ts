import { ar } from "./resources/ar.js";
import { en } from "./resources/en.js";

/**
 * Arabic coverage.
 *
 * The failure this exists to prevent is not a crash: it is an Arabic page that
 * renders perfectly while showing "Featured stores", "Product code" and
 * "Required" in English. i18next falls back to English on a missing key, so a
 * gap in the Arabic resources is completely silent — the page looks finished
 * and is not.
 *
 * So the test walks both trees and asserts that every leaf English label has an
 * Arabic counterpart, and that the counterpart is not simply the English string
 * copied across.
 */

type Tree = { readonly [key: string]: Tree | string };

function leaves(tree: Tree, prefix = ""): readonly (readonly [string, string])[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return typeof value === "string"
      ? [[path, value] as const]
      : leaves(value, path);
  });
}

const englishLeaves = leaves(en as unknown as Tree);
const arabicLeaves = new Map(leaves(ar as unknown as Tree));

/**
 * Labels that are correctly identical in both files.
 *
 * A language switcher names each language IN that language, so both entries are
 * the same string in both files: "English" stays English and "العربية" stays
 * Arabic, which is what every bilingual site does and what lets a reader find
 * their own language without already knowing the other one.
 *
 * Anything else appearing here should be treated as an untranslated string, not
 * as a new exception to add.
 */
const intentionallyIdentical = new Set(["common.arabic", "common.english"]);

describe("Arabic system labels", () => {
  it("covers every English label", () => {
    const missing = englishLeaves
      .map(([path]) => path)
      .filter((path) => !arabicLeaves.has(path));
    expect(missing).toStrictEqual([]);
  });

  it("adds no Arabic key that English does not have", () => {
    // A stray Arabic-only key is a typo that will never render.
    const englishPaths = new Set(englishLeaves.map(([path]) => path));
    const extra = [...arabicLeaves.keys()].filter((path) => !englishPaths.has(path));
    expect(extra).toStrictEqual([]);
  });

  it("actually translates them instead of copying the English", () => {
    const untranslated = englishLeaves
      .filter(([path, value]) => {
        if (intentionallyIdentical.has(path)) return false;
        return arabicLeaves.get(path) === value;
      })
      .map(([path]) => path);
    expect(untranslated).toStrictEqual([]);
  });

  it("writes the customer-facing labels in Arabic script", () => {
    // A spot check on the labels the user reported as still English, asserting
    // the presence of Arabic characters rather than an exact wording, so
    // rephrasing does not break the test but reverting to English does.
    const arabicScript = /[؀-ۿ]/;
    for (const path of [
      "common.searchPlaceholder",
      "home.featuredStores.title",
      "home.quickCategories.title",
      "product.availability.available",
      "product.code",
      "product.optionRequired",
      "product.share.action",
      "store.businessHours",
      "store.delivery",
      "categories.subcategories",
    ]) {
      expect(arabicLeaves.get(path)).toMatch(arabicScript);
    }
  });
});
