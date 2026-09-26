import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalise, templateSha256 } from "./accounting-template.canonical.js";
import type { AccountingTemplate } from "./accounting-template.types.js";
import { validateAccountingTemplate } from "./accounting-template.validator.js";

/**
 * The approved Accounting Template catalogue.
 *
 * ---------------------------------------------------------------------------
 * THE SERVER DECIDES WHICH TEMPLATES EXIST
 * ---------------------------------------------------------------------------
 *
 * A browser asks for a template by CODE and VERSION. It never sends a file
 * path, a URL, or template content. If it could, "create a Company" would
 * become "run arbitrary Chart-of-Accounts definitions of my choosing against
 * the database", which is a materially different and much larger capability
 * than the one being built.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HASH IS PINNED HERE
 * ---------------------------------------------------------------------------
 *
 * Version alone is not enough. A template file can be regenerated — the
 * exporter is a command anyone can run — and a regenerated v1 with a different
 * Chart of Accounts would silently initialise Companies differently while every
 * record still said "UAE_DELIVERY_STANDARD v1".
 *
 * So the expected canonical hash is pinned in code. If the file on disk no
 * longer matches, the registry refuses to serve it rather than applying
 * something unrecognised. Changing the template legitimately therefore means
 * changing this constant in the same commit — which is exactly the review step
 * that ought to exist.
 *
 * ---------------------------------------------------------------------------
 * PATH RESOLUTION
 * ---------------------------------------------------------------------------
 *
 * Resolved from `import.meta.url`, not `process.cwd()`. The API is started from
 * different working directories in development (`apps/api` via tsx) and in the
 * container (`/opt/app/apps/api` running `dist/main.js`), and in both the
 * module sits two levels below the package root. `package.json` ships
 * `resources` alongside `dist` so the file exists in the deployed image.
 */
export interface ApprovedTemplate {
  readonly templateCode: string;
  readonly templateVersion: number;
  readonly displayName: string;
  readonly fileName: string;
  /** SHA-256 of the canonical file. Pinned so the bytes cannot drift silently. */
  readonly sha256: string;
}

export const approvedTemplates: readonly ApprovedTemplate[] = [
  {
    templateCode: "UAE_DELIVERY_STANDARD",
    templateVersion: 1,
    displayName: "UAE Delivery Standard",
    fileName: "uae-delivery-standard-v1.json",
    sha256: "2d66f8ee57cc17ce732a2ee3158f8e40131b8e815dfa9355ff13551070e06581",
  },
  {
    templateCode: "UAE_DELIVERY_STANDARD",
    templateVersion: 2,
    displayName: "UAE Delivery Standard",
    fileName: "uae-delivery-standard-v2.json",
    sha256: "21f5b63bdd906bbbede52da55d563533025aef2876058b24ee8ee6197cc7a698",
  },
  {
    templateCode: "UAE_DELIVERY_STANDARD",
    templateVersion: 3,
    displayName: "UAE Delivery Standard",
    fileName: "uae-delivery-standard-v3.json",
    sha256: "1b322710a3e7ce41afaefa99a5faf33742100535ada1e66aef450ba0f8d1de7c",
  },
];

/**
 * The version a new Company gets when the Platform Portal does not name one
 * explicitly, and the default `--template-version` for the export CLI.
 *
 * v1 is kept in the catalogue and stays fully importable -- Companies already
 * initialised from it must not have their provenance record start pointing at
 * a template they were never actually given. It is simply no longer the
 * default a NEW Company receives. v2 added the complete delivery Areas; v3
 * additionally supplies the two dedicated Employee Payroll asset/control
 * accounts and mappings required by payroll readiness.
 */
export const latestTemplateVersion: Readonly<Record<string, number>> = {
  UAE_DELIVERY_STANDARD: 3,
};

export class TemplateNotApprovedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TemplateNotApprovedError";
  }
}

const templateDirectory = fileURLToPath(
  new URL("../../resources/accounting-templates/", import.meta.url),
);

/** The catalogue the Platform Portal offers, with no file paths exposed. */
export function listApprovedTemplates(): readonly {
  templateCode: string;
  templateVersion: number;
  displayName: string;
}[] {
  return approvedTemplates.map(({ templateCode, templateVersion, displayName }) => ({
    templateCode,
    templateVersion,
    displayName,
  }));
}

export interface LoadedTemplate {
  readonly approved: ApprovedTemplate;
  readonly template: AccountingTemplate;
  readonly sha256: string;
}

/**
 * Loads an approved template, refusing anything unrecognised or altered.
 *
 * Four gates, in order: the code/version pair must be in the catalogue, the
 * file must parse, its canonical hash must match the pin, and it must pass the
 * same validator the exporter runs. Only then is it handed to the importer.
 */
export function loadApprovedTemplate(
  templateCode: string,
  templateVersion: number,
): LoadedTemplate {
  const approved = approvedTemplates.find(
    (entry) => entry.templateCode === templateCode && entry.templateVersion === templateVersion,
  );
  if (approved === undefined) {
    throw new TemplateNotApprovedError(
      `Accounting template '${templateCode}' version ${templateVersion} is not an approved template.`,
    );
  }

  // The file name comes from the catalogue entry, never from the caller, so no
  // input reaches the filesystem path.
  const contents = readFileSync(`${templateDirectory}${approved.fileName}`, "utf8");
  const parsed: unknown = JSON.parse(contents);
  const sha256 = templateSha256(parsed);
  if (sha256 !== approved.sha256) {
    throw new TemplateNotApprovedError(
      `Accounting template '${templateCode}' version ${templateVersion} does not match its approved content. ` +
        `Expected ${approved.sha256}, found ${sha256}. ` +
        "Regenerating a template requires a new version or an explicitly updated approved hash.",
    );
  }
  // Canonical form is asserted separately from the hash so a file that is
  // merely reformatted produces a clear diagnostic rather than a hash mismatch.
  if (canonicalise(parsed) !== contents) {
    throw new TemplateNotApprovedError(
      `Accounting template '${templateCode}' version ${templateVersion} is not stored in canonical form.`,
    );
  }
  validateAccountingTemplate(parsed);

  return { approved, template: parsed, sha256 };
}
