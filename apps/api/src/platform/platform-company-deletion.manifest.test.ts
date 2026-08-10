import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";

import { PermanentDeleteCompanyDto } from "./platform-company.dto.js";

import {
  COMPANY_DELETION_APPROVED_GUARDS,
  COMPANY_DELETION_CYCLE_BREAKS,
  COMPANY_DELETION_DIRECT_TABLES,
  COMPANY_DELETION_GLOBAL_PRESERVE,
  COMPANY_DELETION_INDIRECT,
  COMPANY_DELETION_MANIFEST_HASH,
  COMPANY_DELETION_MANIFEST_VERSION,
} from "./platform-company-deletion.manifest.js";

describe("permanent Company deletion manifest", () => {
  it.each([
    "environment",
    "status",
    "closedAt",
    "companyCode",
    "backupPath",
    "tableNames",
    "skipBackup",
    "force",
    "bypassWait",
  ])("rejects the unknown final-delete DTO field %s", async (field) => {
    const input = plainToInstance(PermanentDeleteCompanyDto, {
      operationId: "11111111-1111-4111-8111-111111111111",
      previewId: "22222222-2222-4222-8222-222222222222",
      confirmation: "DELETE CMP-123456",
      idempotencyKey: "certification-key",
      [field]: field === "tableNames" ? ["companies"] : "attacker-controlled",
    });
    const errors = await validate(input, {
      forbidNonWhitelisted: true,
      whitelist: true,
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: field,
          constraints: expect.objectContaining({ whitelistValidation: expect.any(String) }),
        }),
      ]),
    );
  });

  it("pins the reviewed live Company-table inventory", () => {
    expect(COMPANY_DELETION_MANIFEST_VERSION).toBe("company-deletion-v2");
    // 127 -> 129: Prompt 15 added two Company-scoped tables
    // (`device_registrations`, `notification_outbox_events`), both reviewed
    // and correctly classified as direct-delete — see the comment above
    // `NEW_DIRECT_TABLES` in `platform-company-deletion.manifest.ts`.
    expect(COMPANY_DELETION_DIRECT_TABLES.size).toBe(129);
    expect(COMPANY_DELETION_MANIFEST_HASH).toMatch(/^[a-f0-9]{64}$/);
  });

  it("classifies the only reviewed indirect ownership paths explicitly", () => {
    expect(COMPANY_DELETION_INDIRECT.map((entry) => entry.table)).toEqual([
      "role_permissions",
      "storefront_marketplace_categories",
    ]);
  });

  it("preserves global commerce and Marketplace taxonomy", () => {
    expect(COMPANY_DELETION_GLOBAL_PRESERVE.has("trader_commerce_profiles")).toBe(true);
    expect(COMPANY_DELETION_GLOBAL_PRESERVE.has("marketplace_categories")).toBe(true);
  });

  it("uses only the two reviewed cycle breaks and an exact guard allowlist", () => {
    expect(COMPANY_DELETION_CYCLE_BREAKS.map((entry) => entry.table).sort()).toEqual([
      "conversations",
      "journal_entries",
    ]);
    expect(COMPANY_DELETION_APPROVED_GUARDS.size).toBeGreaterThan(50);
    expect(COMPANY_DELETION_APPROVED_GUARDS.has("ALL")).toBe(false);
  });
});
