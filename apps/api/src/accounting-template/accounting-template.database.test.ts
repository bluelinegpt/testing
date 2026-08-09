import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import pg from "pg";

import { configuration } from "../configuration/environment.js";
import { canonicalise, templateSha256 } from "./accounting-template.canonical.js";
import { buildTemplate, readSetup } from "./accounting-template.exporter.js";
import {
  scanForDatabaseIdentifiers,
  scanForTransactionalContent,
  validateAccountingTemplate,
} from "./accounting-template.validator.js";

const runDatabaseTests = process.env.RUN_ACCOUNTING_TEMPLATE_DATABASE === "true";

/** The source Company is named explicitly and never inferred. */
const SOURCE_COMPANY_ID = "dd28829b-2b7c-4851-a0be-181b92673e84";
const templatePath = resolve(
  process.cwd(),
  "resources/accounting-templates/uae-delivery-standard-v1.json",
);

/**
 * The exporter against the real source Company.
 *
 * Gated behind `RUN_ACCOUNTING_TEMPLATE_DATABASE=true`, matching every other
 * database-backed suite here. Every statement it issues is a read; the only
 * thing it proves that a fixture cannot is that the committed template still
 * describes the Company it was exported from, and that the Company is left
 * exactly as it was found.
 */
describe.skipIf(!runDatabaseTests)("Accounting template export against the source Company", () => {
  const identity = {
    templateCode: "UAE_DELIVERY_STANDARD",
    templateVersion: 1,
    name: "BluelineGPT Standard Delivery Accounting",
    countryCode: "AE",
  };

  /** A checksum over every setup and transactional table the exporter reads. */
  async function fingerprint(client: pg.PoolClient): Promise<string> {
    const rows = await client.query<{ payload: string }>(
      `select coalesce(string_agg(payload, '|' order by payload), '') as payload from (
         select 'coa:' || code || ':' || name_en || ':' || account_class || ':' || is_active::text ||
                ':' || coalesce(description, '') as payload
           from chart_of_accounts where company_id = $1
         union all
         select 'map:' || mapping_key || ':' || is_active::text ||
                ':' || coalesce(debit_account_id::text, '') || coalesce(credit_account_id::text, '')
           from account_mappings where company_id = $1
         union all
         select 'cfg:' || accounting_enabled::text || automatic_posting_enabled::text ||
                base_currency || fiscal_year_start_month::text || segregation_policy
           from accounting_configurations where company_id = $1
         union all
         select 'cash:' || cash_account_code || coalesce(location_or_custodian, '')
           from company_cash_accounts where company_id = $1
         union all
         select 'bank:' || bank_account_code || bank_name || coalesce(account_number_masked, '')
           from company_bank_accounts where company_id = $1
         union all
         select 'bd:' || timezone || business_day_start::text || coalesce(effective_to::text, '')
           from company_business_day_configurations where company_id = $1
         union all
         select 'fy:' || fiscal_year_code || start_date::text || status
           from fiscal_years where company_id = $1
         union all
         select 'ob:' || batch_number || total_debit::text || total_credit::text || status
           from opening_balance_batches where company_id = $1
         union all
         select 'obl:' || id::text || debit::text || credit::text
           from opening_balance_lines where company_id = $1
         union all
         select 'ctr:' || reference_type || prefix || next_value::text
           from company_reference_counters where company_id = $1
       ) as snapshot`,
      [SOURCE_COMPANY_ID],
    );
    return createHash("sha256")
      .update(rows.rows[0]?.payload ?? "")
      .digest("hex");
  }

  it("exports the source Company's setup without changing it", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env"), quiet: true });
    const settings = configuration();
    const pool = new pg.Pool({ connectionString: settings.database.url, max: 1 });
    const client = await pool.connect();

    try {
      // -----------------------------------------------------------------
      // The source Company is the one that was asked for
      // -----------------------------------------------------------------
      const company = (
        await client.query<{ name_en: string }>("select name_en from companies where id = $1", [
          SOURCE_COMPANY_ID,
        ])
      ).rows[0];
      expect(company?.name_en).toBe("Dana Delivery Services");

      const before = await fingerprint(client);

      // -----------------------------------------------------------------
      // Unknown Company is refused
      // -----------------------------------------------------------------
      await expect(readSetup(client, "00000000-0000-4000-8000-000000000000")).rejects.toThrow(
        /No Company found/,
      );

      // -----------------------------------------------------------------
      // The read is genuinely read-only, enforced by PostgreSQL
      // -----------------------------------------------------------------
      await client.query("begin transaction read only");
      await expect(
        client.query("update chart_of_accounts set name_en = name_en where company_id = $1", [
          SOURCE_COMPANY_ID,
        ]),
      ).rejects.toMatchObject({ code: "25006" });
      await client.query("rollback");

      // -----------------------------------------------------------------
      // Export
      // -----------------------------------------------------------------
      const setup = await readSetup(client, SOURCE_COMPANY_ID);
      expect(setup.companyName).toBe("Dana Delivery Services");
      expect(setup.accounts.length).toBeGreaterThan(0);
      expect(setup.mappings.length).toBeGreaterThan(0);
      expect(setup.configuration).toBeDefined();

      const template = buildTemplate(setup, identity);
      expect(() => validateAccountingTemplate(template)).not.toThrow();

      // The Company's real configuration is represented.
      expect(template.accounts).toHaveLength(setup.accounts.length);
      expect(template.accountMappings).toHaveLength(setup.mappings.length);
      expect(template.currency).toBe("AED");
      expect(template.businessDay.timezone).toBe("Asia/Dubai");

      // -----------------------------------------------------------------
      // Nothing transactional survives
      //
      // The source Company currently holds opening balance batches and lines.
      // That makes this the sharpest available check: real financial history
      // exists a few tables away, and none of it reaches the template.
      // -----------------------------------------------------------------
      const openingBalances = (
        await client.query<{ n: string }>(
          `select (select count(*) from opening_balance_batches where company_id = $1)
                + (select count(*) from opening_balance_lines where company_id = $1) as n`,
          [SOURCE_COMPANY_ID],
        )
      ).rows[0];
      expect(Number(openingBalances?.n)).toBeGreaterThan(0);
      expect(template.openingBalances).toEqual([]);
      expect(scanForTransactionalContent(template)).toEqual([]);

      const serialised = canonicalise(template);
      expect(serialised).not.toContain(SOURCE_COMPANY_ID);
      expect(serialised).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
      expect(scanForDatabaseIdentifiers(template)).toEqual([]);
      // The source Company's real bank identity must not travel.
      const bankIdentity = (
        await client.query<{ bank_name: string; masked: string | null }>(
          "select bank_name, account_number_masked as masked from company_bank_accounts where company_id = $1",
          [SOURCE_COMPANY_ID],
        )
      ).rows;
      for (const bank of bankIdentity) {
        expect(serialised).not.toContain(bank.bank_name);
        if (bank.masked !== null) expect(serialised).not.toContain(bank.masked);
      }

      // -----------------------------------------------------------------
      // Deterministic, and the committed file is current
      // -----------------------------------------------------------------
      const second = buildTemplate(await readSetup(client, SOURCE_COMPANY_ID), identity);
      expect(canonicalise(second)).toBe(serialised);
      expect(templateSha256(second)).toBe(templateSha256(template));

      expect(readFileSync(templatePath, "utf8")).toBe(serialised);

      // -----------------------------------------------------------------
      // The Company is exactly as it was found
      // -----------------------------------------------------------------
      expect(await fingerprint(client)).toBe(before);
    } finally {
      client.release();
      await pool.end();
    }
  }, 120_000);
});
