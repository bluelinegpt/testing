import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type {
  CreateOpeningBalanceDto,
  OpeningBalanceLineDto,
  OpeningBalanceListQueryDto,
  ReverseOpeningBalanceDto,
  UpdateOpeningBalanceDto,
} from "./accounting.dto.js";
import { mapAccountingDatabaseError } from "./accounting-error.mapper.js";
import { AccountingFoundationService } from "./accounting-foundation.service.js";
import { assertJournalLineAmounts } from "./accounting.guards.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";

interface BatchRecord {
  readonly approvedBy: string | null;
  readonly createdBy: string;
  readonly description: string;
  readonly effectiveDate: string;
  readonly fiscalPeriodId: string;
  readonly fiscalYearId: string;
  readonly id: string;
  readonly journalId: string | null;
  readonly reversalJournalId: string | null;
  readonly status: string;
}

interface PeriodRecord {
  readonly fiscalPeriodId: string;
  readonly fiscalYearId: string;
}

function rethrowAccounting(error: unknown): never {
  if (error instanceof ApplicationException) throw error;
  return mapAccountingDatabaseError(error);
}

@Injectable()
export class OpeningBalanceService {
  public constructor(
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(AccountingOperationSupport)
    private readonly support: AccountingOperationSupport,
    @Inject(AccountingFoundationService)
    private readonly foundation: AccountingFoundationService,
  ) {}

  private async lockPeriod(
    database: Kysely<DatabaseSchema>,
    date: string,
    requireOpen: boolean,
  ): Promise<PeriodRecord> {
    const { companyId } = this.support.context();
    const result = await sql<PeriodRecord>`
      select p.id as "fiscalPeriodId", y.id as "fiscalYearId"
        from fiscal_years y
        join accounting_periods p
          on p.fiscal_year_id=y.id and p.company_id=y.company_id
       where y.company_id=${companyId}::uuid
         and ${date}::date between p.period_start and p.period_end
         ${requireOpen ? sql`and y.status in ('open','reopened')
                         and p.status in ('open','reopened')` : sql``}
       for update of y, p
    `.execute(database);
    if (result.rows.length !== 1) {
      throw new ApplicationException(
        requireOpen
          ? "accounting_opening_balance_posting_period_closed"
          : "accounting_fiscal_period_not_found",
        requireOpen
          ? "The Opening Balance date is not in an Open Fiscal Period"
          : "The Opening Balance date does not belong to a Fiscal Period",
        HttpStatus.CONFLICT,
      );
    }
    return result.rows[0]!;
  }

  private async lockBatch(
    database: Kysely<DatabaseSchema>,
    batchId: string,
  ): Promise<BatchRecord> {
    const { companyId } = this.support.context();
    const result = await sql<BatchRecord>`
      select id, status, effective_date::text as "effectiveDate",
             fiscal_year_id as "fiscalYearId", accounting_period_id as "fiscalPeriodId",
             description, journal_id as "journalId",
             reversal_journal_id as "reversalJournalId",
             created_by_account_id as "createdBy",
             approved_by_account_id as "approvedBy"
        from opening_balance_batches
       where id=${batchId}::uuid and company_id=${companyId}::uuid for update
    `.execute(database);
    if (result.rows[0] === undefined) {
      throw new ApplicationException(
        "accounting_opening_balance_not_found",
        "The Opening Balance Batch was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return result.rows[0];
  }

  private validateLines(lines: readonly OpeningBalanceLineDto[]): void {
    const numbers = new Set<number>();
    for (const line of lines) {
      assertJournalLineAmounts(line.debit, line.credit);
      if (numbers.has(line.lineNumber)) {
        throw new ApplicationException(
          "accounting_opening_balance_duplicate_line_number",
          "Opening Balance Line numbers must be unique",
          HttpStatus.BAD_REQUEST,
        );
      }
      numbers.add(line.lineNumber);
    }
  }

  private totals(lines: readonly OpeningBalanceLineDto[]) {
    const debit = lines.reduce((sum, line) => sum.plus(line.debit), new Decimal(0));
    const credit = lines.reduce((sum, line) => sum.plus(line.credit), new Decimal(0));
    const difference = debit.minus(credit);
    return {
      balanced: lines.length >= 2 && debit.gt(0) && debit.eq(credit),
      difference: difference.toFixed(2),
      totalCredit: credit.toFixed(2),
      totalDebit: debit.toFixed(2),
    };
  }

  private async validateAccounts(
    database: Kysely<DatabaseSchema>,
    lines: readonly OpeningBalanceLineDto[],
  ): Promise<void> {
    if (lines.length === 0) return;
    const { companyId } = this.support.context();
    const ids = [...new Set(lines.map((line) => line.accountId))];
    const accounts = await sql<{
      controlType: string | null;
      id: string;
      isActive: boolean;
      isControl: boolean;
      isPosting: boolean;
    }>`
      select id, is_active as "isActive", is_posting_account as "isPosting",
             is_control_account as "isControl", control_account_type as "controlType"
        from chart_of_accounts
       where company_id=${companyId}::uuid and id=any(${ids}::uuid[])
       for share
    `.execute(database);
    const byId = new Map(accounts.rows.map((account) => [account.id, account]));
    for (const line of lines) {
      const account = byId.get(line.accountId);
      if (account === undefined || !account.isActive || !account.isPosting) {
        throw new ApplicationException(
          "accounting_opening_balance_account_unavailable",
          `Opening Balance Line ${line.lineNumber} uses an unavailable Account`,
          HttpStatus.CONFLICT,
        );
      }
      if (account.isControl) {
        const valid =
          account.controlType === "trader_payable" ? line.traderId !== undefined
          : account.controlType === "driver_payable" ? line.driverId !== undefined
          : account.controlType === "payroll_payable"
            ? line.employeeId !== undefined || line.subledgerId !== undefined
          : account.controlType === "accounts_receivable" || account.controlType === "vat"
            ? line.traderId !== undefined || line.subledgerId !== undefined
          : line.subledgerId !== undefined;
        if (!valid) {
          throw new ApplicationException(
            "accounting_opening_balance_control_account_invalid",
            `Opening Balance Line ${line.lineNumber} requires valid subledger context`,
            HttpStatus.BAD_REQUEST,
          );
        }
      }
    }
  }

  private async readLines(database: Kysely<DatabaseSchema>, batchId: string) {
    const { companyId } = this.support.context();
    const result = await sql<Record<string, string | null>>`
      select id, line_number::text as "lineNumber", account_id as "accountId",
             debit::text as debit, credit::text as credit, description,
             account_code_snapshot as "accountCodeSnapshot",
             account_name_en_snapshot as "accountNameEnSnapshot",
             account_name_ar_snapshot as "accountNameArSnapshot",
             subledger_type as "subledgerType", subledger_id as "subledgerId",
             trader_id as "traderId", driver_id as "driverId", employee_id as "employeeId"
        from opening_balance_lines
       where opening_balance_batch_id=${batchId}::uuid and company_id=${companyId}::uuid
       order by line_number for share
    `.execute(database);
    return result.rows;
  }

  private toDtos(rows: readonly Record<string, string | null>[]): OpeningBalanceLineDto[] {
    return rows.map((row) => ({
      accountId: row.accountId!,
      credit: Number(row.credit),
      debit: Number(row.debit),
      lineNumber: Number(row.lineNumber),
      ...(row.description === null ? {} : { description: row.description }),
      ...(row.subledgerType === null ? {} : { subledgerType: row.subledgerType }),
      ...(row.subledgerId === null ? {} : { subledgerId: row.subledgerId }),
      ...(row.traderId === null ? {} : { traderId: row.traderId }),
      ...(row.driverId === null ? {} : { driverId: row.driverId }),
      ...(row.employeeId === null ? {} : { employeeId: row.employeeId }),
    }));
  }

  private async insertLines(
    database: Kysely<DatabaseSchema>,
    batchId: string,
    lines: readonly OpeningBalanceLineDto[],
  ): Promise<void> {
    const { actorId, companyId } = this.support.context();
    for (const line of lines) {
      await sql`
        insert into opening_balance_lines (
          id, company_id, opening_balance_batch_id, line_number, account_id,
          debit, credit, description, subledger_type, subledger_id,
          trader_id, driver_id, employee_id, created_by_account_id, updated_by_account_id
        ) values (
          ${randomUUID()}::uuid, ${companyId}::uuid, ${batchId}::uuid,
          ${line.lineNumber}, ${line.accountId}::uuid, ${line.debit}, ${line.credit},
          ${line.description ?? null}, ${line.subledgerType ?? null},
          ${line.subledgerId ?? null}::uuid, ${line.traderId ?? null}::uuid,
          ${line.driverId ?? null}::uuid, ${line.employeeId ?? null}::uuid,
          ${actorId}::uuid, ${actorId}::uuid
        )
      `.execute(database);
    }
  }

  private async makeEditable(
    database: Kysely<DatabaseSchema>,
    batch: BatchRecord,
  ): Promise<void> {
    if (batch.status === "validated") {
      const { actorId, companyId } = this.support.context();
      await sql`
        update opening_balance_batches
           set status='draft', updated_by_account_id=${actorId}::uuid,
               updated_at=now(), version=version+1
         where id=${batch.id}::uuid and company_id=${companyId}::uuid
      `.execute(database);
      return;
    }
    if (batch.status !== "draft") {
      throw new ApplicationException(
        "accounting_opening_balance_not_editable",
        "Only Draft or Validated Opening Balance Batches can be edited",
        HttpStatus.CONFLICT,
      );
    }
  }

  public async create(input: CreateOpeningBalanceDto, idempotencyKey: string | undefined) {
    this.support.assertPermission("accounting.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const operation = "accounting.opening_balance.create";
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation,
          payload: input,
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const period = await this.lockPeriod(transaction, input.effectiveDate, false);
        const lines = input.lines ?? [];
        this.validateLines(lines);
        await this.validateAccounts(transaction, lines);
        const { actorId, companyId } = this.support.context();
        const id = randomUUID();
        const batchNumber = await this.foundation.nextOpeningBalanceNumber(transaction);
        await sql`
          insert into opening_balance_batches (
            id, company_id, batch_number, effective_date, fiscal_year_id,
            accounting_period_id, description, currency, status, notes,
            created_by_account_id, updated_by_account_id
          ) values (
            ${id}::uuid, ${companyId}::uuid, ${batchNumber},
            ${input.effectiveDate}::date, ${period.fiscalYearId}::uuid,
            ${period.fiscalPeriodId}::uuid, ${input.description.trim()}, 'AED', 'draft',
            ${input.notes ?? null}, ${actorId}::uuid, ${actorId}::uuid
          )
        `.execute(transaction);
        await this.insertLines(transaction, id, lines);
        const calculated = this.totals(lines);
        if (calculated.balanced) {
          await sql`
            update opening_balance_batches
               set status='validated', validated_by_account_id=${actorId}::uuid,
                   validated_at=now(), version=version+1
             where id=${id}::uuid and company_id=${companyId}::uuid
          `.execute(transaction);
        }
        const response = {
          batchNumber,
          effectiveDate: input.effectiveDate,
          id,
          status: calculated.balanced ? "validated" : "draft",
          ...calculated,
        };
        await this.support.audit(transaction, {
          action: "accounting.opening_balance.created",
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: id,
          subjectType: "opening_balance",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation,
          resourceId: id,
          resourceType: "opening_balance",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async updateHeader(
    batchId: string,
    input: UpdateOpeningBalanceDto,
    idempotencyKey: string | undefined,
  ) {
    this.support.assertPermission("accounting.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const operation = "accounting.opening_balance.update";
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation,
          payload: { batchId, ...input },
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const batch = await this.lockBatch(transaction, batchId);
        await this.makeEditable(transaction, batch);
        const date = input.effectiveDate ?? batch.effectiveDate;
        const period = await this.lockPeriod(transaction, date, false);
        const { actorId, companyId } = this.support.context();
        const payload = JSON.stringify(input);
        const result = await sql<Record<string, unknown>>`
          update opening_balance_batches b
             set effective_date=${date}::date, fiscal_year_id=${period.fiscalYearId}::uuid,
                 accounting_period_id=${period.fiscalPeriodId}::uuid,
                 description=coalesce(${payload}::jsonb->>'description', b.description),
                 notes=case when ${payload}::jsonb ? 'notes'
                   then ${payload}::jsonb->>'notes' else b.notes end,
                 updated_by_account_id=${actorId}::uuid, updated_at=now(), version=b.version+1
           where b.id=${batchId}::uuid and b.company_id=${companyId}::uuid
           returning id, batch_number as "batchNumber", effective_date::text as "effectiveDate",
                     description, status, version::text as version
        `.execute(transaction);
        const response = result.rows[0]!;
        await this.support.audit(transaction, {
          action: "accounting.opening_balance.updated",
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: batchId,
          subjectType: "opening_balance",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation,
          resourceId: batchId,
          resourceType: "opening_balance",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async replaceLines(
    batchId: string,
    lines: readonly OpeningBalanceLineDto[],
    idempotencyKey: string | undefined,
  ) {
    return this.mutateLines(batchId, "replace", idempotencyKey, () => [...lines], { lines });
  }

  public async addLine(
    batchId: string,
    line: OpeningBalanceLineDto,
    idempotencyKey: string | undefined,
  ) {
    return this.mutateLines(batchId, "add", idempotencyKey, (lines) => [...lines, line], { line });
  }

  public async updateLine(
    batchId: string,
    lineId: string,
    line: OpeningBalanceLineDto,
    idempotencyKey: string | undefined,
  ) {
    return this.mutateLines(
      batchId,
      "update",
      idempotencyKey,
      (lines, ids) => {
        const index = ids.indexOf(lineId);
        if (index < 0) this.lineNotFound();
        return lines.map((item, current) => current === index ? line : item);
      },
      { line, lineId },
    );
  }

  public async removeLine(
    batchId: string,
    lineId: string,
    idempotencyKey: string | undefined,
  ) {
    return this.mutateLines(
      batchId,
      "remove",
      idempotencyKey,
      (lines, ids) => {
        const index = ids.indexOf(lineId);
        if (index < 0) this.lineNotFound();
        return lines.filter((_item, current) => current !== index);
      },
      { lineId },
    );
  }

  private lineNotFound(): never {
    throw new ApplicationException(
      "accounting_opening_balance_line_not_found",
      "The Opening Balance Line was not found",
      HttpStatus.NOT_FOUND,
    );
  }

  private async mutateLines(
    batchId: string,
    action: "add" | "remove" | "replace" | "update",
    idempotencyKey: string | undefined,
    mutation: (
      lines: OpeningBalanceLineDto[],
      lineIds: string[],
    ) => OpeningBalanceLineDto[],
    payload: Record<string, unknown>,
  ) {
    this.support.assertPermission("accounting.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const operation = `accounting.opening_balance.lines.${action}`;
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation,
          payload: { batchId, ...payload },
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const batch = await this.lockBatch(transaction, batchId);
        await this.makeEditable(transaction, batch);
        const raw = await this.readLines(transaction, batchId);
        const lines = mutation(this.toDtos(raw), raw.map((line) => line.id!));
        this.validateLines(lines);
        await this.validateAccounts(transaction, lines);
        const { actorId, companyId } = this.support.context();
        await sql`
          delete from opening_balance_lines
           where opening_balance_batch_id=${batchId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        await this.insertLines(transaction, batchId, lines);
        const calculated = this.totals(lines);
        await sql`
          update opening_balance_batches
             set status=${calculated.balanced ? "validated" : "draft"},
                 validated_by_account_id=${calculated.balanced ? actorId : null}::uuid,
                 validated_at=${calculated.balanced ? sql`now()` : sql`null`},
                 updated_by_account_id=${actorId}::uuid, updated_at=now(), version=version+1
           where id=${batchId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        const response = {
          id: batchId,
          status: calculated.balanced ? "validated" : "draft",
          ...calculated,
        };
        await this.support.audit(transaction, {
          action: `accounting.opening_balance.lines_${action}`,
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: batchId,
          subjectType: "opening_balance",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation,
          resourceId: batchId,
          resourceType: "opening_balance",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async validate(batchId: string) {
    this.support.assertPermission("accounting.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const preview = await sql<{ effectiveDate: string }>`
          select effective_date::text as "effectiveDate"
            from opening_balance_batches
           where id=${batchId}::uuid and company_id=${this.support.context().companyId}::uuid
        `.execute(transaction);
        if (preview.rows[0] === undefined) {
          throw new ApplicationException(
            "accounting_opening_balance_not_found",
            "The Opening Balance Batch was not found",
            HttpStatus.NOT_FOUND,
          );
        }
        await this.lockPeriod(transaction, preview.rows[0].effectiveDate, true);
        const batch = await this.lockBatch(transaction, batchId);
        if (batch.effectiveDate !== preview.rows[0].effectiveDate) {
          throw new ApplicationException(
            "accounting_concurrent_modification",
            "The Opening Balance Batch changed during validation",
            HttpStatus.CONFLICT,
          );
        }
        if (!["draft","validated"].includes(batch.status)) {
          throw new ApplicationException(
            "accounting_opening_balance_not_editable",
            "Only Draft or Validated Opening Balance Batches can be validated",
            HttpStatus.CONFLICT,
          );
        }
        const lines = this.toDtos(await this.readLines(transaction, batchId));
        this.validateLines(lines);
        await this.validateAccounts(transaction, lines);
        const calculated = this.totals(lines);
        const { actorId, companyId } = this.support.context();
        if (!calculated.balanced) {
          if (batch.status === "validated") {
            await sql`
              update opening_balance_batches
                 set status='draft', validated_by_account_id=null, validated_at=null,
                     updated_by_account_id=${actorId}::uuid, updated_at=now(), version=version+1
               where id=${batchId}::uuid and company_id=${companyId}::uuid
            `.execute(transaction);
          }
          return { id: batchId, lineErrors: [], status: "draft", valid: false, ...calculated };
        }
        await sql`
          update opening_balance_batches
             set status='validated', validated_by_account_id=${actorId}::uuid,
                 validated_at=now(), updated_by_account_id=${actorId}::uuid,
                 updated_at=now(), version=version+1
           where id=${batchId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        const response = {
          id: batchId,
          lineErrors: [],
          status: "validated",
          valid: true,
          ...calculated,
        };
        await this.support.audit(transaction, {
          action: "accounting.opening_balance.validated",
          after: response,
          correlationId: randomUUID(),
          subjectId: batchId,
          subjectType: "opening_balance",
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async approve(
    batchId: string,
    note: string | undefined,
    idempotencyKey: string | undefined,
  ) {
    this.support.assertPermission("accounting.approve");
    return this.transition(batchId, "approved", note, idempotencyKey);
  }

  public async post(
    batchId: string,
    note: string | undefined,
    idempotencyKey: string | undefined,
  ) {
    this.support.assertPermission("accounting.post");
    return this.transition(batchId, "posted", note, idempotencyKey);
  }

  private async transition(
    batchId: string,
    target: "approved" | "posted",
    note: string | undefined,
    idempotencyKey: string | undefined,
  ) {
    try {
      return await this.transactions.execute(async (transaction) => {
        const operation = `accounting.opening_balance.${target}`;
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation,
          payload: { batchId, note, target },
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const preview = await sql<{ effectiveDate: string }>`
          select effective_date::text as "effectiveDate"
            from opening_balance_batches
           where id=${batchId}::uuid and company_id=${this.support.context().companyId}::uuid
        `.execute(transaction);
        if (preview.rows[0] === undefined) {
          throw new ApplicationException(
            "accounting_opening_balance_not_found",
            "The Opening Balance Batch was not found",
            HttpStatus.NOT_FOUND,
          );
        }
        const period = await this.lockPeriod(transaction, preview.rows[0].effectiveDate, true);
        const batch = await this.lockBatch(transaction, batchId);
        if (batch.effectiveDate !== preview.rows[0].effectiveDate) {
          throw new ApplicationException(
            "accounting_concurrent_modification",
            "The Opening Balance Batch changed during the operation",
            HttpStatus.CONFLICT,
          );
        }
        if (target === "approved" && batch.status !== "validated") {
          throw new ApplicationException(
            "accounting_opening_balance_not_validated",
            "Only a Validated Opening Balance Batch can be approved",
            HttpStatus.CONFLICT,
          );
        }
        if (target === "posted" && batch.status !== "approved") {
          throw new ApplicationException(
            batch.status === "posted"
              ? "accounting_opening_balance_already_posted"
              : "accounting_opening_balance_not_approved",
            "Only an Approved Opening Balance Batch can be posted",
            HttpStatus.CONFLICT,
          );
        }
        const lines = this.toDtos(await this.readLines(transaction, batchId));
        this.validateLines(lines);
        await this.validateAccounts(transaction, lines);
        const calculated = this.totals(lines);
        if (!calculated.balanced) {
          throw new ApplicationException(
            "accounting_opening_balance_not_balanced",
            "Opening Balance Debit and Credit totals are not balanced",
            HttpStatus.CONFLICT,
          );
        }
        const { actorId, companyId } = this.support.context();
        if (target === "approved") {
          await this.support.enforceApprovalSegregation(transaction, batch.createdBy);
          const result = await sql<Record<string, unknown>>`
            update opening_balance_batches
               set status='approved', approved_by_account_id=${actorId}::uuid,
                   approved_at=now(), approval_note=${note ?? null}, version=version+1
             where id=${batchId}::uuid and company_id=${companyId}::uuid
             returning id, batch_number as "batchNumber", status,
                       total_debit::text as "totalDebit", total_credit::text as "totalCredit",
                       approved_at as "approvedAt", version::text as version
          `.execute(transaction);
          const response = result.rows[0]!;
          await this.finishTransition(transaction, operation, batchId, response, idempotencyKey);
          return response;
        }
        await this.support.enforcePostingSegregation(transaction, batch.approvedBy);
        if (batch.journalId !== null) {
          throw new ApplicationException(
            "accounting_opening_balance_journal_exists",
            "The Opening Balance Batch already has a linked Journal",
            HttpStatus.CONFLICT,
          );
        }
        const journalId = randomUUID();
        const journalNumber = await this.foundation.nextJournalNumber(transaction);
        await sql`
          insert into journal_entries (
            id, company_id, journal_number, accounting_period_id, fiscal_year_id,
            business_date, journal_type, source_type, source_id, description,
            currency, exchange_rate, status,
            source_entity_type, source_entity_id, source_reference, notes,
            created_by_account_id, updated_by_account_id, approved_by_account_id,
            approved_at, posted_by_account_id, posted_at
          ) values (
            ${journalId}::uuid, ${companyId}::uuid, ${journalNumber},
            ${period.fiscalPeriodId}::uuid, ${period.fiscalYearId}::uuid,
            ${batch.effectiveDate}::date, 'opening_balance', 'opening_balance',
            ${batchId}::uuid, ${batch.description}, 'AED', 1, 'draft',
            'opening_balance', ${batchId}::uuid, null, ${note ?? null},
            ${actorId}::uuid, ${actorId}::uuid, null, null, null, null
          )
        `.execute(transaction);
        await this.insertJournalLines(transaction, journalId, batchId);
        await sql`
          update journal_entries set status='balanced', version=version+1
           where id=${journalId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        await sql`
          update journal_entries
             set status='approved', approved_by_account_id=${actorId}::uuid,
                 approved_at=now(), approval_note=${note ?? null}, version=version+1
           where id=${journalId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        await sql`
          update journal_entries
             set status='posted', posted_by_account_id=${actorId}::uuid,
                 posted_at=now(), posting_note=${note ?? null}, version=version+1
           where id=${journalId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        const result = await sql<Record<string, unknown>>`
          update opening_balance_batches
             set status='posted', journal_id=${journalId}::uuid,
                 posted_by_account_id=${actorId}::uuid, posted_at=now(),
                 posting_note=${note ?? null}, version=version+1
           where id=${batchId}::uuid and company_id=${companyId}::uuid
           returning id, batch_number as "batchNumber", status,
                     journal_id as "journalId", posted_at as "postedAt",
                     version::text as version
        `.execute(transaction);
        const response = { ...result.rows[0]!, journalNumber };
        await this.support.audit(transaction, {
          action: "accounting.journal.posted",
          after: { journalId, journalNumber, source: "opening_balance" },
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: journalId,
          subjectType: "journal",
        });
        await this.finishTransition(transaction, operation, batchId, response, idempotencyKey);
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  private async insertJournalLines(
    database: Kysely<DatabaseSchema>,
    journalId: string,
    batchId: string,
  ): Promise<void> {
    const { actorId, companyId } = this.support.context();
    await sql`
      insert into journal_lines (
        id, company_id, journal_entry_id, line_number, account_id,
        debit, credit, account_code_snapshot, account_name_en_snapshot,
        account_name_ar_snapshot, description, subledger_type, subledger_id,
        trader_id, driver_id, employee_id, source_entity_type, source_entity_id,
        created_by_account_id, updated_by_account_id
      )
      select gen_random_uuid(), company_id, ${journalId}::uuid, line_number, account_id,
             debit, credit, account_code_snapshot, account_name_en_snapshot,
             account_name_ar_snapshot, description, subledger_type, subledger_id,
             trader_id, driver_id, employee_id, 'opening_balance', ${batchId}::uuid,
             ${actorId}::uuid, ${actorId}::uuid
        from opening_balance_lines
       where opening_balance_batch_id=${batchId}::uuid and company_id=${companyId}::uuid
       order by line_number
    `.execute(database);
  }

  private async finishTransition(
    database: Kysely<DatabaseSchema>,
    operation: string,
    batchId: string,
    response: object,
    idempotencyKey: string | undefined,
  ): Promise<void> {
    await this.support.audit(database, {
      action: operation,
      after: response,
      correlationId: idempotencyKey ?? randomUUID(),
      subjectId: batchId,
      subjectType: "opening_balance",
    });
    await this.support.completeIdempotency(database, {
      idempotencyKey: idempotencyKey!,
      operation,
      resourceId: batchId,
      resourceType: "opening_balance",
      responseBody: response,
    });
  }

  public async reverse(
    batchId: string,
    input: ReverseOpeningBalanceDto,
    idempotencyKey: string | undefined,
  ) {
    this.support.assertPermission("accounting.reverse");
    try {
      return await this.transactions.execute(async (transaction) => {
        const operation = "accounting.opening_balance.reverse";
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation,
          payload: { batchId, ...input },
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const reversalPeriod = await this.lockPeriod(transaction, input.reversalDate, true);
        const batch = await this.lockBatch(transaction, batchId);
        if (
          batch.status !== "posted"
          || batch.journalId === null
          || batch.reversalJournalId !== null
        ) {
          throw new ApplicationException(
            batch.status === "reversed"
              ? "accounting_opening_balance_already_reversed"
              : "accounting_opening_balance_not_reversible",
            "Only an unreversed Posted Opening Balance Batch can be reversed",
            HttpStatus.CONFLICT,
          );
        }
        const { actorId, companyId } = this.support.context();
        const original = await sql<{
          approvedBy: string | null;
          createdBy: string;
          description: string;
          journalNumber: string;
          postedBy: string | null;
          status: string;
        }>`
          select status, journal_number as "journalNumber", description,
                 created_by_account_id as "createdBy",
                 approved_by_account_id as "approvedBy",
                 posted_by_account_id as "postedBy"
            from journal_entries
           where id=${batch.journalId}::uuid and company_id=${companyId}::uuid for update
        `.execute(transaction);
        const originalJournal = original.rows[0];
        if (originalJournal === undefined || originalJournal.status !== "posted") {
          throw new ApplicationException(
            "accounting_opening_balance_reversal_conflict",
            "The linked Opening Balance Journal is not Posted",
            HttpStatus.CONFLICT,
          );
        }
        await this.support.enforceReversalSegregation(transaction, {
          approvedBy: originalJournal.approvedBy,
          createdBy: originalJournal.createdBy,
          postedBy: originalJournal.postedBy,
        });
        const originalLines = await sql<Record<string, string | null>>`
          select line_number::text as "lineNumber", account_id as "accountId",
                 debit::text as debit, credit::text as credit, description,
                 account_code_snapshot as "accountCodeSnapshot",
                 account_name_en_snapshot as "accountNameEnSnapshot",
                 account_name_ar_snapshot as "accountNameArSnapshot",
                 subledger_type as "subledgerType", subledger_id as "subledgerId",
                 trader_id as "traderId", driver_id as "driverId", employee_id as "employeeId"
            from journal_lines
           where journal_entry_id=${batch.journalId}::uuid and company_id=${companyId}::uuid
           order by line_number for share
        `.execute(transaction);
        const reversalId = randomUUID();
        const reversalNumber = await this.foundation.nextJournalNumber(transaction);
        await sql`
          insert into journal_entries (
            id, company_id, journal_number, accounting_period_id, fiscal_year_id,
            business_date, journal_type, source_type, source_id, description,
            currency, exchange_rate, status,
            source_entity_type, source_entity_id, reversal_of_id,
            created_by_account_id, updated_by_account_id, approved_by_account_id,
            approved_at, posted_by_account_id, posted_at
          )
          select ${reversalId}::uuid, company_id, ${reversalNumber},
                 ${reversalPeriod.fiscalPeriodId}::uuid, ${reversalPeriod.fiscalYearId}::uuid,
                 ${input.reversalDate}::date, 'reversal', 'opening_balance', ${batchId}::uuid,
                 ${`Reversal of ${originalJournal.journalNumber}: ${input.reason.trim()}`},
                 currency, exchange_rate, 'draft',
                 'opening_balance', ${batchId}::uuid, id,
                 ${actorId}::uuid, ${actorId}::uuid, null, null, null, null
            from journal_entries where id=${batch.journalId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        for (const line of originalLines.rows) {
          await sql`
            insert into journal_lines (
              id, company_id, journal_entry_id, line_number, account_id,
              debit, credit, account_code_snapshot, account_name_en_snapshot,
              account_name_ar_snapshot, description, subledger_type, subledger_id,
              trader_id, driver_id, employee_id, source_entity_type, source_entity_id,
              created_by_account_id, updated_by_account_id
            ) values (
              ${randomUUID()}::uuid, ${companyId}::uuid, ${reversalId}::uuid,
              ${Number(line.lineNumber)}, ${line.accountId}::uuid,
              ${line.credit}, ${line.debit}, ${line.accountCodeSnapshot},
              ${line.accountNameEnSnapshot}, ${line.accountNameArSnapshot},
              ${line.description},
              ${line.subledgerType}, ${line.subledgerId}::uuid,
              ${line.traderId}::uuid, ${line.driverId}::uuid, ${line.employeeId}::uuid,
              'opening_balance', ${batchId}::uuid, ${actorId}::uuid, ${actorId}::uuid
            )
          `.execute(transaction);
        }
        await sql`
          update journal_entries set status='balanced', version=version+1
           where id=${reversalId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        await sql`
          update journal_entries
             set status='approved', approved_by_account_id=${actorId}::uuid,
                 approved_at=now(), approval_note=${input.reason.trim()}, version=version+1
           where id=${reversalId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        await sql`
          update journal_entries
             set status='posted', posted_by_account_id=${actorId}::uuid,
                 posted_at=now(), posting_note=${input.reason.trim()}, version=version+1
           where id=${reversalId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        await sql`
          update journal_entries
             set status='reversed', reversed_by_journal_id=${reversalId}::uuid,
                 reversed_by_account_id=${actorId}::uuid, reversed_at=now(),
                 reversal_reason=${input.reason.trim()}, version=version+1
           where id=${batch.journalId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        const result = await sql<Record<string, unknown>>`
          update opening_balance_batches
             set status='reversed', reversal_journal_id=${reversalId}::uuid,
                 reversed_by_account_id=${actorId}::uuid, reversed_at=now(),
                 reversal_reason=${input.reason.trim()}, version=version+1
           where id=${batchId}::uuid and company_id=${companyId}::uuid
           returning id, batch_number as "batchNumber", status,
                     journal_id as "journalId", reversal_journal_id as "reversalJournalId",
                     reversed_at as "reversedAt", version::text as version
        `.execute(transaction);
        const response = { ...result.rows[0]!, reversalJournalNumber: reversalNumber };
        await this.support.audit(transaction, {
          action: "accounting.journal.reversed",
          after: { originalJournalId: batch.journalId, reversalId, reversalNumber },
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: batch.journalId,
          subjectType: "journal",
        });
        await this.finishTransition(transaction, operation, batchId, response, idempotencyKey);
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async summary() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await this.transactions.execute((transaction) => sql<Record<string, string>>`
      select count(*) filter (where status='draft')::text as "draftCount",
             count(*) filter (where status='validated')::text as "validatedCount",
             count(*) filter (where status='approved')::text as "approvedCount",
             count(*) filter (where status='posted')::text as "postedCount",
             count(*) filter (where status='reversed')::text as "reversedCount",
             coalesce(sum(total_debit) filter (where status='posted'),0)::text as "totalPostedDebit",
             coalesce(sum(total_credit) filter (where status='posted'),0)::text as "totalPostedCredit",
             count(*) filter (where status='validated')::text as "awaitingApproval",
             count(*) filter (where status='approved')::text as "awaitingPosting"
        from opening_balance_batches where company_id=${companyId}::uuid
    `.execute(transaction));
    return result.rows[0]!;
  }

  public async list(query: OpeningBalanceListQueryDto) {
    this.support.assertPermission("accounting.view");
    const { limit, offset, page, pageSize } = this.support.pagination(query);
    const { companyId } = this.support.context();
    const result = await this.transactions.execute((transaction) => sql<Record<string, unknown>>`
      with filtered as (
        select distinct b.id
          from opening_balance_batches b
          left join opening_balance_lines l
            on l.opening_balance_batch_id=b.id and l.company_id=b.company_id
         where b.company_id=${companyId}::uuid
           and (${query.batchNumber ?? null}::text is null
             or b.batch_number ilike '%' || ${query.batchNumber ?? null} || '%')
           and (${query.dateFrom ?? null}::date is null or b.effective_date >= ${query.dateFrom ?? null}::date)
           and (${query.dateTo ?? null}::date is null or b.effective_date <= ${query.dateTo ?? null}::date)
           and (${query.fiscalYearId ?? null}::uuid is null or b.fiscal_year_id=${query.fiscalYearId ?? null}::uuid)
           and (${query.fiscalPeriodId ?? null}::uuid is null or b.accounting_period_id=${query.fiscalPeriodId ?? null}::uuid)
           and (${query.status ?? null}::text is null or b.status=${query.status ?? null})
           and (${query.accountId ?? null}::uuid is null or l.account_id=${query.accountId ?? null}::uuid)
           and (${query.traderId ?? null}::uuid is null or l.trader_id=${query.traderId ?? null}::uuid)
           and (${query.driverId ?? null}::uuid is null or l.driver_id=${query.driverId ?? null}::uuid)
           and (${query.employeeId ?? null}::uuid is null or l.employee_id=${query.employeeId ?? null}::uuid)
           and (${query.createdBy ?? null}::uuid is null or b.created_by_account_id=${query.createdBy ?? null}::uuid)
           and (${query.approvedBy ?? null}::uuid is null or b.approved_by_account_id=${query.approvedBy ?? null}::uuid)
           and (${query.postedBy ?? null}::uuid is null or b.posted_by_account_id=${query.postedBy ?? null}::uuid)
           and (${query.reversedOnly ?? null}::boolean is null
             or not ${query.reversedOnly ?? false} or b.status='reversed')
      ), counted as (select count(*)::integer as total from filtered)
      select b.id, b.batch_number as "batchNumber", b.effective_date::text as "effectiveDate",
             y.fiscal_year_code as "fiscalYear", p.period_code as "fiscalPeriod",
             b.description, b.total_debit::text as "totalDebit",
             b.total_credit::text as "totalCredit", b.status,
             creator.username as "createdBy", approver.username as "approvedBy",
             poster.username as "postedBy", b.created_at as "createdAt",
             b.posted_at as "postedAt", j.journal_number as "journalNumber",
             r.journal_number as "reversalJournalNumber",
             (b.status='reversed') as "isReversed", counted.total
        from filtered f cross join counted
        join opening_balance_batches b on b.id=f.id and b.company_id=${companyId}::uuid
        join fiscal_years y on y.id=b.fiscal_year_id and y.company_id=b.company_id
        join accounting_periods p on p.id=b.accounting_period_id and p.company_id=b.company_id
        join accounts creator on creator.id=b.created_by_account_id
        left join accounts approver on approver.id=b.approved_by_account_id
        left join accounts poster on poster.id=b.posted_by_account_id
        left join journal_entries j on j.id=b.journal_id and j.company_id=b.company_id
        left join journal_entries r on r.id=b.reversal_journal_id and r.company_id=b.company_id
       order by b.effective_date desc, b.batch_number desc limit ${limit} offset ${offset}
    `.execute(transaction));
    const total = Number(result.rows[0]?.total ?? 0);
    return {
      items: result.rows.map(({ total: _total, ...row }) => row),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  public async detail(batchId: string) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const header = await sql<Record<string, unknown>>`
        select b.id, b.company_id as "companyId", b.batch_number as "batchNumber",
               b.effective_date::text as "effectiveDate", b.description, b.currency,
               b.total_debit::text as "totalDebit", b.total_credit::text as "totalCredit",
               b.status, b.notes, y.fiscal_year_code as "fiscalYear",
               p.period_code as "fiscalPeriod", creator.username as "createdBy",
               updater.username as "updatedBy", validator.username as "validatedBy",
               approver.username as "approvedBy", poster.username as "postedBy",
               reverser.username as "reversedBy", b.created_at as "createdAt",
               b.updated_at as "updatedAt", b.validated_at as "validatedAt",
               b.approved_at as "approvedAt", b.approval_note as "approvalNote",
               b.posted_at as "postedAt", b.posting_note as "postingNote",
               b.reversed_at as "reversedAt", b.reversal_reason as "reversalReason",
               j.id as "journalId", j.journal_number as "journalNumber",
               r.id as "reversalJournalId", r.journal_number as "reversalJournalNumber"
          from opening_balance_batches b
          join fiscal_years y on y.id=b.fiscal_year_id and y.company_id=b.company_id
          join accounting_periods p on p.id=b.accounting_period_id and p.company_id=b.company_id
          join accounts creator on creator.id=b.created_by_account_id
          left join accounts updater on updater.id=b.updated_by_account_id
          left join accounts validator on validator.id=b.validated_by_account_id
          left join accounts approver on approver.id=b.approved_by_account_id
          left join accounts poster on poster.id=b.posted_by_account_id
          left join accounts reverser on reverser.id=b.reversed_by_account_id
          left join journal_entries j on j.id=b.journal_id and j.company_id=b.company_id
          left join journal_entries r on r.id=b.reversal_journal_id and r.company_id=b.company_id
         where b.id=${batchId}::uuid and b.company_id=${companyId}::uuid
      `.execute(transaction);
      if (header.rows[0] === undefined) {
        throw new ApplicationException(
          "accounting_opening_balance_not_found",
          "The Opening Balance Batch was not found",
          HttpStatus.NOT_FOUND,
        );
      }
      const lines = await sql<Record<string, unknown>>`
        select l.id, l.line_number as "lineNumber", l.account_id as "accountId",
               coalesce(l.account_code_snapshot,a.code) as "accountCode",
               coalesce(l.account_name_en_snapshot,a.name_en) as "accountName",
               coalesce(l.account_name_ar_snapshot,a.name_ar) as "accountNameAr",
               l.debit::text as debit,
               l.credit::text as credit, l.description,
               l.subledger_type as "subledgerType", l.subledger_id as "subledgerId",
               l.trader_id as "traderId", t.name_en as "traderName",
               l.driver_id as "driverId", d.name_en as "driverName",
               l.employee_id as "employeeId", e.name_en as "employeeName"
          from opening_balance_lines l
          join chart_of_accounts a on a.id=l.account_id and a.company_id=l.company_id
          left join traders t on t.id=l.trader_id and t.company_id=l.company_id
          left join drivers d on d.id=l.driver_id and d.company_id=l.company_id
          left join employees e on e.id=l.employee_id and e.company_id=l.company_id
         where l.opening_balance_batch_id=${batchId}::uuid and l.company_id=${companyId}::uuid
         order by l.line_number
      `.execute(transaction);
      return { ...header.rows[0], lines: lines.rows };
    });
  }
}
