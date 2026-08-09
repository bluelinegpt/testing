import { buildTemplate } from "./accounting-template.exporter.js";
import { companySetupFixture, testTemplateIdentity } from "./accounting-template.fixture.js";
import type { AccountingTemplate } from "./accounting-template.types.js";
import {
  TemplateValidationError,
  scanForDatabaseIdentifiers,
  scanForTransactionalContent,
  validateAccountingTemplate,
} from "./accounting-template.validator.js";

/** A valid template, as a mutable plain object the tests can damage. */
function valid(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(buildTemplate(companySetupFixture(), testTemplateIdentity)),
  ) as Record<string, unknown>;
}

function expectRejected(mutate: (template: Record<string, unknown>) => void, match: RegExp): void {
  const template = valid();
  mutate(template);
  try {
    validateAccountingTemplate(template);
    expect.unreachable("the validator accepted an invalid template");
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateValidationError);
    expect((error as TemplateValidationError).problems.join("\n")).toMatch(match);
  }
}

describe("template validator", () => {
  it("accepts a well-formed template", () => {
    expect(() => validateAccountingTemplate(valid())).not.toThrow();
  });

  it("rejects a non-object", () => {
    expect(() => validateAccountingTemplate("nope")).toThrow(TemplateValidationError);
  });

  describe("metadata", () => {
    it("rejects an unsupported schema version", () => {
      expectRejected((t) => (t.schemaVersion = 2), /schemaVersion 2 is not supported/);
    });
    it("rejects a malformed template code", () => {
      expectRejected(
        (t) => (t.templateCode = "lower case"),
        /templateCode must be UPPER_SNAKE_CASE/,
      );
    });
    it("rejects a non-positive template version", () => {
      expectRejected((t) => (t.templateVersion = 0), /templateVersion must be a positive integer/);
    });
    it("rejects a malformed currency", () => {
      expectRejected((t) => (t.currency = "AEDD"), /currency must be a three-letter ISO code/);
    });
    it("rejects a malformed country", () => {
      expectRejected((t) => (t.countryCode = "UAE"), /countryCode must be a two-letter ISO code/);
    });
  });

  describe("accounts", () => {
    it("rejects a duplicate account key", () => {
      expectRejected((t) => {
        const accounts = t.accounts as AccountingTemplate["accounts"];
        (t.accounts as unknown[]) = [...accounts, { ...accounts[0]!, code: "9999" }];
      }, /duplicate account key/);
    });

    it("rejects a duplicate account code", () => {
      expectRejected((t) => {
        const accounts = t.accounts as AccountingTemplate["accounts"];
        (t.accounts as unknown[]) = [...accounts, { ...accounts[0]!, key: "ASSET_DUPLICATE" }];
      }, /duplicate account code/);
    });

    it("rejects a malformed key", () => {
      expectRejected((t) => {
        (t.accounts as { key: string }[])[0]!.key = "lower_case";
      }, /key must be UPPER_SNAKE_CASE/);
    });

    it("rejects an unsupported account type", () => {
      expectRejected((t) => {
        (t.accounts as { accountType: string }[])[0]!.accountType = "wealth";
      }, /accountType "wealth" is not supported/);
    });

    it("rejects a control account with no control type", () => {
      expectRejected((t) => {
        const account = (t.accounts as Record<string, unknown>[]).find(
          (a) => a.isControlAccount === true,
        )!;
        account.controlAccountType = null;
      }, /control account must declare controlAccountType/);
    });
  });

  describe("hierarchy", () => {
    it("rejects a parent key that does not exist", () => {
      expectRejected((t) => {
        (t.accounts as { parentAccountKey: string | null }[])[0]!.parentAccountKey = "ASSET_GHOST";
      }, /parentAccountKey "ASSET_GHOST" does not exist/);
    });

    it("rejects an account that is its own parent", () => {
      expectRejected((t) => {
        const accounts = t.accounts as { key: string; parentAccountKey: string | null }[];
        accounts[0]!.parentAccountKey = accounts[0]!.key;
      }, /cannot be its own parent/);
    });

    it("rejects a hierarchy cycle", () => {
      expectRejected((t) => {
        const accounts = t.accounts as { key: string; parentAccountKey: string | null }[];
        accounts[0]!.parentAccountKey = accounts[1]!.key;
        accounts[1]!.parentAccountKey = accounts[0]!.key;
      }, /contains a cycle/);
    });
  });

  describe("mappings", () => {
    it("rejects a mapping account key that does not exist", () => {
      expectRejected((t) => {
        (t.accountMappings as { creditAccountKey: string | null }[])[0]!.creditAccountKey =
          "REVENUE_GHOST";
      }, /does not match any exported account key/);
    });

    it("rejects a duplicate mapping key", () => {
      expectRejected((t) => {
        const mappings = t.accountMappings as unknown[];
        (t.accountMappings as unknown[]) = [...mappings, mappings[0]];
      }, /duplicate mappingKey/);
    });

    it("rejects a mapping that references no account at all", () => {
      expectRejected((t) => {
        const mapping = (t.accountMappings as Record<string, unknown>[])[0]!;
        for (const slot of [
          "debitAccountKey",
          "creditAccountKey",
          "vatAccountKey",
          "feeAccountKey",
          "expenseAccountKey",
          "payableAccountKey",
        ]) {
          mapping[slot] = null;
        }
      }, /references no account at all/);
    });

    it("rejects an expense category pointing at a mapping that does not exist", () => {
      expectRejected((t) => {
        (
          t.generalExpenseCategories as { defaultExpenseMappingKey: string }[]
        )[0]!.defaultExpenseMappingKey = "no_such_mapping";
      }, /does not match an exported mapping/);
    });

    it("rejects a named account slot that does not resolve", () => {
      expectRejected((t) => {
        const configuration = t.accountingConfiguration as Record<string, unknown>;
        (configuration.defaultAccountKeys as Record<string, unknown>).cash = "ASSET_GHOST";
      }, /defaultAccountKeys\.cash does not match an account key/);
    });
  });

  describe("cash and bank", () => {
    it("rejects a cash account whose GL account does not exist", () => {
      expectRejected((t) => {
        (t.defaultCashAccounts as { glAccountKey: string }[])[0]!.glAccountKey = "ASSET_GHOST";
      }, /defaultCashAccounts\[0\].*does not exist/);
    });
    it("rejects a bank account whose GL account does not exist", () => {
      expectRejected((t) => {
        (t.defaultBankAccounts as { glAccountKey: string }[])[0]!.glAccountKey = "ASSET_GHOST";
      }, /defaultBankAccounts\[0\].*does not exist/);
    });
  });

  describe("safety scans", () => {
    it("rejects a database identifier anywhere in the document", () => {
      expectRejected((t) => {
        (t.accounts as Record<string, unknown>[])[0]!.description =
          "dd28829b-2b7c-4851-a0be-181b92673e84";
      }, /contains a database identifier/);
    });

    it("rejects a source Company identifier hidden in provenance", () => {
      expectRejected((t) => {
        (t.source as Record<string, unknown>).companyId = "dd28829b-2b7c-4851-a0be-181b92673e84";
      }, /identifier field|contains a database identifier/);
    });

    it("rejects an identifier-shaped field even when it is empty", () => {
      expectRejected((t) => {
        (t.accounts as Record<string, unknown>[])[0]!.parentAccountId = null;
      }, /identifier field and must be a template key/);
    });

    it("rejects opening balances", () => {
      expectRejected((t) => {
        (t.openingBalances as unknown[]) = [{ accountKey: "ASSET_CASH", amount: "1.00" }];
      }, /openingBalances must be empty/);
    });

    it("rejects a missing openingBalances declaration", () => {
      expectRejected((t) => {
        delete t.openingBalances;
      }, /openingBalances must be present/);
    });

    it("rejects balance-bearing fields", () => {
      expectRejected((t) => {
        (t.accounts as Record<string, unknown>[])[0]!.balance = "1000.00";
      }, /transactional and must not appear/);
    });

    it("rejects a reference counter watermark", () => {
      expectRejected((t) => {
        (t.referenceNumberPrefixes as Record<string, unknown>[])[0]!.nextValue = 57;
      }, /transactional and must not appear/);
    });
  });

  describe("scan helpers in isolation", () => {
    it("finds a UUID at any depth", () => {
      expect(
        scanForDatabaseIdentifiers({ a: { b: [{ c: "dd28829b-2b7c-4851-a0be-181b92673e84" }] } }),
      ).toHaveLength(1);
    });
    it("does not flag ordinary text", () => {
      expect(scanForDatabaseIdentifiers({ name: "Main Cash", key: "ASSET_CASH" })).toEqual([]);
    });
    it("does not flag legitimate template fields", () => {
      expect(
        scanForTransactionalContent({
          openingBalances: [],
          normalBalance: "debit",
          isValid: true,
          overridePermission: "accounting.manage",
        }),
      ).toEqual([]);
    });
  });
});
