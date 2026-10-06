import { HttpStatus } from "@nestjs/common";

import { ApplicationException } from "../presentation/errors/application.exception.js";

/**
 * Multi-value search: "2383, 1523, 2447" (or one value per line, pasted from
 * Excel) means "any of these, each matched EXACTLY".
 *
 * A term is a LIST as soon as it contains a separator (comma, Arabic comma or
 * a line break). Semicolons are deliberately NOT separators: they appear in
 * free text. A term with no separator keeps the single-value behaviour of
 * the field it is typed into, so nothing that works today changes.
 */

export const SEARCH_LIST_LIMIT = 200;

const SEPARATORS = /[,،\r\n]+/u;

/** True when the term is a list (it contains at least one separator). */
export function isSearchList(term: string | null | undefined): boolean {
  return term !== null && term !== undefined && SEPARATORS.test(term);
}

/**
 * The trimmed, de-duplicated, non-empty values of a list. Refuses more than
 * SEARCH_LIST_LIMIT values with a clear 400 rather than building a huge query.
 */
export function splitSearchList(term: string): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const raw of term.split(SEPARATORS)) {
    const value = raw.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (value === "") continue;
    const key = value.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  if (values.length > SEARCH_LIST_LIMIT) {
    throw new ApplicationException(
      "search_list_too_long",
      `Search up to ${SEARCH_LIST_LIMIT} values at a time`,
      HttpStatus.BAD_REQUEST,
    );
  }
  return values;
}

/**
 * Every stored Order Number a typed value can mean, for an EXACT match.
 *
 * Order Numbers are stored as `ORD-` plus a zero-padded sequence
 * (`ORD-000110`). Operators type them in full, in lower case, or as the bare
 * number ("110"), so each value yields the exact candidates for those forms --
 * never a pattern: "110" can match ORD-000110 and ORD-110 but not ORD-001100.
 */
export function orderNumberCandidates(value: string): string[] {
  const upper = value.toUpperCase();
  const candidates = new Set<string>([value, upper]);
  const numeric = /^(?:ORD-?)?0*(\d+)$/u.exec(upper);
  if (numeric !== null) {
    const digits = numeric[1]!;
    candidates.add(`ORD-${digits}`);
    candidates.add(`ORD-${digits.padStart(6, "0")}`);
  }
  return [...candidates];
}
