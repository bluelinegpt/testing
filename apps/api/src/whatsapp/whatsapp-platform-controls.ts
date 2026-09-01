import { HttpStatus } from "@nestjs/common";
import { type Kysely, sql, type Transaction } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";

type ExecuteContext = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

/**
 * The Platform's per-Company WhatsApp kill switch
 * (`company_whatsapp_platform_settings`). ABSENCE of a row means ENABLED —
 * only an explicit `whatsapp_enabled = false` row disables a Company. The
 * automatic Order-status hook embeds the same predicate directly in its
 * context query (`whatsapp-outbox-writer.service.ts`) so the write stays a
 * single statement; every interactive entry point uses these helpers.
 */
export async function isWhatsAppDisabledByPlatform(
  execute: ExecuteContext,
  companyId: string,
): Promise<boolean> {
  const row = (
    await sql<{ disabled: boolean }>`
      select exists (
        select 1 from company_whatsapp_platform_settings
         where company_id = ${companyId}::uuid and whatsapp_enabled = false
      ) as "disabled"
    `.execute(execute)
  ).rows[0];
  return row?.disabled === true;
}

export async function assertWhatsAppEnabledByPlatform(
  execute: ExecuteContext,
  companyId: string,
): Promise<void> {
  if (await isWhatsAppDisabledByPlatform(execute, companyId)) {
    throw new ApplicationException(
      "whatsapp_disabled_by_platform",
      "WhatsApp is disabled for this Company by Platform Administration",
      HttpStatus.CONFLICT,
    );
  }
}
