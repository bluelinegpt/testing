/**
 * Stable template keys.
 *
 * ---------------------------------------------------------------------------
 * WHY KEYS ARE DERIVED, NOT HAND-WRITTEN
 * ---------------------------------------------------------------------------
 *
 * Every relationship in a template — a mapping pointing at an account, a Cash
 * account pointing at its GL account, a child account pointing at its parent —
 * is expressed as a key. If those keys were maintained by hand they would drift
 * from the Chart of Accounts they name, and the drift would only surface when a
 * new Company was initialised with a mapping pointing at nothing.
 *
 * So they are derived from the account's own semantics, by a pure function.
 * Re-running the exporter against unchanged configuration produces byte-identical
 * keys, which is what makes the template hash meaningful.
 *
 * ---------------------------------------------------------------------------
 * THE DERIVATION
 * ---------------------------------------------------------------------------
 *
 * `<ACCOUNT_TYPE>_<ACCOUNT_CLASS>`, with one simplification and one tie-break.
 *
 * The simplification: a class that merely repeats its own type is redundant.
 * `expense` + `driver_expense` would read `EXPENSE_DRIVER_EXPENSE`, so a leading
 * or trailing segment equal to the type word is dropped — giving `EXPENSE_DRIVER`,
 * `EXPENSE_PAYROLL`, `REVENUE_DELIVERY`. Note this only strips the *type* word:
 * `vat_payable` keeps `payable` because `payable` is not `liability`.
 *
 * The tie-break: two accounts may legitimately share a class (a Chart of
 * Accounts can hold several `other_receivable` accounts). The first collision
 * makes ALL members of that class carry a `_<CODE>` suffix — not just the later
 * ones. Suffixing only the duplicates would mean the key of an existing account
 * changed depending on whether a second one had been added yet, and a key that
 * moves is not a stable key.
 */

const accountTypeWords = new Set(["asset", "liability", "equity", "revenue", "expense"]);

/** Strips a leading or trailing segment that merely repeats the account type. */
function simplifyClass(accountType: string, accountClass: string): string {
  const segments = accountClass.split("_").filter((segment) => segment.length > 0);
  if (segments.length > 1 && segments[0] === accountType) {
    return segments.slice(1).join("_");
  }
  if (segments.length > 1 && segments[segments.length - 1] === accountType) {
    return segments.slice(0, -1).join("_");
  }
  return segments.join("_");
}

function normalise(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export interface KeyedAccountInput {
  readonly code: string;
  readonly accountType: string;
  readonly accountClass: string;
}

/**
 * Derives the key for every account in one pass.
 *
 * Returns a map from account code to key. Account codes are unique per Company
 * (`chart_of_accounts` indexes them so), which makes the code the right handle
 * for the caller to resolve relationships by.
 */
export function deriveAccountKeys(
  accounts: readonly KeyedAccountInput[],
): ReadonlyMap<string, string> {
  const baseByCode = new Map<string, string>();
  const codesByBase = new Map<string, string[]>();

  for (const account of accounts) {
    const type = account.accountType.trim().toLowerCase();
    const typeWord = accountTypeWords.has(type) ? type : "";
    const base = normalise(
      `${type}_${simplifyClass(typeWord, account.accountClass.trim().toLowerCase())}`,
    );
    baseByCode.set(account.code, base);
    codesByBase.set(base, [...(codesByBase.get(base) ?? []), account.code]);
  }

  const keys = new Map<string, string>();
  for (const [code, base] of baseByCode) {
    const sharing = codesByBase.get(base) ?? [];
    // Every member of a shared class is suffixed, including the first, so a key
    // never changes because a sibling was added later.
    keys.set(code, sharing.length > 1 ? `${base}_${normalise(code)}` : base);
  }
  return keys;
}

/** Key for a non-account template entity (expense type, category, allowance). */
export function deriveEntityKey(prefix: string, code: string): string {
  return normalise(`${prefix}_${code}`);
}
