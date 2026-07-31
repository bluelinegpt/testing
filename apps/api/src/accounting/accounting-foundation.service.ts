import { createHash } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { accountingReferenceDefinitions } from "./accounting.constants.js";
import type { AccountingEventContract } from "./accounting.contracts.js";
import { assertPostingPeriodOpen } from "./accounting.guards.js";

interface PostingPeriodRecord {
  readonly fiscalPeriodId: string;
  readonly fiscalPeriodStatus:
    | "future"
    | "open"
    | "soft_closed"
    | "closed"
    | "reopened";
  readonly fiscalYearId: string;
  readonly fiscalYearStatus: "draft" | "open" | "closed" | "reopened";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Internal-only foundation operations. No write route calls these methods in
 * Accounting Prompt 1.
 */
@Injectable()
export class AccountingFoundationService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  public eventHash(event: AccountingEventContract): string {
    return createHash("sha256").update(canonicalJson(event)).digest("hex");
  }

  public assertEventRetryPayload(
    existingEventHash: string,
    event: AccountingEventContract,
  ): void {
    if (existingEventHash !== this.eventHash(event)) {
      throw new ApplicationException(
        "accounting_event_payload_mismatch",
        "This Accounting Event identity was already used with different financial facts",
        HttpStatus.CONFLICT,
      );
    }
  }

  public async nextJournalNumber(
    database: Kysely<DatabaseSchema> = this.database,
  ): Promise<string> {
    const definition = accountingReferenceDefinitions.journal;
    return this.history.nextReferenceNumber(
      database,
      this.tenants.current().companyId,
      definition.referenceType,
      definition.prefix,
    );
  }

  public async nextOpeningBalanceNumber(
    database: Kysely<DatabaseSchema> = this.database,
  ): Promise<string> {
    const definition = accountingReferenceDefinitions.openingBalance;
    return this.history.nextReferenceNumber(
      database,
      this.tenants.current().companyId,
      definition.referenceType,
      definition.prefix,
    );
  }

  public async assertAccountHierarchyChange(
    accountId: string,
    proposedParentId: string,
  ): Promise<void> {
    const companyId = this.tenants.current().companyId;
    if (accountId === proposedParentId) {
      throw new ApplicationException(
        "accounting_account_hierarchy_cycle",
        "An Account cannot be its own parent",
        HttpStatus.CONFLICT,
      );
    }
    await this.transactions.execute(async (transaction) => {
      const locked = await sql<{ id: string }>`
        select id from chart_of_accounts
         where company_id = ${companyId}::uuid
           and id in (${accountId}::uuid, ${proposedParentId}::uuid)
         for update
      `.execute(transaction);
      if (!locked.rows.some((row) => row.id === proposedParentId)) {
        throw new ApplicationException(
          "accounting_parent_account_not_found",
          "The parent Account was not found in the active Company",
          HttpStatus.NOT_FOUND,
        );
      }
      if (!locked.rows.some((row) => row.id === accountId)) {
        throw new ApplicationException(
          "accounting_account_not_found",
          "The Account was not found in the active Company",
          HttpStatus.NOT_FOUND,
        );
      }
      const result = await sql<{ cycle: boolean }>`
        with recursive ancestors as (
          select a.id, a.parent_account_id
            from chart_of_accounts a
           where a.id = ${proposedParentId}::uuid
             and a.company_id = ${companyId}::uuid
          union all
          select a.id, a.parent_account_id
            from chart_of_accounts a
            join ancestors p on p.parent_account_id = a.id
           where a.company_id = ${companyId}::uuid
        )
        select exists(select 1 from ancestors where id = ${accountId}::uuid) as cycle
      `.execute(transaction);
      if (result.rows[0]?.cycle === true) {
        throw new ApplicationException(
          "accounting_account_hierarchy_cycle",
          "The Account parent change would create a hierarchy cycle",
          HttpStatus.CONFLICT,
        );
      }
    });
  }

  public async resolvePostingPeriod(accountingDate: string): Promise<PostingPeriodRecord> {
    const companyId = this.tenants.current().companyId;
    const result = await sql<PostingPeriodRecord>`
      select p.id as "fiscalPeriodId", p.status as "fiscalPeriodStatus",
             y.id as "fiscalYearId", y.status as "fiscalYearStatus"
        from accounting_periods p
        join fiscal_years y
          on y.id = p.fiscal_year_id and y.company_id = p.company_id
       where p.company_id = ${companyId}::uuid
         and ${accountingDate}::date between p.period_start and p.period_end
       limit 2
    `.execute(this.database);
    if (result.rows.length !== 1) {
      throw new ApplicationException(
        "accounting_fiscal_period_not_found",
        "The Accounting Date does not resolve to one Fiscal Period",
        HttpStatus.CONFLICT,
      );
    }
    const period = result.rows[0];
    if (period === undefined) {
      throw new ApplicationException(
        "accounting_fiscal_period_not_found",
        "The Accounting Date does not resolve to one Fiscal Period",
        HttpStatus.CONFLICT,
      );
    }
    assertPostingPeriodOpen(period);
    return period;
  }

  public async audit(input: {
    readonly action: string;
    readonly after: object;
    readonly correlationId: string;
    readonly subjectId: string;
    readonly subjectType: string;
  }): Promise<void> {
    await this.history.audit(this.database, {
      ...input,
      actorId: this.identities.current().identityId,
      companyId: this.tenants.current().companyId,
    });
  }
}
