import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type {
  CreateJournalDto,
  JournalLineDto,
  JournalListQueryDto,
  ReplaceJournalLinesDto,
  ReverseJournalDto,
  UpdateJournalDto,
} from "./accounting.dto.js";
import { mapAccountingDatabaseError } from "./accounting-error.mapper.js";
import { AccountingFoundationService } from "./accounting-foundation.service.js";
import { assertJournalLineAmounts } from "./accounting.guards.js";
import {
  AccountingOperationSupport,
  numericReferenceOrder,
} from "./accounting-operation.support.js";

interface JournalRecord {
  readonly accountingPeriodId: string;
  readonly approvedBy: string | null;
  readonly businessDate: string;
  readonly createdBy: string;
  readonly description: string;
  readonly fiscalYearId: string;
  readonly id: string;
  readonly journalNumber: string;
  readonly journalType: string;
  readonly postedBy: string | null;
  readonly reversedByJournalId: string | null;
  readonly status: string;
  readonly totalCredit: string;
  readonly totalDebit: string;
}

interface PeriodRecord {
  readonly fiscalPeriodId: string;
  readonly fiscalPeriodStatus: string;
  readonly fiscalYearId: string;
  readonly fiscalYearStatus: string;
}

function rethrowAccounting(error: unknown): never {
  if (error instanceof ApplicationException) throw error;
  return mapAccountingDatabaseError(error);
}

@Injectable()
export class ManualJournalService {
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
      select p.id as "fiscalPeriodId", p.status as "fiscalPeriodStatus",
             y.id as "fiscalYearId", y.status as "fiscalYearStatus"
        from fiscal_years y
        join accounting_periods p
          on p.fiscal_year_id=y.id and p.company_id=y.company_id
       where y.company_id=${companyId}::uuid
         and ${date}::date between p.period_start and p.period_end
       for update of y, p
    `.execute(database);
    if (result.rows.length !== 1) {
      throw new ApplicationException(
        "accounting_fiscal_period_not_found",
        "The Journal Date must resolve to exactly one Fiscal Period",
        HttpStatus.CONFLICT,
      );
    }
    const period = result.rows[0]!;
    if (
      requireOpen &&
      (!["open", "reopened"].includes(period.fiscalYearStatus) ||
        !["open", "reopened"].includes(period.fiscalPeriodStatus))
    ) {
      throw new ApplicationException(
        period.fiscalPeriodStatus === "soft_closed"
          ? "accounting_fiscal_period_soft_closed"
          : "accounting_journal_posting_period_closed",
        "The Fiscal Period is not open for this Accounting operation",
        HttpStatus.CONFLICT,
      );
    }
    return period;
  }

  private async lockJournal(
    database: Kysely<DatabaseSchema>,
    journalId: string,
  ): Promise<JournalRecord> {
    const { companyId } = this.support.context();
    const result = await sql<JournalRecord>`
      select id, journal_number as "journalNumber", business_date::text as "businessDate",
             accounting_period_id as "accountingPeriodId", fiscal_year_id as "fiscalYearId",
             journal_type as "journalType", description, status,
             total_debit::text as "totalDebit",
             total_credit::text as "totalCredit",
             created_by_account_id as "createdBy",
             approved_by_account_id as "approvedBy",
             posted_by_account_id as "postedBy",
             reversed_by_journal_id as "reversedByJournalId"
        from journal_entries
       where id=${journalId}::uuid and company_id=${companyId}::uuid
       for update
    `.execute(database);
    const journal = result.rows[0];
    if (journal === undefined) {
      throw new ApplicationException(
        "accounting_journal_not_found",
        "The Accounting Journal was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return journal;
  }

  private assertManualJournal(journal: JournalRecord): void {
    if (journal.journalType !== "manual") {
      throw new ApplicationException(
        "accounting_journal_operation_not_permitted",
        "This operation is available only for Manual Journals",
        HttpStatus.CONFLICT,
      );
    }
  }

  private validateInputLines(lines: readonly JournalLineDto[]): void {
    if (new Set(lines.map((line) => line.lineNumber)).size !== lines.length) {
      throw new ApplicationException(
        "accounting_journal_line_duplicate_number",
        "Journal Line Numbers must be unique",
        HttpStatus.BAD_REQUEST,
      );
    }
    for (const [index, line] of lines.entries()) {
      try {
        assertJournalLineAmounts(line.debit, line.credit);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Enter a Debit or Credit amount.";
        throw new ApplicationException(
          "accounting_journal_line_invalid_amount",
          `Row ${line.lineNumber || index + 1}: ${message}`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }
  }

  private normalizeInputLineAmount(value: number | string | null | undefined): number {
    let amount: Decimal;
    try {
      amount = new Decimal(value ?? 0);
    } catch {
      throw new ApplicationException(
        "accounting_journal_line_invalid_amount",
        "Journal line amount must be a valid number.",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!amount.isFinite() || amount.isNegative() || amount.decimalPlaces() > 2) {
      throw new ApplicationException(
        "accounting_journal_line_invalid_amount",
        "Journal line amount must be zero or a positive amount with up to two decimals.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return Number(amount.toFixed(2));
  }

  private normalizeInputLines(lines: readonly JournalLineDto[]): JournalLineDto[] {
    return lines.map((line, index) => {
      const normalizedDebit = this.normalizeInputLineAmount(line.debit);
      const normalizedCredit = this.normalizeInputLineAmount(line.credit);
      const amountSide =
        line.amountSide ??
        (normalizedDebit > 0 && normalizedCredit === 0
          ? "debit"
          : normalizedCredit > 0 && normalizedDebit === 0
            ? "credit"
            : undefined);

      return {
        ...line,
        // Omitted, not set to undefined: absent already means "no side was
        // determined", and the draft type treats a present-but-undefined
        // property as a different thing. The credit/debit values below read
        // the same local, so balancing is unchanged.
        ...(amountSide === undefined ? {} : { amountSide }),
        credit: amountSide === "debit" ? 0 : normalizedCredit,
        debit: amountSide === "credit" ? 0 : normalizedDebit,
        lineNumber: index + 1,
      };
    });
  }

  private async validateAccounts(
    database: Kysely<DatabaseSchema>,
    lines: readonly JournalLineDto[],
    manual = true,
  ): Promise<void> {
    const { companyId } = this.support.context();
    const ids = [...new Set(lines.map((line) => line.accountId))];
    if (ids.length === 0) return;
    const result = await sql<{
      id: string;
      isActive: boolean;
      isControl: boolean;
      isPosting: boolean;
    }>`
      select id, is_active as "isActive", is_posting_account as "isPosting",
             is_control_account as "isControl"
        from chart_of_accounts
       where company_id=${companyId}::uuid and id=any(${ids}::uuid[])
       for share
    `.execute(database);
    if (result.rows.length !== ids.length) {
      throw new ApplicationException(
        "accounting_journal_line_cross_company_account",
        "Every Journal Account must belong to the active Company",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (result.rows.some((account) => !account.isActive || !account.isPosting)) {
      throw new ApplicationException(
        "accounting_journal_account_unavailable",
        "Journal Lines require active Posting Accounts",
        HttpStatus.CONFLICT,
      );
    }
    if (manual && result.rows.some((account) => account.isControl)) {
      throw new ApplicationException(
        "accounting_manual_control_account_posting_prohibited",
        "Manual Journals cannot post directly to Control Accounts",
        HttpStatus.CONFLICT,
      );
    }
  }

  private totals(lines: readonly { credit: number | string; debit: number | string }[]) {
    const totalDebit = lines.reduce((sum, line) => sum.plus(line.debit), new Decimal(0));
    const totalCredit = lines.reduce((sum, line) => sum.plus(line.credit), new Decimal(0));
    return {
      balanced: lines.length >= 2 && totalDebit.greaterThan(0) && totalDebit.equals(totalCredit),
      difference: totalDebit.minus(totalCredit).toFixed(2),
      totalCredit: totalCredit.toFixed(2),
      totalDebit: totalDebit.toFixed(2),
    };
  }

  private async insertLines(
    database: Kysely<DatabaseSchema>,
    journalId: string,
    lines: readonly JournalLineDto[],
  ): Promise<void> {
    const { actorId, companyId } = this.support.context();
    for (const line of lines) {
      await sql`
        insert into journal_lines (
          company_id, journal_entry_id, line_number, account_id, debit, credit,
          description, subledger_type, subledger_id, trader_id, driver_id,
          employee_id, order_id, trader_settlement_id, driver_collection_id,
          payroll_period_id, payroll_payment_id, outsourced_driver_fee_accrual_id,
          outsourced_driver_fee_payment_id, company_bank_account_id,
          source_entity_type, source_entity_id, created_by_account_id,
          updated_by_account_id
        ) values (
          ${companyId}::uuid, ${journalId}::uuid, ${line.lineNumber},
          ${line.accountId}::uuid, ${line.debit}, ${line.credit},
          ${line.description ?? null}, ${line.subledgerType ?? null},
          ${line.subledgerId ?? null}::uuid, ${line.traderId ?? null}::uuid,
          ${line.driverId ?? null}::uuid, ${line.employeeId ?? null}::uuid,
          ${line.orderId ?? null}::uuid, ${line.traderSettlementId ?? null}::uuid,
          ${line.driverCollectionId ?? null}::uuid, ${line.payrollPeriodId ?? null}::uuid,
          ${line.payrollPaymentId ?? null}::uuid,
          ${line.outsourcedDriverFeeAccrualId ?? null}::uuid,
          ${line.outsourcedDriverFeePaymentId ?? null}::uuid,
          ${line.companyBankAccountId ?? null}::uuid,
          ${line.sourceEntityType ?? null}, ${line.sourceEntityId ?? null}::uuid,
          ${actorId}::uuid, ${actorId}::uuid
        )
      `.execute(database);
    }
  }

  private async readLines(database: Kysely<DatabaseSchema>, journalId: string) {
    const { companyId } = this.support.context();
    const result = await sql<Record<string, string | null>>`
      select id, line_number::text as "lineNumber", account_id as "accountId",
             debit::text as debit, credit::text as credit, description,
             account_code_snapshot as "accountCodeSnapshot",
             account_name_en_snapshot as "accountNameEnSnapshot",
             account_name_ar_snapshot as "accountNameArSnapshot",
             subledger_type as "subledgerType", subledger_id as "subledgerId",
             trader_id as "traderId", driver_id as "driverId", employee_id as "employeeId",
             order_id as "orderId", trader_settlement_id as "traderSettlementId",
             driver_collection_id as "driverCollectionId",
             payroll_period_id as "payrollPeriodId", payroll_payment_id as "payrollPaymentId",
             outsourced_driver_fee_accrual_id as "outsourcedDriverFeeAccrualId",
             outsourced_driver_fee_payment_id as "outsourcedDriverFeePaymentId",
             company_bank_account_id as "companyBankAccountId",
             source_entity_type as "sourceEntityType", source_entity_id as "sourceEntityId"
        from journal_lines
       where journal_entry_id=${journalId}::uuid and company_id=${companyId}::uuid
       order by line_number
       for share
    `.execute(database);
    return result.rows;
  }

  private toLineDtos(rows: readonly Record<string, string | null>[]): JournalLineDto[] {
    return rows.map((row) => {
      const line: Record<string, string | number> = {
        accountId: row.accountId!,
        credit: Number(row.credit),
        debit: Number(row.debit),
        lineNumber: Number(row.lineNumber),
      };
      for (const key of [
        "description",
        "subledgerType",
        "subledgerId",
        "traderId",
        "driverId",
        "employeeId",
        "orderId",
        "traderSettlementId",
        "driverCollectionId",
        "payrollPeriodId",
        "payrollPaymentId",
        "outsourcedDriverFeeAccrualId",
        "outsourcedDriverFeePaymentId",
        "companyBankAccountId",
        "sourceEntityType",
        "sourceEntityId",
      ] as const) {
        if (row[key] !== null) line[key] = row[key]!;
      }
      return line as unknown as JournalLineDto;
    });
  }

  public async create(input: CreateJournalDto, idempotencyKey: string | undefined) {
    this.support.assertPermission("accounting.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.journal.create",
          payload: input,
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const lines = this.normalizeInputLines(input.lines ?? []);
        this.validateInputLines(lines);
        await this.validateAccounts(transaction, lines);
        const period = await this.lockPeriod(transaction, input.journalDate, false);
        const { actorId, companyId } = this.support.context();
        const id = randomUUID();
        const journalNumber = await this.foundation.nextJournalNumber(transaction);
        await sql`
          insert into journal_entries (
            id, company_id, journal_number, accounting_period_id, fiscal_year_id,
            business_date, journal_type, source_type, source_id, description,
            currency, exchange_rate, status, source_entity_type, source_entity_id,
            source_reference, correlation_id, idempotency_key, notes,
            created_by_account_id, updated_by_account_id
          ) values (
            ${id}::uuid, ${companyId}::uuid, ${journalNumber},
            ${period.fiscalPeriodId}::uuid, ${period.fiscalYearId}::uuid,
            ${input.journalDate}::date, 'manual', 'manual', null,
            ${input.description.trim()}, 'AED', 1, 'draft', null, null,
            ${input.sourceReference ?? null}, ${input.correlationReference ?? null},
            ${idempotencyKey!}, ${input.notes ?? null},
            ${actorId}::uuid, ${actorId}::uuid
          )
        `.execute(transaction);
        await this.insertLines(transaction, id, lines);
        const calculated = this.totals(lines);
        if (calculated.balanced) {
          await sql`update journal_entries set status='balanced', version=version+1
                     where id=${id}::uuid and company_id=${companyId}::uuid`.execute(transaction);
        }
        const response = {
          id,
          journalNumber,
          journalDate: input.journalDate,
          status: calculated.balanced ? "balanced" : "draft",
          ...calculated,
        };
        await this.support.audit(transaction, {
          action: "accounting.journal.created",
          after: response,
          correlationId: input.correlationReference ?? idempotencyKey ?? randomUUID(),
          subjectId: id,
          subjectType: "journal",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation: "accounting.journal.create",
          resourceId: id,
          resourceType: "journal",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  private async makeEditable(database: Kysely<DatabaseSchema>, journal: JournalRecord) {
    this.assertManualJournal(journal);
    if (journal.status === "balanced") {
      const { actorId, companyId } = this.support.context();
      await sql`update journal_entries set status='draft', updated_by_account_id=${actorId}::uuid,
                   updated_at=now(), version=version+1
                 where id=${journal.id}::uuid and company_id=${companyId}::uuid`.execute(database);
      return;
    }
    if (journal.status !== "draft") {
      throw new ApplicationException(
        "accounting_journal_not_editable",
        "Only Draft Journals can be edited",
        HttpStatus.CONFLICT,
      );
    }
  }

  public async updateHeader(
    journalId: string,
    input: UpdateJournalDto,
    idempotencyKey: string | undefined,
  ) {
    this.support.assertPermission("accounting.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.journal.update",
          payload: { journalId, ...input },
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const journal = await this.lockJournal(transaction, journalId);
        this.assertManualJournal(journal);
        await this.makeEditable(transaction, journal);
        const date = input.journalDate ?? journal.businessDate;
        const period = await this.lockPeriod(transaction, date, false);
        const { actorId, companyId } = this.support.context();
        // Lines travel separately from the jsonb header-patch payload below;
        // they are replaced wholesale (same semantics as replaceLines) inside
        // this same transaction when provided.
        const { lines: inputLines, ...headerInput } = input;
        const payload = JSON.stringify(headerInput);
        const result = await sql<Record<string, unknown>>`
          update journal_entries j
             set business_date=${date}::date, accounting_period_id=${period.fiscalPeriodId}::uuid,
                 fiscal_year_id=${period.fiscalYearId}::uuid,
                 description=coalesce(${payload}::jsonb->>'description', j.description),
                 source_reference=case when ${payload}::jsonb ? 'sourceReference'
                   then ${payload}::jsonb->>'sourceReference' else j.source_reference end,
                 correlation_id=case when ${payload}::jsonb ? 'correlationReference'
                   then ${payload}::jsonb->>'correlationReference' else j.correlation_id end,
                 notes=case when ${payload}::jsonb ? 'notes'
                   then ${payload}::jsonb->>'notes' else j.notes end,
                 updated_by_account_id=${actorId}::uuid, updated_at=now(), version=j.version+1
           where j.id=${journalId}::uuid and j.company_id=${companyId}::uuid
           returning id, journal_number as "journalNumber", business_date::text as "journalDate",
                     description, status, total_debit::text as "totalDebit",
                     total_credit::text as "totalCredit", version::text as version
        `.execute(transaction);
        let response = result.rows[0]!;
        if (inputLines !== undefined) {
          const lines = this.normalizeInputLines(inputLines);
          this.validateInputLines(lines);
          await this.validateAccounts(transaction, lines);
          await sql`delete from journal_lines where journal_entry_id=${journalId}::uuid
                      and company_id=${companyId}::uuid`.execute(transaction);
          await this.insertLines(transaction, journalId, lines);
          const calculated = this.totals(lines);
          if (calculated.balanced) {
            await sql`update journal_entries set status='balanced',
                         updated_by_account_id=${actorId}::uuid, updated_at=now(), version=version+1
                       where id=${journalId}::uuid and company_id=${companyId}::uuid`.execute(
              transaction,
            );
          }
          response = {
            ...response,
            status: calculated.balanced ? "balanced" : "draft",
            ...calculated,
          };
        }
        await this.support.audit(transaction, {
          action: "accounting.journal.updated",
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: journalId,
          subjectType: "journal",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation: "accounting.journal.update",
          resourceId: journalId,
          resourceType: "journal",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async replaceLines(
    journalId: string,
    input: ReplaceJournalLinesDto,
    idempotencyKey: string | undefined,
  ) {
    this.support.assertPermission("accounting.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.journal.lines.replace",
          payload: { journalId, ...input },
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const journal = await this.lockJournal(transaction, journalId);
        this.assertManualJournal(journal);
        await this.makeEditable(transaction, journal);
        const lines = this.normalizeInputLines(input.lines);
        this.validateInputLines(lines);
        await this.validateAccounts(transaction, lines);
        const { actorId, companyId } = this.support.context();
        await sql`delete from journal_lines where journal_entry_id=${journalId}::uuid
                    and company_id=${companyId}::uuid`.execute(transaction);
        await this.insertLines(transaction, journalId, lines);
        const calculated = this.totals(lines);
        if (calculated.balanced) {
          await sql`update journal_entries set status='balanced',
                       updated_by_account_id=${actorId}::uuid, updated_at=now(), version=version+1
                     where id=${journalId}::uuid and company_id=${companyId}::uuid`.execute(
            transaction,
          );
        }
        const response = {
          id: journalId,
          status: calculated.balanced ? "balanced" : "draft",
          ...calculated,
        };
        await this.support.audit(transaction, {
          action: "accounting.journal.lines_replaced",
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: journalId,
          subjectType: "journal",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation: "accounting.journal.lines.replace",
          resourceId: journalId,
          resourceType: "journal",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async addLine(
    journalId: string,
    line: JournalLineDto,
    idempotencyKey: string | undefined,
  ) {
    return this.mutateLines(journalId, "add", idempotencyKey, (lines) => [...lines, line], {
      line,
    });
  }

  public async updateLine(
    journalId: string,
    lineId: string,
    line: JournalLineDto,
    idempotencyKey: string | undefined,
  ) {
    return this.mutateLines(
      journalId,
      "update",
      idempotencyKey,
      (lines, lineIds) => {
        const index = lineIds.indexOf(lineId);
        if (index < 0) {
          throw new ApplicationException(
            "accounting_journal_line_not_found",
            "The Journal Line was not found",
            HttpStatus.NOT_FOUND,
          );
        }
        return lines.map((existing, currentIndex) => (currentIndex === index ? line : existing));
      },
      { line, lineId },
    );
  }

  public async removeLine(journalId: string, lineId: string, idempotencyKey: string | undefined) {
    return this.mutateLines(
      journalId,
      "remove",
      idempotencyKey,
      (lines, lineIds) => {
        const index = lineIds.indexOf(lineId);
        if (index < 0) {
          throw new ApplicationException(
            "accounting_journal_line_not_found",
            "The Journal Line was not found",
            HttpStatus.NOT_FOUND,
          );
        }
        return lines.filter((_line, currentIndex) => currentIndex !== index);
      },
      { lineId },
    );
  }

  private async mutateLines(
    journalId: string,
    action: "add" | "remove" | "update",
    idempotencyKey: string | undefined,
    mutation: (lines: JournalLineDto[], lineIds: string[]) => JournalLineDto[],
    payload: Record<string, unknown>,
  ) {
    this.support.assertPermission("accounting.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const operation = `accounting.journal.line.${action}`;
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation,
          payload: { journalId, ...payload },
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const journal = await this.lockJournal(transaction, journalId);
        await this.makeEditable(transaction, journal);
        const raw = await this.readLines(transaction, journalId);
        const lines = this.normalizeInputLines(
          mutation(
            this.toLineDtos(raw),
            raw.map((item) => item.id!),
          ),
        );
        this.validateInputLines(lines);
        await this.validateAccounts(transaction, lines);
        const { actorId, companyId } = this.support.context();
        await sql`delete from journal_lines
                   where journal_entry_id=${journalId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        await this.insertLines(transaction, journalId, lines);
        const calculated = this.totals(lines);
        await sql`
          update journal_entries
             set status=${calculated.balanced ? "balanced" : "draft"},
                 updated_by_account_id=${actorId}::uuid, updated_at=now(), version=version+1
           where id=${journalId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        const response = {
          id: journalId,
          status: calculated.balanced ? "balanced" : "draft",
          ...calculated,
        };
        await this.support.audit(transaction, {
          action: `accounting.journal.line_${action}`,
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: journalId,
          subjectType: "journal",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation,
          resourceId: journalId,
          resourceType: "journal",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async validate(journalId: string) {
    this.support.assertPermission("accounting.manage");
    try {
      return await this.transactions.execute(async (transaction) => {
        const preview = await sql<{ businessDate: string }>`
          select business_date::text as "businessDate"
            from journal_entries
           where id=${journalId}::uuid and company_id=${this.support.context().companyId}::uuid
        `.execute(transaction);
        if (preview.rows[0] === undefined) {
          throw new ApplicationException(
            "accounting_journal_not_found",
            "The Accounting Journal was not found",
            HttpStatus.NOT_FOUND,
          );
        }
        await this.lockPeriod(transaction, preview.rows[0].businessDate, true);
        const journal = await this.lockJournal(transaction, journalId);
        this.assertManualJournal(journal);
        if (journal.businessDate !== preview.rows[0].businessDate) {
          throw new ApplicationException(
            "accounting_concurrent_modification",
            "The Journal changed while it was being validated",
            HttpStatus.CONFLICT,
          );
        }
        if (!["draft", "balanced"].includes(journal.status)) {
          throw new ApplicationException(
            "accounting_journal_not_editable",
            "Only Draft or Balanced Journals can be validated",
            HttpStatus.CONFLICT,
          );
        }
        const raw = await this.readLines(transaction, journalId);
        const lines = raw.map((line) => ({
          accountId: line.accountId,
          credit: Number(line.credit),
          debit: Number(line.debit),
          lineNumber: Number(line.lineNumber),
        })) as JournalLineDto[];
        await this.validateAccounts(transaction, lines);
        const calculated = this.totals(lines);
        const { actorId, companyId } = this.support.context();
        if (!calculated.balanced) {
          if (journal.status === "balanced") {
            await sql`update journal_entries set status='draft',
                         updated_by_account_id=${actorId}::uuid, updated_at=now(), version=version+1
                       where id=${journalId}::uuid and company_id=${companyId}::uuid`.execute(
              transaction,
            );
          }
          return { id: journalId, lineErrors: [], status: "draft", valid: false, ...calculated };
        }
        // Only write the status when it actually changes: the history-guard
        // trigger forbids ANY update to an already-'balanced' Journal except a
        // transition to draft/approved/cancelled, so a balanced->balanced
        // self-update would raise accounting_journal_not_editable. Since
        // saving lines now auto-balances the Journal, an already-balanced
        // state on Validate is the normal case, not an anomaly.
        if (journal.status !== "balanced") {
          await sql`update journal_entries set status='balanced',
                       updated_by_account_id=${actorId}::uuid, updated_at=now(), version=version+1
                     where id=${journalId}::uuid and company_id=${companyId}::uuid`.execute(
            transaction,
          );
        }
        const response = {
          id: journalId,
          lineErrors: [],
          status: "balanced",
          valid: true,
          ...calculated,
        };
        await this.support.audit(transaction, {
          action: "accounting.journal.validated",
          after: response,
          correlationId: randomUUID(),
          subjectId: journalId,
          subjectType: "journal",
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  private async transition(
    journalId: string,
    target: "approved" | "cancelled" | "posted",
    noteOrReason: string | undefined,
    idempotencyKey: string | undefined,
  ) {
    const permission =
      target === "approved"
        ? "accounting.approve"
        : target === "posted"
          ? "accounting.post"
          : "accounting.manage";
    this.support.assertPermission(permission);
    try {
      return await this.transactions.execute(async (transaction) => {
        const operation = `accounting.journal.${target}`;
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation,
          payload: { journalId, noteOrReason, target },
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const preview = await sql<{ businessDate: string }>`
          select business_date::text as "businessDate" from journal_entries
           where id=${journalId}::uuid and company_id=${this.support.context().companyId}::uuid
        `.execute(transaction);
        if (preview.rows[0] === undefined) {
          throw new ApplicationException(
            "accounting_journal_not_found",
            "The Accounting Journal was not found",
            HttpStatus.NOT_FOUND,
          );
        }
        if (target === "approved" || target === "posted") {
          await this.lockPeriod(transaction, preview.rows[0].businessDate, true);
        }
        const journal = await this.lockJournal(transaction, journalId);
        this.assertManualJournal(journal);
        if (
          (target === "approved" || target === "posted") &&
          journal.businessDate !== preview.rows[0].businessDate
        ) {
          throw new ApplicationException(
            "accounting_concurrent_modification",
            "The Journal changed while the operation was in progress",
            HttpStatus.CONFLICT,
          );
        }
        const { actorId, companyId } = this.support.context();
        if (target === "approved") {
          if (journal.status !== "balanced") {
            throw new ApplicationException(
              "accounting_journal_not_approvable",
              "Only a Balanced Journal can be approved",
              HttpStatus.CONFLICT,
            );
          }
          await this.support.enforceApprovalSegregation(transaction, journal.createdBy);
        } else if (target === "posted") {
          if (journal.status !== "approved") {
            throw new ApplicationException(
              "accounting_journal_not_approved",
              "Only an Approved Journal can be posted",
              HttpStatus.CONFLICT,
            );
          }
          await this.support.enforcePostingSegregation(transaction, journal.approvedBy);
        } else {
          if (!noteOrReason?.trim()) {
            throw new ApplicationException(
              "accounting_journal_cancellation_reason_required",
              "A cancellation reason is required",
              HttpStatus.BAD_REQUEST,
            );
          }
          if (!["draft", "balanced", "approved"].includes(journal.status)) {
            throw new ApplicationException(
              "accounting_journal_not_cancellable",
              "Only an unposted Journal can be cancelled",
              HttpStatus.CONFLICT,
            );
          }
        }
        const lines = await this.readLines(transaction, journalId);
        if (target !== "cancelled") {
          const normalized = lines.map((line) => ({
            accountId: line.accountId,
            credit: Number(line.credit),
            debit: Number(line.debit),
            lineNumber: Number(line.lineNumber),
          })) as JournalLineDto[];
          await this.validateAccounts(transaction, normalized);
          const calculated = this.totals(normalized);
          if (!calculated.balanced) {
            throw new ApplicationException(
              "accounting_journal_not_balanced",
              "Journal Debit and Credit totals are not balanced",
              HttpStatus.CONFLICT,
            );
          }
        }
        const result = await sql<Record<string, unknown>>`
          update journal_entries
             set status=${target}, version=version+1,
                 approved_by_account_id=case when ${target}='approved' then ${actorId}::uuid else approved_by_account_id end,
                 approved_at=case when ${target}='approved' then now() else approved_at end,
                 approval_note=case when ${target}='approved' then ${noteOrReason ?? null} else approval_note end,
                 posted_by_account_id=case when ${target}='posted' then ${actorId}::uuid else posted_by_account_id end,
                 posted_at=case when ${target}='posted' then now() else posted_at end,
                 posting_note=case when ${target}='posted' then ${noteOrReason ?? null} else posting_note end,
                 cancelled_by_account_id=case when ${target}='cancelled' then ${actorId}::uuid else cancelled_by_account_id end,
                 cancelled_at=case when ${target}='cancelled' then now() else cancelled_at end,
                 cancellation_reason=case when ${target}='cancelled' then ${noteOrReason ?? null} else cancellation_reason end
           where id=${journalId}::uuid and company_id=${companyId}::uuid
           returning id, journal_number as "journalNumber", status,
                     total_debit::text as "totalDebit", total_credit::text as "totalCredit",
                     approved_at as "approvedAt", posted_at as "postedAt",
                     cancelled_at as "cancelledAt", version::text as version
        `.execute(transaction);
        const response = result.rows[0]!;
        await this.support.audit(transaction, {
          action: `accounting.journal.${target}`,
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: journalId,
          subjectType: "journal",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation,
          resourceId: journalId,
          resourceType: "journal",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public approve(journalId: string, note: string | undefined, idempotencyKey: string | undefined) {
    return this.transition(journalId, "approved", note, idempotencyKey);
  }
  public post(journalId: string, note: string | undefined, idempotencyKey: string | undefined) {
    return this.transition(journalId, "posted", note, idempotencyKey);
  }
  public cancel(journalId: string, reason: string, idempotencyKey: string | undefined) {
    return this.transition(journalId, "cancelled", reason, idempotencyKey);
  }

  public async reverse(
    journalId: string,
    input: ReverseJournalDto,
    idempotencyKey: string | undefined,
  ) {
    this.support.assertPermission("accounting.reverse");
    try {
      return await this.transactions.execute(async (transaction) => {
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.journal.reverse",
          payload: { journalId, ...input },
        });
        if (reservation.replayResponse !== undefined) return reservation.replayResponse;
        const reversalPeriod = await this.lockPeriod(transaction, input.reversalDate, true);
        const original = await this.lockJournal(transaction, journalId);
        this.assertManualJournal(original);
        if (original.status !== "posted" || original.reversedByJournalId !== null) {
          throw new ApplicationException(
            original.status === "reversed"
              ? "accounting_journal_already_reversed"
              : "accounting_journal_not_reversible",
            "Only an unreversed Posted Journal can be reversed",
            HttpStatus.CONFLICT,
          );
        }
        await this.support.enforceReversalSegregation(transaction, original);
        const originalLines = await this.readLines(transaction, journalId);
        const { actorId, companyId } = this.support.context();
        const reversalId = randomUUID();
        const reversalNumber = await this.foundation.nextJournalNumber(transaction);
        await sql`
          insert into journal_entries (
            id, company_id, journal_number, accounting_period_id, fiscal_year_id,
            business_date, journal_type, source_type, description, currency,
            exchange_rate, status, source_entity_type, source_entity_id,
            source_reference, correlation_id, idempotency_key, reversal_of_id,
            created_by_account_id, updated_by_account_id
          ) values (
            ${reversalId}::uuid, ${companyId}::uuid, ${reversalNumber},
            ${reversalPeriod.fiscalPeriodId}::uuid, ${reversalPeriod.fiscalYearId}::uuid,
            ${input.reversalDate}::date, 'reversal', 'manual',
            ${input.description ?? `Reversal of ${original.journalNumber}`},
            'AED', 1, 'draft', 'journal', ${journalId}::uuid,
            ${original.journalNumber}, ${idempotencyKey!}, ${idempotencyKey!},
            ${journalId}::uuid, ${actorId}::uuid, ${actorId}::uuid
          )
        `.execute(transaction);
        for (const line of originalLines) {
          await sql`
            insert into journal_lines (
              company_id, journal_entry_id, line_number, account_id, debit, credit,
              account_code_snapshot, account_name_en_snapshot, account_name_ar_snapshot,
              description, subledger_type, subledger_id, trader_id, driver_id,
              employee_id, order_id, trader_settlement_id, driver_collection_id,
              payroll_period_id, payroll_payment_id, outsourced_driver_fee_accrual_id,
              outsourced_driver_fee_payment_id, company_bank_account_id,
              source_entity_type, source_entity_id, created_by_account_id,
              updated_by_account_id
            ) values (
              ${companyId}::uuid, ${reversalId}::uuid, ${Number(line.lineNumber)},
              ${line.accountId}::uuid, ${line.credit}, ${line.debit},
              ${line.accountCodeSnapshot}, ${line.accountNameEnSnapshot},
              ${line.accountNameArSnapshot}, ${line.description},
              ${line.subledgerType}, ${line.subledgerId}::uuid, ${line.traderId}::uuid,
              ${line.driverId}::uuid, ${line.employeeId}::uuid, ${line.orderId}::uuid,
              ${line.traderSettlementId}::uuid, ${line.driverCollectionId}::uuid,
              ${line.payrollPeriodId}::uuid, ${line.payrollPaymentId}::uuid,
              ${line.outsourcedDriverFeeAccrualId}::uuid,
              ${line.outsourcedDriverFeePaymentId}::uuid,
              ${line.companyBankAccountId}::uuid, ${line.sourceEntityType},
              ${line.sourceEntityId}::uuid, ${actorId}::uuid, ${actorId}::uuid
            )
          `.execute(transaction);
        }
        await sql`update journal_entries set status='balanced', version=version+1
                   where id=${reversalId}::uuid and company_id=${companyId}::uuid`.execute(
          transaction,
        );
        await sql`update journal_entries
                     set status='approved', approved_by_account_id=${actorId}::uuid,
                         approved_at=now(), approval_note=${input.reason}, version=version+1
                   where id=${reversalId}::uuid and company_id=${companyId}::uuid`.execute(
          transaction,
        );
        await sql`update journal_entries
                     set status='posted', posted_by_account_id=${actorId}::uuid,
                         posted_at=now(), posting_note=${input.reason}, version=version+1
                   where id=${reversalId}::uuid and company_id=${companyId}::uuid`.execute(
          transaction,
        );
        await sql`update journal_entries
                     set status='reversed', reversed_by_journal_id=${reversalId}::uuid,
                         reversed_by_account_id=${actorId}::uuid, reversed_at=now(),
                         reversal_reason=${input.reason}, version=version+1
                   where id=${journalId}::uuid and company_id=${companyId}::uuid`.execute(
          transaction,
        );
        const response = {
          originalJournalId: journalId,
          originalJournalNumber: original.journalNumber,
          reversalDate: input.reversalDate,
          reversalJournalId: reversalId,
          reversalJournalNumber: reversalNumber,
          status: "reversed",
        };
        await this.support.audit(transaction, {
          action: "accounting.journal.reversed",
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: journalId,
          subjectType: "journal",
        });
        await this.support.audit(transaction, {
          action: "accounting.journal.reversal_created",
          after: response,
          correlationId: idempotencyKey ?? randomUUID(),
          subjectId: reversalId,
          subjectType: "journal",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation: "accounting.journal.reverse",
          resourceId: reversalId,
          resourceType: "journal",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      return rethrowAccounting(error);
    }
  }

  public async summary() {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const result = await sql<Record<string, string | number>>`
        select
          count(*) filter (where status='draft')::int as "draftCount",
          count(*) filter (where status='balanced')::int as "balancedCount",
          count(*) filter (where status='approved')::int as "approvedCount",
          count(*) filter (where status='posted')::int as "postedCount",
          count(*) filter (where status='reversed')::int as "reversedCount",
          count(*) filter (where status='cancelled')::int as "cancelledCount",
          coalesce(sum(total_debit) filter (
            where status='posted' and accounting_period_id in (
              select id from accounting_periods where company_id=${companyId}::uuid
                and (now() at time zone coalesce((
                  select timezone from company_settings where company_id=${companyId}::uuid
                ), 'Asia/Dubai'))::date between period_start and period_end
            )
          ),0)::text as "currentPeriodPostedDebit",
          coalesce(sum(total_credit) filter (
            where status='posted' and accounting_period_id in (
              select id from accounting_periods where company_id=${companyId}::uuid
                and (now() at time zone coalesce((
                  select timezone from company_settings where company_id=${companyId}::uuid
                ), 'Asia/Dubai'))::date between period_start and period_end
            )
          ),0)::text as "currentPeriodPostedCredit",
          count(*) filter (where status='balanced')::int as "awaitingApproval",
          count(*) filter (where status='approved')::int as "awaitingPosting"
        from journal_entries where company_id=${companyId}::uuid
      `.execute(transaction);
      return result.rows[0]!;
    });
  }

  public async list(query: JournalListQueryDto) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const pagination = this.support.pagination(query);
    // Allowlisted sort keys: the client sends a business key, never a column
    // name, so nothing from the request can reach the ORDER BY fragment.
    const sort = this.support.sorting(
      query,
      {
        businessDate: "j.business_date",
        createdAt: "j.created_at",
        description: "j.description",
        journalNumber: numericReferenceOrder("j.journal_number"),
        status: "j.status",
        totalCredit: "j.total_credit",
        totalDebit: "j.total_debit",
      },
      "businessDate",
    );
    const result = await this.transactions.execute(async (transaction) =>
      sql<Record<string, unknown>>`
        select j.id, j.company_id as "companyId", j.journal_number as "journalNumber",
               j.business_date::text as "journalDate", y.fiscal_year_code as "fiscalYear",
               p.period_code as "fiscalPeriod", j.journal_type as "journalType",
               j.source_type as "journalSource", j.description,
               j.total_debit::text as "totalDebit", j.total_credit::text as "totalCredit",
               j.status, j.source_reference as "sourceReference",
               creator.username as "createdBy", approver.username as "approvedBy",
               poster.username as "postedBy", j.created_at as "createdAt",
               j.posted_at as "postedAt", j.reversal_of_id is not null as "isReversal",
               reversing.journal_number as "reversalJournalNumber",
               original.journal_number as "originalJournalNumber",
               count(*) over()::int as "totalRows"
          from journal_entries j
          join fiscal_years y on y.id=j.fiscal_year_id and y.company_id=j.company_id
          join accounting_periods p on p.id=j.accounting_period_id and p.company_id=j.company_id
          join accounts creator on creator.id=j.created_by_account_id
          left join accounts approver on approver.id=j.approved_by_account_id
          left join accounts poster on poster.id=j.posted_by_account_id
          left join journal_entries reversing
            on reversing.id=j.reversed_by_journal_id and reversing.company_id=j.company_id
          left join journal_entries original
            on original.id=j.reversal_of_id and original.company_id=j.company_id
         where j.company_id=${companyId}::uuid
           and (${query.journalNumber ?? null}::text is null
             or j.journal_number ilike ${`%${query.journalNumber ?? ""}%`})
           and (${query.dateFrom ?? null}::date is null or j.business_date >= ${query.dateFrom ?? null}::date)
           and (${query.dateTo ?? null}::date is null or j.business_date <= ${query.dateTo ?? null}::date)
           and (${query.fiscalYearId ?? null}::uuid is null or j.fiscal_year_id=${query.fiscalYearId ?? null}::uuid)
           and (${query.fiscalPeriodId ?? null}::uuid is null or j.accounting_period_id=${query.fiscalPeriodId ?? null}::uuid)
           and (${query.journalType ?? null}::text is null or j.journal_type=${query.journalType ?? null})
           and (${query.journalSource ?? null}::text is null or j.source_type=${query.journalSource ?? null})
           and (${query.status ?? null}::text is null or j.status=${query.status ?? null})
           and (${query.createdBy ?? null}::uuid is null or j.created_by_account_id=${query.createdBy ?? null}::uuid)
           and (${query.approvedBy ?? null}::uuid is null or j.approved_by_account_id=${query.approvedBy ?? null}::uuid)
           and (${query.postedBy ?? null}::uuid is null or j.posted_by_account_id=${query.postedBy ?? null}::uuid)
           and (${query.reversedOnly ?? false}=false or j.status='reversed')
           and (${query.cancelledOnly ?? false}=false or j.status='cancelled')
           and (${query.accountId ?? null}::uuid is null or exists (
             select 1 from journal_lines l where l.journal_entry_id=j.id
               and l.company_id=j.company_id and l.account_id=${query.accountId ?? null}::uuid
           ))
           and (${query.traderId ?? null}::uuid is null or exists (
             select 1 from journal_lines l where l.journal_entry_id=j.id
               and l.company_id=j.company_id and l.trader_id=${query.traderId ?? null}::uuid
           ))
           and (${query.driverId ?? null}::uuid is null or exists (
             select 1 from journal_lines l where l.journal_entry_id=j.id
               and l.company_id=j.company_id and l.driver_id=${query.driverId ?? null}::uuid
           ))
           and (${query.employeeId ?? null}::uuid is null or exists (
             select 1 from journal_lines l where l.journal_entry_id=j.id
               and l.company_id=j.company_id and l.employee_id=${query.employeeId ?? null}::uuid
           ))
           and (${query.orderId ?? null}::uuid is null or exists (
             select 1 from journal_lines l where l.journal_entry_id=j.id
               and l.company_id=j.company_id and l.order_id=${query.orderId ?? null}::uuid
           ))
           and (${query.settlementId ?? null}::uuid is null or exists (
             select 1 from journal_lines l where l.journal_entry_id=j.id
               and l.company_id=j.company_id and l.trader_settlement_id=${query.settlementId ?? null}::uuid
           ))
           and (${query.driverCollectionId ?? null}::uuid is null or exists (
             select 1 from journal_lines l where l.journal_entry_id=j.id
               and l.company_id=j.company_id and l.driver_collection_id=${query.driverCollectionId ?? null}::uuid
           ))
           and (${query.payrollPeriodId ?? null}::uuid is null or exists (
             select 1 from journal_lines l where l.journal_entry_id=j.id
               and l.company_id=j.company_id and l.payroll_period_id=${query.payrollPeriodId ?? null}::uuid
           ))
         -- Deterministic newest-first ordering. business_date + created_at
         -- alone left same-day Journals in an unstable order across pages, and
         -- ignored the Journal sequence entirely. The number is sorted by its
         -- NUMERIC suffix, so JRN-000010 correctly follows JRN-000009 instead
         -- of sorting lexically. j.id is the final tiebreaker so the total
         -- order is strict and paging can never repeat or drop a row.
         -- The class [^0-9] is used rather than a backslash escape, which a JS
         -- template literal would swallow before the SQL is built.
         -- Requested sort first, then the Phase 1 deterministic tail: business
         -- date, the journal number's NUMERIC sequence, created_at, and finally
         -- the id so offset pagination can never repeat or omit a row.
         order by ${sql.raw(sort.column)} ${sql.raw(sort.direction)} nulls last,
                  j.business_date desc,
                  ${sql.raw(numericReferenceOrder("j.journal_number"))} desc nulls last,
                  j.created_at desc,
                  j.id desc
         limit ${pagination.limit} offset ${pagination.offset}
      `.execute(transaction),
    );
    const total = Number(result.rows[0]?.totalRows ?? 0);
    return {
      items: result.rows.map(({ totalRows, ...row }) => {
        void totalRows;
        return row;
      }),
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      sortBy: sort.sortBy,
      sortDirection: sort.sortDirection,
      totalPages: Math.ceil(total / pagination.pageSize),
    };
  }

  public async detail(journalId: string) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const header = await sql<Record<string, unknown>>`
        select j.id, j.journal_number as "journalNumber",
               j.business_date::text as "journalDate", j.journal_type as "journalType",
               j.source_type as "journalSource", j.description, j.currency,
               j.exchange_rate::text as "exchangeRate",
               j.total_debit::text as "totalDebit", j.total_credit::text as "totalCredit",
               j.status, j.source_entity_type as "sourceEntityType",
               j.source_entity_id as "sourceEntityId",
               j.source_reference as "sourceReference",
               j.correlation_id as "correlationReference", j.notes,
               j.created_at as "createdAt", j.updated_at as "updatedAt",
               j.approved_at as "approvedAt", j.approval_note as "approvalNote",
               j.posted_at as "postedAt", j.posting_note as "postingNote",
               j.cancelled_at as "cancelledAt",
               j.cancellation_reason as "cancellationReason",
               j.reversed_at as "reversedAt", j.reversal_reason as "reversalReason",
               j.version::text as version, y.fiscal_year_code as "fiscalYear",
               p.period_code as "fiscalPeriod", creator.username as "createdByName",
               approver.username as "approvedByName", poster.username as "postedByName",
               canceller.username as "cancelledByName",
               reverser.username as "reversedByName",
               original.journal_number as "originalJournalNumber",
               reversing.journal_number as "reversalJournalNumber",
               -- Related Records needs the identifiers the detail routes take,
               -- not only the business references shown on screen. Additive:
               -- nothing existing changes shape.
               j.reversal_of_id as "originalJournalId",
               j.reversed_by_journal_id as "reversalJournalId",
               ev.id as "accountingEventId",
               ev.event_type as "accountingEventType",
               ev.source_entity_type as "eventSourceEntityType",
               ev.source_entity_id as "eventSourceEntityId",
               ev.source_reference as "eventSourceReference"
          from journal_entries j
          join fiscal_years y on y.id=j.fiscal_year_id and y.company_id=j.company_id
          join accounting_periods p on p.id=j.accounting_period_id and p.company_id=j.company_id
          join accounts creator on creator.id=j.created_by_account_id
          left join accounts approver on approver.id=j.approved_by_account_id
          left join accounts poster on poster.id=j.posted_by_account_id
          left join accounts canceller on canceller.id=j.cancelled_by_account_id
          left join accounts reverser on reverser.id=j.reversed_by_account_id
          left join journal_entries original
            on original.id=j.reversal_of_id and original.company_id=j.company_id
          left join journal_entries reversing
            on reversing.id=j.reversed_by_journal_id and reversing.company_id=j.company_id
          left join accounting_events ev
            on ev.id=j.accounting_event_id and ev.company_id=j.company_id
         where j.id=${journalId}::uuid and j.company_id=${companyId}::uuid
      `.execute(transaction);
      if (header.rows[0] === undefined) {
        throw new ApplicationException(
          "accounting_journal_not_found",
          "The Accounting Journal was not found",
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
               t.code as "traderCode", t.name_ar as "traderNameAr",
               l.driver_id as "driverId", d.name_en as "driverName",
               d.code as "driverCode", d.name_ar as "driverNameAr",
               l.employee_id as "employeeId", e.name_en as "employeeName",
               e.employee_number as "employeeNumber", e.name_ar as "employeeNameAr",
               l.order_id as "orderId", o.order_number as "orderNumber",
               l.trader_settlement_id as "traderSettlementId",
               l.driver_collection_id as "driverCollectionId",
               l.payroll_period_id as "payrollPeriodId",
               l.payroll_payment_id as "payrollPaymentId",
               l.outsourced_driver_fee_accrual_id as "outsourcedDriverFeeAccrualId",
               l.outsourced_driver_fee_payment_id as "outsourcedDriverFeePaymentId",
               l.general_expense_id as "generalExpenseId",
               l.general_expense_payment_id as "generalExpensePaymentId",
               l.source_entity_type as "sourceEntityType",
               l.source_entity_id as "sourceEntityId",
               -- Business reference + party for every subledger the line can
               -- carry, resolved by LEFT JOIN in this one query. Each join is
               -- on a primary key AND company_id, so Company isolation holds
               -- and no row can trigger a follow-up lookup (no N+1).
               ts.settlement_number as "settlementNumber",
               tst.code as "settlementTraderCode",
               tst.name_en as "settlementTraderName",
               tst.name_ar as "settlementTraderNameAr",
               dr.reconciliation_number as "collectionNumber",
               drd.code as "collectionDriverCode",
               drd.name_en as "collectionDriverName",
               drd.name_ar as "collectionDriverNameAr",
               pp.period_reference as "payrollPeriodReference",
               ppay.payment_number as "payrollPaymentNumber",
               odfa.source_reference as "driverFeeAccrualReference",
               odfad.code as "driverFeeAccrualDriverCode",
               odfad.name_en as "driverFeeAccrualDriverName",
               odfp.payment_number as "driverFeePaymentNumber",
               odfpd.code as "driverFeePaymentDriverCode",
               odfpd.name_en as "driverFeePaymentDriverName",
               ge.expense_number as "generalExpenseNumber",
               ge.payee_name_snapshot as "generalExpensePayee",
               gep.payment_number as "generalExpensePaymentNumber",
               tc.collection_number as "traderCollectionNumber",
               tcr.code as "traderCollectionTraderCode",
               tcr.name_en as "traderCollectionTraderName",
               tcr.name_ar as "traderCollectionTraderNameAr"
          from journal_lines l
          join chart_of_accounts a on a.id=l.account_id and a.company_id=l.company_id
          left join traders t on t.id=l.trader_id and t.company_id=l.company_id
          left join drivers d on d.id=l.driver_id and d.company_id=l.company_id
          left join employees e on e.id=l.employee_id and e.company_id=l.company_id
          left join orders o on o.id=l.order_id and o.company_id=l.company_id
          left join trader_settlements ts
            on ts.id=l.trader_settlement_id and ts.company_id=l.company_id
          left join traders tst on tst.id=ts.trader_id and tst.company_id=ts.company_id
          left join driver_reconciliations dr
            on dr.id=l.driver_collection_id and dr.company_id=l.company_id
          left join drivers drd on drd.id=dr.driver_id and drd.company_id=dr.company_id
          left join payroll_periods pp
            on pp.id=l.payroll_period_id and pp.company_id=l.company_id
          left join payroll_payments ppay
            on ppay.id=l.payroll_payment_id and ppay.company_id=l.company_id
          left join outsourced_driver_fee_accruals odfa
            on odfa.id=l.outsourced_driver_fee_accrual_id and odfa.company_id=l.company_id
          left join drivers odfad on odfad.id=odfa.driver_id and odfad.company_id=odfa.company_id
          left join outsourced_driver_fee_payments odfp
            on odfp.id=l.outsourced_driver_fee_payment_id and odfp.company_id=l.company_id
          left join drivers odfpd on odfpd.id=odfp.driver_id and odfpd.company_id=odfp.company_id
          left join general_expenses ge
            on ge.id=l.general_expense_id and ge.company_id=l.company_id
          left join general_expense_payments gep
            on gep.id=l.general_expense_payment_id and gep.company_id=l.company_id
          left join trader_collections tc
            on tc.id=l.subledger_id and l.subledger_type='trader_collection'
           and tc.company_id=l.company_id
          left join traders tcr on tcr.id=tc.trader_id and tcr.company_id=tc.company_id
         where l.journal_entry_id=${journalId}::uuid and l.company_id=${companyId}::uuid
         order by l.line_number
      `.execute(transaction);
      return { ...header.rows[0], lines: lines.rows };
    });
  }
}
