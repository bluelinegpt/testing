import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import pg from "pg";

import type { AppConfiguration } from "../configuration/environment.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { redactSensitive } from "./platform-audit.service.js";
import { runReset } from "./reset-company-test-data.engine.js";
import {
  buildReports,
  computeBlockers,
  introspectSchema,
} from "./reset-company-test-data.manifest.js";

/**
 * Platform-portal front end for the Company test-data reset.
 *
 * The engine, manifest and their safety tests have existed since Prompt 2A as
 * a CLI-only tool; this service adds nothing to what a reset removes or
 * preserves — it only exposes the same engine over the Portal, with the same
 * order of protections the CLI enforces:
 *
 *   1. THE COMPANY'S OWN ENVIRONMENT IS THE DECISIVE GATE. A Company whose
 *      `environment` is 'production' is refused in the preview, refused again
 *      at execution, and re-checked INSIDE the execution transaction with the
 *      Company row locked, so a concurrent move-to-production cannot race a
 *      reset past the check. There is deliberately no bypass and no
 *      permission that overrides it: development, demo, sandbox and trial
 *      Companies can be reset for training as many times as needed, and a
 *      production Company can never be.
 *   2. Typed confirmation — `RESET <code>` exactly, same shape as Close and
 *      Permanent Delete.
 *   3. A pg_dump backup is written before any change; if pg_dump is not
 *      available the reset refuses. The API has no `--allow-no-backup`.
 *
 * A raw `pg` connection is used instead of Kysely because the engine is
 * written against `pg.PoolClient` — it suspends and restores triggers and
 * verifies preserved tables inside one transaction, and re-implementing that
 * against Kysely would mean a second copy of reviewed safety code.
 */

export interface CompanyResetTableCount {
  readonly table: string;
  readonly rows: number;
}

export interface CompanyResetPreview {
  readonly company: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly status: string;
    readonly environment: string;
  };
  readonly eligible: boolean;
  readonly blockers: readonly string[];
  readonly confirmation: string;
  readonly tables: readonly CompanyResetTableCount[];
  readonly totalRows: number;
}

export interface CompanyResetResult {
  readonly company: { readonly id: string; readonly code: string; readonly name: string };
  readonly removed: readonly CompanyResetTableCount[];
  readonly totalRemoved: number;
  readonly preservedVerified: number;
  readonly backupFile: string;
}

interface CompanyRow {
  readonly id: string;
  readonly code: string;
  readonly name_en: string;
  readonly status: string;
  readonly environment: string;
}

const PRODUCTION_BLOCKER =
  "This Company is in production. Production data can never be reset — there is no bypass.";

@Injectable()
export class PlatformCompanyResetService {
  public constructor(
    @Inject(ConfigService) private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  public preview(companyId: string): Promise<CompanyResetPreview> {
    return this.withClient(async (client) => {
      await client.query("begin transaction read only");
      try {
        const company = await this.loadCompany(client, companyId);
        // The production gate is part of computeBlockers, so the preview
        // reports it exactly as the engine will enforce it.
        const blockers: string[] = [];
        const environment = (process.env.NODE_ENV ?? "development").trim().toLowerCase();
        const snapshot = await introspectSchema(client);
        const reports = await buildReports(client, companyId, snapshot);
        const readiness = computeBlockers(reports, snapshot, environment, {
          code: company.code,
          environment: company.environment,
        });
        blockers.push(...readiness.blockers);
        if (readiness.cycle.length > 0) {
          blockers.push(`Unbroken foreign-key cycle among: ${readiness.cycle.join(", ")}`);
        }

        const tables = reports
          .filter((report) => report.classification === "PURGE" && (report.rows ?? 0) > 0)
          .map((report) => ({ table: report.table, rows: report.rows ?? 0 }))
          .sort((first, second) => second.rows - first.rows);

        return {
          company: this.identity(company),
          eligible: blockers.length === 0,
          blockers,
          confirmation: `RESET ${company.code}`,
          tables,
          totalRows: tables.reduce((total, entry) => total + entry.rows, 0),
        };
      } finally {
        await client.query("rollback");
      }
    });
  }

  public execute(
    companyId: string,
    confirmation: string,
    actor: { accountId: string; correlationId: string },
  ): Promise<CompanyResetResult> {
    return this.withClient(async (client) => {
      const company = await this.loadCompany(client, companyId);
      this.refuseProduction(company);
      if (confirmation !== `RESET ${company.code}`) {
        throw new ApplicationException(
          "company_reset_confirmation_mismatch",
          `Type RESET ${company.code} to confirm`,
          HttpStatus.BAD_REQUEST,
        );
      }

      // The backup is written before the transaction opens: a dump taken
      // inside it would see the data already gone.
      const backupFile = await this.takeBackup(companyId);

      await client.query("begin");
      try {
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended('platform-company-reset', 0))",
        );
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [companyId]);
        // Re-read WITH the row locked: the pre-check above was advisory, this
        // one is the guarantee. A move-to-production committed between the
        // two is caught here.
        const locked = (
          await client.query<CompanyRow>(
            "select id, code, name_en, status, environment from companies where id = $1 for update",
            [companyId],
          )
        ).rows[0];
        if (locked === undefined) {
          throw this.notFound();
        }
        this.refuseProduction(locked);

        const summary = await runReset(client, companyId, () => undefined);
        const removed = summary.removed
          .filter((entry) => entry.rows > 0)
          .map((entry) => ({ table: entry.table, rows: entry.rows }));

        await this.auditInResetTransaction(client, {
          companyId,
          actorAccountId: actor.accountId,
          correlationId: actor.correlationId,
          before: { environment: locked.environment, totalRows: summary.totalRemoved },
          after: {
            totalRemoved: summary.totalRemoved,
            tablesCleared: removed.length,
            backupFile: basename(backupFile),
          },
        });
        await client.query("commit");

        return {
          company: { id: locked.id, code: locked.code, name: locked.name_en },
          removed,
          totalRemoved: summary.totalRemoved,
          preservedVerified: summary.preservedVerified,
          backupFile: basename(backupFile),
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  private identity(company: CompanyRow): CompanyResetPreview["company"] {
    return {
      id: company.id,
      code: company.code,
      name: company.name_en,
      status: company.status,
      environment: company.environment,
    };
  }

  private refuseProduction(company: CompanyRow): void {
    if (company.environment === "production") {
      throw new ApplicationException(
        "company_reset_production_refused",
        PRODUCTION_BLOCKER,
        HttpStatus.CONFLICT,
      );
    }
  }

  private async loadCompany(client: pg.PoolClient, companyId: string): Promise<CompanyRow> {
    const company = (
      await client.query<CompanyRow>(
        "select id, code, name_en, status, environment from companies where id = $1",
        [companyId],
      )
    ).rows[0];
    if (company === undefined) {
      throw this.notFound();
    }
    return company;
  }

  /**
   * Same columns and markers as `PlatformAuditService.record`, written with
   * the reset's own client so the audit row shares the reset transaction —
   * if the reset rolls back, so does its audit entry, and the refusal paths
   * above never reach this point.
   */
  private async auditInResetTransaction(
    client: pg.PoolClient,
    input: {
      companyId: string;
      actorAccountId: string;
      correlationId: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `insert into audit_events (
         company_id, actor_account_id, action, subject_type, subject_id,
         before_data, after_data, correlation_id, actor_role, source, result, source_application
       ) values ($1::uuid, $2::uuid, 'platform.company.data_reset', 'company', $1::text,
                 $3::jsonb, $4::jsonb, $5, 'platform_administrator', 'platform_portal',
                 'success', 'platform-web')`,
      [
        input.companyId,
        input.actorAccountId,
        JSON.stringify(redactSensitive(input.before)),
        JSON.stringify(redactSensitive(input.after)),
        input.correlationId,
      ],
    );
  }

  private async takeBackup(companyId: string): Promise<string> {
    const settings = this.config.get("companyDeletion", { infer: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = resolve(settings.backupRoot, `company-reset-${companyId}-${stamp}.dump`);
    await mkdir(settings.backupRoot, { recursive: true });

    const url = this.config.get("database.url", { infer: true });
    const exitCode = await new Promise<number | null>((resolveExit) => {
      const child = spawn("pg_dump", ["--format=custom", "--file", target, url], {
        stdio: "ignore",
        timeout: settings.timeoutMs,
      });
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
    return target;
  }

  private notFound(): ApplicationException {
    return new ApplicationException(
      "company_not_found",
      "The requested Company does not exist",
      HttpStatus.NOT_FOUND,
    );
  }

  private async withClient<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const pool = new pg.Pool({
      application_name: "blueline-platform-company-reset",
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
