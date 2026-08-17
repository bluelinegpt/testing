import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { templateSha256 } from "./accounting-template.canonical.js";
import {
  TemplateNotApprovedError,
  approvedTemplates,
  latestTemplateVersion,
  listApprovedTemplates,
  loadApprovedTemplate,
} from "./accounting-template.registry.js";

describe("approved template registry", () => {
  it("offers only the approved catalogue, with no file paths", () => {
    const listed = listApprovedTemplates();
    expect(listed).toEqual([
      {
        templateCode: "UAE_DELIVERY_STANDARD",
        templateVersion: 1,
        displayName: "UAE Delivery Standard",
      },
      {
        templateCode: "UAE_DELIVERY_STANDARD",
        templateVersion: 2,
        displayName: "UAE Delivery Standard",
      },
    ]);
    // A file name in the browser-facing catalogue would be the first step
    // towards a caller choosing its own file.
    for (const entry of listed) {
      expect(entry).not.toHaveProperty("fileName");
      expect(entry).not.toHaveProperty("sha256");
    }
  });

  it("loads the approved template", () => {
    const loaded = loadApprovedTemplate("UAE_DELIVERY_STANDARD", 1);
    expect(loaded.template.templateCode).toBe("UAE_DELIVERY_STANDARD");
    expect(loaded.template.accounts.length).toBeGreaterThan(0);
    expect(loaded.sha256).toBe(loaded.approved.sha256);
  });

  /**
   * v1 predates the Areas section and must keep working unchanged: a Company
   * already initialised from it, and a fresh one that deliberately asks for
   * it, must both still be able to.
   */
  it("keeps v1 importable, with no Areas section", () => {
    const loaded = loadApprovedTemplate("UAE_DELIVERY_STANDARD", 1);
    expect(loaded.template.areas ?? []).toEqual([]);
  });

  /**
   * v2 carries the UAE's delivery Areas, embedded from the canonical
   * reference list rather than from any Company's live data — see
   * `TemplateArea`. All Emirates-equivalent records must be represented, and the count
   * matches the reference list the CLI reports when the template was built.
   */
  it("loads v2 with a complete Areas section", () => {
    const loaded = loadApprovedTemplate("UAE_DELIVERY_STANDARD", 2);
    const areas = loaded.template.areas ?? [];
    expect(areas.length).toBeGreaterThan(400);
    const emirateCodes = new Set(areas.map((area) => area.emirateCode));
    expect(emirateCodes).toEqual(new Set([
      "AUH", "DXB", "SHJ", "AJM", "UAQ", "RAK", "FUJ", "WST", "OAA", "EST",
    ]));
    for (const code of ["WST", "OAA", "EST"]) {
      expect(areas.filter((area) => area.emirateCode === code && area.nameEn === "All Areas"))
        .toHaveLength(1);
    }
    for (const area of areas) {
      expect(area.nameEn.trim()).not.toBe("");
      expect(area.nameAr.trim()).not.toBe("");
    }
  });

  it("refuses an unknown template code", () => {
    expect(() => loadApprovedTemplate("SOMETHING_ELSE", 1)).toThrow(TemplateNotApprovedError);
  });

  it("refuses an unapproved version of an approved code", () => {
    expect(() => loadApprovedTemplate("UAE_DELIVERY_STANDARD", 3)).toThrow(
      /version 3 is not an approved template/,
    );
  });

  /**
   * A NEW Company must receive the latest version by default -- v1 silently
   * left every new tenant without a working set of Areas, and nothing about
   * that was visible until someone tried to use one.
   */
  it("points new Companies at the latest version", () => {
    expect(latestTemplateVersion.UAE_DELIVERY_STANDARD).toBe(2);
  });

  /**
   * Version alone is not enough. The exporter is a command anyone can run, so a
   * regenerated v1 could otherwise initialise Companies differently while every
   * record still said "UAE_DELIVERY_STANDARD v1".
   */
  it("pins the hash of the file it will actually apply", () => {
    const entry = approvedTemplates[0]!;
    const path = resolve(process.cwd(), `resources/accounting-templates/${entry.fileName}`);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as unknown;
    expect(templateSha256(onDisk)).toBe(entry.sha256);
  });

  it("refuses content that no longer matches the pinned hash", () => {
    const entry = approvedTemplates[0]!;
    const original = entry.sha256;
    try {
      (entry as { sha256: string }).sha256 = "0".repeat(64);
      expect(() => loadApprovedTemplate("UAE_DELIVERY_STANDARD", 1)).toThrow(
        /does not match its approved content/,
      );
    } finally {
      (entry as { sha256: string }).sha256 = original;
    }
  });

  it("resolves its own path rather than depending on the working directory", () => {
    // The API starts from `apps/api` in development and `/opt/app/apps/api` in
    // the container, so a cwd-relative path would work in exactly one of them.
    const source = readFileSync(
      resolve(process.cwd(), "src/accounting-template/accounting-template.registry.ts"),
      "utf8",
    );
    // Asserted on the declaration itself rather than on the file as a whole:
    // the surrounding comment necessarily mentions the thing it warns against.
    const declaration = /const templateDirectory = [^;]+;/.exec(source)?.[0] ?? "";
    expect(declaration).toContain("import.meta.url");
    expect(declaration).not.toContain("process.cwd()");
  });

  it("ships the resources directory in the published package", () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
      files: string[];
    };
    // `pnpm deploy` copies only what `files` lists; without this the template
    // would be missing from the container and every Company creation would fail
    // in production only.
    expect(manifest.files).toContain("resources");
  });
});
