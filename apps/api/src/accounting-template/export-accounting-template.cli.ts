import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnvironment } from "dotenv";
import pg from "pg";

import { configuration } from "../configuration/environment.js";
import { canonicalise, templateSha256 } from "./accounting-template.canonical.js";
import { buildTemplate, readCanonicalAreas, readSetup } from "./accounting-template.exporter.js";
import { validateAccountingTemplate } from "./accounting-template.validator.js";

/**
 * Exports a Company's Accounting setup to a reusable template file.
 *
 *   pnpm --filter @blueline/api accounting:template:export -- \
 *     --company-id <uuid> \
 *     --output resources/accounting-templates/uae-delivery-standard-v1.json
 *
 * READ-ONLY. Every database statement runs inside `begin transaction read only`,
 * so the source Company cannot be modified. The only thing this command writes
 * is the JSON file.
 *
 * The template is validated BEFORE the file is written, so a template that
 * would be rejected on import never reaches disk.
 */

loadEnvironment({ path: resolve(process.cwd(), "../../.env"), quiet: true });

export interface ExportOptions {
  companyId: string;
  output: string;
  templateCode: string;
  templateVersion: number;
  templateName: string;
  countryCode: string;
  check: boolean;
  help: boolean;
}

export function parseArguments(argv: string[]): ExportOptions {
  const args = argv.filter((value) => value.trim() !== "");
  const valueOf = (name: string, fallback: string): string => {
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index] ?? "";
      if (value === name) return (args[index + 1] ?? "").trim();
      if (value.startsWith(`${name}=`)) return value.slice(name.length + 1).trim();
    }
    return fallback;
  };
  const version = Number.parseInt(valueOf("--template-version", "1"), 10);
  return {
    companyId: valueOf("--company-id", ""),
    output: valueOf("--output", "resources/accounting-templates/uae-delivery-standard-v1.json"),
    templateCode: valueOf("--template-code", "UAE_DELIVERY_STANDARD"),
    templateVersion: Number.isInteger(version) && version > 0 ? version : 0,
    templateName: valueOf("--template-name", "BluelineGPT Standard Delivery Accounting"),
    countryCode: valueOf("--country-code", "AE"),
    // `--check` verifies the file on disk still matches the Company without
    // rewriting it. That is what makes "is this template still current?" a
    // question the build can answer.
    check: args.includes("--check"),
    help: args.includes("--help") || args.length === 0,
  };
}

export function rejectionReason(options: ExportOptions): string | null {
  if (options.companyId === "") {
    return "Refusing to export: --company-id <uuid> is required. The source Company is never inferred.";
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.companyId)) {
    return `Refusing to export: --company-id '${options.companyId}' is not a UUID.`;
  }
  if (options.templateVersion < 1) {
    return "Refusing to export: --template-version must be a positive integer.";
  }
  if (options.output === "") {
    return "Refusing to export: --output <path> is required.";
  }
  return null;
}

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function report(template: ReturnType<typeof buildTemplate>, sha256: string): void {
  write("");
  write("Template content");
  write("-".repeat(78));
  write(`  chart of accounts            ${template.accounts.length}`);
  write(`  account mappings             ${template.accountMappings.length}`);
  write(
    `  named account slots          ${Object.values(template.accountingConfiguration.defaultAccountKeys).filter((key) => key !== null).length} of ${Object.keys(template.accountingConfiguration.defaultAccountKeys).length}`,
  );
  write(
    `  control accounts             ${template.accounts.filter((a) => a.isControlAccount).length}`,
  );
  write(`  default cash accounts        ${template.defaultCashAccounts.length}`);
  write(`  default bank accounts        ${template.defaultBankAccounts.length}`);
  write(`  expense types                ${template.expenseTypes.length}`);
  write(`  general expense categories   ${template.generalExpenseCategories.length}`);
  write(`  allowance types              ${template.allowanceTypes.length}`);
  write(`  reference number prefixes    ${template.referenceNumberPrefixes.length}`);
  write(
    `  business day                 ${template.businessDay.startTime} ${template.businessDay.timezone}`,
  );
  write(
    `  fiscal policy                start month ${template.fiscalPolicy.fiscalYearStartMonth}, ${template.fiscalPolicy.periodsPerYear} ${template.fiscalPolicy.periodModel} periods`,
  );
  write(`  opening balances             ${template.openingBalances.length} (must be 0)`);
  write(`  required company inputs      ${template.requiredCompanyInputs.length}`);
  write(`  documented exclusions        ${template.excludedFromTemplate.length}`);
  write("");
  write(`  templateCode     ${template.templateCode}`);
  write(`  templateVersion  ${template.templateVersion}`);
  write(`  sha256           ${sha256}`);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help && options.companyId === "") {
    write("Usage:");
    write("  accounting:template:export -- --company-id <uuid> [--output <path>]");
    write("      [--template-code CODE] [--template-version N] [--country-code AE] [--check]");
    write("");
    write("Read-only. Exports Accounting SETUP only — never transactions or balances.");
    return;
  }

  const refusal = rejectionReason(options);
  if (refusal !== null) {
    process.stderr.write(`${refusal}\n`);
    process.exit(2);
  }

  const settings = configuration();
  const pool = new pg.Pool({ connectionString: settings.database.url, max: 1 });
  const client = await pool.connect();
  try {
    const setup = await readSetup(client, options.companyId);
    write(`Source Company: ${setup.companyName}`);
    const areas = await readCanonicalAreas();
    write(`Delivery Areas (from the canonical UAE reference list): ${areas.length}`);
    const template = buildTemplate(
      setup,
      {
        templateCode: options.templateCode,
        templateVersion: options.templateVersion,
        name: options.templateName,
        countryCode: options.countryCode,
      },
      areas,
    );
    validateAccountingTemplate(template);
    const contents = canonicalise(template);
    const sha256 = templateSha256(template);

    const target = resolve(process.cwd(), options.output);
    if (options.check) {
      const { readFileSync, existsSync } = await import("node:fs");
      if (!existsSync(target)) {
        process.stderr.write(`Template file is missing: ${target}\n`);
        process.exit(4);
      }
      if (readFileSync(target, "utf8") !== contents) {
        process.stderr.write(
          `Template file is out of date with the Company: ${target}\nRe-run without --check to regenerate.\n`,
        );
        process.exit(5);
      }
      report(template, sha256);
      write("");
      write("TEMPLATE_UP_TO_DATE");
      return;
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
    write(`Template written to ${target}`);
    report(template, sha256);
    write("");
    write("TEMPLATE_EXPORTED");
  } finally {
    client.release();
    await pool.end();
  }
}

// Only run when invoked directly, so the exported guards stay unit-testable.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
