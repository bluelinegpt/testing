import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import pg from "pg";

import type { AppConfiguration } from "../configuration/environment.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import {
  buildReports,
  computeBlockers,
  introspectSchema,
} from "./reset-company-test-data.manifest.js";
import {
  getResetCompanyUserPlan,
  previewResetCompanyUsers,
} from "./reset-company-users.js";

/**
 * LEGACY Company test-data reset -- READ-ONLY remainder (Company Data Reset,
 * Prompt 3).
 *
 * The legacy mutations (`execute` = whole-Company `runReset`, `executeUsers` =
 * `removeResetCompanyUsers`) were retired in Prompt 2 (their routes answer
 * 410 `company_reset_retired`) and REMOVED here in Prompt 3: every Company
 * Data Reset mutation goes through `executeAndAuditCompanyDataReset`
 * (company-data-reset.service.ts). What remains are the read-only legacy
 * previews behind GET reset-preview / users-reset-eligible / POST
 * users-reset-preview; each runs in a read-only transaction that is rolled
 * back. Nothing in this service writes.
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
  readonly fiscalCalendar: {
    readonly fiscalYearsPreserved: number;
    readonly periodsPreserved: number;
    readonly fiscalYearsToOpen: number;
    readonly periodsToOpen: number;
    readonly fiscalYearStatuses: Readonly<Record<string, number>>;
    readonly periodStatuses: Readonly<Record<string, number>>;
  };
  readonly usersToRemove: readonly {
    readonly accountId: string;
    readonly accountKind: string;
    readonly username: string;
    readonly displayName: string;
    readonly sharedIdentity: boolean;
    readonly sharedReferences: readonly string[];
  }[];
  readonly adminUsersPreserved: readonly {
    readonly accountId: string;
    readonly accountKind: string;
    readonly username: string;
    readonly displayName: string;
    readonly sharedIdentity: boolean;
    readonly sharedReferences: readonly string[];
  }[];
}

export interface CompanyUsersResetPreview {
  readonly company: { readonly id: string; readonly code: string; readonly name: string; readonly environment: string };
  readonly eligible: boolean;
  readonly blockers: readonly string[];
  readonly confirmation: string;
  readonly selectedUsers: readonly unknown[];
  readonly accountsToDelete: readonly unknown[];
  readonly identitiesRetained: readonly unknown[];
  readonly adminUsersPreserved: readonly unknown[];
}

export interface CompanyUsersResetEligible {
  readonly company: { readonly id: string; readonly code: string; readonly name: string; readonly environment: string };
  readonly eligible: boolean;
  readonly blockers: readonly string[];
  readonly usersToRemove: readonly unknown[];
  readonly adminUsersPreserved: readonly unknown[];
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
        const users = await getResetCompanyUserPlan(client, companyId);
        const fiscalCalendar = await this.fiscalCalendarPreview(client, companyId);

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
          fiscalCalendar,
          usersToRemove: users.usersToRemove,
          adminUsersPreserved: users.adminUsersPreserved,
        };
      } finally {
        await client.query("rollback");
      }
    });
  }

  public previewUsers(companyId: string, accountIds: readonly string[]): Promise<CompanyUsersResetPreview> {
    return this.withClient(async (client) => {
      await client.query("begin transaction read only");
      try {
        const company = await this.loadCompany(client, companyId);
        const blockers = company.environment === "production" ? [PRODUCTION_BLOCKER] : [];
        const users = await this.previewSelectedUsers(client, companyId, accountIds);
        return {
          company: { id: company.id, code: company.code, name: company.name_en, environment: company.environment },
          eligible: blockers.length === 0,
          blockers,
          confirmation: `RESET USERS ${company.code}`,
          ...users,
        };
      } finally {
        await client.query("rollback");
      }
    });
  }

  public usersResetEligible(companyId: string): Promise<CompanyUsersResetEligible> {
    return this.withClient(async (client) => {
      await client.query("begin transaction read only");
      try {
        const company = await this.loadCompany(client, companyId);
        const blockers = company.environment === "production" ? [PRODUCTION_BLOCKER] : [];
        const plan = await getResetCompanyUserPlan(client, companyId);
        return {
          company: { id: company.id, code: company.code, name: company.name_en, environment: company.environment },
          eligible: blockers.length === 0,
          blockers,
          ...plan,
        };
      } finally {
        await client.query("rollback");
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

  private async fiscalCalendarPreview(
    client: pg.PoolClient,
    companyId: string,
  ): Promise<CompanyResetPreview["fiscalCalendar"]> {
    const [years, periods] = await Promise.all([
      client.query<{ status: string; count: string }>(
        "select status, count(*)::bigint as count from fiscal_years " +
          "where company_id = $1 group by status",
        [companyId],
      ),
      client.query<{ status: string; count: string }>(
        "select status, count(*)::bigint as count from accounting_periods " +
          "where company_id = $1 group by status",
        [companyId],
      ),
    ]);
    const fiscalYearStatuses = Object.fromEntries(
      years.rows.map((row) => [row.status, Number(row.count)]),
    );
    const periodStatuses = Object.fromEntries(
      periods.rows.map((row) => [row.status, Number(row.count)]),
    );
    const total = (statuses: Readonly<Record<string, number>>) =>
      Object.values(statuses).reduce((sum, count) => sum + count, 0);
    return {
      fiscalYearsPreserved: total(fiscalYearStatuses),
      periodsPreserved: total(periodStatuses),
      fiscalYearsToOpen: Object.entries(fiscalYearStatuses)
        .filter(([status]) => status !== "open")
        .reduce((sum, [, count]) => sum + count, 0),
      periodsToOpen: Object.entries(periodStatuses)
        .filter(([status]) => status !== "open")
        .reduce((sum, [, count]) => sum + count, 0),
      fiscalYearStatuses,
      periodStatuses,
    };
  }

  private async previewSelectedUsers(client: pg.PoolClient, companyId: string, accountIds: readonly string[]) {
    try {
      return await previewResetCompanyUsers(client, companyId, accountIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Selected users are not eligible for reset.";
      const isAdmin = message.toLowerCase().includes("admin");
      throw new ApplicationException(
        isAdmin ? "company_users_reset_admin_protected" : "company_users_reset_selection_invalid",
        message,
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
