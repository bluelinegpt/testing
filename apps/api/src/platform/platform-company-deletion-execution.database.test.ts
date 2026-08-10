import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ConfigService } from "@nestjs/config";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { configuration, type AppConfiguration } from "../configuration/environment.js";
import { FileStoragePort } from "../files/file-storage.port.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import {
  PlatformCompanyDeletionBackupService,
  runBackupProcess,
} from "./platform-company-deletion-backup.service.js";
import { PlatformCompanyDeletionExecutionService } from "./platform-company-deletion-execution.service.js";
import { PlatformCompanyDeletionService } from "./platform-company-deletion.service.js";

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
const enabled = process.env.RUN_COMPANY_DELETION_DATABASE === "true";

class EmptyStorage extends FileStoragePort {
  public async storePrivate(): Promise<{ storageKey: string }> { throw new Error("unused"); }
  public async readPrivate(): Promise<Uint8Array> { throw new Error("unused"); }
  public async deletePrivate(): Promise<void> {}
  public async storeCommerce(): Promise<{ storageKey: string }> { throw new Error("unused"); }
  public async readCommerce(): Promise<Uint8Array> { throw new Error("unused"); }
  public async deleteCommerce(): Promise<void> {}
}

describe.skipIf(!enabled)("permanent Company deletion database proof", () => {
  it("deletes a dedicated Development fixture and preserves another Company", async () => {
    const settings = configuration();
    const pool = new pg.Pool({ connectionString: settings.database.url, max: 2 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const companyId = randomUUID();
    const code = `DEV-DEL-${companyId.slice(0, 8).toUpperCase()}`;
    const operationKey = randomUUID();
    try {
      const actor = (await sql<{ id: string }>`select id from accounts where company_id is null order by created_at limit 1`.execute(database)).rows[0];
      const unrelatedBefore = Number((await sql<{ n: string }>`select count(*)::bigint n from companies`.execute(database)).rows[0]?.n ?? 0);
      expect(actor).toBeDefined();
      await sql`insert into companies(id,code,subdomain,name_en,status,environment,closed_at) values(${companyId}::uuid,${code},${`dev-del-${companyId.slice(0, 8)}`},'Permanent deletion fixture','closed','development',now())`.execute(database);

      const previewService = new PlatformCompanyDeletionService(database);
      const preview = await previewService.preview(companyId, { accountId: actor!.id, correlationId: randomUUID() }, operationKey);
      expect(preview.blockers).toEqual([]);

      const configService = new ConfigService<AppConfiguration, true>(settings);
      const backupService = new PlatformCompanyDeletionBackupService(database, configService, runBackupProcess);
      const backup = await backupService.createVerifiedBackup(companyId, String(preview.operationId), actor!.id);
      expect(backup.status).toBe("verified");

      const execution = new PlatformCompanyDeletionExecutionService(database, configService, new EmptyStorage(), () => undefined);
      const result = await execution.execute(companyId, {
        operationId: String(preview.operationId),
        previewId: String(preview.previewId),
        confirmation: `DELETE ${code}`,
        idempotencyKey: operationKey,
      });
      expect(result.state).toBe("completed");
      expect((await sql`select 1 from companies where id=${companyId}::uuid`.execute(database)).rows).toHaveLength(0);
      expect(Number((await sql<{ n: string }>`select count(*)::bigint n from companies`.execute(database)).rows[0]?.n)).toBe(unrelatedBefore);
      expect((await sql<{ state: string }>`select state from platform_company_deletion_operations where id=${String(preview.operationId)}::uuid`.execute(database)).rows[0]?.state).toBe("completed");
    } finally {
      await database.destroy();
    }
  }, 360_000);
});
