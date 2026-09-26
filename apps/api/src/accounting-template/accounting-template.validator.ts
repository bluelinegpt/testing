import type {
  AccountingTemplate,
  TemplateAccount,
  TemplateAccountMapping,
} from "./accounting-template.types.js";

/**
 * Template validation.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS HAND-WRITTEN AND NOT `class-validator`
 * ---------------------------------------------------------------------------
 *
 * `class-validator` is this repository's HTTP DTO validator: it is driven by
 * decorators on request classes and is wired into the Nest validation pipe. A
 * template is not a request — it is a build-time artefact read from disk by a
 * CLI that never boots Nest, and most of what must be checked here is
 * *relational* (does every mapping point at an account that exists, is the
 * account hierarchy acyclic) rather than per-field. Expressing a cycle check as
 * a field decorator is not possible.
 *
 * So the checks live in one pure function with no framework dependency, which
 * the exporter runs before writing and the importer will run before loading.
 *
 * ---------------------------------------------------------------------------
 * THE VALIDATOR IS ALSO THE SAFETY NET
 * ---------------------------------------------------------------------------
 *
 * Beyond structural correctness it enforces the two rules that make a template
 * safe to reuse: no database identifier may appear anywhere in it, and no
 * financial history may have leaked in. Those two checks are the reason an
 * exporter bug becomes a refused export rather than a corrupted template.
 */

const supportedSchemaVersions = new Set([1]);
const accountTypes = new Set(["asset", "liability", "equity", "revenue", "expense"]);
const normalBalances = new Set(["debit", "credit"]);
const keyPattern = /^[A-Z][A-Z0-9_]*$/;
const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const currencyPattern = /^[A-Z]{3}$/;
const countryPattern = /^[A-Z]{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The six account slots a mapping may fill. */
const mappingAccountSlots = [
  "debitAccountKey",
  "creditAccountKey",
  "vatAccountKey",
  "feeAccountKey",
  "expenseAccountKey",
  "payableAccountKey",
] as const;

/**
 * Field names that would mean transactional history had leaked into the
 * template. Checked against every property name at any depth.
 */
const transactionalFieldNames = [
  "accountid",
  "accountingeventid",
  "batchid",
  "companyid",
  "customerid",
  "debitamount",
  "creditamount",
  "driverid",
  "employeeid",
  "journalid",
  "journalentryid",
  "openingbalancebatchid",
  "orderid",
  "parentaccountid",
  "payrollid",
  "settlementid",
  "traderid",
  "totaldebit",
  "totalcredit",
  "balance",
  "nextvalue",
];

export class TemplateValidationError extends Error {
  public constructor(public readonly problems: readonly string[]) {
    super(`The Accounting Template is not valid:\n  - ${problems.join("\n  - ")}`);
    this.name = "TemplateValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Visits every node in the document exactly once, with the property name it
 * was reached by.
 *
 * "Exactly once" is load-bearing: an earlier shape visited each property both
 * from its parent and again on recursion, which reported every finding twice
 * and would have made a count-based assertion quietly meaningless.
 */
function walk(
  value: unknown,
  path: string,
  key: string | undefined,
  visit: (path: string, key: string | undefined, value: unknown) => void,
): void {
  visit(path, key, value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`, undefined, visit));
    return;
  }
  if (isRecord(value)) {
    for (const [childKey, entry] of Object.entries(value)) {
      walk(entry, `${path}.${childKey}`, childKey, visit);
    }
  }
}

/**
 * Detects database identifiers anywhere in the document.
 *
 * Deliberately blunt: ANY UUID-shaped string fails, wherever it appears,
 * including inside provenance metadata. A template that needs a UUID to be
 * understood is a template that depends on one particular database.
 */
export function scanForDatabaseIdentifiers(template: unknown): string[] {
  const problems: string[] = [];
  walk(template, "$", undefined, (path, key, value) => {
    if (typeof value === "string" && uuidPattern.test(value)) {
      problems.push(`${path} contains a database identifier ("${value}")`);
    }
    // Named identifier fields are how a UUID would normally arrive. Flagging
    // the NAME as well as the value catches a field that happens to be null
    // today but is wired to carry an identifier tomorrow. Matched
    // case-sensitively so `accountId` and `account_id` are caught while
    // `isValid` and `overridePermission` are not.
    if (key !== undefined && (/[A-Za-z]Id$/.test(key) || /(^|_)id$/.test(key))) {
      problems.push(`${path} is an identifier field and must be a template key instead`);
    }
  });
  return problems;
}

/** Detects transactional or balance-bearing content anywhere in the document. */
export function scanForTransactionalContent(template: unknown): string[] {
  const problems: string[] = [];
  walk(template, "$", undefined, (path, key) => {
    if (key === undefined) return;
    if (transactionalFieldNames.includes(key.toLowerCase())) {
      problems.push(`${path} is transactional and must not appear in a template`);
    }
  });
  const openingBalances = isRecord(template) ? template.openingBalances : undefined;
  if (!Array.isArray(openingBalances)) {
    problems.push("$.openingBalances must be present and be an empty array");
  } else if (openingBalances.length > 0) {
    problems.push(
      `$.openingBalances must be empty but holds ${openingBalances.length} entr(y/ies)`,
    );
  }
  return problems;
}

function validateAccounts(accounts: readonly TemplateAccount[], problems: string[]): Set<string> {
  const keys = new Set<string>();
  const codes = new Set<string>();
  for (const [index, account] of accounts.entries()) {
    const at = `accounts[${index}] (${account.key ?? "?"})`;
    if (typeof account.key !== "string" || !keyPattern.test(account.key)) {
      problems.push(`${at}: key must be UPPER_SNAKE_CASE`);
    } else if (keys.has(account.key)) {
      problems.push(`${at}: duplicate account key`);
    } else {
      keys.add(account.key);
    }
    if (typeof account.code !== "string" || account.code.trim() === "") {
      problems.push(`${at}: code is required`);
    } else if (codes.has(account.code)) {
      problems.push(`${at}: duplicate account code "${account.code}"`);
    } else {
      codes.add(account.code);
    }
    if (!accountTypes.has(account.accountType)) {
      problems.push(`${at}: accountType "${account.accountType}" is not supported`);
    }
    if (!normalBalances.has(account.normalBalance)) {
      problems.push(`${at}: normalBalance must be debit or credit`);
    }
    if (typeof account.nameEn !== "string" || account.nameEn.trim() === "") {
      problems.push(`${at}: nameEn is required`);
    }
    if (typeof account.currency !== "string" || !currencyPattern.test(account.currency)) {
      problems.push(`${at}: currency must be a three-letter code`);
    }
    if (account.isControlAccount && account.controlAccountType === null) {
      problems.push(`${at}: a control account must declare controlAccountType`);
    }
  }
  return keys;
}

/**
 * Hierarchy checks.
 *
 * A missing parent would produce an account the importer cannot place; a cycle
 * would make it loop forever. Both are caught here rather than at import time,
 * because a template is written once and loaded many times.
 */
function validateHierarchy(
  accounts: readonly TemplateAccount[],
  keys: ReadonlySet<string>,
  problems: string[],
): void {
  const parents = new Map<string, string | null>();
  for (const account of accounts) {
    if (account.parentAccountKey !== null && !keys.has(account.parentAccountKey)) {
      problems.push(
        `accounts (${account.key}): parentAccountKey "${account.parentAccountKey}" does not exist`,
      );
      continue;
    }
    if (account.parentAccountKey === account.key) {
      problems.push(`accounts (${account.key}): an account cannot be its own parent`);
      continue;
    }
    parents.set(account.key, account.parentAccountKey);
  }

  for (const start of parents.keys()) {
    const seen = new Set<string>([start]);
    let current = parents.get(start) ?? null;
    while (current !== null) {
      if (seen.has(current)) {
        problems.push(`accounts (${start}): parent hierarchy contains a cycle`);
        break;
      }
      seen.add(current);
      current = parents.get(current) ?? null;
    }
  }
}

function validateMappings(
  mappings: readonly TemplateAccountMapping[],
  accountKeys: ReadonlySet<string>,
  problems: string[],
): void {
  const seen = new Set<string>();
  for (const [index, mapping] of mappings.entries()) {
    const at = `accountMappings[${index}] (${mapping.mappingKey ?? "?"})`;
    if (typeof mapping.mappingKey !== "string" || mapping.mappingKey.trim() === "") {
      problems.push(`${at}: mappingKey is required`);
    } else if (seen.has(mapping.mappingKey)) {
      problems.push(`${at}: duplicate mappingKey`);
    } else {
      seen.add(mapping.mappingKey);
    }

    let filled = 0;
    for (const slot of mappingAccountSlots) {
      const key = mapping[slot];
      if (key === null || key === undefined) continue;
      filled += 1;
      if (!accountKeys.has(key)) {
        problems.push(`${at}: ${slot} "${key}" does not match any exported account key`);
      }
    }
    // A mapping that names no account cannot post anything; it is a
    // configuration hole, not a valid rule.
    if (filled === 0) {
      problems.push(`${at}: references no account at all`);
    }
  }
}

export function validateAccountingTemplate(
  candidate: unknown,
): asserts candidate is AccountingTemplate {
  const problems: string[] = [];

  if (!isRecord(candidate)) {
    throw new TemplateValidationError(["the template must be a JSON object"]);
  }
  const template = candidate as unknown as AccountingTemplate;

  if (!supportedSchemaVersions.has(template.schemaVersion)) {
    problems.push(
      `schemaVersion ${String(template.schemaVersion)} is not supported (supported: ${[...supportedSchemaVersions].join(", ")})`,
    );
  }
  if (
    typeof template.templateCode !== "string" ||
    !/^[A-Z][A-Z0-9_]*$/.test(template.templateCode)
  ) {
    problems.push("templateCode must be UPPER_SNAKE_CASE");
  }
  if (!Number.isInteger(template.templateVersion) || template.templateVersion < 1) {
    problems.push("templateVersion must be a positive integer");
  }
  if (typeof template.name !== "string" || template.name.trim() === "") {
    problems.push("name is required");
  }
  if (typeof template.countryCode !== "string" || !countryPattern.test(template.countryCode)) {
    problems.push("countryCode must be a two-letter ISO code");
  }
  if (typeof template.currency !== "string" || !currencyPattern.test(template.currency)) {
    problems.push("currency must be a three-letter ISO code");
  }
  if (!isRecord(template.source) || template.source.type !== "company_export") {
    problems.push("source.type must be company_export");
  }

  if (!Array.isArray(template.accounts) || template.accounts.length === 0) {
    problems.push("accounts must be a non-empty array");
    throw new TemplateValidationError(problems);
  }
  if (!Array.isArray(template.accountMappings)) {
    problems.push("accountMappings must be an array");
    throw new TemplateValidationError(problems);
  }

  const accountKeys = validateAccounts(template.accounts, problems);
  validateHierarchy(template.accounts, accountKeys, problems);
  validateMappings(template.accountMappings, accountKeys, problems);

  // Named account slots in the configuration must resolve too.
  const defaults = template.accountingConfiguration?.defaultAccountKeys;
  if (!isRecord(defaults)) {
    problems.push("accountingConfiguration.defaultAccountKeys must be an object");
  } else {
    for (const [slot, key] of Object.entries(defaults)) {
      if (key === null) continue;
      if (typeof key !== "string" || !accountKeys.has(key)) {
        problems.push(
          `accountingConfiguration.defaultAccountKeys.${slot} does not match an account key`,
        );
      }
    }
  }

  for (const [index, cash] of (template.defaultCashAccounts ?? []).entries()) {
    if (!accountKeys.has(cash.glAccountKey)) {
      problems.push(
        `defaultCashAccounts[${index}]: glAccountKey "${cash.glAccountKey}" does not exist`,
      );
    }
  }
  for (const [index, bank] of (template.defaultBankAccounts ?? []).entries()) {
    if (!accountKeys.has(bank.glAccountKey)) {
      problems.push(
        `defaultBankAccounts[${index}]: glAccountKey "${bank.glAccountKey}" does not exist`,
      );
    }
  }

  const mappingKeys = new Set(template.accountMappings.map((mapping) => mapping.mappingKey));
  for (const [index, category] of (template.generalExpenseCategories ?? []).entries()) {
    if (!mappingKeys.has(category.defaultExpenseMappingKey)) {
      problems.push(
        `generalExpenseCategories[${index}]: defaultExpenseMappingKey "${category.defaultExpenseMappingKey}" does not match an exported mapping`,
      );
    }
  }

  const businessDay = template.businessDay;
  if (!isRecord(businessDay) || !timePattern.test(String(businessDay.startTime))) {
    problems.push("businessDay.startTime must be HH:MM");
  }
  if (isRecord(businessDay) && typeof businessDay.timezone !== "string") {
    problems.push("businessDay.timezone is required");
  }

  const fiscal = template.fiscalPolicy;
  if (
    !isRecord(fiscal) ||
    !Number.isInteger(fiscal.fiscalYearStartMonth) ||
    Number(fiscal.fiscalYearStartMonth) < 1 ||
    Number(fiscal.fiscalYearStartMonth) > 12
  ) {
    problems.push("fiscalPolicy.fiscalYearStartMonth must be between 1 and 12");
  }

  problems.push(...scanForDatabaseIdentifiers(template));
  problems.push(...scanForTransactionalContent(template));

  if (problems.length > 0) {
    throw new TemplateValidationError(problems);
  }
}
