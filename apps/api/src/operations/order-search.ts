import { type RawBuilder, sql } from "kysely";

import { normalizeUaeMobile } from "../shared/uae-mobile.js";

/**
 * The one predicate behind the single Order search field.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT THE OLD SHAPE
 * ---------------------------------------------------------------------------
 *
 * This replaces a seven-way `ILIKE '%term%'` chain that also reached into the
 * joined Trader and Driver rows. Every arm of it was unindexable -- a leading
 * wildcard defeats a B-tree, and no index on `orders` can help a predicate on
 * `traders`. At 100,000 rows that chain measured 237ms and scaled linearly, so
 * it was a sequential scan of the whole Company on every keystroke.
 *
 * Each branch below is instead shaped to hit an index created by
 * `20260810300000_order_search_index_foundation`:
 *
 *   branch            index
 *   order number      orders_company_order_number_pattern_index  (prefix)
 *   serial number     orders_company_serial_pattern_index        (exact/prefix)
 *   mobile            orders_company_mobile_pattern_index        (exact/prefix)
 *   reference         orders_reference_normalized_trgm_index     (infix)
 *   customer name     orders_customer_name_trgm_index            (infix)
 *
 * ---------------------------------------------------------------------------
 * THINGS THAT LOOK LIKE MISTAKES AND ARE NOT
 * ---------------------------------------------------------------------------
 *
 * `lower(customer_name) like lower(...)` rather than `ILIKE`. The trigram index
 * is built on `lower(customer_name)`; `ILIKE` does not match that expression and
 * silently falls back to a scan. The two read almost identically and behave
 * completely differently, which is exactly why this comment exists.
 *
 * The Order Number arm tests the term AND its uppercase form. `text_pattern_ops`
 * is byte-ordered and therefore case-sensitive, so a typed `ord-1` would never
 * reach `ORD-1`. Two prefix probes stay indexed; `upper(o.order_number)` would
 * not, because no index exists on that expression.
 *
 * Trader and Driver names are deliberately NOT searched. The unified field is
 * specified as Order No., Reference No., Customer Name and Mobile; Trader and
 * Driver remain structured filters, which are indexed and exact. Restoring them
 * here would reintroduce the unindexable join predicate this replaces.
 *
 * Serial Number is exact and prefix only, not infix. It is an operator-assigned
 * identifier read off a label, so a fragment from the middle of one is not a
 * search anybody performs -- and infix would have cost a trigram index for a
 * capability nobody asked for. Reference Number is the field operators paste
 * fragments of, and that is where the trigram coverage is.
 */

/** Matches how `normalizeOrderIdentifier` stores `reference_number_normalized`. */
export function normalizeReferenceTerm(term: string): string {
  return term.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

/** True when the term is worth spending the mobile branch on. */
function looksLikeMobile(term: string): boolean {
  // Digits, with optional leading + and separators people paste from contacts.
  return /^[+0-9][0-9\s()\-.]{3,}$/u.test(term);
}

/**
 * A `where` fragment for one search term, or `true` when there is nothing to
 * search. Every value is a bound parameter; no user text is concatenated into
 * SQL, so a term like `'; drop table orders --` is matched as literal text.
 *
 * `o` must be the alias of `orders` in the calling query.
 */
export function unifiedOrderSearchPredicate(term: string | null | undefined): RawBuilder<boolean> {
  const trimmed = term?.trim() ?? "";
  if (trimmed === "") return sql<boolean>`true`;

  const reference = normalizeReferenceTerm(trimmed);
  const branches: RawBuilder<boolean>[] = [
    // PSystem Serial: globally unique and always tried first.
    sql<boolean>`o.psystem_serial_normalized = ${reference}`,
    // Order Number: exact first, then prefix, in both the typed and upper form.
    sql<boolean>`o.order_number = ${trimmed}`,
    sql<boolean>`o.order_number like ${trimmed + "%"}`,
    sql<boolean>`o.order_number like ${trimmed.toUpperCase() + "%"}`,
    // Serial: exact, then prefix. Shares the Reference normalisation because the
    // writer normalises both through `normalizeOrderIdentifier` -- lower-cased,
    // NFKC, trimmed, spaces collapsed, leading zeros and '-', '_', '/' intact.
    // Never cast to a number: '000123' is a different serial from '123'.
    sql<boolean>`o.serial_number_normalized = ${reference}`,
    sql<boolean>`o.serial_number_normalized like ${reference + "%"}`,
    // Reference: infix on the normalised column, so leading zeros survive and
    // '-', '_' and '/' are matched literally rather than stripped.
    sql<boolean>`o.reference_number_normalized like ${"%" + reference + "%"}`,
    // Customer Name: infix, case-insensitive, Unicode-safe. Arabic works
    // through the same trigram index as Latin.
    sql<boolean>`lower(o.customer_name) like ${"%" + reference + "%"}`,
  ];

  if (looksLikeMobile(trimmed)) {
    const canonical = normalizeUaeMobile(trimmed);
    if (canonical !== null && canonical !== undefined) {
      // A recognised UAE number: match the canonical stored form exactly,
      // whichever of the accepted input forms was typed.
      branches.push(sql<boolean>`o.customer_mobile_number = ${canonical}`);
    }
    // Partial numbers never normalise, so a prefix probe on the digits is what
    // makes "0506468" find something while still using the index.
    const digits = trimmed.replace(/[^0-9]/gu, "");
    if (digits.length >= 3) {
      branches.push(sql<boolean>`o.customer_mobile_number like ${digits + "%"}`);
      // The same digits after the local-to-canonical shift, so a partial
      // '05064' also reaches a stored '9715064...'.
      if (digits.startsWith("0")) {
        branches.push(sql<boolean>`o.customer_mobile_number like ${"971" + digits.slice(1) + "%"}`);
      }
    }
  }

  return sql<boolean>`(${sql.join(branches, sql` or `)})`;
}
