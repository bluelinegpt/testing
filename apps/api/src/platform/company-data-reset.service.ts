import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import pg from "pg";

import type { AppConfiguration } from "../configuration/environment.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import {
  normalizeResetRequest,
  type NormalizedResetRequest,
  type ResetPlanRequest,
  ResetRequestError,
} from "./company-data-reset.domains.js";
import {
  type CompanyDataResetOutcome,
  executeCompanyDataReset,
  ResetIntegrityError,
  ResetPlanNotExecutableError,
  ResetPlanStaleError,
} from "./company-data-reset.executor.js";
import {
  buildCompanyDataResetPlan,
  type CompanyDataResetPlan,
  CompanyNotFoundForReset,
} from "./company-data-reset.planner.js";
import { redactSensitive } from "./platform-audit.service.js";

/**
 * COMPANY DATA RESET service (Company Data Reset, Prompt 1).
 *
 *   preview -> a read-only transaction, rolled back: the deterministic plan
 *              and its planVersion. No mutation, no lock beyond reads.
 *   execute -> typed confirmation, production refused, verified pg_dump
 *              backup taken BEFORE the transaction, then ONE transaction:
 *              advisory + row locks, plan rebuilt and compared to the
 *              previewed planVersion (409 reset_plan_stale), the certified
 *              plan applied, post-reset integrity verified, the reset audit
 *              written -- COMMIT; any failure -> ROLLBACK (no half reset).
 * Platform administrative audit (repair executions / attempts, audit_events)
 * is never removed by any preset.
 */

export interface CompanyDataResetExecution {
  readonly company: { readonly id: string; readonly code: string; readonly name: string };
  readonly planVersion: string;
  readonly preset: string;
  readonly effectiveDomains: readonly string[];
  readonly removed: CompanyDataResetOutcome["removed"];
  readonly totalRemoved: number;
  readonly identitiesDeleted: number;
  readonly identitiesPreserved: number;
  readonly employeesDeleted: number;
  readonly employeesDetached: number;
  readonly driversDeleted: number;
  readonly driversDetached: number;
  readonly entityLinksRemoved: number;
  readonly fiscalYearsOpened: number;
  readonly periodsOpened: number;
  readonly integrityChecks: readonly string[];
  readonly backupFile: string;
  /** sha256 of the verified pg_dump file (also in the reset audit row). */
  readonly backupSha256: string;
  readonly backupBytes: number;
  /** The reset audit row (audit_events.id) and the request correlation id. */
  readonly auditEventId: string;
  readonly correlationId: string;
}

/** A verified pg_dump: readable by pg_restore, with its checksum. */
export interface CompanyDataResetBackup {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Who requested an execution: a Platform administrator (portal) or an operator CLI on a disposable database. */
export interface CompanyDataResetActor {
  readonly accountId: string | null;
  readonly correlationId: string;
  readonly source: "platform_portal" | "cli";
  readonly backupFile: string | null;
  readonly backupSha256?: string | null;
}

export type AuditedCompanyDataResetOutcome = CompanyDataResetOutcome & { readonly auditEventId: string };

/**
 * THE single Company Data Reset mutation entry point (portal AND CLI).
 * Inside the caller's transaction: rebuild + verify the previewed plan,
 * execute it, verify integrity, write the reset audit row. The caller only
 * opens / commits / rolls back the transaction; nothing else deletes.
 */
export async function executeAndAuditCompanyDataReset(
  client: pg.PoolClient,
  companyId: string,
  request: NormalizedResetRequest,
  planVersion: string,
  actor: CompanyDataResetActor,
): Promise<AuditedCompanyDataResetOutcome> {
  const outcome = await executeCompanyDataReset(client, companyId, request, planVersion);
  const before = {
    planVersion: outcome.plan.planVersion,
    preset: request.preset,
    selectedDomains: request.selectedDomains,
    userMode: request.userMode,
  };
  const after = {
    backupFile: actor.backupFile,
    backupSha256: actor.backupSha256 ?? null,
    effectiveDomains: outcome.plan.effectiveDomains,
    fiscalPeriodsOpened: outcome.periodsOpened,
    fiscalYearsOpened: outcome.fiscalYearsOpened,
    identitiesDeleted: outcome.identitiesDeleted,
    identitiesPreserved: outcome.identitiesPreserved,
    requiredDependencies: outcome.plan.requiredDependencies.map((dependency) => dependency.domain),
    summary: outcome.plan.summary,
    totalRemoved: outcome.totalRemoved,
    usersRemoved: outcome.plan.users.filter((user) => user.remove).map((user) => user.accountId),
  };
  const portal = actor.source === "platform_portal";
  const audit = await client.query<{ id: string }>(
    `insert into audit_events (company_id, actor_account_id, action, subject_type, subject_id, before_data, after_data, correlation_id,
       actor_role, source, result, source_application)
     values ($1::uuid, $2::uuid, 'platform.company.data_reset.planned', 'company', $1::text, $3::jsonb, $4::jsonb, $5,
       $6, $7, 'success', $8)
     returning id::text`,
    [
      companyId,
      actor.accountId,
      JSON.stringify(redactSensitive(before)),
      JSON.stringify(redactSensitive(after)),
      actor.correlationId,
      portal ? "platform_administrator" : "operator_cli",
      portal ? "platform_portal" : "reset_cli",
      portal ? "platform-web" : "system",
    ],
  );
  return { ...outcome, auditEventId: audit.rows[0]!.id };
}

/**
 * Failure evidence (Prompt 3): a reset that was refused or rolled back AFTER
 * confirmation writes one 'platform.company.data_reset.failed' audit row in
 * its own statement (the reset transaction itself left nothing behind).
 */
export async function auditCompanyDataResetFailure(
  client: pg.PoolClient,
  companyId: string,
  request: NormalizedResetRequest,
  planVersion: string,
  actor: CompanyDataResetActor,
  errorCode: string,
): Promise<void> {
  const portal = actor.source === "platform_portal";
  await client.query(
    `insert into audit_events (company_id, actor_account_id, action, subject_type, subject_id, before_data, after_data, correlation_id,
       actor_role, source, result, failure_reason, source_application)
     values ($1::uuid, $2::uuid, 'platform.company.data_reset.failed', 'company', $1::text, $3::jsonb, $4::jsonb, $5,
       $6, $7, 'failure', $8, $9)`,
    [
      companyId,
      actor.accountId,
      JSON.stringify(redactSensitive({ planVersion, preset: request.preset, selectedDomains: request.selectedDomains, userMode: request.userMode })),
      JSON.stringify(redactSensitive({ backupFile: actor.backupFile, backupSha256: actor.backupSha256 ?? null, rolledBack: true })),
      actor.correlationId,
      portal ? "platform_administrator" : "operator_cli",
      portal ? "platform_portal" : "reset_cli",
      errorCode,
      portal ? "platform-web" : "system",
    ],
  );
}

@Injectable()
export class CompanyDataResetService {
  public constructor(@Inject(ConfigService) private readonly config: ConfigService<AppConfiguration, true>) {}

  public preview(companyId: string, request: ResetPlanRequest): Promise<CompanyDataResetPlan> {
    const normalized = this.normalize(request);
    return this.withClient(async (client) => {
      await client.query("begin transaction read only");
      try {
        return await buildCompanyDataResetPlan(client, companyId, normalized);
      } catch (error) {
        throw this.translate(error);
      } finally {
        await client.query("rollback");
      }
    });
  }

  public execute(
    companyId: string,
    request: ResetPlanRequest & { readonly planVersion: string; readonly confirmation: string },
    actor: { readonly accountId: string; readonly correlationId: string },
  ): Promise<CompanyDataResetExecution> {
    const normalized = this.normalize(request);
    return this.withClient(async (client) => {
      const company = (
        await client.query<{ id: string; code: string; name_en: string; environment: string }>(
          "select id, code, name_en, environment from companies where id = $1",
          [companyId],
        )
      ).rows[0];
      if (company === undefined) throw this.notFound();
      if (company.environment === "production") {
        throw new ApplicationException("company_reset_production_refused", "Production data can never be reset.", HttpStatus.CONFLICT);
      }
      if (request.confirmation !== `RESET ${company.code}`) {
        throw new ApplicationException("company_reset_confirmation_mismatch", `Type RESET ${company.code} to confirm`, HttpStatus.BAD_REQUEST);
      }
      const auditActor: CompanyDataResetActor = {
        accountId: actor.accountId,
        backupFile: null,
        correlationId: actor.correlationId,
        source: "platform_portal",
      };
      let backup: CompanyDataResetBackup;
      try {
        // Cheap read-only pre-check: a stale or blocked plan is refused BEFORE a
        // full-database backup is taken. The authoritative check is repeated
        // under lock inside the execution transaction.
        await client.query("begin transaction read only");
        try {
          const current = await buildCompanyDataResetPlan(client, companyId, normalized);
          if (current.planVersion !== request.planVersion) throw new ResetPlanStaleError(request.planVersion, current.planVersion);
          if (!current.executable) throw new ResetPlanNotExecutableError(current.blockers);
        } finally {
          await client.query("rollback");
        }
        backup = await this.takeBackup(companyId);
      } catch (error) {
        const translated = this.translate(error);
        await this.recordFailure(client, companyId, normalized, request.planVersion, auditActor, translated);
        throw translated;
      }
      const backedUp: CompanyDataResetActor = { ...auditActor, backupFile: basename(backup.file), backupSha256: backup.sha256 };
      await client.query("begin");
      try {
        const outcome = await executeAndAuditCompanyDataReset(client, companyId, normalized, request.planVersion, backedUp);
        await client.query("commit");
        return {
          auditEventId: outcome.auditEventId,
          backupBytes: backup.bytes,
          backupFile: basename(backup.file),
          backupSha256: backup.sha256,
          correlationId: actor.correlationId,
          company: { code: company.code, id: company.id, name: company.name_en },
          driversDeleted: outcome.driversDeleted,
          driversDetached: outcome.driversDetached,
          effectiveDomains: outcome.plan.effectiveDomains,
          employeesDeleted: outcome.employeesDeleted,
          employeesDetached: outcome.employeesDetached,
          entityLinksRemoved: outcome.entityLinksRemoved,
          fiscalYearsOpened: outcome.fiscalYearsOpened,
          periodsOpened: outcome.periodsOpened,
          identitiesDeleted: outcome.identitiesDeleted,
          identitiesPreserved: outcome.identitiesPreserved,
          integrityChecks: outcome.integrityChecks,
          planVersion: outcome.plan.planVersion,
          preset: normalized.preset,
          removed: outcome.removed,
          totalRemoved: outcome.totalRemoved,
        };
      } catch (error) {
        await client.query("rollback");
        const translated = this.translate(error);
        await this.recordFailure(client, companyId, normalized, request.planVersion, backedUp, translated);
        throw translated;
      }
    });
  }

  /** Best effort: failure evidence must never mask the original error. */
  private async recordFailure(
    client: pg.PoolClient,
    companyId: string,
    request: NormalizedResetRequest,
    planVersion: string,
    actor: CompanyDataResetActor,
    error: unknown,
  ): Promise<void> {
    const code = error instanceof ApplicationException ? error.errorCode : "reset_failed_rolled_back";
    try {
      await auditCompanyDataResetFailure(client, companyId, request, planVersion, actor, code);
    } catch {
      // The reset itself already rolled back; nothing else to do.
    }
  }

  private normalize(request: ResetPlanRequest): NormalizedResetRequest {
    try {
      return normalizeResetRequest(request);
    } catch (error) {
      throw this.translate(error);
    }
  }

  private translate(error: unknown): unknown {
    if (error instanceof ApplicationException) return error;
    if (error instanceof ResetRequestError) {
      return new ApplicationException("reset_request_invalid", error.message, HttpStatus.BAD_REQUEST);
    }
    if (error instanceof CompanyNotFoundForReset) return this.notFound();
    if (error instanceof ResetPlanStaleError) {
      return new ApplicationException("reset_plan_stale", error.message, HttpStatus.CONFLICT);
    }
    if (error instanceof ResetPlanNotExecutableError) {
      return new ApplicationException("reset_plan_blocked", error.message, HttpStatus.CONFLICT, error.blockers);
    }
    if (error instanceof ResetIntegrityError) {
      return new ApplicationException("reset_integrity_failed", `${error.message} Nothing was changed.`, HttpStatus.CONFLICT);
    }
    return error;
  }

  /**
   * MANDATORY before every portal execution: a full-database pg_dump (custom
   * format) written to COMPANY_DELETION_BACKUP_ROOT, then VERIFIED readable
   * with `pg_restore --list`, and checksummed. Any failure refuses the reset.
   */
  private async takeBackup(companyId: string): Promise<CompanyDataResetBackup> {
    const settings = this.config.get("companyDeletion", { infer: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = resolve(settings.backupRoot, `company-data-reset-${companyId}-${stamp}.dump`);
    await mkdir(settings.backupRoot, { recursive: true });
    const url = this.config.get("database.url", { infer: true });
    const exitCode = await new Promise<number | null>((resolveExit) => {
      const child = spawn("pg_dump", ["--format=custom", "--file", target, url], { stdio: "ignore", timeout: settings.timeoutMs });
      child.on("error", () => resolveExit(null));
      child.on("exit", (code) => resolveExit(code));
    });
    if (exitCode !== 0) {
      throw new ApplicationException(
        "company_reset_backup_failed",
        "A verified pg_dump backup could not be taken; refusing to reset without one",
        HttpStatus.CONFLICT,
      );
    }
    const listExit = await new Promise<number | null>((resolveExit) => {
      const child = spawn("pg_restore", ["--list", target], { stdio: "ignore", timeout: settings.timeoutMs });
      child.on("error", () => resolveExit(null));
      child.on("exit", (code) => resolveExit(code));
    });
    const bytes = (await stat(target).catch(() => ({ size: 0 }))).size;
    if (listExit !== 0 || bytes === 0) {
      throw new ApplicationException(
        "company_reset_backup_failed",
        "The pg_dump backup could not be verified with pg_restore; refusing to reset without one",
        HttpStatus.CONFLICT,
      );
    }
    const sha256 = await new Promise<string>((resolveHash, rejectHash) => {
      const hash = createHash("sha256");
      createReadStream(target)
        .on("data", (chunk) => hash.update(chunk))
        .on("error", rejectHash)
        .on("end", () => resolveHash(hash.digest("hex")));
    });
    return { bytes, file: target, sha256 };
  }

  private notFound(): ApplicationException {
    return new ApplicationException("company_not_found", "The requested Company does not exist", HttpStatus.NOT_FOUND);
  }

  private async withClient<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const pool = new pg.Pool({
      application_name: "blueline-company-data-reset",
      connectionString: this.config.get("database.url", { infer: true }),
      max: 1,
    });
    const client = await pool.connect();
    try {
      return await work(client);
    } finally {
      client.release();
      await pool.end();
    }
  }
}
