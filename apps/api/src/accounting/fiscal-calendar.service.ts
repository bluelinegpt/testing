import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type {
  CreateFiscalPeriodDto,
  CreateFiscalYearDto,
  GenerateFiscalPeriodsDto,
} from "./accounting.dto.js";
import { mapAccountingDatabaseError } from "./accounting-error.mapper.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";

function rethrowAccounting(error: unknown): never {
  if (error instanceof ApplicationException) throw error;
  return mapAccountingDatabaseError(error);
}

@Injectable()
export class FiscalCalendarService {
  public constructor(
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(AccountingOperationSupport)
    private readonly support: AccountingOperationSupport,
  ) {}

  private async lockCalendarScope(
    database: Kysely<DatabaseSchema>,
    companyId: string,
  ): Promise<void> {
    await sql`
      select pg_advisory_xact_lock(
        hashtextextended('accounting_fiscal_calendar:' || ${companyId}::text, 0)
      )
    `.execute(database);
  }

  private async generatePeriodsInTransaction(
    transaction: Kysely<DatabaseSchema>,
    input: { fiscalYearId: string; periodCodePrefix?: string },
  ) {
    const { actorId, companyId } = this.support.context();
    const year = await sql<{ code: string; endDate: string; startDate: string }>`
      select fiscal_year_code as code, start_date::text as "startDate",
             end_date::text as "endDate"
        from fiscal_years
       where id=${input.fiscalYearId}::uuid and company_id=${companyId}::uuid
       for update
    `.execute(transaction);
    const record = year.rows[0];
    if (record === undefined) {
      throw new ApplicationException(
        "accounting_fiscal_year_not_found",
        "The Fiscal Year was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const existing = await sql<{ count: number }>`
      select count(*)::int as count from accounting_periods
       where fiscal_year_id=${input.fiscalYearId}::uuid and company_id=${companyId}::uuid
    `.execute(transaction);
    if ((existing.rows[0]?.count ?? 0) > 0) {
      throw new ApplicationException(
        "accounting_fiscal_period_overlap",
        "Fiscal Periods already exist for this Fiscal Year",
        HttpStatus.CONFLICT,
      );
    }
    const count = await sql<{ count: number }>`
      select count(*)::int as count
        from generate_series(
          ${record.startDate}::date, ${record.endDate}::date, interval '1 month'
        )
    `.execute(transaction);
    if ((count.rows[0]?.count ?? 0) > 12) {
      throw new ApplicationException(
        "accounting_fiscal_calendar_change_prohibited",
        "Automatic generation supports at most twelve normal Fiscal Periods",
        HttpStatus.BAD_REQUEST,
      );
    }
    const prefix = input.periodCodePrefix?.trim() || record.code;
    const result = await sql<Record<string, unknown>>`
      with generated as (
        select row_number() over (order by period_start)::int as period_number,
               period_start::date as period_start,
               least(
                 (period_start + interval '1 month - 1 day')::date,
                 ${record.endDate}::date
               ) as period_end
          from generate_series(
            ${record.startDate}::date, ${record.endDate}::date, interval '1 month'
          ) period_start
      )
      insert into accounting_periods (
        company_id, fiscal_year_id, period_number, period_code, name,
        period_start, period_end, status, is_adjustment_period,
        created_by_account_id
      )
      select ${companyId}::uuid, ${input.fiscalYearId}::uuid, period_number,
             ${prefix} || '-P' || lpad(period_number::text, 2, '0'),
             'Period ' || period_number::text, period_start, period_end,
             'future', false, ${actorId}::uuid
        from generated
      returning id, period_number as "periodNumber", period_code as "periodCode",
                name, period_start::text as "startDate", period_end::text as "endDate",
                status
    `.execute(transaction);
    return result.rows;
  }

  public async createFiscalYear(
    input: CreateFiscalYearDto,
    idempotencyKey: string | undefined,
  ) {
    this.support.assertPermission("accounting.periods.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.fiscal_year.create",
          payload: input,
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const { actorId, companyId } = this.support.context();
        await this.lockCalendarScope(transaction, companyId);
        const id = randomUUID();
        const result = await sql<Record<string, unknown>>`
          insert into fiscal_years (
            id, company_id, fiscal_year_code, name, start_date, end_date,
            status, created_by_account_id
          ) values (
            ${id}::uuid, ${companyId}::uuid, ${input.fiscalYearCode.trim()},
            ${input.name.trim()}, ${input.startDate}::date, ${input.endDate}::date,
            'draft', ${actorId}::uuid
          )
          returning id, fiscal_year_code as "fiscalYearCode", name,
                    start_date::text as "startDate", end_date::text as "endDate",
                    status, version::text as version
        `.execute(transaction);
        const periods = input.generatePeriods
          ? await this.generatePeriodsInTransaction(transaction, {
              fiscalYearId: id,
              ...(input.periodCodePrefix === undefined
                ? {}
                : { periodCodePrefix: input.periodCodePrefix }),
            })
          : [];
        const response = { ...result.rows[0], periods };
        await this.support.audit(transaction, {
          action: "accounting.fiscal_year.created",
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: id,
          subjectType: "fiscal_year",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation: "accounting.fiscal_year.create",
          resourceId: id,
          resourceType: "fiscal_year",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async createFiscalPeriod(
    input: CreateFiscalPeriodDto,
    idempotencyKey: string | undefined,
  ) {
    this.support.assertPermission("accounting.periods.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.fiscal_period.create",
          payload: input,
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const { actorId, companyId } = this.support.context();
        await sql`select id from fiscal_years where id=${input.fiscalYearId}::uuid
                    and company_id=${companyId}::uuid for update`.execute(transaction);
        const id = randomUUID();
        const result = await sql<Record<string, unknown>>`
          insert into accounting_periods (
            id, company_id, fiscal_year_id, period_number, period_code, name,
            period_start, period_end, status, is_adjustment_period,
            created_by_account_id
          ) values (
            ${id}::uuid, ${companyId}::uuid, ${input.fiscalYearId}::uuid,
            ${input.periodNumber}, ${input.periodCode.trim()}, ${input.name.trim()},
            ${input.startDate}::date, ${input.endDate}::date, 'future',
            ${input.isAdjustmentPeriod ?? false}, ${actorId}::uuid
          )
          returning id, fiscal_year_id as "fiscalYearId", period_number as "periodNumber",
                    period_code as "periodCode", name, period_start::text as "startDate",
                    period_end::text as "endDate", status, version::text as version
        `.execute(transaction);
        const response = result.rows[0]!;
        await this.support.audit(transaction, {
          action: "accounting.fiscal_period.created",
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: id,
          subjectType: "fiscal_period",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation: "accounting.fiscal_period.create",
          resourceId: id,
          resourceType: "fiscal_period",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async generateFiscalPeriods(
    input: GenerateFiscalPeriodsDto,
    idempotencyKey: string | undefined,
  ) {
    this.support.assertPermission("accounting.periods.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.fiscal_period.generate",
          payload: input,
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const rows = await this.generatePeriodsInTransaction(transaction, input);
        const response = { fiscalYearId: input.fiscalYearId, periods: rows };
        await this.support.audit(transaction, {
          action: "accounting.fiscal_periods.generated",
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: input.fiscalYearId,
          subjectType: "fiscal_year",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation: "accounting.fiscal_period.generate",
          resourceId: input.fiscalYearId,
          resourceType: "fiscal_year",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async periodDependencies(periodId: string, database?: Kysely<DatabaseSchema>) {
    const { companyId } = this.support.context();
    const work = async (db: Kysely<DatabaseSchema>) => {
      const result = await sql<Record<string, string | number>>`
        select p.id, p.status, p.fiscal_year_id as "fiscalYearId",
          count(j.id) filter (where j.status='draft')::int as "draftJournals",
          count(j.id) filter (where j.status='balanced')::int as "balancedJournals",
          count(j.id) filter (where j.status='approved')::int as "approvedJournals",
          count(j.id) filter (where j.status='posted')::int as "postedJournals",
          count(j.id) filter (where j.journal_type='reversal'
            and j.status <> 'posted')::int as "unpostedReversalJournals",
          (select count(*)::int from opening_balance_batches b
            where b.company_id=p.company_id and b.accounting_period_id=p.id
              and b.status='draft') as "draftOpeningBalances",
          (select count(*)::int from opening_balance_batches b
            where b.company_id=p.company_id and b.accounting_period_id=p.id
              and b.status='validated') as "validatedOpeningBalances",
          (select count(*)::int from opening_balance_batches b
            where b.company_id=p.company_id and b.accounting_period_id=p.id
              and b.status='approved') as "approvedOpeningBalances",
          (select count(*)::int from opening_balance_batches b
            where b.company_id=p.company_id and b.accounting_period_id=p.id
              and b.status='posted') as "postedOpeningBalances"
        from accounting_periods p
        left join journal_entries j on j.accounting_period_id=p.id and j.company_id=p.company_id
       where p.id=${periodId}::uuid and p.company_id=${companyId}::uuid
       group by p.id
      `.execute(db);
      const row = result.rows[0];
      if (row === undefined) {
        throw new ApplicationException(
          "accounting_fiscal_period_not_found",
          "The Fiscal Period was not found",
          HttpStatus.NOT_FOUND,
        );
      }
      const closeBlocking = [
        ["draft_journals", Number(row.draftJournals)],
        ["balanced_journals", Number(row.balancedJournals)],
        ["approved_journals", Number(row.approvedJournals)],
        ["unposted_reversals", Number(row.unpostedReversalJournals)],
        ["draft_opening_balances", Number(row.draftOpeningBalances)],
        ["validated_opening_balances", Number(row.validatedOpeningBalances)],
        ["approved_opening_balances", Number(row.approvedOpeningBalances)],
      ].filter(([, count]) => Number(count) > 0).map(([code, count]) => ({ code, count }));
      return {
        ...row,
        activePostingOperations: 0,
        blockingIssues: closeBlocking,
        canClose: closeBlocking.length === 0,
        canReopen: ["closed","soft_closed"].includes(String(row.status)),
        canSoftClose: ["open","reopened"].includes(String(row.status)),
        warnings: [],
      };
    };
    if (database !== undefined) return work(database);
    return this.transactions.execute(work);
  }

  public async yearDependencies(fiscalYearId: string, database?: Kysely<DatabaseSchema>) {
    const { companyId } = this.support.context();
    const work = async (db: Kysely<DatabaseSchema>) => {
      const result = await sql<Record<string, string | number>>`
        select y.id, y.status, y.start_date::text as "startDate", y.end_date::text as "endDate",
          count(distinct p.id)::int as "totalPeriods",
          count(distinct p.id) filter (where p.status='future')::int as "futurePeriods",
          count(distinct p.id) filter (where p.status='open')::int as "openPeriods",
          count(distinct p.id) filter (where p.status='reopened')::int as "reopenedPeriods",
          count(distinct p.id) filter (where p.status='soft_closed')::int as "softClosedPeriods",
          count(distinct p.id) filter (where p.status='closed')::int as "closedPeriods",
          count(distinct j.id) filter (where j.status='draft')::int as "draftJournals",
          count(distinct j.id) filter (where j.status='balanced')::int as "balancedJournals",
          count(distinct j.id) filter (where j.status='approved')::int as "approvedJournals",
          count(distinct j.id) filter (where j.status='posted')::int as "postedJournals",
          (select count(*)::int from opening_balance_batches b
            where b.company_id=y.company_id and b.fiscal_year_id=y.id
              and b.status in ('draft','validated','approved')) as "incompleteOpeningBalances",
          (select count(*)::int from opening_balance_batches b
            where b.company_id=y.company_id and b.fiscal_year_id=y.id
              and b.status='posted') as "postedOpeningBalances",
          (select count(*)::int from opening_balance_batches b
            where b.company_id=y.company_id and b.fiscal_year_id=y.id
              and b.status='reversed') as "reversedOpeningBalances"
        from fiscal_years y
        left join accounting_periods p on p.fiscal_year_id=y.id and p.company_id=y.company_id
        left join journal_entries j on j.fiscal_year_id=y.id and j.company_id=y.company_id
       where y.id=${fiscalYearId}::uuid and y.company_id=${companyId}::uuid
       group by y.id
      `.execute(db);
      const row = result.rows[0];
      if (row === undefined) {
        throw new ApplicationException(
          "accounting_fiscal_year_not_found",
          "The Fiscal Year was not found",
          HttpStatus.NOT_FOUND,
        );
      }
      const blockingIssues: { code: string; count: number }[] = [];
      if (Number(row.totalPeriods) === 0) blockingIssues.push({ code: "no_periods", count: 1 });
      if (Number(row.closedPeriods) !== Number(row.totalPeriods)) {
        blockingIssues.push({
          code: "periods_not_closed",
          count: Number(row.totalPeriods) - Number(row.closedPeriods),
        });
      }
      for (const [code, value] of [
        ["draft_journals", row.draftJournals],
        ["balanced_journals", row.balancedJournals],
        ["approved_journals", row.approvedJournals],
        ["incomplete_opening_balances", row.incompleteOpeningBalances],
      ] as const) {
        if (Number(value) > 0) blockingIssues.push({ code, count: Number(value) });
      }
      return {
        ...row,
        activePostingOperations: 0,
        blockingIssues,
        canClose: blockingIssues.length === 0,
        canOpen: String(row.status) === "draft" && Number(row.totalPeriods) > 0,
        canReopen: String(row.status) === "closed",
        warnings: ["Closing creates no financial or Retained Earnings Journal"],
      };
    };
    if (database !== undefined) return work(database);
    return this.transactions.execute(work);
  }

  public async transitionPeriod(
    periodId: string,
    target: "closed" | "open" | "reopened" | "soft_closed",
    reason: string | undefined,
    idempotencyKey: string | undefined,
  ) {
    this.support.assertPermission("accounting.periods.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const operation = `accounting.fiscal_period.${target}`;
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation,
          payload: { periodId, reason, target },
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const { actorId, companyId } = this.support.context();
        const locked = await sql<{ status: string; fiscalYearStatus: string }>`
          select p.status, y.status as "fiscalYearStatus"
            from accounting_periods p join fiscal_years y
              on y.id=p.fiscal_year_id and y.company_id=p.company_id
           where p.id=${periodId}::uuid and p.company_id=${companyId}::uuid
           for update of y, p
        `.execute(transaction);
        const current = locked.rows[0];
        if (current === undefined) {
          throw new ApplicationException(
            "accounting_fiscal_period_not_found",
            "The Fiscal Period was not found",
            HttpStatus.NOT_FOUND,
          );
        }
        if (target === "reopened" && !reason?.trim()) {
          throw new ApplicationException(
            "accounting_fiscal_period_reopen_reason_required",
            "A reason is required to reopen a Fiscal Period",
            HttpStatus.BAD_REQUEST,
          );
        }
        const allowedPeriodOrigins: Record<string, readonly string[]> = {
          closed: ["open", "reopened", "soft_closed"],
          open: ["future"],
          reopened: ["closed", "soft_closed"],
          soft_closed: ["open", "reopened"],
        };
        if (!allowedPeriodOrigins[target]!.includes(current.status)) {
          throw new ApplicationException(
            "accounting_fiscal_period_invalid_transition",
            `Fiscal Period cannot transition from ${current.status} to ${target}`,
            HttpStatus.CONFLICT,
          );
        }
        if (["open","reopened"].includes(target)
            && !["open","reopened"].includes(current.fiscalYearStatus)) {
          throw new ApplicationException(
            "accounting_fiscal_year_closed",
            "The Fiscal Year is not open",
            HttpStatus.CONFLICT,
          );
        }
        if (target === "closed" || target === "soft_closed") {
          const dependencies = await this.periodDependencies(periodId, transaction);
          if (target === "closed" && !dependencies.canClose) {
            throw new ApplicationException(
              "accounting_fiscal_period_close_blocked",
              "Fiscal Period closing is blocked by incomplete Accounting records",
              HttpStatus.CONFLICT,
              dependencies.blockingIssues.map((issue) => String(issue.code)),
            );
          }
          if (target === "soft_closed" && !dependencies.canSoftClose) {
            throw new ApplicationException(
              "accounting_fiscal_period_soft_close_blocked",
              "The Fiscal Period cannot be soft-closed from its current status",
              HttpStatus.CONFLICT,
            );
          }
        }
        const result = await sql<Record<string, unknown>>`
          update accounting_periods
             set status=${target}, version=version+1,
                 opened_by_account_id=case when ${target}='open' then ${actorId}::uuid else opened_by_account_id end,
                 opened_at=case when ${target}='open' then now() else opened_at end,
                 closed_by_account_id=case when ${target} in ('closed','soft_closed') then ${actorId}::uuid else closed_by_account_id end,
                 closed_at=case when ${target} in ('closed','soft_closed') then now() else closed_at end,
                 close_reason=case when ${target} in ('closed','soft_closed') then ${reason ?? null} else close_reason end,
                 reopened_by_account_id=case when ${target}='reopened' then ${actorId}::uuid else reopened_by_account_id end,
                 reopened_at=case when ${target}='reopened' then now() else reopened_at end,
                 reopen_reason=case when ${target}='reopened' then ${reason ?? null} else reopen_reason end
           where id=${periodId}::uuid and company_id=${companyId}::uuid
           returning id, status, version::text as version
        `.execute(transaction);
        const response = result.rows[0]!;
        await this.support.audit(transaction, {
          action: `accounting.fiscal_period.${target}`,
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: periodId,
          subjectType: "fiscal_period",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation,
          resourceId: periodId,
          resourceType: "fiscal_period",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async transitionFiscalYear(
    fiscalYearId: string,
    target: "closed" | "open" | "reopened",
    reason: string | undefined,
    idempotencyKey: string | undefined,
  ) {
    this.support.assertPermission("accounting.periods.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const operation = `accounting.fiscal_year.${target}`;
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation,
          payload: { fiscalYearId, reason, target },
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const { actorId, companyId } = this.support.context();
        const locked = await sql<{ status: string }>`
          select status from fiscal_years
           where id=${fiscalYearId}::uuid and company_id=${companyId}::uuid for update
        `.execute(transaction);
        const current = locked.rows[0];
        if (current === undefined) {
          throw new ApplicationException(
            "accounting_fiscal_year_not_found",
            "The Fiscal Year was not found",
            HttpStatus.NOT_FOUND,
          );
        }
        await sql`select id from accounting_periods
                   where fiscal_year_id=${fiscalYearId}::uuid and company_id=${companyId}::uuid
                   order by period_start for update`.execute(transaction);
        if (target === "reopened" && !reason?.trim()) {
          throw new ApplicationException(
            "accounting_fiscal_year_reopen_reason_required",
            "A reason is required to reopen a Fiscal Year",
            HttpStatus.BAD_REQUEST,
          );
        }
        const allowedYearOrigins: Record<string, readonly string[]> = {
          closed: ["open", "reopened"],
          open: ["draft"],
          reopened: ["closed"],
        };
        if (!allowedYearOrigins[target]!.includes(current.status)) {
          throw new ApplicationException(
            "accounting_fiscal_year_invalid_transition",
            `Fiscal Year cannot transition from ${current.status} to ${target}`,
            HttpStatus.CONFLICT,
          );
        }
        const dependencies = await this.yearDependencies(fiscalYearId, transaction);
        if (target === "open" && !dependencies.canOpen) {
          throw new ApplicationException(
            "accounting_fiscal_year_invalid_transition",
            "The Fiscal Year is not ready to open",
            HttpStatus.CONFLICT,
          );
        }
        if (target === "closed" && !dependencies.canClose) {
          throw new ApplicationException(
            "accounting_fiscal_year_close_blocked",
            "Fiscal Year closing is blocked by incomplete Accounting records",
            HttpStatus.CONFLICT,
            dependencies.blockingIssues.map((issue) => issue.code),
          );
        }
        if (target === "reopened" && !dependencies.canReopen) {
          throw new ApplicationException(
            "accounting_fiscal_year_invalid_transition",
            "The Fiscal Year cannot be reopened from its current status",
            HttpStatus.CONFLICT,
          );
        }
        const result = await sql<Record<string, unknown>>`
          update fiscal_years
             set status=${target}, version=version+1,
                 opened_by_account_id=case when ${target}='open' then ${actorId}::uuid else opened_by_account_id end,
                 opened_at=case when ${target}='open' then now() else opened_at end,
                 closed_by_account_id=case when ${target}='closed' then ${actorId}::uuid else closed_by_account_id end,
                 closed_at=case when ${target}='closed' then now() else closed_at end,
                 close_reason=case when ${target}='closed' then ${reason ?? null} else close_reason end,
                 reopened_by_account_id=case when ${target}='reopened' then ${actorId}::uuid else reopened_by_account_id end,
                 reopened_at=case when ${target}='reopened' then now() else reopened_at end,
                 reopen_reason=case when ${target}='reopened' then ${reason ?? null} else reopen_reason end
           where id=${fiscalYearId}::uuid and company_id=${companyId}::uuid
           returning id, status, version::text as version
        `.execute(transaction);
        const response = result.rows[0]!;
        await this.support.audit(transaction, {
          action: `accounting.fiscal_year.${target}`,
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: fiscalYearId,
          subjectType: "fiscal_year",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation,
          resourceId: fiscalYearId,
          resourceType: "fiscal_year",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }
}
