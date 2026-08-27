import { createHash } from "node:crypto";
import { basename } from "node:path";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { AppConfiguration } from "../configuration/environment.js";
import { FileStoragePort } from "../files/file-storage.port.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import { GeneralExpenseAccountingEventWriter } from "./general-expense-accounting-event.writer.js";
import { GeneralExpenseQueryService } from "./general-expense-query.service.js";
import type {
  CreateGeneralExpenseCategoryDto,
  CreateGeneralExpenseDto,
  GeneralExpenseAttachmentDto,
  GeneralExpenseAttachmentUploadDto,
  GeneralExpenseLineDto,
  GeneralExpenseReasonDto,
  UpdateGeneralExpenseCategoryDto,
  UpdateGeneralExpenseDto,
} from "./general-expense.dto.js";

interface ExpenseRecord {
  readonly accountingDate: string | null;
  readonly approvedBy: string | null;
  readonly approvedAmount: string;
  readonly categoryId: string | null;
  readonly correlationId: string;
  readonly createdBy: string;
  readonly expenseDate: string | null;
  readonly expenseNumber: string;
  readonly id: string;
  readonly paidAmount: string;
  readonly paymentStatus: string;
  readonly status: string;
  readonly totalAmount: string;
  readonly version: string;
}

interface CategoryRecord {
  readonly code: string;
  readonly defaultExpenseMappingKey: string;
  readonly defaultVatTreatment: string;
  readonly id: string;
  readonly isActive: boolean;
  readonly nameAr: string | null;
  readonly nameEn: string;
}

interface CalculatedLine {
  readonly category: CategoryRecord;
  readonly expenseCostAmount: string;
  readonly grossAmount: string;
  readonly input: GeneralExpenseLineDto;
  readonly netAmount: string;
  readonly nonrecoverableVatAmount: string;
  readonly recoverableVatAmount: string;
  readonly vatAmount: string;
  readonly vatRate: string;
}

function reason(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ApplicationException(
      "accounting_general_expense_reason_required",
      "A reason is required",
      HttpStatus.BAD_REQUEST,
    );
  }
  return normalized;
}

function decimal(value: string, code: string): Decimal {
  try {
    const result = new Decimal(value);
    if (!result.isFinite()) throw new Error("non-finite");
    return result;
  } catch {
    throw new ApplicationException(
      code,
      "A valid decimal value is required",
      HttpStatus.BAD_REQUEST,
    );
  }
}

@Injectable()
export class GeneralExpenseService {
  private readonly storageProvider: string;

  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
    @Inject(AccountingOperationSupport) private readonly support: AccountingOperationSupport,
    @Inject(GeneralExpenseAccountingEventWriter)
    private readonly eventWriter: GeneralExpenseAccountingEventWriter,
    @Inject(GeneralExpenseQueryService)
    private readonly queries: GeneralExpenseQueryService,
    @Inject(FileStoragePort) private readonly storage: FileStoragePort,
    @Inject(ConfigService) configuration: ConfigService<AppConfiguration, true>,
  ) {
    this.storageProvider = configuration.get("files.provider", { infer: true });
  }

  public async createCategory(input: CreateGeneralExpenseCategoryDto, idempotencyKey?: string) {
    this.support.assertPermission("accounting.manage");
    const context = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "general_expense_category.create",
        payload: input,
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      await this.assertCategoryMapping(
        transaction,
        input.defaultExpenseMappingKey,
        input.effectiveFrom,
      );

      // Auto-generate code if not provided
      let finalCode = input.code?.trim().toUpperCase();
      if (!finalCode) {
        finalCode = await this.generateNextCategoryCode(transaction, context.companyId);
      }

      const result = await sql<{ id: string }>`
        insert into general_expense_categories (
          company_id,code,name_en,name_ar,description,
          default_expense_mapping_key,default_vat_treatment,
          effective_from,effective_to,created_by_account_id
        ) values (
          ${context.companyId}::uuid,${finalCode},
          ${input.nameEn.trim()},${input.nameAr?.trim() || null},
          ${input.description?.trim() || null},${input.defaultExpenseMappingKey.trim()},
          ${input.defaultVatTreatment},${input.effectiveFrom}::date,
          ${input.effectiveTo ?? null}::date,${context.actorId}::uuid
        )
        returning id
      `.execute(transaction);
      const id = result.rows[0]!.id;
      const response = { id };
      await this.support.audit(transaction, {
        action: "general_expense_category_created",
        after: { ...input, code: finalCode },
        correlationId: id,
        subjectId: id,
        subjectType: "general_expense_category",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "general_expense_category.create",
        resourceId: id,
        resourceType: "general_expense_category",
        responseBody: response,
      });
      return response;
    });
  }

  /**
   * Generate the next available expense category code in the format EXP-000001.
   * Queries existing codes in this company and returns the next sequential number.
   */
  private async generateNextCategoryCode(transaction: Kysely<DatabaseSchema>, companyId: string): Promise<string> {
    const result = await sql<{ maxNumber: number | null }>`
      select max(
        cast(substring(code from 5) as integer)
      ) as "maxNumber"
      from general_expense_categories
      where company_id = ${companyId}::uuid
        and code ~ '^EXP-[0-9]{6}$'
    `.execute(transaction);

    const maxNumber = result.rows[0]?.maxNumber ?? 0;
    const nextNumber = maxNumber + 1;
    return `EXP-${String(nextNumber).padStart(6, "0")}`;
  }

  public async updateCategory(
    categoryId: string,
    input: UpdateGeneralExpenseCategoryDto,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.manage");
    const context = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "general_expense_category.update",
        payload: { categoryId, ...input },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      await this.assertCategoryMapping(
        transaction,
        input.defaultExpenseMappingKey,
        input.effectiveFrom,
      );
      const updated = await sql<{ id: string; version: string }>`
        update general_expense_categories
           set code=${input.code.trim().toUpperCase()},name_en=${input.nameEn.trim()},
               name_ar=${input.nameAr?.trim() || null},
               description=${input.description?.trim() || null},
               default_expense_mapping_key=${input.defaultExpenseMappingKey.trim()},
               default_vat_treatment=${input.defaultVatTreatment},
               effective_from=${input.effectiveFrom}::date,
               effective_to=${input.effectiveTo ?? null}::date,
               updated_at=now(),version=version+1
         where id=${categoryId}::uuid and company_id=${context.companyId}::uuid
           and version=${input.version} and is_active
         returning id,version::text
      `.execute(transaction);
      const row = updated.rows[0];
      if (row === undefined) this.staleOrMissing("accounting_general_expense_category_not_found");
      const response = { id: row.id, version: row.version };
      await this.support.audit(transaction, {
        action: "general_expense_category_updated",
        after: response,
        correlationId: categoryId,
        subjectId: categoryId,
        subjectType: "general_expense_category",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "general_expense_category.update",
        resourceId: categoryId,
        resourceType: "general_expense_category",
        responseBody: response,
      });
      return response;
    });
  }

  public async deactivateCategory(
    categoryId: string,
    input: GeneralExpenseReasonDto,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.manage");
    const context = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "general_expense_category.deactivate",
        payload: { categoryId, ...input },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const updated = await sql<{ id: string; version: string }>`
        update general_expense_categories
           set is_active=false,deactivated_by_account_id=${context.actorId}::uuid,
               deactivated_at=now(),updated_at=now(),version=version+1
         where id=${categoryId}::uuid and company_id=${context.companyId}::uuid
           and version=${input.version} and is_active
         returning id,version::text
      `.execute(transaction);
      const row = updated.rows[0];
      if (row === undefined) this.staleOrMissing("accounting_general_expense_category_not_found");
      const response = { id: row.id, version: row.version };
      await this.support.audit(transaction, {
        action: "general_expense_category_deactivated",
        after: { ...response, reason: reason(input.reason) },
        correlationId: categoryId,
        subjectId: categoryId,
        subjectType: "general_expense_category",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "general_expense_category.deactivate",
        resourceId: categoryId,
        resourceType: "general_expense_category",
        responseBody: response,
      });
      return response;
    });
  }

  public async activateCategory(
    categoryId: string,
    input: GeneralExpenseReasonDto,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.manage");
    const context = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "general_expense_category.activate",
        payload: { categoryId, ...input },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const updated = await sql<{ id: string; version: string }>`
        update general_expense_categories
           set is_active=true,deactivated_by_account_id=null,deactivated_at=null,
               updated_at=now(),version=version+1
         where id=${categoryId}::uuid and company_id=${context.companyId}::uuid
           and version=${input.version} and not is_active
         returning id,version::text
      `.execute(transaction);
      const row = updated.rows[0];
      if (row === undefined) this.staleOrMissing("accounting_general_expense_category_not_found");
      const response = { id: row.id, version: row.version };
      await this.support.audit(transaction, {
        action: "general_expense_category_activated",
        after: { ...response, reason: reason(input.reason) },
        correlationId: categoryId,
        subjectId: categoryId,
        subjectType: "general_expense_category",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "general_expense_category.activate",
        resourceId: categoryId,
        resourceType: "general_expense_category",
        responseBody: response,
      });
      return response;
    });
  }

  public async create(input: CreateGeneralExpenseDto, idempotencyKey?: string) {
    this.support.assertPermission("accounting.manage");
    const context = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "general_expense.create",
        payload: input,
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const expenseNumber = await this.history.nextReferenceNumber(
        transaction,
        context.companyId,
        "general_expense",
        "EXP",
      );
      const headerCategory =
        input.categoryId === undefined
          ? undefined
          : await this.category(transaction, input.categoryId, input.expenseDate, false);
      const created = await sql<{ correlationId: string; id: string }>`
        insert into general_expenses (
          company_id,expense_number,expense_date,accounting_date,category_id,
          category_code_snapshot,category_name_en_snapshot,category_name_ar_snapshot,
          payee_type,payee_id,payee_name_snapshot,payee_contact_snapshot,
          description,reference_number,external_reference,vat_registration_number,
          tax_invoice_number,tax_invoice_date,notes,source_type,
          source_entity_type,source_entity_id,created_by_account_id,updated_by_account_id
        ) values (
          ${context.companyId}::uuid,${expenseNumber},${input.expenseDate ?? null}::date,
          ${input.accountingDate ?? input.expenseDate ?? null}::date,
          ${input.categoryId ?? null}::uuid,${headerCategory?.code ?? null},
          ${headerCategory?.nameEn ?? null},${headerCategory?.nameAr ?? null},
          ${input.payeeType ?? null},${input.payeeId ?? null}::uuid,
          ${input.payeeName?.trim() || null},${input.payeeContact?.trim() || null},
          ${input.description?.trim() || null},${input.referenceNumber?.trim() || null},
          ${input.externalReference?.trim() || null},
          ${input.vatRegistrationNumber?.trim() || null},
          ${input.taxInvoiceNumber?.trim() || null},${input.taxInvoiceDate ?? null}::date,
          ${input.notes?.trim() || null},${input.sourceType ?? "manual_general_expense"},
          ${input.sourceEntityType?.trim() || null},${input.sourceEntityId ?? null}::uuid,
          ${context.actorId}::uuid,${context.actorId}::uuid
        )
        returning id,correlation_id::text as "correlationId"
      `.execute(transaction);
      const row = created.rows[0]!;
      if ((input.lines?.length ?? 0) > 0) {
        await this.replaceLines(transaction, row.id, input.lines!);
      }
      const response = await this.detailFrom(transaction, row.id);
      await this.support.audit(transaction, {
        action: "general_expense_created",
        after: { expenseNumber, status: "draft", totalAmount: response.totalAmount },
        correlationId: row.correlationId,
        subjectId: row.id,
        subjectType: "general_expense",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "general_expense.create",
        resourceId: row.id,
        resourceType: "general_expense",
        responseBody: response,
      });
      return response;
    });
  }

  public async update(expenseId: string, input: UpdateGeneralExpenseDto, idempotencyKey?: string) {
    this.support.assertPermission("accounting.manage");
    const context = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "general_expense.update",
        payload: { expenseId, ...input },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const current = await this.lockedExpense(transaction, expenseId);
      if (current.status !== "draft") {
        this.conflict("accounting_general_expense_not_editable");
      }
      if (Number(current.version) !== input.version) {
        this.conflict("accounting_general_expense_stale_version");
      }
      const headerCategory =
        input.categoryId === undefined
          ? undefined
          : await this.category(transaction, input.categoryId, input.expenseDate, false);
      await sql`
        update general_expenses
           set expense_date=${input.expenseDate ?? null}::date,
               accounting_date=${input.accountingDate ?? input.expenseDate ?? null}::date,
               category_id=${input.categoryId ?? null}::uuid,
               category_code_snapshot=${headerCategory?.code ?? null},
               category_name_en_snapshot=${headerCategory?.nameEn ?? null},
               category_name_ar_snapshot=${headerCategory?.nameAr ?? null},
               payee_type=${input.payeeType ?? null},payee_id=${input.payeeId ?? null}::uuid,
               payee_name_snapshot=${input.payeeName?.trim() || null},
               payee_contact_snapshot=${input.payeeContact?.trim() || null},
               description=${input.description?.trim() || null},
               reference_number=${input.referenceNumber?.trim() || null},
               external_reference=${input.externalReference?.trim() || null},
               vat_registration_number=${input.vatRegistrationNumber?.trim() || null},
               tax_invoice_number=${input.taxInvoiceNumber?.trim() || null},
               tax_invoice_date=${input.taxInvoiceDate ?? null}::date,
               notes=${input.notes?.trim() || null},
               source_type=${input.sourceType ?? "manual_general_expense"},
               source_entity_type=${input.sourceEntityType?.trim() || null},
               source_entity_id=${input.sourceEntityId ?? null}::uuid,
               updated_by_account_id=${context.actorId}::uuid,
               updated_at=now(),version=version+1
         where id=${expenseId}::uuid and company_id=${context.companyId}::uuid
      `.execute(transaction);
      if (input.lines !== undefined) await this.replaceLines(transaction, expenseId, input.lines);
      const response = await this.detailFrom(transaction, expenseId);
      await this.support.audit(transaction, {
        action: "general_expense_updated",
        after: {
          status: response.status,
          totalAmount: response.totalAmount,
          version: response.version,
        },
        correlationId: current.correlationId,
        subjectId: expenseId,
        subjectType: "general_expense",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "general_expense.update",
        resourceId: expenseId,
        resourceType: "general_expense",
        responseBody: response,
      });
      return response;
    });
  }

  public async validate(expenseId: string) {
    this.support.assertAnyPermission("accounting.view", "accounting.manage");
    return this.transactions.execute(async (transaction) => {
      const expense = await this.lockedExpense(transaction, expenseId);
      const issues = await this.validationIssues(transaction, expense);
      return { expenseId, issues, valid: issues.length === 0 };
    });
  }

  public submit(expenseId: string, input: GeneralExpenseReasonDto, key?: string) {
    return this.transition(expenseId, input, key, "submit");
  }

  public withdraw(expenseId: string, input: GeneralExpenseReasonDto, key?: string) {
    return this.transition(expenseId, input, key, "withdraw");
  }

  public reject(expenseId: string, input: GeneralExpenseReasonDto, key?: string) {
    return this.transition(expenseId, input, key, "reject");
  }

  public returnToDraft(expenseId: string, input: GeneralExpenseReasonDto, key?: string) {
    return this.transition(expenseId, input, key, "return_to_draft");
  }

  public cancel(expenseId: string, input: GeneralExpenseReasonDto, key?: string) {
    return this.transition(expenseId, input, key, "cancel");
  }

  public async approve(expenseId: string, input: GeneralExpenseReasonDto, idempotencyKey?: string) {
    this.support.assertPermission("accounting.approve");
    const context = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "general_expense.approve",
        payload: { expenseId, ...input },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const expense = await this.lockedExpense(transaction, expenseId);
      if (expense.status !== "submitted")
        this.conflict("accounting_general_expense_not_approvable");
      if (Number(expense.version) !== input.version)
        this.conflict("accounting_general_expense_stale_version");
      const issues = await this.validationIssues(transaction, expense);
      if (issues.length > 0) {
        throw new ApplicationException(
          "accounting_general_expense_not_approvable",
          `The Expense has validation issues: ${issues.join(", ")}`,
          HttpStatus.CONFLICT,
        );
      }
      await this.support.enforceApprovalSegregation(transaction, expense.createdBy);
      await sql`
        update general_expenses
           set status='approved',payment_status='unpaid',
               approved_amount=total_amount,outstanding_amount=total_amount,
               approved_by_account_id=${context.actorId}::uuid,approved_at=now(),
               updated_by_account_id=${context.actorId}::uuid,updated_at=now(),
               version=version+1
         where id=${expenseId}::uuid and company_id=${context.companyId}::uuid
      `.execute(transaction);
      const updated = await this.lockedExpense(transaction, expenseId);
      const eventId = await this.eventWriter.enqueue(transaction, {
        accountingDate: updated.accountingDate!,
        actorId: context.actorId,
        companyId: context.companyId,
        correlationId: updated.correlationId,
        description: `General Expense ${updated.expenseNumber} approved`,
        eventType: "general_expense_approved",
        metadata: {
          approvedAmount: updated.approvedAmount,
          expenseNumber: updated.expenseNumber,
          reason: reason(input.reason),
        },
        sourceEntityId: expenseId,
        sourceEntityType: "general_expense",
        sourceReference: updated.expenseNumber,
      });
      const response = { eventId, ...(await this.detailFrom(transaction, expenseId)) };
      await this.support.audit(transaction, {
        action: "general_expense_approved",
        after: {
          approvedAmount: updated.approvedAmount,
          eventId,
          previousStatus: expense.status,
          status: updated.status,
        },
        correlationId: updated.correlationId,
        subjectId: expenseId,
        subjectType: "general_expense",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "general_expense.approve",
        resourceId: expenseId,
        resourceType: "general_expense",
        responseBody: response,
      });
      return response;
    });
  }

  public async reverse(expenseId: string, input: GeneralExpenseReasonDto, idempotencyKey?: string) {
    this.support.assertPermission("accounting.reverse");
    const context = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "general_expense.reverse",
        payload: { expenseId, ...input },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const expense = await this.lockedExpense(transaction, expenseId);
      if (!["approved", "partially_paid", "paid"].includes(expense.status)) {
        this.conflict(
          expense.status === "reversed"
            ? "accounting_general_expense_already_reversed"
            : "accounting_general_expense_not_reversible",
        );
      }
      if (Number(expense.version) !== input.version)
        this.conflict("accounting_general_expense_stale_version");
      if (!new Decimal(expense.paidAmount).isZero()) {
        this.conflict("accounting_general_expense_active_payments_block_reversal");
      }
      await this.support.enforceReversalSegregation(transaction, {
        approvedBy: expense.approvedBy,
        createdBy: expense.createdBy,
        postedBy: expense.approvedBy,
      });
      const originalEventId = await this.eventWriter.originalEventId(transaction, {
        companyId: context.companyId,
        eventType: "general_expense_approved",
        sourceEntityId: expenseId,
        sourceEntityType: "general_expense",
      });
      await sql`
        update general_expenses
           set status='reversed',payment_status='reversed',
               reversed_by_account_id=${context.actorId}::uuid,reversed_at=now(),
               reversal_reason=${reason(input.reason)},
               updated_by_account_id=${context.actorId}::uuid,updated_at=now(),
               version=version+1
         where id=${expenseId}::uuid and company_id=${context.companyId}::uuid
      `.execute(transaction);
      const eventId = await this.eventWriter.enqueue(transaction, {
        accountingDate: input.accountingDate ?? expense.accountingDate!,
        actorId: context.actorId,
        companyId: context.companyId,
        correlationId: expense.correlationId,
        description: `General Expense ${expense.expenseNumber} reversed`,
        eventType: "general_expense_reversed",
        metadata: { expenseNumber: expense.expenseNumber, reason: reason(input.reason) },
        reversalOfEventId: originalEventId,
        sourceEntityId: expenseId,
        sourceEntityType: "general_expense",
        sourceReference: expense.expenseNumber,
      });
      const response = { eventId, ...(await this.detailFrom(transaction, expenseId)) };
      await this.support.audit(transaction, {
        action: "general_expense_reversed",
        after: { eventId, reason: reason(input.reason), status: "reversed" },
        correlationId: expense.correlationId,
        subjectId: expenseId,
        subjectType: "general_expense",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "general_expense.reverse",
        resourceId: expenseId,
        resourceType: "general_expense",
        responseBody: response,
      });
      return response;
    });
  }

  public async attach(
    expenseId: string,
    input: GeneralExpenseAttachmentDto,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.manage");
    const context = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "general_expense.attachment.link",
        payload: { expenseId, ...input },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const expense = await this.lockedExpense(transaction, expenseId);
      if (["cancelled", "reversed"].includes(expense.status)) {
        this.conflict("accounting_general_expense_attachment_not_allowed");
      }
      const file = await sql<{
        filename: string;
        mediaType: string;
        sizeBytes: string;
      }>`
        select original_filename as filename,media_type as "mediaType",
               size_bytes::text as "sizeBytes"
          from file_objects
         where id=${input.fileObjectId}::uuid and company_id=${context.companyId}::uuid
           and deleted_at is null and scan_status='clean'
         for share
      `.execute(transaction);
      const item = file.rows[0];
      if (item === undefined) {
        throw new ApplicationException(
          "accounting_general_expense_attachment_invalid",
          "The attachment is not an active clean Company file",
          HttpStatus.CONFLICT,
        );
      }
      if (input.paymentId !== undefined) {
        const payment = await sql<{ id: string }>`
          select id from general_expense_payments
           where id=${input.paymentId}::uuid and company_id=${context.companyId}::uuid
             and general_expense_id=${expenseId}::uuid
        `.execute(transaction);
        if (payment.rows[0] === undefined)
          this.conflict("accounting_general_expense_payment_not_found");
      }
      const inserted = await sql<{ id: string }>`
        insert into general_expense_attachments (
          company_id,general_expense_id,general_expense_payment_id,file_object_id,
          attachment_type,file_name_snapshot,media_type_snapshot,size_bytes_snapshot,
          description,uploaded_by_account_id
        ) values (
          ${context.companyId}::uuid,${expenseId}::uuid,${input.paymentId ?? null}::uuid,
          ${input.fileObjectId}::uuid,${input.attachmentType},${item.filename},
          ${item.mediaType},${item.sizeBytes}::bigint,${input.description?.trim() || null},
          ${context.actorId}::uuid
        )
        returning id
      `.execute(transaction);
      const id = inserted.rows[0]!.id;
      const response = { id };
      await this.support.audit(transaction, {
        action: "general_expense_attachment_linked",
        after: { attachmentType: input.attachmentType, paymentId: input.paymentId ?? null },
        correlationId: expense.correlationId,
        subjectId: expenseId,
        subjectType: "general_expense",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "general_expense.attachment.link",
        resourceId: id,
        resourceType: "general_expense_attachment",
        responseBody: response,
      });
      return response;
    });
  }

  public async deactivateAttachment(
    expenseId: string,
    attachmentId: string,
    input: GeneralExpenseReasonDto,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.manage");
    const context = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "general_expense.attachment.deactivate",
        payload: { attachmentId, expenseId, ...input },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const expense = await this.lockedExpense(transaction, expenseId);
      if (!["draft", "rejected"].includes(expense.status)) {
        this.conflict("accounting_general_expense_attachment_history_immutable");
      }
      if (Number(expense.version) !== input.version) {
        this.conflict("accounting_general_expense_stale_version");
      }
      const updated = await sql<{ id: string }>`
        update general_expense_attachments
           set is_active=false,deactivated_by_account_id=${context.actorId}::uuid,
               deactivated_at=now()
         where id=${attachmentId}::uuid and company_id=${context.companyId}::uuid
           and general_expense_id=${expenseId}::uuid and is_active
         returning id
      `.execute(transaction);
      if (updated.rows[0] === undefined) {
        this.conflict("accounting_general_expense_attachment_invalid");
      }
      const response = { id: attachmentId, isActive: false };
      await this.support.audit(transaction, {
        action: "general_expense_attachment_deactivated",
        after: { ...response, reason: reason(input.reason) },
        correlationId: expense.correlationId,
        subjectId: expenseId,
        subjectType: "general_expense",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "general_expense.attachment.deactivate",
        resourceId: attachmentId,
        resourceType: "general_expense_attachment",
        responseBody: response,
      });
      return response;
    });
  }

  public async uploadAttachment(
    expenseId: string,
    input: GeneralExpenseAttachmentUploadDto,
    file: {
      readonly buffer: Buffer;
      readonly mimetype?: string;
      readonly originalname?: string;
    },
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.manage");
    const context = this.support.context();
    const bytes = file.buffer ?? Buffer.alloc(0);
    const mediaType = this.attachmentMediaType(bytes, file.mimetype);
    const originalFilename = this.safeAttachmentFilename(file.originalname, mediaType);
    const stored = await this.storage.storePrivate(
      context.companyId,
      {
        contentType: mediaType,
        fileName: originalFilename,
        sizeBytes: bytes.length,
      },
      (async function* content() {
        yield bytes;
      })(),
    );
    try {
      return await this.transactions.execute(async (transaction) => {
        const reservation = await this.support.reserveIdempotency(transaction, {
          idempotencyKey,
          operation: "general_expense.attachment.upload",
          payload: {
            expenseId,
            ...input,
            fileHash: createHash("sha256").update(bytes).digest("hex"),
            mediaType,
            originalFilename,
          },
        });
        if (reservation.replayResponse !== undefined) {
          await this.storage.deletePrivate(context.companyId, stored.storageKey);
          return reservation.replayResponse;
        }
        const expense = await this.lockedExpense(transaction, expenseId);
        if (["cancelled", "reversed"].includes(expense.status)) {
          this.conflict("accounting_general_expense_attachment_not_allowed");
        }
        if (input.paymentId !== undefined) {
          const payment = await sql<{ id: string }>`
            select id from general_expense_payments
             where id=${input.paymentId}::uuid and company_id=${context.companyId}::uuid
               and general_expense_id=${expenseId}::uuid
          `.execute(transaction);
          if (payment.rows[0] === undefined) {
            this.conflict("accounting_general_expense_payment_not_found");
          }
        }
        const hash = createHash("sha256").update(bytes).digest("hex");
        const fileRecord = await sql<{ id: string }>`
          insert into file_objects (
            company_id,storage_provider,storage_key,original_filename,media_type,
            size_bytes,sha256,classification,scan_status,uploaded_by_account_id
          ) values (
            ${context.companyId}::uuid,${this.storageProvider},${stored.storageKey},
            ${originalFilename},${mediaType},${bytes.length},${hash},
            'private','clean',${context.actorId}::uuid
          )
          returning id
        `.execute(transaction);
        const fileObjectId = fileRecord.rows[0]!.id;
        const attachment = await sql<{ id: string }>`
          insert into general_expense_attachments (
            company_id,general_expense_id,general_expense_payment_id,file_object_id,
            attachment_type,file_name_snapshot,media_type_snapshot,size_bytes_snapshot,
            description,uploaded_by_account_id
          ) values (
            ${context.companyId}::uuid,${expenseId}::uuid,
            ${input.paymentId ?? null}::uuid,${fileObjectId}::uuid,
            ${input.attachmentType},${originalFilename},${mediaType},${bytes.length},
            ${input.description?.trim() || null},${context.actorId}::uuid
          )
          returning id
        `.execute(transaction);
        const response = {
          fileObjectId,
          id: attachment.rows[0]!.id,
          mediaType,
          originalFilename,
          sizeBytes: bytes.length,
        };
        await this.support.audit(transaction, {
          action: "general_expense_attachment_uploaded",
          after: {
            attachmentType: input.attachmentType,
            fileObjectId,
            mediaType,
            paymentId: input.paymentId ?? null,
            sizeBytes: bytes.length,
          },
          correlationId: expense.correlationId,
          subjectId: expenseId,
          subjectType: "general_expense",
        });
        await this.support.completeIdempotency(transaction, {
          idempotencyKey: idempotencyKey!,
          operation: "general_expense.attachment.upload",
          resourceId: attachment.rows[0]!.id,
          resourceType: "general_expense_attachment",
          responseBody: response,
        });
        return response;
      });
    } catch (error) {
      await this.storage.deletePrivate(context.companyId, stored.storageKey).catch(() => undefined);
      throw error;
    }
  }

  public async attachmentContent(attachmentId: string) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const result = await sql<{
      fileName: string;
      mediaType: string;
      storageKey: string;
    }>`
      select a.file_name_snapshot as "fileName",
             a.media_type_snapshot as "mediaType",f.storage_key as "storageKey"
        from general_expense_attachments a
        join file_objects f
          on f.id=a.file_object_id and f.company_id=a.company_id
       where a.id=${attachmentId}::uuid and a.company_id=${companyId}::uuid
         and a.is_active and f.deleted_at is null
    `.execute(this.database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "accounting_general_expense_attachment_invalid",
        "The General Expense attachment was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return {
      bytes: await this.storage.readPrivate(companyId, row.storageKey),
      fileName: row.fileName,
      mediaType: row.mediaType,
    };
  }

  private async transition(
    expenseId: string,
    input: GeneralExpenseReasonDto,
    idempotencyKey: string | undefined,
    action: "cancel" | "reject" | "return_to_draft" | "submit" | "withdraw",
  ) {
    this.support.assertPermission(action === "reject" ? "accounting.approve" : "accounting.manage");
    const context = this.support.context();
    const transitions = {
      cancel: { allowed: ["draft", "submitted", "rejected"], target: "cancelled" },
      reject: { allowed: ["submitted"], target: "rejected" },
      return_to_draft: { allowed: ["rejected"], target: "draft" },
      submit: { allowed: ["draft"], target: "submitted" },
      withdraw: { allowed: ["submitted"], target: "draft" },
    } as const;
    return this.transactions.execute(async (transaction) => {
      const operation = `general_expense.${action}`;
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation,
        payload: { expenseId, ...input },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;
      const expense = await this.lockedExpense(transaction, expenseId);
      if (Number(expense.version) !== input.version)
        this.conflict("accounting_general_expense_stale_version");
      const rule = transitions[action];
      if (!(rule.allowed as readonly string[]).includes(expense.status)) {
        this.conflict(
          `accounting_general_expense_not_${action === "submit" ? "submittable" : action + "able"}`,
        );
      }
      if (action === "submit") {
        const issues = await this.validationIssues(transaction, expense);
        if (issues.length > 0) {
          throw new ApplicationException(
            "accounting_general_expense_not_submittable",
            `The Expense has validation issues: ${issues.join(", ")}`,
            HttpStatus.CONFLICT,
          );
        }
      }
      const normalizedReason = reason(input.reason);
      await sql`
        update general_expenses set
          status=${rule.target},
          submitted_by_account_id=case when ${action}='submit' then ${context.actorId}::uuid
            when ${action} in ('withdraw','return_to_draft') then null else submitted_by_account_id end,
          submitted_at=case when ${action}='submit' then now()
            when ${action} in ('withdraw','return_to_draft') then null else submitted_at end,
          rejected_by_account_id=case when ${action}='reject' then ${context.actorId}::uuid
            when ${action}='return_to_draft' then null else rejected_by_account_id end,
          rejected_at=case when ${action}='reject' then now()
            when ${action}='return_to_draft' then null else rejected_at end,
          rejection_reason=case when ${action}='reject' then ${normalizedReason}
            when ${action}='return_to_draft' then null else rejection_reason end,
          cancelled_by_account_id=case when ${action}='cancel' then ${context.actorId}::uuid
            else cancelled_by_account_id end,
          cancelled_at=case when ${action}='cancel' then now() else cancelled_at end,
          cancellation_reason=case when ${action}='cancel' then ${normalizedReason}
            else cancellation_reason end,
          updated_by_account_id=${context.actorId}::uuid,updated_at=now(),version=version+1
        where id=${expenseId}::uuid and company_id=${context.companyId}::uuid
      `.execute(transaction);
      const response = await this.detailFrom(transaction, expenseId);
      await this.support.audit(transaction, {
        action: `general_expense_${action}`,
        after: { previousStatus: expense.status, reason: normalizedReason, status: rule.target },
        correlationId: expense.correlationId,
        subjectId: expenseId,
        subjectType: "general_expense",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation,
        resourceId: expenseId,
        resourceType: "general_expense",
        responseBody: response,
      });
      return response;
    });
  }

  private async replaceLines(
    database: Kysely<DatabaseSchema>,
    expenseId: string,
    inputs: readonly GeneralExpenseLineDto[],
  ): Promise<void> {
    const context = this.support.context();
    const calculated: CalculatedLine[] = [];
    for (const input of inputs) {
      calculated.push(await this.calculateLine(database, input));
    }
    await sql`
      delete from general_expense_lines
       where company_id=${context.companyId}::uuid
         and general_expense_id=${expenseId}::uuid
    `.execute(database);
    let lineNumber = 0;
    for (const line of calculated) {
      lineNumber += 1;
      await sql`
        insert into general_expense_lines (
          company_id,general_expense_id,line_number,category_id,
          category_code_snapshot,category_name_en_snapshot,category_name_ar_snapshot,
          description,quantity,unit_amount,net_amount,vat_treatment,vat_rate,
          vat_amount,recoverable_vat_amount,nonrecoverable_vat_amount,
          gross_amount,expense_cost_amount,expense_account_mapping_key,
          trader_id,driver_id,employee_id,order_id,
          created_by_account_id,updated_by_account_id
        ) values (
          ${context.companyId}::uuid,${expenseId}::uuid,${lineNumber},
          ${line.input.categoryId}::uuid,${line.category.code},${line.category.nameEn},
          ${line.category.nameAr},${line.input.description.trim()},
          ${line.input.quantity}::numeric,${line.input.unitAmount}::numeric,
          ${line.netAmount}::numeric,${line.input.vatTreatment},${line.vatRate}::numeric,
          ${line.vatAmount}::numeric,${line.recoverableVatAmount}::numeric,
          ${line.nonrecoverableVatAmount}::numeric,${line.grossAmount}::numeric,
          ${line.expenseCostAmount}::numeric,
          ${line.input.expenseAccountMappingKey?.trim() || line.category.defaultExpenseMappingKey},
          ${line.input.traderId ?? null}::uuid,${line.input.driverId ?? null}::uuid,
          ${line.input.employeeId ?? null}::uuid,${line.input.orderId ?? null}::uuid,
          ${context.actorId}::uuid,${context.actorId}::uuid
        )
      `.execute(database);
    }
    const totals = calculated.reduce(
      (current, line) => ({
        net: current.net.plus(line.netAmount),
        nonrecoverable: current.nonrecoverable.plus(line.nonrecoverableVatAmount),
        recoverable: current.recoverable.plus(line.recoverableVatAmount),
        total: current.total.plus(line.grossAmount),
        vat: current.vat.plus(line.vatAmount),
      }),
      {
        net: new Decimal(0),
        nonrecoverable: new Decimal(0),
        recoverable: new Decimal(0),
        total: new Decimal(0),
        vat: new Decimal(0),
      },
    );
    await sql`
      update general_expenses
         set subtotal=${totals.net.toFixed(2)}::numeric,
             vat_amount=${totals.vat.toFixed(2)}::numeric,
             recoverable_vat_amount=${totals.recoverable.toFixed(2)}::numeric,
             nonrecoverable_vat_amount=${totals.nonrecoverable.toFixed(2)}::numeric,
             total_amount=${totals.total.toFixed(2)}::numeric,
             updated_at=now()
       where id=${expenseId}::uuid and company_id=${context.companyId}::uuid
    `.execute(database);
  }

  private async calculateLine(
    database: Kysely<DatabaseSchema>,
    input: GeneralExpenseLineDto,
  ): Promise<CalculatedLine> {
    const category = await this.category(database, input.categoryId, undefined, true);
    const quantity = decimal(input.quantity, "accounting_general_expense_invalid_quantity");
    const unit = decimal(input.unitAmount, "accounting_general_expense_invalid_unit_amount");
    const net = quantity.mul(unit).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    // greaterThan(0): Quantity and Net must be strictly positive, and
    // Decimal.isPositive() is a sign check that accepts zero — a zero-value
    // Expense line would later emit a zero Accounting component and be
    // rejected at posting time. Unit stays "not negative" so a zero unit
    // amount is caught through Net rather than on its own.
    if (
      !quantity.greaterThan(0) ||
      unit.isNegative() ||
      !net.greaterThan(0) ||
      net.greaterThan("9999999999999999.99")
    ) {
      this.conflict("accounting_general_expense_invalid_line");
    }
    let vatRate = decimal(input.vatRate, "accounting_general_expense_vat_rate_invalid");
    if (["zero_rated", "exempt", "out_of_scope"].includes(input.vatTreatment)) {
      vatRate = new Decimal(0);
    }
    if (vatRate.isNegative() || vatRate.greaterThan(100)) {
      this.conflict("accounting_general_expense_vat_rate_invalid");
    }
    const vat = net.mul(vatRate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    let recoverable = vat;
    if (input.vatTreatment === "non_recoverable") recoverable = new Decimal(0);
    if (input.vatTreatment === "partially_recoverable") {
      const percentage = decimal(
        input.recoverablePercentage ?? "",
        "accounting_general_expense_vat_recoverability_invalid",
      );
      if (percentage.isNegative() || percentage.greaterThan(100)) {
        this.conflict("accounting_general_expense_vat_recoverability_invalid");
      }
      recoverable = vat.mul(percentage).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }
    const nonrecoverable = vat.minus(recoverable);
    return {
      category,
      expenseCostAmount: net.plus(nonrecoverable).toFixed(2),
      grossAmount: net.plus(vat).toFixed(2),
      input,
      netAmount: net.toFixed(2),
      nonrecoverableVatAmount: nonrecoverable.toFixed(2),
      recoverableVatAmount: recoverable.toFixed(2),
      vatAmount: vat.toFixed(2),
      vatRate: vatRate.toFixed(4),
    };
  }

  private async validationIssues(
    database: Kysely<DatabaseSchema>,
    expense: ExpenseRecord,
  ): Promise<string[]> {
    const context = this.support.context();
    const detail = await sql<{
      lineCount: string;
      payeeId: string | null;
      payeeName: string | null;
      payeeType: string | null;
    }>`
      select e.payee_type as "payeeType",e.payee_id as "payeeId",
             e.payee_name_snapshot as "payeeName",
             count(l.id)::text as "lineCount"
        from general_expenses e
        left join general_expense_lines l
          on l.company_id=e.company_id and l.general_expense_id=e.id
       where e.id=${expense.id}::uuid and e.company_id=${context.companyId}::uuid
       group by e.id
    `.execute(database);
    const row = detail.rows[0]!;
    const issues: string[] = [];
    if (expense.expenseDate === null) issues.push("expense_date_required");
    if (expense.accountingDate === null) issues.push("accounting_date_required");
    if (expense.categoryId === null) issues.push("category_required");
    if (Number(row.lineCount) === 0) issues.push("expense_lines_required");
    if (row.payeeType === null) issues.push("payee_type_required");
    if ((row.payeeName?.trim() ?? "") === "" && row.payeeId === null) {
      issues.push("payee_name_required");
    }
    if (new Decimal(expense.totalAmount).lessThanOrEqualTo(0)) {
      issues.push("positive_total_required");
    }
    const dateState = await sql<{ taxInvoiceDateValid: boolean }>`
      select tax_invoice_date is null
             or tax_invoice_date <= (
               now() at time zone coalesce(
                 (select timezone from company_settings
                   where company_id=${context.companyId}::uuid),
                 'Asia/Dubai'
               )
             )::date
               as "taxInvoiceDateValid"
        from general_expenses
       where id=${expense.id}::uuid and company_id=${context.companyId}::uuid
    `.execute(database);
    if (!(dateState.rows[0]?.taxInvoiceDateValid ?? false)) {
      issues.push("tax_invoice_date_after_approval_date");
    }
    if (expense.categoryId !== null && expense.expenseDate !== null) {
      const categoryState = await sql<{ valid: boolean }>`
        select exists (
          select 1 from general_expense_categories
           where id=${expense.categoryId}::uuid
             and company_id=${context.companyId}::uuid and is_active
             and effective_from<=${expense.expenseDate}::date
             and coalesce(effective_to,'infinity'::date)>=${expense.expenseDate}::date
        ) and not exists (
          select 1 from general_expense_lines l
          join general_expense_categories c
            on c.id=l.category_id and c.company_id=l.company_id
           where l.company_id=${context.companyId}::uuid
             and l.general_expense_id=${expense.id}::uuid
             and (
               not c.is_active
               or c.effective_from>${expense.expenseDate}::date
               or coalesce(c.effective_to,'infinity'::date)<${expense.expenseDate}::date
             )
        ) as valid
      `.execute(database);
      if (!(categoryState.rows[0]?.valid ?? false)) {
        issues.push("category_inactive_or_not_effective");
      }
    }
    // Accounts must resolve BEFORE approval. Without this the Expense is
    // approved first and only fails later, during Accounting Event
    // processing, leaving an approved Expense with no Journal.
    const accountingDate = expense.accountingDate ?? expense.expenseDate;
    if (accountingDate !== null) {
      const mappingKeys = await sql<{ mappingKey: string | null }>`
        select distinct expense_account_mapping_key as "mappingKey"
          from general_expense_lines
         where company_id=${context.companyId}::uuid
           and general_expense_id=${expense.id}::uuid
      `.execute(database);
      for (const { mappingKey } of mappingKeys.rows) {
        const account = await this.queries.resolveMappingAccount(
          database,
          context.companyId,
          mappingKey,
          accountingDate,
          "debit",
        );
        if (account.issue !== null) issues.push(`expense_account_${account.status}`);
      }
      const payable = await this.queries.resolveMappingAccount(
        database,
        context.companyId,
        "general_expense_payable",
        accountingDate,
        "credit",
      );
      if (payable.issue !== null) issues.push(`payable_account_${payable.status}`);
    }
    if (row.payeeId !== null && row.payeeType !== null) {
      const entityTables: Readonly<Record<string, string>> = {
        driver: "drivers",
        employee: "employees",
        trader: "traders",
      };
      const table = entityTables[row.payeeType];
      if (table === undefined) {
        issues.push("linked_payee_type_unsupported");
      } else {
        const found = await sql<{ found: boolean }>`
          select exists (
            select 1 from ${sql.table(table)}
             where id=${row.payeeId}::uuid and company_id=${context.companyId}::uuid
          ) as found
        `.execute(database);
        if (!(found.rows[0]?.found ?? false)) issues.push("linked_payee_not_found");
      }
    }
    return issues;
  }

  private async category(
    database: Kysely<DatabaseSchema>,
    categoryId: string,
    expenseDate: string | undefined,
    requireActive: boolean,
  ): Promise<CategoryRecord> {
    const { companyId } = this.support.context();
    const result = await sql<CategoryRecord>`
      select id,code,name_en as "nameEn",name_ar as "nameAr",
             default_expense_mapping_key as "defaultExpenseMappingKey",
             default_vat_treatment as "defaultVatTreatment",is_active as "isActive"
        from general_expense_categories
       where id=${categoryId}::uuid and company_id=${companyId}::uuid
         and (${requireActive} = false or is_active)
         and (${expenseDate ?? null}::date is null
              or (effective_from<=${expenseDate ?? null}::date
                  and coalesce(effective_to,'infinity'::date)>=${expenseDate ?? null}::date))
       for share
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        requireActive
          ? "accounting_general_expense_category_inactive"
          : "accounting_general_expense_category_not_found",
        "The Expense Category is unavailable",
        HttpStatus.CONFLICT,
      );
    }
    return row;
  }

  private async assertCategoryMapping(
    database: Kysely<DatabaseSchema>,
    mappingKey: string,
    effectiveDate: string,
  ): Promise<void> {
    const { companyId } = this.support.context();
    const result = await sql<{ valid: boolean }>`
      select exists (
        select 1 from account_mappings m
        join chart_of_accounts a
          on a.company_id=m.company_id
         and a.id=coalesce(m.expense_account_id,m.debit_account_id)
       where m.company_id=${companyId}::uuid and m.mapping_key=${mappingKey.trim()}
         and m.is_active and m.effective_from<=${effectiveDate}::date
         and coalesce(m.effective_to,'infinity'::date)>=${effectiveDate}::date
         and a.account_type='expense' and a.is_active and a.is_posting_account
      ) as valid
    `.execute(database);
    if (!(result.rows[0]?.valid ?? false)) {
      this.conflict("accounting_general_expense_category_mapping_invalid");
    }
  }

  private async lockedExpense(
    database: Kysely<DatabaseSchema>,
    expenseId: string,
  ): Promise<ExpenseRecord> {
    const { companyId } = this.support.context();
    const result = await sql<ExpenseRecord>`
      select id,expense_number as "expenseNumber",expense_date::text as "expenseDate",
             accounting_date::text as "accountingDate",category_id as "categoryId",
             total_amount::text as "totalAmount",approved_amount::text as "approvedAmount",
             paid_amount::text as "paidAmount",status,payment_status as "paymentStatus",
             created_by_account_id as "createdBy",approved_by_account_id as "approvedBy",
             correlation_id::text as "correlationId",version::text
        from general_expenses
       where id=${expenseId}::uuid and company_id=${companyId}::uuid
       for update
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "accounting_general_expense_not_found",
        "The General Expense was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private async detailFrom(database: Kysely<DatabaseSchema>, expenseId: string) {
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select id,expense_number as "expenseNumber",expense_date as "expenseDate",
             accounting_date as "accountingDate",category_id as "categoryId",
             payee_type as "payeeType",payee_id as "payeeId",
             payee_name_snapshot as "payeeName",description,reference_number as "referenceNumber",
             subtotal::text,vat_amount::text as "vatAmount",
             recoverable_vat_amount::text as "recoverableVatAmount",
             nonrecoverable_vat_amount::text as "nonrecoverableVatAmount",
             total_amount::text as "totalAmount",approved_amount::text as "approvedAmount",
             paid_amount::text as "paidAmount",outstanding_amount::text as "outstandingAmount",
             status,payment_status as "paymentStatus",source_type as "sourceType",
             correlation_id as "correlationId",created_at as "createdAt",
             updated_at as "updatedAt",version::text
        from general_expenses
       where id=${expenseId}::uuid and company_id=${companyId}::uuid
    `.execute(database);
    return result.rows[0]!;
  }

  private conflict(code: string): never {
    throw new ApplicationException(
      code,
      "The General Expense operation is not allowed",
      HttpStatus.CONFLICT,
    );
  }

  private attachmentMediaType(bytes: Buffer, claimed?: string): string {
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
      throw new ApplicationException(
        "accounting_general_expense_attachment_invalid",
        "The attachment is empty or exceeds 10 MB",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const detected =
      bytes.subarray(0, 5).toString("ascii") === "%PDF-"
        ? "application/pdf"
        : bytes.length >= 8 &&
            bytes
              .subarray(0, 8)
              .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
          ? "image/png"
          : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
            ? "image/jpeg"
            : undefined;
    if (detected === undefined || (claimed !== undefined && claimed !== detected)) {
      throw new ApplicationException(
        "accounting_general_expense_attachment_invalid",
        "Only signature-validated PDF, PNG, and JPEG evidence is supported",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return detected;
  }

  private safeAttachmentFilename(value: string | undefined, mediaType: string): string {
    const extension =
      mediaType === "application/pdf" ? ".pdf" : mediaType === "image/png" ? ".png" : ".jpg";
    const cleaned = basename(value?.trim() || `expense-evidence${extension}`)
      .replace(/[^A-Za-z0-9._ -]/g, "_")
      .slice(0, 180);
    return cleaned.toLowerCase().endsWith(extension)
      ? cleaned
      : `${cleaned.replace(/\.[^.]+$/, "")}${extension}`;
  }

  private staleOrMissing(code: string): never {
    throw new ApplicationException(
      code,
      "The record was not found or has changed",
      HttpStatus.CONFLICT,
    );
  }
}
