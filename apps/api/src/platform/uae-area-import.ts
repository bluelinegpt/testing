import { randomUUID } from "node:crypto";
import { promises as fileSystem } from "node:fs";
import { resolve } from "node:path";

import type { INestApplicationContext } from "@nestjs/common";
import { sql } from "kysely";

import { AreaConfigurationService } from "../company-configuration/area-configuration.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";

interface SeedArea {
  readonly emirateCode: string;
  readonly nameAr: string;
  readonly nameEn: string;
}

export interface AreaImportResult {
  readonly backfilledArabicNames: number;
  readonly created: number;
  readonly failed: readonly { readonly name: string; readonly reason: string }[];
  readonly skippedExisting: number;
  readonly total: number;
}

/**
 * Imports the UAE Area reference list into one Company.
 *
 * Idempotent: an Area already present under the same Emirate is skipped rather
 * than duplicated, so the import can be re-run safely. Creation goes through
 * AreaConfigurationService so codes are generated, uniqueness is enforced and
 * every row is audited exactly as if an administrator had typed it.
 *
 * Existing Areas that predate the import and carry no Arabic name are
 * backfilled from the reference list. Nothing else about them is touched: an
 * operator's own English spelling is never overwritten.
 */
export async function importUaeAreas(
  context: INestApplicationContext,
  options: { readonly correlationId: string; readonly subdomain: string },
): Promise<AreaImportResult> {
  const database = context.get(DATABASE);
  const areas = context.get(AreaConfigurationService);
  const store = context.get(RequestSecurityContextStore);

  const company = await sql<{ id: string }>`
    select id from companies where lower(subdomain) = lower(${options.subdomain})
  `.execute(database);
  const companyId = company.rows[0]?.id;
  if (companyId === undefined) {
    throw new Error(`Company '${options.subdomain}' was not found`);
  }

  // Import as the Company's administrator so audit attribution is a real actor.
  const account = await sql<{ id: string }>`
    select id from accounts
     where company_id = ${companyId}::uuid and account_kind = 'company_user' and status = 'active'
     order by created_at
     limit 1
  `.execute(database);
  const actorId = account.rows[0]?.id;
  if (actorId === undefined) {
    throw new Error(`Company '${options.subdomain}' has no active company user to attribute to`);
  }

  const emirateRows = await sql<{ code: string; id: string }>`
    select id, code from emirates
  `.execute(database);
  const emirateByCode = new Map(emirateRows.rows.map((row) => [row.code, row.id]));

  const file = resolve(process.cwd(), "../../database/seeds/uae-areas.json");
  const seed = JSON.parse(await fileSystem.readFile(file, "utf8")) as readonly SeedArea[];

  const existingRows = await sql<{ emirateId: string; id: string; nameAr: string | null; nameEn: string }>`
    select id, emirate_id as "emirateId", name_en as "nameEn", name_ar as "nameAr"
      from areas where company_id = ${companyId}::uuid
  `.execute(database);
  const key = (emirateId: string, nameEn: string) => `${emirateId}::${nameEn.trim().toLowerCase()}`;
  const existing = new Map(
    existingRows.rows.map((row) => [key(row.emirateId, row.nameEn), row]),
  );

  let created = 0;
  let skippedExisting = 0;
  let backfilledArabicNames = 0;
  const failed: { name: string; reason: string }[] = [];

  for (const area of seed) {
    const emirateId = emirateByCode.get(area.emirateCode);
    if (emirateId === undefined) {
      failed.push({ name: area.nameEn, reason: `Unknown Emirate ${area.emirateCode}` });
      continue;
    }

    const already = existing.get(key(emirateId, area.nameEn));
    if (already !== undefined) {
      skippedExisting += 1;
      // Only fill a gap; never overwrite a name the operator already set.
      if (already.nameAr === null || already.nameAr.trim() === "") {
        await sql`
          update areas set name_ar = ${area.nameAr}, updated_at = now(), version = version + 1
           where id = ${already.id}::uuid and company_id = ${companyId}::uuid
        `.execute(database);
        backfilledArabicNames += 1;
      }
      continue;
    }

    try {
      // Each create runs inside a tenant/identity scope, so the service applies
      // Company isolation and audit without any HTTP request.
      await store.run(
        {
          identity: {
            companyId,
            forcePasswordChange: false,
            identityId: actorId,
            kind: "company_user",
            permissions: new Set(["users_roles.manage"]),
            sessionId: randomUUID(),
          },
          tenant: { companyId, identityId: actorId },
        },
        () =>
          areas.create(
            { emirateId, nameAr: area.nameAr, nameEn: area.nameEn },
            options.correlationId,
          ),
      );
      created += 1;
    } catch (error) {
      failed.push({ name: area.nameEn, reason: (error as Error).message });
    }
  }

  return { backfilledArabicNames, created, failed, skippedExisting, total: seed.length };
}
