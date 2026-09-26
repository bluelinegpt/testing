import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalise, templateSha256 } from "./accounting-template.canonical.js";
import { buildTemplate, type CompanySetup } from "./accounting-template.exporter.js";
import { companySetupFixture, testTemplateIdentity } from "./accounting-template.fixture.js";
import { deriveAccountKeys } from "./accounting-template.keys.js";
import {
  scanForDatabaseIdentifiers,
  scanForTransactionalContent,
  validateAccountingTemplate,
} from "./accounting-template.validator.js";
import { parseArguments, rejectionReason } from "./export-accounting-template.cli.js";

const templatePath = resolve(
  process.cwd(),
  "resources/accounting-templates/uae-delivery-standard-v1.json",
);
const build = (setup: CompanySetup = companySetupFixture()) =>
  buildTemplate(setup, testTemplateIdentity);

describe("template key derivation", () => {
  it("derives readable semantic keys", () => {
    const keys = deriveAccountKeys([
      { code: "1000", accountType: "asset", accountClass: "cash" },
      { code: "4000", accountType: "revenue", accountClass: "delivery_revenue" },
      { code: "5000", accountType: "expense", accountClass: "driver_expense" },
      { code: "2040", accountType: "liability", accountClass: "vat_payable" },
    ]);
    expect(keys.get("1000")).toBe("ASSET_CASH");
    // The redundant type word is dropped...
    expect(keys.get("4000")).toBe("REVENUE_DELIVERY");
    expect(keys.get("5000")).toBe("EXPENSE_DRIVER");
    // ...but only the type word: `payable` is not `liability`.
    expect(keys.get("2040")).toBe("LIABILITY_VAT_PAYABLE");
  });

  /**
   * Suffixing only the later duplicate would mean an account's key changed the
   * day a sibling was added. A key that moves is not a stable key.
   */
  it("suffixes every member of a shared class, not just the later ones", () => {
    const keys = deriveAccountKeys([
      { code: "1110", accountType: "asset", accountClass: "other_receivable" },
      { code: "1120", accountType: "asset", accountClass: "other_receivable" },
    ]);
    expect(keys.get("1110")).toBe("ASSET_OTHER_RECEIVABLE_1110");
    expect(keys.get("1120")).toBe("ASSET_OTHER_RECEIVABLE_1120");
  });

  it("is order-independent and repeatable", () => {
    const input = [
      { code: "1000", accountType: "asset", accountClass: "cash" },
      { code: "1010", accountType: "asset", accountClass: "bank" },
    ];
    const forward = deriveAccountKeys(input);
    const reversed = deriveAccountKeys([...input].reverse());
    expect(forward.get("1000")).toBe(reversed.get("1000"));
    expect(forward.get("1010")).toBe(reversed.get("1010"));
  });
});

describe("buildTemplate", () => {
  it("replaces every account identifier with a template key", () => {
    const template = build();
    const serialised = JSON.stringify(template);
    expect(serialised).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(scanForDatabaseIdentifiers(template)).toEqual([]);
    for (const account of template.accounts) {
      expect(account.key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it("expresses parent relationships as keys", () => {
    const template = build();
    const child = template.accounts.find((account) => account.code === "1120");
    expect(child?.parentAccountKey).toBe("ASSET_ACCOUNTS_RECEIVABLE");
    const root = template.accounts.find((account) => account.code === "1000");
    expect(root?.parentAccountKey).toBeNull();
  });

  it("expresses every mapping slot as an account key", () => {
    const template = build();
    const keys = new Set(template.accounts.map((account) => account.key));
    for (const mapping of template.accountMappings) {
      for (const slot of [
        mapping.debitAccountKey,
        mapping.creditAccountKey,
        mapping.vatAccountKey,
        mapping.feeAccountKey,
        mapping.expenseAccountKey,
        mapping.payableAccountKey,
      ]) {
        if (slot !== null) expect(keys.has(slot)).toBe(true);
      }
    }
    const payable = template.accountMappings.find((m) => m.mappingKey === "trader_payable");
    expect(payable?.payableAccountKey).toBe("LIABILITY_TRADER_PAYABLE");
  });

  it("keeps the engine's mapping keys verbatim", () => {
    // The posting engine looks these up by name; renaming them into a prettier
    // convention would silently break every posting rule on import.
    const template = build();
    expect(template.accountMappings.map((m) => m.mappingKey)).toContain("delivery_revenue");
  });

  it("refuses a mapping that points at an account outside the export", () => {
    const setup = companySetupFixture();
    setup.mappings.push({
      mapping_key: "orphan",
      is_active: true,
      debit_code: "9999",
      credit_code: null,
      vat_code: null,
      fee_code: null,
      expense_code: null,
      payable_code: null,
    });
    expect(() => build(setup)).toThrow(/"9999" is referenced but not exported/);
  });

  it("refuses a Company with no Chart of Accounts", () => {
    const setup = companySetupFixture();
    setup.accounts = [];
    expect(() => build(setup)).toThrow(/no Chart of Accounts/);
  });

  it("refuses a Company with no Accounting configuration", () => {
    const setup = companySetupFixture();
    setup.configuration = undefined;
    expect(() => build(setup)).toThrow(/no Accounting configuration/);
  });

  it("refuses a Company with no active Business Day configuration", () => {
    const setup = companySetupFixture();
    setup.businessDay = undefined;
    expect(() => build(setup)).toThrow(/no active Business Day/);
  });

  it("exports no opening balances", () => {
    expect(build().openingBalances).toEqual([]);
    expect(scanForTransactionalContent(build())).toEqual([]);
  });

  /**
   * The bank definition is a SHAPE. Omitting the identity fields entirely,
   * rather than blanking them, leaves no field for one Company's banking
   * details to hide in.
   */
  it("carries no bank identity, only the fields a Company must supply", () => {
    const template = build();
    const bank = template.defaultBankAccounts[0];
    expect(bank).toBeDefined();
    expect(bank).not.toHaveProperty("bankName");
    expect(bank).not.toHaveProperty("iban");
    expect(bank).not.toHaveProperty("accountNumber");
    expect(bank?.requiresCompanyInput).toContain("iban");
    expect(bank?.glAccountKey).toBe("ASSET_BANK");
  });

  it("carries no cash custodian or location", () => {
    const cash = build().defaultCashAccounts[0];
    expect(cash).not.toHaveProperty("locationOrCustodian");
    expect(cash?.requiresCompanyInput).toContain("locationOrCustodian");
  });

  it("exports fiscal policy rather than dated fiscal periods", () => {
    const template = build();
    expect(template.fiscalPolicy.fiscalYearStartMonth).toBe(1);
    expect(template.fiscalPolicy.generatedOnCompanyCreation).toBe(true);
    expect(template).not.toHaveProperty("fiscalYears");
    expect(template).not.toHaveProperty("accountingPeriods");
    expect(JSON.stringify(template)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("exports reference prefixes without their counters", () => {
    const template = build();
    expect(template.referenceNumberPrefixes).toEqual([{ referenceType: "journal", prefix: "JRN" }]);
    expect(JSON.stringify(template)).not.toContain("nextValue");
  });

  it("orders every collection deterministically", () => {
    const shuffled = companySetupFixture();
    shuffled.accounts.reverse();
    shuffled.mappings.reverse();
    expect(canonicalise(build(shuffled))).toBe(canonicalise(build()));
  });

  it("produces a stable hash for unchanged configuration", () => {
    expect(templateSha256(build())).toBe(templateSha256(build()));
    expect(templateSha256(build())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the hash when configuration changes", () => {
    const changed = companySetupFixture();
    changed.accounts[0] = { ...changed.accounts[0]!, name_en: "Renamed Cash" };
    expect(templateSha256(build(changed))).not.toBe(templateSha256(build()));
  });

  it("validates its own output before returning it", () => {
    expect(() => validateAccountingTemplate(build())).not.toThrow();
  });
});

describe("export command guards", () => {
  it("requires an explicit source Company", () => {
    const options = parseArguments(["--output", "x.json"]);
    expect(rejectionReason(options)).toMatch(/--company-id .* is required/);
  });

  it("refuses a source Company that is not a UUID", () => {
    const options = parseArguments(["--company-id", "dana"]);
    expect(rejectionReason(options)).toMatch(/is not a UUID/);
  });

  it("accepts an explicit Company", () => {
    const options = parseArguments([
      "--company-id",
      "dd28829b-2b7c-4851-a0be-181b92673e84",
      "--output",
      "out.json",
    ]);
    expect(rejectionReason(options)).toBeNull();
    expect(options.output).toBe("out.json");
    expect(options.templateCode).toBe("UAE_DELIVERY_STANDARD");
    expect(options.templateVersion).toBe(1);
  });

  it("refuses a non-positive template version", () => {
    expect(
      rejectionReason(
        parseArguments([
          "--company-id",
          "dd28829b-2b7c-4851-a0be-181b92673e84",
          "--template-version",
          "0",
        ]),
      ),
    ).toMatch(/positive integer/);
  });
});

/**
 * The committed artefact itself. These assertions are what stop a future edit
 * from checking in a template that no longer satisfies the format's guarantees.
 */
describe("the committed uae-delivery-standard-v1 template", () => {
  const raw = readFileSync(templatePath, "utf8");
  const template = JSON.parse(raw) as Record<string, unknown>;

  it("validates", () => {
    expect(() => validateAccountingTemplate(template)).not.toThrow();
  });

  it("is stored in canonical form, so its file hash is the template hash", () => {
    expect(raw).toBe(canonicalise(template));
  });

  it("carries no database identifier of any kind", () => {
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(raw).not.toContain("dd28829b-2b7c-4851-a0be-181b92673e84");
    expect(scanForDatabaseIdentifiers(template)).toEqual([]);
  });

  it("carries no transactional content and no opening balance", () => {
    expect(scanForTransactionalContent(template)).toEqual([]);
    expect(template.openingBalances).toEqual([]);
  });

  it("does not depend on the source Company existing", () => {
    const source = template.source as Record<string, unknown>;
    expect(Object.keys(source).sort()).toEqual(["companyName", "type"]);
  });

  it("has the expected identity and hash", () => {
    expect(template.templateCode).toBe("UAE_DELIVERY_STANDARD");
    expect(template.templateVersion).toBe(1);
    expect(template.schemaVersion).toBe(1);
    expect(template.currency).toBe("AED");
    expect(template.countryCode).toBe("AE");
    expect(templateSha256(template)).toBe(
      "2d66f8ee57cc17ce732a2ee3158f8e40131b8e815dfa9355ff13551070e06581",
    );
  });
});
