import type { SeoDocument } from "./seo-document.js";

/**
 * Turning a `SeoDocument` into HTML head markup.
 *
 * ---------------------------------------------------------------------------
 * EVERY DYNAMIC VALUE HERE IS TRADER-CONTROLLED TEXT
 * ---------------------------------------------------------------------------
 *
 * Store names, Product names and descriptions are typed by Traders and injected
 * into `<title>`, into attribute values, and into a `<script>` block. Any of
 * those is an injection point if the text is concatenated raw, and the payload
 * does not even have to be malicious — a shop legitimately called
 * `Mo"s <Boutique>` breaks the document by accident.
 *
 * So there are two distinct escapers, because the contexts have different
 * rules, and using one where the other belongs is exactly how these bugs ship:
 *
 *   `escapeHtml`  — for text and attribute values.
 *   `escapeJsonLd` — for JSON inside a <script> element.
 *
 * ---------------------------------------------------------------------------
 * WHY JSON-LD NEEDS MORE THAN JSON.stringify
 * ---------------------------------------------------------------------------
 *
 * `JSON.stringify` produces valid JSON, and valid JSON containing the literal
 * characters `</script>` still terminates the surrounding element — the HTML
 * parser does not know or care that it is inside a string. A Product
 * description containing that sequence would close the script early and drop
 * the rest of the payload into the document as markup.
 *
 * Escaping `<`, `>` and `&` as unicode sequences keeps the JSON semantically
 * identical (a parser reads `<` as `<`) while leaving no character the
 * HTML tokeniser can act on. U+2028/U+2029 go too: they are legal in JSON but
 * are line terminators in JavaScript.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escaping JSON for a <script> element.
 *
 * The replacement values are six-character TEXT sequences beginning with a
 * backslash. Writing the character they denote instead would replace "<" with
 * "<" and escape nothing -- that exact mistake produced a function that looked
 * right and left a raw </script> in the output, so it is called out here.
 *
 * U+2028/U+2029 come from fromCharCode because a literal one in source IS a
 * line terminator and breaks the file.
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const jsLineTerminators = new RegExp(`[${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, "g");

export function escapeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(jsLineTerminators, (character) =>
      character === LINE_SEPARATOR ? "\\u2028" : "\\u2029",
    );
}

function meta(name: string, content: string | null): string {
  if (content === null) return "";
  return `<meta name="${escapeHtml(name)}" content="${escapeHtml(content)}" />`;
}

function property(name: string, content: string | null): string {
  if (content === null) return "";
  return `<meta property="${escapeHtml(name)}" content="${escapeHtml(content)}" />`;
}

/** The `<head>` fragment for a route. */
export function renderMetadata(document: SeoDocument): string {
  const ogLocale = document.locale === "ar" ? "ar_AE" : "en_US";
  const alternateLocale = document.locale === "ar" ? "en_US" : "ar_AE";

  const tags = [
    `<title>${escapeHtml(document.title)}</title>`,
    meta("description", document.description),
    meta("robots", document.robots),
    `<link rel="canonical" href="${escapeHtml(document.canonical)}" />`,
    ...document.alternates.map(
      (alternate) =>
        `<link rel="alternate" hreflang="${escapeHtml(alternate.hrefLang)}" href="${escapeHtml(alternate.href)}" />`,
    ),
    property("og:type", document.ogType),
    property("og:title", document.title),
    property("og:description", document.description),
    property("og:url", document.canonical),
    property("og:site_name", document.siteName),
    property("og:locale", ogLocale),
    property("og:locale:alternate", alternateLocale),
    // Only ever an absolute, publicly fetchable URL — a relative path or a
    // private endpoint would produce a share card with a broken image.
    property("og:image", document.imageUrl),
    meta("twitter:card", document.imageUrl === null ? "summary" : "summary_large_image"),
    meta("twitter:title", document.title),
    meta("twitter:description", document.description),
    meta("twitter:image", document.imageUrl),
    ...document.jsonLd.map(
      (entry) => `<script type="application/ld+json">${escapeJsonLd(entry)}</script>`,
    ),
  ];
  return tags.filter((tag) => tag !== "").join("\n    ");
}

/**
 * Inject metadata into the built shell.
 *
 * The shell's own `<title>` is removed first. Leaving it would emit two title
 * elements, and which one a given crawler honours is not something worth
 * discovering in production.
 *
 * `lang` and `dir` are rewritten on the `<html>` element so the document is
 * correct for Arabic before React runs — a crawler and a screen reader both
 * read that attribute, and neither waits for hydration.
 */
export function injectMetadata(shell: string, document: SeoDocument): string {
  const direction = document.locale === "ar" ? "rtl" : "ltr";
  return shell
    .replace(/<html[^>]*>/i, `<html lang="${document.locale}" dir="${direction}">`)
    .replace(/<title>.*?<\/title>\s*/is, "")
    .replace("</head>", `    ${renderMetadata(document)}\n  </head>`);
}
