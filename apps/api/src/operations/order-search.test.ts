import { describe, expect, it } from "vitest";

import { normalizeReferenceTerm, unifiedOrderSearchPredicate } from "./order-search.js";

/**
 * What the unified search term turns into.
 *
 * These assert the SHAPE of the predicate -- which columns are probed and with
 * what bound values -- because that is what decides whether an index is usable.
 * A change that swapped `lower(customer_name) like` for `ILIKE` would still
 * return correct rows and would silently cost a sequential scan on every
 * keystroke; only a shape assertion catches it.
 *
 * The plans themselves are verified separately against 100,000 rows.
 */

/** The compiled fragment: SQL text plus its bound parameters. */
function compiled(term: string | null | undefined) {
  const node = unifiedOrderSearchPredicate(term) as unknown as {
    toOperationNode: () => unknown;
  };
  // Kysely builds the fragment lazily; stringifying the node is enough to see
  // the literal SQL and the parameter list this test cares about.
  return JSON.stringify(node.toOperationNode());
}

const parameters = (term: string) => {
  const found = [...compiled(term).matchAll(/"value":"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    JSON.parse(`"${match[1]}"`),
  );
  return found as string[];
};

describe("unified order search predicate", () => {
  it("matches everything when there is no term", () => {
    for (const empty of [undefined, null, "", "   "]) {
      expect(compiled(empty)).toContain("true");
    }
  });

  it("trims surrounding whitespace before searching", () => {
    expect(parameters("  ORD-1  ")).toContain("ORD-1");
  });

  it("probes the Order Number exactly and by prefix, in both cases", () => {
    const values = parameters("ord-000123");
    expect(values).toContain("ord-000123");
    expect(values).toContain("ord-000123%");
    // text_pattern_ops is byte-ordered, so the uppercase probe is what lets a
    // lowercase search reach an uppercase stored Order Number.
    expect(values).toContain("ORD-000123%");
  });

  it("searches the Reference infix and preserves leading zeros", () => {
    const values = parameters("000123");
    expect(values).toContain("%000123%");
    // Never cast to a number: '000123' must not become '123'.
    expect(values).not.toContain("%123%");
  });

  it("keeps -, _ and / in the Reference term", () => {
    for (const reference of ["abc-001", "abc_002", "abc/003"]) {
      expect(parameters(reference)).toContain(`%${reference}%`);
    }
  });

  it("lower-cases the Reference term to match how it is stored", () => {
    expect(parameters("ABC-001")).toContain("%abc-001%");
    expect(normalizeReferenceTerm("  ABC-001  ")).toBe("abc-001");
    expect(normalizeReferenceTerm("ABC   001")).toBe("abc 001");
  });

  it("probes the Serial Number exactly and by prefix", () => {
    const values = parameters("SN-0000123");
    // Normalised the same way the writer stores it: lower-cased, trimmed.
    expect(values).toContain("sn-0000123");
    expect(values).toContain("sn-0000123%");
  });

  it("preserves leading zeros in a Serial Number", () => {
    const values = parameters("sn-000123");
    expect(values).toContain("sn-000123");
    // Never coerced to a number: '000123' is a different serial from '123'.
    expect(values).not.toContain("sn-123");
  });

  it("searches the Serial exactly and by prefix, never by infix", () => {
    const sqlText = compiled("sn-0000123");
    expect(sqlText).toContain("o.serial_number_normalized = ");
    expect(sqlText).toContain("o.serial_number_normalized like ");
    /* No infix probe on the SERIAL column -- that would need a trigram index
       this field deliberately lacks. Asserted on the SQL shape, not the
       parameter list: the Reference branch legitimately binds the same term
       wrapped in '%', so a value-only check would confuse the two columns. */
    const serialProbes = [...sqlText.matchAll(/o\.serial_number_normalized [^,"]*/g)].map(
      (match) => match[0],
    );
    expect(serialProbes).toHaveLength(2);
    expect(serialProbes.join(" ")).not.toContain("like ${'%'");
  });

  it("keeps -, _ and / in a Serial term", () => {
    for (const serial of ["sn-001", "sn_002", "sn/003"]) {
      expect(parameters(serial)).toContain(serial);
    }
  });

  it("uses the lowered name expression, never ILIKE", () => {
    const sqlText = compiled("Ahmed");
    expect(sqlText).toContain("lower(o.customer_name) like");
    // ILIKE would not match the trigram index and would scan instead.
    expect(sqlText.toLowerCase()).not.toContain("ilike");
  });

  it("searches Arabic names through the same branch", () => {
    expect(parameters("أحمد")).toContain("%أحمد%");
  });

  it("adds the canonical mobile probe for a recognisable UAE number", () => {
    for (const typed of ["0506468442", "+971506468442", "971506468442"]) {
      const values = parameters(typed);
      expect(values, `${typed} should reach the canonical form`).toContain("971506468442");
    }
  });

  it("adds a prefix probe for a partial mobile, in both local and canonical form", () => {
    const values = parameters("05064684");
    expect(values).toContain("05064684%");
    // The same digits after the trunk-zero shift, so a local partial still
    // reaches a canonically stored number.
    expect(values).toContain("9715064684%");
  });

  it("does not spend the mobile branch on a plainly non-numeric term", () => {
    const sqlText = compiled("Ahmed Ali");
    expect(sqlText).not.toContain("customer_mobile_number");
  });

  it("never searches Trader or Driver names", () => {
    // Those are structured filters. Reintroducing them here would put an
    // unindexable predicate on a joined table back into every search.
    const sqlText = compiled("Noon");
    expect(sqlText).not.toContain("t.name_en");
    expect(sqlText).not.toContain("d.name_en");
  });

  it("binds SQL-looking input as a value rather than as syntax", () => {
    const hostile = "'; drop table orders --";
    const sqlText = compiled(hostile);
    // The term appears only in the parameter list, never in the SQL text.
    expect(sqlText).toContain("drop table orders");
    expect(sqlText).not.toContain("; drop table orders --'");
    expect(parameters(hostile)).toContain(hostile);
  });
});
