import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import { sql } from "kysely";

import type { AppConfiguration } from "../configuration/environment.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { Kysely } from "kysely";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { calculateCompanyDeletionEligibility } from "./platform-company-deletion.service.js";

const BACKUP_EXECUTABLE = "pg_dump";

export interface BackupProcessResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export type BackupProcessRunner = (input: {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
}) => Promise<BackupProcessResult>;

export const COMPANY_DELETION_BACKUP_RUNNER = Symbol("COMPANY_DELETION_BACKUP_RUNNER");

export const runBackupProcess: BackupProcessRunner = ({ executable, args, timeoutMs }) =>
  new Promise((resolveResult, reject) => {
    const child = spawn(executable, [...args], { stdio: "ignore", windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolveResult({ exitCode, timedOut });
    });
  });

export async function checksumFileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

@Injectable()
export class PlatformCompanyDeletionBackupService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(ConfigService) private readonly config: ConfigService<AppConfiguration, true>,
    @Inject(COMPANY_DELETION_BACKUP_RUNNER) private readonly runner: BackupProcessRunner,
  ) {}

  public async createVerifiedBackup(
    companyId: string,
    operationId: string,
    actorAccountId: string,
  ): Promise<Record<string, unknown>> {
    const resolved = (
      await sql<{
        code: string;
        status: string;
        environment: string;
        closedAt: Date | null;
        now: Date;
        previewId: string | null;
        operationState: string;
      }>`
        select company.code, company.status, company.environment, company.closed_at as "closedAt",
               clock_timestamp() as now, operation.preview_id as "previewId",
               operation.state as "operationState"
          from companies company
          join platform_company_deletion_operations operation
            on operation.company_id_snapshot = company.id and operation.id = ${operationId}::uuid
         where company.id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (resolved === undefined) {
      throw new ApplicationException("company_deletion_operation_not_found", "Deletion operation not found", HttpStatus.NOT_FOUND);
    }
    const eligibility = calculateCompanyDeletionEligibility(resolved);
    if (!eligibility.eligible) {
      throw new ApplicationException("company_deletion_backup_not_eligible", eligibility.blockers.join("; "), HttpStatus.CONFLICT);
    }
    if (resolved.previewId === null || !["previewed", "blocked", "ready"].includes(resolved.operationState)) {
      throw new ApplicationException("company_deletion_preview_required", "A current deletion preview is required", HttpStatus.CONFLICT);
    }

    const existing = (
      await sql<{ id: string; storageReference: string; checksum: string; sizeBytes: string; verifiedAt: Date }>`
        select id, storage_reference as "storageReference", checksum_sha256 as checksum,
               size_bytes as "sizeBytes", verified_at as "verifiedAt"
          from platform_company_deletion_backups
         where operation_id = ${operationId}::uuid and status = 'verified'
      `.execute(this.database)
    ).rows[0];
    if (existing !== undefined) return this.safeResult(existing);

    const backupId = (
      await sql<{ id: string }>`
        insert into platform_company_deletion_backups (
          operation_id, company_id_snapshot, backup_type, status, created_by_account_id
        ) values (${operationId}::uuid, ${companyId}::uuid, 'full_database', 'requested', ${actorAccountId}::uuid)
        returning id
      `.execute(this.database)
    ).rows[0]?.id;
    if (backupId === undefined) throw new Error("Backup record was not created");

    const settings = this.config.get("companyDeletion", { infer: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `company-deletion-${companyId}-${operationId}-${stamp}.dump`;
    const target = resolve(settings.backupRoot, fileName);
    try {
      await mkdir(settings.backupRoot, { recursive: true });
      await sql`update platform_company_deletion_backups set status = 'running' where id = ${backupId}::uuid`.execute(this.database);
      const processResult = await this.runner({
        executable: BACKUP_EXECUTABLE,
        args: ["--format=custom", "--file", target, this.config.get("database.url", { infer: true })],
        timeoutMs: settings.timeoutMs,
      });
      if (processResult.timedOut || processResult.exitCode !== 0) throw new Error("backup_process_failed");
      const artifact = await stat(target);
      if (!artifact.isFile() || artifact.size <= 0) throw new Error("backup_artifact_missing");
      const checksum = await checksumFileSha256(target);
      const verified = (
        await sql<{ id: string; storageReference: string; checksum: string; sizeBytes: string; verifiedAt: Date }>`
          update platform_company_deletion_backups
             set status = 'verified', storage_reference = ${fileName}, checksum_sha256 = ${checksum},
                 size_bytes = ${artifact.size}, completed_at = now(), verified_at = now()
           where id = ${backupId}::uuid
           returning id, storage_reference as "storageReference", checksum_sha256 as checksum,
                     size_bytes as "sizeBytes", verified_at as "verifiedAt"
        `.execute(this.database)
      ).rows[0];
      if (verified === undefined) throw new Error("backup_verification_not_recorded");
      await sql`
        update platform_company_deletion_operations
           set backup_reference = ${fileName},
               state = case
                 when exists (
                   select 1 from platform_company_deletion_previews preview
                    where preview.id = platform_company_deletion_operations.preview_id
                      and jsonb_array_length(preview.blockers) = 0
                 ) then 'ready' else state end,
               updated_at = now()
         where id = ${operationId}::uuid
      `.execute(this.database);
      await sql`
        update platform_company_deletion_previews preview set ready_for_delete = true
         where preview.id = (
           select operation.preview_id from platform_company_deletion_operations operation
            where operation.id = ${operationId}::uuid and operation.state = 'ready'
         )
      `.execute(this.database);
      return this.safeResult(verified);
    } catch {
      await sql`
        update platform_company_deletion_backups
           set status = 'failed', completed_at = now(), failure_reason = 'Verified database backup could not be created'
         where id = ${backupId}::uuid
      `.execute(this.database);
      throw new ApplicationException(
        "company_deletion_backup_failed",
        "Verified database backup could not be created; Company deletion remains blocked",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private safeResult(row: { id: string; storageReference: string; checksum: string; sizeBytes: string; verifiedAt: Date }): Record<string, unknown> {
    return {
      id: row.id,
      backupType: "full_database",
      status: "verified",
      backupReference: basename(row.storageReference),
      checksumSha256: row.checksum,
      sizeBytes: Number(row.sizeBytes),
      verifiedAt: row.verifiedAt.toISOString(),
    };
  }
}
