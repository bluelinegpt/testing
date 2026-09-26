import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, type Transaction, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { AccountingEventType, CashBankMovementType } from "./accounting.constants.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import { BalanceEnforcementCoordinator } from "./balance-enforcement.coordinator.js";
import type { BalanceEnforcementResult } from "./balance-enforcement.coordinator.js";
import type {
  BankAccountMutationDto,
  CashAccountMutationDto,
  CashBankAttachmentDto,
  CashBankMovementMutationDto,
} from "./cash-bank.dto.js";

interface MovementRecord {
  readonly accountingDate: string;
  readonly amount: string;
  readonly classificationMappingKey: string | null;
  readonly confirmedBy: string | null;
  readonly correlationId: string;
  readonly createdBy: string;
  readonly destinationBankAccountId: string | null;
  readonly destinationCashAccountId: string | null;
  readonly feeAmount: string;
  readonly id: string;
  readonly movementDate: string;
  readonly movementNumber: string;
  readonly movementType: CashBankMovementType;
  readonly sourceBankAccountId: string | null;
  readonly sourceCashAccountId: string | null;
  readonly status: string;
  readonly version: string;
}

const eventTypeByMovement: Readonly<
  Record<Exclude<CashBankMovementType, "opening_balance">, AccountingEventType>
> = {
  bank_deposit: "bank_deposit_confirmed",
  bank_to_bank_transfer: "bank_to_bank_transfer_confirmed",
  bank_to_cash_transfer: "bank_to_cash_transfer_confirmed",
  bank_withdrawal: "bank_withdrawal_confirmed",
  cash_deposit: "cash_deposit_confirmed",
  cash_to_bank_transfer: "cash_to_bank_transfer_confirmed",
  cash_to_cash_transfer: "cash_to_cash_transfer_confirmed",
  cash_withdrawal: "cash_withdrawal_confirmed",
};

function decimal(value: string | undefined, code = "accounting_cash_bank_invalid_numeric_value") {
  try {
    const parsed = new Decimal(value ?? "0").toDecimalPlaces(2);
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw new ApplicationException(code, "A valid AED amount is required", HttpStatus.BAD_REQUEST);
  }
}

function nonempty(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length === 0 ? null : normalized;
}

@Injectable()
export class CashBankManagementService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(AccountingOperationSupport)
    private readonly support: AccountingOperationSupport,
    @Inject(BalanceEnforcementCoordinator)
    private readonly balanceEnforcement: BalanceEnforcementCoordinator,
  ) {}

  public async cashAccounts(activeOnly = false) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const rows = await sql<Record<string, unknown>>`
      select c.id,c.cash_account_code as code,c.cash_account_name as name,
             c.cash_account_name_ar as "nameAr",c.cash_account_type as type,
             c.location_or_custodian as "locationOrCustodian",
             c.linked_gl_account_id as "linkedGlAccountId",
             a.code as "linkedGlAccountCode",a.name_en as "linkedGlAccountName",
             c.currency,c.effective_from::text as "effectiveFrom",
             c.effective_to::text as "effectiveTo",c.description,
             c.is_active as "isActive",c.version::text
        from company_cash_accounts c
        join chart_of_accounts a on a.id=c.linked_gl_account_id and a.company_id=c.company_id
       where c.company_id=${companyId}::uuid and (${activeOnly}::boolean=false or c.is_active)
       order by c.is_active desc,c.cash_account_code
    `.execute(this.database);
    return rows.rows;
  }

  public async bankAccounts(activeOnly = false) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const rows = await sql<Record<string, unknown>>`
      select b.id,b.bank_account_code as code,b.account_name as "accountName",
             b.bank_name as "bankName",b.branch_name as "branchName",
             case when b.account_number is null then b.account_number_masked
                  else '***'||right(b.account_number,4) end as "maskedAccountNumber",
             case when b.iban is null then null else left(b.iban,4)||'********'||right(b.iban,4) end as "maskedIban",
             b.swift_code as "swiftCode",b.account_type as "accountType",
             b.linked_gl_account_id as "linkedGlAccountId",
             a.code as "linkedGlAccountCode",a.name_en as "linkedGlAccountName",
             b.currency,b.effective_from::text as "effectiveFrom",
             b.effective_to::text as "effectiveTo",b.description,
             b.is_active as "isActive",b.version::text
        from company_bank_accounts b
        left join chart_of_accounts a on a.id=b.linked_gl_account_id and a.company_id=b.company_id
       where b.company_id=${companyId}::uuid and (${activeOnly}::boolean=false or b.is_active)
       order by b.is_active desc,b.bank_account_code
    `.execute(this.database);
    return rows.rows;
  }

  public async account(kind: "bank" | "cash", id: string) {
    const rows = kind === "cash" ? await this.cashAccounts(false) : await this.bankAccounts(false);
    const account = rows.find((row) => row.id === id);
    if (account === undefined) {
      throw new ApplicationException(
        kind === "cash" ? "accounting_cash_account_not_found" : "accounting_bank_account_not_found",
        kind === "cash" ? "The Cash Account was not found" : "The Bank Account was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const dependencies = await this.dependencies(kind, id);
    return { ...account, dependencies };
  }

  public async createCashAccount(input: CashAccountMutationDto, idempotencyKey?: string) {
    this.support.assertPermission("accounting.configuration.manage");
    return this.transactions.execute(async (transaction) => {
      const replay = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.cash-account.create",
        payload: input,
      });
      if (replay.replayResponse !== undefined) return replay.replayResponse;
      const { actorId, companyId } = this.support.context();
      await this.assertLinkedGl(transaction, input.linkedGlAccountId, "cash", input.effectiveFrom);
      const inserted = await sql<{ id: string }>`
        insert into company_cash_accounts(
          company_id,cash_account_code,cash_account_name,cash_account_name_ar,
          cash_account_type,branch_id,location_or_custodian,linked_gl_account_id,
          effective_from,effective_to,description,created_by_account_id
        ) values(
          ${companyId}::uuid,${input.code.trim()},${input.name.trim()},
          ${nonempty(input.nameAr)},${input.type},${input.branchId ?? null}::uuid,
          ${nonempty(input.locationOrCustodian)},${input.linkedGlAccountId}::uuid,
          ${input.effectiveFrom}::date,${input.effectiveTo ?? null}::date,
          ${nonempty(input.description)},${actorId}::uuid
        ) returning id
      `.execute(transaction);
      const response = { id: inserted.rows[0]!.id, code: input.code.trim(), isActive: true };
      await this.auditAndComplete(transaction, {
        action: "accounting.cash_account.created",
        correlationId: idempotencyKey ?? randomUUID(),
        idempotencyKey: idempotencyKey!,
        operation: "accounting.cash-account.create",
        response,
        resourceType: "company_cash_account",
      });
      return response;
    });
  }

  public async updateCashAccount(
    id: string,
    input: CashAccountMutationDto,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.configuration.manage");
    return this.transactions.execute(async (transaction) => {
      const replay = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.cash-account.update",
        payload: { id, ...input },
      });
      if (replay.replayResponse !== undefined) return replay.replayResponse;
      const { actorId, companyId } = this.support.context();
      await this.assertLinkedGl(transaction, input.linkedGlAccountId, "cash", input.effectiveFrom);
      const updated = await sql<{ id: string; version: string }>`
        update company_cash_accounts set
          cash_account_name=${input.name.trim()},cash_account_name_ar=${nonempty(input.nameAr)},
          cash_account_type=${input.type},branch_id=${input.branchId ?? null}::uuid,
          location_or_custodian=${nonempty(input.locationOrCustodian)},
          linked_gl_account_id=${input.linkedGlAccountId}::uuid,
          effective_from=${input.effectiveFrom}::date,effective_to=${input.effectiveTo ?? null}::date,
          description=${nonempty(input.description)},updated_by_account_id=${actorId}::uuid,
          updated_at=now(),version=version+1
        where id=${id}::uuid and company_id=${companyId}::uuid
          and (${input.version ?? null}::bigint is null or version=${input.version ?? null}::bigint)
        returning id,version::text
      `.execute(transaction);
      if (updated.rows[0] === undefined)
        this.conflict("accounting_cash_account_stale_or_not_found");
      const response = updated.rows[0]!;
      await this.auditAndComplete(transaction, {
        action: "accounting.cash_account.updated",
        correlationId: idempotencyKey ?? randomUUID(),
        idempotencyKey: idempotencyKey!,
        operation: "accounting.cash-account.update",
        response,
        resourceType: "company_cash_account",
      });
      return response;
    });
  }

  public async createBankAccount(input: BankAccountMutationDto, idempotencyKey?: string) {
    this.support.assertPermission("accounting.configuration.manage");
    return this.transactions.execute(async (transaction) => {
      const replay = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.bank-account.create",
        payload: input,
      });
      if (replay.replayResponse !== undefined) return replay.replayResponse;
      const { actorId, companyId } = this.support.context();
      await this.assertLinkedGl(transaction, input.linkedGlAccountId, "bank", input.effectiveFrom);
      const inserted = await sql<{ id: string }>`
        insert into company_bank_accounts(
          company_id,bank_account_code,account_name,bank_name,branch_name,
          account_number,account_number_masked,iban,swift_code,account_type,
          linked_gl_account_id,effective_from,effective_to,description,
          created_by_account_id
        ) values(
          ${companyId}::uuid,${input.code.trim()},${input.accountName.trim()},
          ${input.bankName.trim()},${nonempty(input.branchName)},
          ${nonempty(input.accountNumber)},
          ${input.accountNumber ? `***${input.accountNumber.slice(-4)}` : null},
          ${input.iban?.trim().toUpperCase() || null},
          ${input.swiftCode?.trim().toUpperCase() || null},${input.accountType},
          ${input.linkedGlAccountId}::uuid,${input.effectiveFrom}::date,
          ${input.effectiveTo ?? null}::date,${nonempty(input.description)},
          ${actorId}::uuid
        ) returning id
      `.execute(transaction);
      const response = { id: inserted.rows[0]!.id, code: input.code.trim(), isActive: true };
      await this.auditAndComplete(transaction, {
        action: "accounting.bank_account.created",
        correlationId: idempotencyKey ?? randomUUID(),
        idempotencyKey: idempotencyKey!,
        operation: "accounting.bank-account.create",
        response,
        resourceType: "company_bank_account",
      });
      return response;
    });
  }

  public async updateBankAccount(
    id: string,
    input: BankAccountMutationDto,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.configuration.manage");
    return this.transactions.execute(async (transaction) => {
      const replay = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.bank-account.update",
        payload: { id, ...input },
      });
      if (replay.replayResponse !== undefined) return replay.replayResponse;
      const { actorId, companyId } = this.support.context();
      await this.assertLinkedGl(transaction, input.linkedGlAccountId, "bank", input.effectiveFrom);
      const hasAccountNumber = Object.prototype.hasOwnProperty.call(input, "accountNumber");
      const accountNumber = nonempty(input.accountNumber);
      const accountNumberMasked = accountNumber === null ? null : `***${accountNumber.slice(-4)}`;
      const hasIban = Object.prototype.hasOwnProperty.call(input, "iban");
      const iban = input.iban?.trim().toUpperCase() || null;
      const updated = await sql<{ id: string; version: string }>`
        update company_bank_accounts set
          account_name=${input.accountName.trim()},bank_name=${input.bankName.trim()},
          branch_name=${nonempty(input.branchName)},
          account_number=case when ${hasAccountNumber} then ${accountNumber} else account_number end,
          account_number_masked=case when ${hasAccountNumber} then ${accountNumberMasked} else account_number_masked end,
          iban=case when ${hasIban} then ${iban} else iban end,
          swift_code=${input.swiftCode?.trim().toUpperCase() || null},
          account_type=${input.accountType},linked_gl_account_id=${input.linkedGlAccountId}::uuid,
          effective_from=${input.effectiveFrom}::date,effective_to=${input.effectiveTo ?? null}::date,
          description=${nonempty(input.description)},updated_by_account_id=${actorId}::uuid,
          updated_at=now(),version=version+1
        where id=${id}::uuid and company_id=${companyId}::uuid
          and (${input.version ?? null}::bigint is null or version=${input.version ?? null}::bigint)
        returning id,version::text
      `.execute(transaction);
      if (updated.rows[0] === undefined)
        this.conflict("accounting_bank_account_stale_or_not_found");
      const response = updated.rows[0]!;
      await this.auditAndComplete(transaction, {
        action: "accounting.bank_account.updated",
        correlationId: idempotencyKey ?? randomUUID(),
        idempotencyKey: idempotencyKey!,
        operation: "accounting.bank-account.update",
        response,
        resourceType: "company_bank_account",
      });
      return response;
    });
  }

  public async setAccountActive(
    kind: "cash" | "bank",
    id: string,
    active: boolean,
    reason: string,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.configuration.manage");
    return this.transactions.execute(async (transaction) => {
      const operation = `accounting.${kind}-account.${active ? "activate" : "deactivate"}`;
      const replay = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation,
        payload: { id, reason: reason.trim() },
      });
      if (replay.replayResponse !== undefined) return replay.replayResponse;
      const { actorId, companyId } = this.support.context();
      const dependencies = await this.accountDependencies(transaction, kind, id, true);
      if (!active && dependencies.blockers.length > 0) {
        throw new ApplicationException(
          "accounting_cash_bank_account_deactivation_blocked",
          "The Account has active Cash/Bank dependencies",
          HttpStatus.CONFLICT,
          dependencies.blockers,
        );
      }
      const updated =
        kind === "cash"
          ? await sql<{ id: string }>`
        update company_cash_accounts set is_active=${active},
          deactivated_by_account_id=case when ${active} then null else ${actorId}::uuid end,
          deactivated_at=case when ${active} then null else now() end,
          updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
        where id=${id}::uuid and company_id=${companyId}::uuid returning id
      `.execute(transaction)
          : await sql<{ id: string }>`
        update company_bank_accounts set is_active=${active},
          deactivated_by_account_id=case when ${active} then null else ${actorId}::uuid end,
          deactivated_at=case when ${active} then null else now() end,
          updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
        where id=${id}::uuid and company_id=${companyId}::uuid returning id
      `.execute(transaction);
      if (updated.rows[0] === undefined) this.notFound(`accounting_${kind}_account_not_found`);
      const response = { id, isActive: active };
      await this.auditAndComplete(transaction, {
        action: `accounting.${kind}_account.${active ? "activated" : "deactivated"}`,
        correlationId: idempotencyKey ?? randomUUID(),
        idempotencyKey: idempotencyKey!,
        operation,
        response: { ...response, reason: reason.trim() },
        resourceType: `company_${kind}_account`,
      });
      return response;
    });
  }

  public async dependencies(kind: "cash" | "bank", id: string) {
    this.support.assertPermission("accounting.view");
    return this.accountDependencies(this.database, kind, id, false);
  }

  public async createMovement(input: CashBankMovementMutationDto, idempotencyKey?: string) {
    this.support.assertPermission("accounting.manage");
    const amount = decimal(input.amount);
    const fee = decimal(input.feeAmount);
    // greaterThan(0): a Movement amount must be strictly positive, and
    // Decimal.isPositive() is a sign check that accepts zero. Fee stays
    // "not negative" — a zero fee is legitimate.
    if (!amount.greaterThan(0) || fee.isNegative()) {
      this.conflict("accounting_cash_bank_movement_invalid_amount");
    }
    return this.transactions.execute(async (transaction) => {
      const replay = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.cash-bank-movement.create",
        payload: input,
      });
      if (replay.replayResponse !== undefined) return replay.replayResponse;
      const { actorId, companyId } = this.support.context();
      const movementNumber = await this.nextMovementNumber(transaction);
      const movementId = randomUUID();
      await sql`
        insert into cash_bank_movements(
          id,company_id,movement_number,movement_type,movement_date,accounting_date,
          source_cash_account_id,source_bank_account_id,destination_cash_account_id,
          destination_bank_account_id,amount,fee_amount,fee_description,payment_method,
          source_classification,destination_classification,classification_mapping_key,
          reference_number,external_reference,description,correlation_id,
          idempotency_identity,created_by_account_id
        ) values(
          ${movementId}::uuid,${companyId}::uuid,${movementNumber},${input.movementType},
          ${input.movementDate}::date,${input.accountingDate}::date,
          ${input.sourceCashAccountId ?? null}::uuid,${input.sourceBankAccountId ?? null}::uuid,
          ${input.destinationCashAccountId ?? null}::uuid,
          ${input.destinationBankAccountId ?? null}::uuid,
          ${amount.toFixed(2)},${fee.toFixed(2)},${nonempty(input.feeDescription)},
          ${this.paymentMethod(input.movementType)},${nonempty(input.sourceClassification)},
          ${nonempty(input.destinationClassification)},${nonempty(input.classificationMappingKey)},
          ${nonempty(input.referenceNumber)},${nonempty(input.externalReference)},
          ${nonempty(input.description)},${idempotencyKey ?? randomUUID()},
          ${idempotencyKey!},${actorId}::uuid
        )
      `.execute(transaction);
      await this.linkAttachments(transaction, movementId, input.attachments ?? []);
      const response = { id: movementId, movementNumber, status: "draft", version: "1" };
      await this.auditAndComplete(transaction, {
        action: "accounting.cash_bank_movement.created",
        correlationId: idempotencyKey ?? movementId,
        idempotencyKey: idempotencyKey!,
        operation: "accounting.cash-bank-movement.create",
        response,
        resourceType: "cash_bank_movement",
      });
      return response;
    });
  }

  public async updateMovement(
    movementId: string,
    input: CashBankMovementMutationDto,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.manage");
    const amount = decimal(input.amount);
    const fee = decimal(input.feeAmount);
    // greaterThan(0): see createMovement — zero passes a sign check.
    if (!amount.greaterThan(0) || fee.isNegative())
      this.conflict("accounting_cash_bank_movement_invalid_amount");
    return this.transactions.execute(async (transaction) => {
      const replay = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.cash-bank-movement.update",
        payload: { movementId, ...input },
      });
      if (replay.replayResponse !== undefined) return replay.replayResponse;
      const { actorId, companyId } = this.support.context();
      const updated = await sql<{ id: string; version: string }>`
        update cash_bank_movements set
          movement_type=${input.movementType},movement_date=${input.movementDate}::date,
          accounting_date=${input.accountingDate}::date,
          source_cash_account_id=${input.sourceCashAccountId ?? null}::uuid,
          source_bank_account_id=${input.sourceBankAccountId ?? null}::uuid,
          destination_cash_account_id=${input.destinationCashAccountId ?? null}::uuid,
          destination_bank_account_id=${input.destinationBankAccountId ?? null}::uuid,
          amount=${amount.toFixed(2)},fee_amount=${fee.toFixed(2)},
          fee_description=${nonempty(input.feeDescription)},
          payment_method=${this.paymentMethod(input.movementType)},
          source_classification=${nonempty(input.sourceClassification)},
          destination_classification=${nonempty(input.destinationClassification)},
          classification_mapping_key=${nonempty(input.classificationMappingKey)},
          reference_number=${nonempty(input.referenceNumber)},
          external_reference=${nonempty(input.externalReference)},
          description=${nonempty(input.description)},updated_by_account_id=${actorId}::uuid,
          updated_at=now(),version=version+1
        where id=${movementId}::uuid and company_id=${companyId}::uuid and status='draft'
          and (${input.version ?? null}::bigint is null or version=${input.version ?? null}::bigint)
        returning id,version::text
      `.execute(transaction);
      if (updated.rows[0] === undefined)
        this.conflict("accounting_cash_bank_movement_not_editable");
      await this.linkAttachments(transaction, movementId, input.attachments ?? []);
      const response = updated.rows[0]!;
      await this.auditAndComplete(transaction, {
        action: "accounting.cash_bank_movement.updated",
        correlationId: idempotencyKey ?? movementId,
        idempotencyKey: idempotencyKey!,
        operation: "accounting.cash-bank-movement.update",
        response,
        resourceType: "cash_bank_movement",
      });
      return response;
    });
  }

  public async validateMovement(movementId: string) {
    this.support.assertPermission("accounting.manage");
    return this.transactions.execute(async (transaction) => {
      const movement = await this.lockMovement(transaction, movementId);
      const issues = await this.validationIssues(transaction, movement);
      return {
        issues,
        movementId,
        ready: issues.length === 0,
        sourceAvailableBalance: await this.sourceBalanceFor(transaction, movement),
        status: movement.status,
      };
    });
  }

  public async confirmMovement(
    movementId: string,
    note: string | undefined,
    idempotencyKey?: string,
    balanceOverrideReason?: string,
  ) {
    this.support.assertPermission("accounting.approve");
    return this.transactions.execute(async (transaction) => {
      // LOCK FIRST, then fingerprint what was locked.
      //
      // The reservation used to run before this, hashing only the Movement id,
      // the note and the override reason. A draft can be edited between
      // attempts -- `updateMovement` may change its amount, fee or either
      // account -- so the same key re-sent after an edit hashed identically and
      // replayed the ORIGINAL confirmation: the caller was told a Movement had
      // been confirmed on terms that no longer existed.
      //
      // Reserving after the row lock closes that. The `for update` here also
      // serialises two concurrent confirmations of the same Movement, so
      // reserving second loses nothing: the second caller waits for the lock,
      // then hashes the row as the first left it.
      const movement = await this.lockMovement(transaction, movementId);
      const replay = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.cash-bank-movement.confirm",
        // The financial state that was actually locked, not a reference to it.
        // The override reason belongs here too: re-sending one key with a
        // different reason asks for the Movement to be authorised on different
        // grounds, which is a different request.
        payload: {
          amount: movement.amount,
          balanceOverrideReason: nonempty(balanceOverrideReason),
          destinationBankAccountId: movement.destinationBankAccountId,
          destinationCashAccountId: movement.destinationCashAccountId,
          feeAmount: movement.feeAmount,
          movementId,
          movementType: movement.movementType,
          note: nonempty(note),
          sourceBankAccountId: movement.sourceBankAccountId,
          sourceCashAccountId: movement.sourceCashAccountId,
        },
      });
      // Returned before the draft-status check below: a genuine replay finds
      // the Movement already `confirmed`, and must be answered rather than
      // rejected as not-confirmable.
      if (replay.replayResponse !== undefined) return replay.replayResponse;
      if (movement.status !== "draft")
        this.conflict("accounting_cash_bank_movement_not_confirmable");
      await this.enforceConfirmationSegregation(transaction, movement.createdBy);
      await this.lockFinancialAccounts(transaction, movement);
      const issues = await this.validationIssues(transaction, movement);
      if (issues.length > 0) {
        throw new ApplicationException(
          "accounting_cash_bank_movement_invalid",
          "The Cash/Bank Movement is not ready for confirmation",
          HttpStatus.CONFLICT,
          issues,
        );
      }
      // Balance control on the SOURCE account only.
      //
      // This REPLACES the former `assertSourceBalance` call at this point. The
      // two could not both stand: that check read a Cash/Bank-module-only
      // balance and refused anything below zero unconditionally, so a Company
      // with a configured Bank overdraft, or an authorised override, would have
      // been blocked by it before the policy was ever consulted -- making the
      // policy dead on exactly the workflow where Bank sources are common.
      //
      // `assertSourceBalance` remains, unchanged, on the reversal path.
      const enforcement = await this.enforceSourceBalance(
        transaction,
        movement,
        balanceOverrideReason,
      );
      const { actorId, companyId } = this.support.context();
      const eventId = await this.enqueueEvent(
        transaction,
        movement,
        actorId,
        idempotencyKey ?? movementId,
      );
      const snapshot = await this.movementSnapshot(transaction, movement);
      await sql`
        update cash_bank_movements set status='confirmed',
          confirmed_by_account_id=${actorId}::uuid,confirmed_at=now(),
          confirmation_note=${nonempty(note)},original_snapshot=${JSON.stringify(snapshot)}::jsonb,
          accounting_event_id=${eventId}::uuid,updated_by_account_id=${actorId}::uuid,
          updated_at=now(),version=version+1
        where id=${movementId}::uuid and company_id=${companyId}::uuid and status='draft'
      `.execute(transaction);
      // Only now, with the Movement confirmed. Written earlier it would survive
      // a rolled-back confirmation as an accusation about money that never
      // moved.
      if (enforcement?.requiresOverrideAudit === true) {
        await this.balanceEnforcement.recordOverrides(transaction, {
          actorId,
          overrideReason: balanceOverrideReason ?? "",
          result: enforcement,
          sourceEntityId: movementId,
          sourceReference: movement.movementNumber,
          sourceType: "cash_bank_movement",
        });
      }
      const response = {
        accountingEventId: eventId,
        // Advisory, never blocking: the balance this Movement was judged
        // against excludes confirmed payments that never recorded which account
        // funded them. Absent when the Movement has no source to judge.
        ...(enforcement === null
          ? {}
          : {
              balanceCoverage: enforcement.coverage,
              balanceCoverageIncomplete: enforcement.balanceCoverageIncomplete,
            }),
        id: movementId,
        movementNumber: movement.movementNumber,
        status: "confirmed",
      };
      await this.auditAndComplete(transaction, {
        action: "accounting.cash_bank_movement.confirmed",
        correlationId: idempotencyKey ?? movement.correlationId,
        idempotencyKey: idempotencyKey!,
        operation: "accounting.cash-bank-movement.confirm",
        response,
        resourceType: "cash_bank_movement",
      });
      return response;
    });
  }

  public async cancelMovement(movementId: string, reason: string, idempotencyKey?: string) {
    this.support.assertPermission("accounting.manage");
    if (reason.trim().length === 0)
      this.conflict("accounting_cash_bank_cancellation_reason_required");
    return this.transactions.execute(async (transaction) => {
      const replay = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.cash-bank-movement.cancel",
        payload: { movementId, reason: reason.trim() },
      });
      if (replay.replayResponse !== undefined) return replay.replayResponse;
      const { actorId, companyId } = this.support.context();
      const updated = await sql<{ movementNumber: string }>`
        update cash_bank_movements set status='cancelled',
          cancelled_by_account_id=${actorId}::uuid,cancelled_at=now(),
          cancellation_reason=${reason.trim()},updated_by_account_id=${actorId}::uuid,
          updated_at=now(),version=version+1
        where id=${movementId}::uuid and company_id=${companyId}::uuid and status='draft'
        returning movement_number as "movementNumber"
      `.execute(transaction);
      if (updated.rows[0] === undefined)
        this.conflict("accounting_cash_bank_movement_not_cancellable");
      const response = {
        id: movementId,
        movementNumber: updated.rows[0]!.movementNumber,
        status: "cancelled",
      };
      await this.auditAndComplete(transaction, {
        action: "accounting.cash_bank_movement.cancelled",
        correlationId: idempotencyKey ?? movementId,
        idempotencyKey: idempotencyKey!,
        operation: "accounting.cash-bank-movement.cancel",
        response: { ...response, reason: reason.trim() },
        resourceType: "cash_bank_movement",
      });
      return response;
    });
  }

  public async reverseMovement(
    movementId: string,
    reversalDate: string,
    reason: string,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.reverse");
    if (reason.trim().length === 0) this.conflict("accounting_cash_bank_reversal_reason_required");
    return this.transactions.execute(async (transaction) => {
      const replay = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.cash-bank-movement.reverse",
        payload: { movementId, reason: reason.trim(), reversalDate },
      });
      if (replay.replayResponse !== undefined) return replay.replayResponse;
      const original = await this.lockMovement(transaction, movementId);
      if (original.status !== "confirmed")
        this.conflict("accounting_cash_bank_movement_not_reversible");
      await this.enforceMovementReversalSegregation(transaction, original);
      await this.assertOpenPeriod(transaction, reversalDate);
      await this.lockFinancialAccounts(transaction, original);
      const { actorId, companyId } = this.support.context();
      const reversed = this.reverseShape(original);
      const reversalNumber = await this.nextMovementNumber(transaction);
      const reversalId = randomUUID();
      const reversalRecord: MovementRecord = {
        ...original,
        accountingDate: reversalDate,
        confirmedBy: actorId,
        destinationBankAccountId: reversed.destinationBankAccountId,
        destinationCashAccountId: reversed.destinationCashAccountId,
        id: reversalId,
        feeAmount: "0.00",
        movementDate: reversalDate,
        movementNumber: reversalNumber,
        movementType: reversed.movementType,
        sourceBankAccountId: reversed.sourceBankAccountId,
        sourceCashAccountId: reversed.sourceCashAccountId,
        status: "confirmed",
      };
      await this.assertSourceBalance(transaction, reversalRecord);
      const originalEvent = await sql<{ id: string }>`
        select id from accounting_events
         where id=${await this.originalEventId(transaction, original)}::uuid
           and company_id=${companyId}::uuid for update
      `.execute(transaction);
      if (originalEvent.rows[0] === undefined)
        this.conflict("accounting_cash_bank_original_event_missing");
      const reversalEventId = await this.enqueueEvent(
        transaction,
        reversalRecord,
        actorId,
        idempotencyKey ?? reversalId,
        originalEvent.rows[0]!.id,
      );
      await sql`
        insert into cash_bank_movements(
          id,company_id,movement_number,movement_type,movement_date,accounting_date,
          source_cash_account_id,source_bank_account_id,destination_cash_account_id,
          destination_bank_account_id,amount,fee_amount,fee_description,payment_method,
          source_classification,destination_classification,classification_mapping_key,
          reference_number,external_reference,description,currency,status,correlation_id,
          idempotency_identity,reversal_of_movement_id,original_snapshot,accounting_event_id,
          created_by_account_id,confirmed_by_account_id,confirmed_at,confirmation_note
        ) select
          ${reversalId}::uuid,company_id,${reversalNumber},${reversed.movementType},
          ${reversalDate}::date,${reversalDate}::date,
          ${reversed.sourceCashAccountId}::uuid,${reversed.sourceBankAccountId}::uuid,
          ${reversed.destinationCashAccountId}::uuid,${reversed.destinationBankAccountId}::uuid,
          amount,fee_amount,fee_description,${this.paymentMethod(reversed.movementType)},
          destination_classification,source_classification,classification_mapping_key,
          reference_number,external_reference,'Reversal: '||coalesce(description,movement_number),
          currency,'confirmed',${idempotencyKey ?? reversalId},${idempotencyKey!},
          id,original_snapshot,${reversalEventId}::uuid,${actorId}::uuid,
          ${actorId}::uuid,now(),${reason.trim()}
        from cash_bank_movements
        where id=${movementId}::uuid and company_id=${companyId}::uuid
      `.execute(transaction);
      await sql`
        update cash_bank_movements set status='reversed',
          reversed_by_movement_id=${reversalId}::uuid,reversed_by_account_id=${actorId}::uuid,
          reversed_at=now(),reversal_reason=${reason.trim()},
          updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
        where id=${movementId}::uuid and company_id=${companyId}::uuid and status='confirmed'
      `.execute(transaction);
      const response = {
        originalMovementId: movementId,
        reversalMovementId: reversalId,
        reversalMovementNumber: reversalNumber,
        status: "reversed",
      };
      await this.auditAndComplete(transaction, {
        action: "accounting.cash_bank_movement.reversed",
        correlationId: idempotencyKey ?? reversalId,
        idempotencyKey: idempotencyKey!,
        operation: "accounting.cash-bank-movement.reverse",
        response: { ...response, reason: reason.trim() },
        resourceType: "cash_bank_movement",
      });
      return response;
    });
  }

  public async linkMovementAttachment(
    movementId: string,
    input: CashBankAttachmentDto,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.manage");
    return this.transactions.execute(async (transaction) => {
      const replay = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.cash-bank-attachment.link",
        payload: { movementId, ...input },
      });
      if (replay.replayResponse !== undefined) return replay.replayResponse;
      await this.lockMovement(transaction, movementId);
      const ids = await this.linkAttachments(transaction, movementId, [input]);
      const response = { id: ids[0]!, movementId };
      await this.auditAndComplete(transaction, {
        action: "accounting.cash_bank_attachment.linked",
        correlationId: idempotencyKey ?? movementId,
        idempotencyKey: idempotencyKey!,
        operation: "accounting.cash-bank-attachment.link",
        response,
        resourceType: "cash_bank_movement_attachment",
      });
      return response;
    });
  }

  private async assertLinkedGl(
    database: Kysely<DatabaseSchema>,
    accountId: string,
    accountClass: "cash" | "bank",
    effectiveDate: string,
  ) {
    const { companyId } = this.support.context();
    const result = await sql<{ id: string }>`
      select id from chart_of_accounts where id=${accountId}::uuid
       and company_id=${companyId}::uuid and account_type='asset'
       and account_class=${accountClass} and is_active and is_posting_account
       and effective_from<=${effectiveDate}::date
       and coalesce(effective_to,'infinity'::date)>=${effectiveDate}::date
    `.execute(database);
    if (result.rows[0] === undefined) this.conflict("accounting_cash_bank_linked_gl_invalid");
  }

  private validMovementStructure(
    input: Pick<
      MovementRecord,
      | "movementType"
      | "sourceCashAccountId"
      | "sourceBankAccountId"
      | "destinationCashAccountId"
      | "destinationBankAccountId"
      | "classificationMappingKey"
      | "feeAmount"
    >,
  ) {
    const fields = {
      db: input.destinationBankAccountId,
      dc: input.destinationCashAccountId,
      sb: input.sourceBankAccountId,
      sc: input.sourceCashAccountId,
    };
    const valid: Readonly<Record<CashBankMovementType, boolean>> = {
      bank_deposit:
        fields.db !== null && fields.dc === null && fields.sb === null && fields.sc === null,
      bank_to_bank_transfer:
        fields.sb !== null &&
        fields.db !== null &&
        fields.sb !== fields.db &&
        fields.sc === null &&
        fields.dc === null,
      bank_to_cash_transfer:
        fields.sb !== null && fields.dc !== null && fields.sc === null && fields.db === null,
      bank_withdrawal:
        fields.sb !== null && fields.sc === null && fields.dc === null && fields.db === null,
      cash_deposit:
        fields.dc !== null && fields.sc === null && fields.sb === null && fields.db === null,
      cash_to_bank_transfer:
        fields.sc !== null && fields.db !== null && fields.sb === null && fields.dc === null,
      cash_to_cash_transfer:
        fields.sc !== null &&
        fields.dc !== null &&
        fields.sc !== fields.dc &&
        fields.sb === null &&
        fields.db === null,
      cash_withdrawal:
        fields.sc !== null && fields.sb === null && fields.dc === null && fields.db === null,
      opening_balance:
        [fields.dc, fields.db].filter(Boolean).length === 1 &&
        fields.sc === null &&
        fields.sb === null,
    };
    const depositOrWithdrawal = [
      "cash_deposit",
      "bank_deposit",
      "cash_withdrawal",
      "bank_withdrawal",
    ].includes(input.movementType);
    const feeHasSource =
      new Decimal(input.feeAmount).isZero() || fields.sc !== null || fields.sb !== null;
    return (
      valid[input.movementType] &&
      feeHasSource &&
      (!depositOrWithdrawal || input.classificationMappingKey !== null)
    );
  }

  private paymentMethod(type: CashBankMovementType) {
    if (type.startsWith("cash_") && !type.includes("_to_")) return "cash";
    if (type.startsWith("bank_") && !type.includes("_to_")) return "visa";
    return type === "opening_balance" ? "internal_transfer" : "internal_transfer";
  }

  private async nextMovementNumber(database: Kysely<DatabaseSchema>) {
    const { companyId } = this.support.context();
    const result = await sql<{ value: number }>`
      insert into company_reference_counters(company_id,reference_type,next_value,prefix)
      values(${companyId}::uuid,'cash_bank_movement',2,'CBM')
      on conflict(company_id,reference_type) do update
        set next_value=company_reference_counters.next_value+1,updated_at=now()
      returning next_value-1 as value
    `.execute(database);
    return `CBM-${String(result.rows[0]!.value).padStart(6, "0")}`;
  }

  private async lockMovement(
    database: Kysely<DatabaseSchema>,
    id: string,
  ): Promise<MovementRecord> {
    const { companyId } = this.support.context();
    const result = await sql<MovementRecord>`
      select id,movement_number as "movementNumber",movement_type as "movementType",
             movement_date::text as "movementDate",accounting_date::text as "accountingDate",
             source_cash_account_id as "sourceCashAccountId",
             source_bank_account_id as "sourceBankAccountId",
             destination_cash_account_id as "destinationCashAccountId",
             destination_bank_account_id as "destinationBankAccountId",
             amount::text,fee_amount::text as "feeAmount",status,
             classification_mapping_key as "classificationMappingKey",
             created_by_account_id as "createdBy",confirmed_by_account_id as "confirmedBy",
             correlation_id as "correlationId",version::text
        from cash_bank_movements
       where id=${id}::uuid and company_id=${companyId}::uuid for update
    `.execute(database);
    if (result.rows[0] === undefined) this.notFound("accounting_cash_bank_movement_not_found");
    return result.rows[0]!;
  }

  private async lockFinancialAccounts(database: Kysely<DatabaseSchema>, movement: MovementRecord) {
    const ids = [
      movement.sourceCashAccountId,
      movement.sourceBankAccountId,
      movement.destinationCashAccountId,
      movement.destinationBankAccountId,
    ]
      .filter((id): id is string => id !== null)
      .sort();
    for (const id of ids) {
      await sql`select pg_advisory_xact_lock(hashtextextended('cash-bank-account:'||${id},0))`.execute(
        database,
      );
    }
  }

  private async validationIssues(database: Kysely<DatabaseSchema>, movement: MovementRecord) {
    const { companyId } = this.support.context();
    const issues: string[] = [];
    if (movement.status !== "draft") issues.push("movement_not_draft");
    if (!this.validMovementStructure(movement)) issues.push("invalid_source_destination_structure");
    const period = await sql<{ count: string }>`
      select count(*)::text as count from accounting_periods p
      join fiscal_years y on y.id=p.fiscal_year_id and y.company_id=p.company_id
      where p.company_id=${companyId}::uuid
       and ${movement.accountingDate}::date between p.period_start and p.period_end
       and p.status in('open','reopened') and y.status in('open','reopened')
    `.execute(database);
    if (period.rows[0]?.count !== "1") issues.push("period_unavailable");
    const accounts = await sql<{ invalid: string }>`
      select count(*)::text as invalid from (
        select id,is_active,effective_from,effective_to,currency from company_cash_accounts
         where company_id=${companyId}::uuid and id in (
           ${movement.sourceCashAccountId ?? null}::uuid,
           ${movement.destinationCashAccountId ?? null}::uuid
         )
        union all
        select id,is_active,effective_from,effective_to,currency from company_bank_accounts
         where company_id=${companyId}::uuid and id in (
           ${movement.sourceBankAccountId ?? null}::uuid,
           ${movement.destinationBankAccountId ?? null}::uuid
         )
      ) a where not a.is_active or a.currency<>'AED'
        or ${movement.movementDate}::date<a.effective_from
        or ${movement.movementDate}::date>coalesce(a.effective_to,'infinity'::date)
    `.execute(database);
    if (accounts.rows[0]?.invalid !== "0")
      issues.push("account_inactive_or_outside_effective_dates");
    if (!movement.movementType.includes("_to_") && movement.movementType !== "opening_balance") {
      const mapping = await sql<{ count: string }>`
        select count(*)::text as count from account_mappings
         where company_id=${companyId}::uuid and is_active
           and mapping_key=${movement.classificationMappingKey}
           and effective_from<=${movement.accountingDate}::date
           and coalesce(effective_to,'infinity'::date)>=${movement.accountingDate}::date
      `.execute(database);
      if (mapping.rows[0]?.count !== "1") {
        issues.push("classification_mapping_unavailable_or_ambiguous");
      }
    }
    return issues;
  }

  private async assertOpenPeriod(database: Kysely<DatabaseSchema>, accountingDate: string) {
    const { companyId } = this.support.context();
    const result = await sql<{ available: boolean }>`
      select exists(select 1 from accounting_periods p
       join fiscal_years y on y.id=p.fiscal_year_id and y.company_id=p.company_id
       where p.company_id=${companyId}::uuid
         and ${accountingDate}::date between p.period_start and p.period_end
         and p.status in('open','reopened') and y.status in('open','reopened')) as available
    `.execute(database);
    if (!result.rows[0]?.available) this.conflict("accounting_cash_bank_period_unavailable");
  }

  private async sourceBalanceFor(database: Kysely<DatabaseSchema>, movement: MovementRecord) {
    if (movement.sourceCashAccountId === null && movement.sourceBankAccountId === null) return null;
    return this.balance(
      database,
      movement.sourceCashAccountId === null ? "bank" : "cash",
      movement.sourceCashAccountId ?? movement.sourceBankAccountId!,
      movement.accountingDate,
    );
  }

  /**
   * Balance control for the account a Movement takes money OUT of.
   *
   * ==========================================================================
   * SOURCE ONLY, AND DECIDED BY THE ROW RATHER THAN THE TYPE
   * ==========================================================================
   *
   * Which account loses funds is read from the Movement's own source columns,
   * not from a list of movement types. The two cannot then disagree: a deposit
   * carries no source and is skipped, a withdrawal carries one, and each
   * transfer carries exactly the one its structure validation already
   * enforced. A hard-coded type list would need editing every time a type is
   * added, and would silently stop enforcing if someone forgot.
   *
   * The DESTINATION is never evaluated. Money arriving can only raise a
   * balance, so checking it would block a transfer that fixes the very
   * shortfall the policy is worried about -- and the destination leg of the
   * posting is left exactly as it was.
   *
   * ==========================================================================
   * AMOUNT PLUS FEE, BECAUSE THAT IS WHAT LEAVES
   * ==========================================================================
   *
   * The deduction is `amount + fee_amount`, matching the source leg of
   * `CashBankQueryService.balances()` (`-amount-fee_amount`) exactly. A fee is
   * always taken from the source, so judging the amount alone would approve a
   * Movement whose fee then takes the account past the floor -- the balance
   * would disagree with the decision that permitted it by precisely the fee.
   *
   * Returns null when there is no source to judge, so the caller can tell
   * "not applicable" from "checked and allowed".
   */
  private async enforceSourceBalance(
    // `Transaction`, not `Kysely`, so the row locks the coordinator takes are
    // held to commit. The other private helpers here predate that distinction
    // and still take `Kysely`; this one does not need to.
    database: Transaction<DatabaseSchema>,
    movement: MovementRecord,
    balanceOverrideReason: string | undefined,
  ): Promise<BalanceEnforcementResult | null> {
    if (movement.sourceCashAccountId === null && movement.sourceBankAccountId === null) {
      return null;
    }
    const kind = movement.sourceCashAccountId === null ? "bank" : "cash";
    const accountId = movement.sourceCashAccountId ?? movement.sourceBankAccountId!;
    const deduction = new Decimal(movement.amount).plus(movement.feeAmount);
    const { actorId } = this.support.context();
    const result = await this.balanceEnforcement.evaluate(database, {
      actorId,
      actorPermissions: this.support.permissions(),
      deductions: [{ accountId, amount: deduction.toFixed(2), kind }],
      sourceReference: movement.movementNumber,
      sourceType: "cash_bank_movement",
      ...(balanceOverrideReason === undefined ? {} : { overrideReason: balanceOverrideReason }),
    });
    if (!result.allowed) {
      throw new ApplicationException(
        result.failureCode ?? "balance_would_go_negative",
        result.failureReason ?? "This Movement is not permitted by the balance policy",
        HttpStatus.CONFLICT,
        this.balanceEnforcement.blockedDetails(result),
      );
    }
    return result;
  }

  private async assertSourceBalance(database: Kysely<DatabaseSchema>, movement: MovementRecord) {
    if (movement.sourceCashAccountId === null && movement.sourceBankAccountId === null) return;
    const available = new Decimal((await this.sourceBalanceFor(database, movement)) ?? "0");
    const required = new Decimal(movement.amount).plus(movement.feeAmount);
    if (available.lessThan(required)) {
      throw new ApplicationException(
        "accounting_cash_bank_insufficient_balance",
        "The source Cash or Bank Account has insufficient available balance",
        HttpStatus.CONFLICT,
        [`Available: ${available.toFixed(2)}; required: ${required.toFixed(2)}`],
      );
    }
  }

  private async balance(
    database: Kysely<DatabaseSchema>,
    kind: "cash" | "bank",
    accountId: string,
    date?: string,
  ) {
    const { companyId } = this.support.context();
    const source =
      kind === "cash" ? sql.ref("m.source_cash_account_id") : sql.ref("m.source_bank_account_id");
    const destination =
      kind === "cash"
        ? sql.ref("m.destination_cash_account_id")
        : sql.ref("m.destination_bank_account_id");
    const originalSource =
      kind === "cash" ? sql.ref("o.source_cash_account_id") : sql.ref("o.source_bank_account_id");
    const originalDestination =
      kind === "cash"
        ? sql.ref("o.destination_cash_account_id")
        : sql.ref("o.destination_bank_account_id");
    const result = await sql<{ balance: string }>`
      with selected_account as (
        select linked_gl_account_id as gl_id from ${
          kind === "cash" ? sql`company_cash_accounts` : sql`company_bank_accounts`
        } where id=${accountId}::uuid and company_id=${companyId}::uuid
      ), opening as (
        select coalesce(sum(l.debit-l.credit),0) as value
          from journal_lines l join journal_entries j
            on j.id=l.journal_entry_id and j.company_id=l.company_id
         where l.company_id=${companyId}::uuid and j.status='posted'
           and j.journal_type='opening_balance'
           and l.account_id=(select gl_id from selected_account)
           and (${date ?? null}::date is null or j.business_date<=${date ?? null}::date)
      ), activity as (
        select coalesce(sum(case when m.reversal_of_movement_id is null then
          case when ${destination}= ${accountId}::uuid then m.amount else 0 end
          - case when ${source}= ${accountId}::uuid then m.amount+m.fee_amount else 0 end
        else -(
          case when ${originalDestination}= ${accountId}::uuid then o.amount else 0 end
          - case when ${originalSource}= ${accountId}::uuid then o.amount+o.fee_amount else 0 end
        ) end
        ),0) as value
        from cash_bank_movements m
        left join cash_bank_movements o
          on o.id=m.reversal_of_movement_id and o.company_id=m.company_id
        where m.company_id=${companyId}::uuid and m.status in('confirmed','reversed')
          and (${date ?? null}::date is null or m.accounting_date<=${date ?? null}::date)
          and (
            ${source}=${accountId}::uuid or ${destination}=${accountId}::uuid
            or ${originalSource}=${accountId}::uuid or ${originalDestination}=${accountId}::uuid
          )
      )
      select ((select value from opening)+(select value from activity))::text as balance
    `.execute(database);
    return new Decimal(result.rows[0]?.balance ?? 0).toFixed(2);
  }

  private async enqueueEvent(
    database: Kysely<DatabaseSchema>,
    movement: MovementRecord,
    actorId: string,
    correlationId: string,
    reversalOfEventId?: string,
  ) {
    const { companyId } = this.support.context();
    const eventType =
      reversalOfEventId === undefined
        ? eventTypeByMovement[
            movement.movementType as Exclude<CashBankMovementType, "opening_balance">
          ]
        : "cash_bank_movement_reversed";
    if (eventType === undefined)
      this.conflict("accounting_cash_bank_opening_balance_requires_approved_batch");
    const identity = {
      accountingDate: movement.accountingDate,
      amount: movement.amount,
      eventType,
      feeAmount: movement.feeAmount,
      movementId: movement.id,
      movementNumber: movement.movementNumber,
      movementType: movement.movementType,
    };
    const hash = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const eventKey = `cash-bank:${eventType}:${movement.id}:v1`;
    const inserted = await sql<{ id: string }>`
      insert into accounting_events(
        company_id,event_type,event_version,source_entity_type,source_entity_id,
        source_reference,effective_accounting_date,currency,correlation_id,
        idempotency_key,event_hash,actor_id,actor_type,description,
        reversal_of_event_id,supplementary_metadata,processing_status,
        operational_area,source_operation_id
      ) values(
        ${companyId}::uuid,${eventType},1,'cash_bank_movement',${movement.id}::uuid,
        ${movement.movementNumber},${movement.accountingDate}::date,'AED',${correlationId},
        ${eventKey},${hash},${actorId}::uuid,'company_user',
        ${`${eventType} for ${movement.movementNumber}`},
        ${reversalOfEventId ?? null}::uuid,${JSON.stringify(identity)}::jsonb,
        'received','cash_bank_management',${eventKey}
      ) on conflict(company_id,event_type,source_entity_type,source_entity_id,event_version)
        do nothing returning id
    `.execute(database);
    if (inserted.rows[0] !== undefined) return inserted.rows[0].id;
    const existing = await sql<{ eventHash: string; id: string }>`
      select id,event_hash as "eventHash" from accounting_events
       where company_id=${companyId}::uuid and event_type=${eventType}
         and source_entity_type='cash_bank_movement' and source_entity_id=${movement.id}::uuid
       for update
    `.execute(database);
    if (existing.rows[0]?.eventHash !== hash)
      this.conflict("accounting_cash_bank_event_payload_mismatch");
    return existing.rows[0]!.id;
  }

  private async movementSnapshot(database: Kysely<DatabaseSchema>, movement: MovementRecord) {
    const { companyId } = this.support.context();
    const result = await sql<Record<string, unknown>>`
      select m.movement_number as "movementNumber",m.movement_type as "movementType",
        m.amount::text,m.fee_amount::text as "feeAmount",m.movement_date::text as "movementDate",
        m.accounting_date::text as "accountingDate",m.source_classification as "sourceClassification",
        m.destination_classification as "destinationClassification",
        sc.cash_account_code as "sourceCashCode",dc.cash_account_code as "destinationCashCode",
        sb.bank_account_code as "sourceBankCode",db.bank_account_code as "destinationBankCode",
        sc.linked_gl_account_id as "sourceCashGlId",dc.linked_gl_account_id as "destinationCashGlId",
        sb.linked_gl_account_id as "sourceBankGlId",db.linked_gl_account_id as "destinationBankGlId"
      from cash_bank_movements m
      left join company_cash_accounts sc on sc.id=m.source_cash_account_id and sc.company_id=m.company_id
      left join company_cash_accounts dc on dc.id=m.destination_cash_account_id and dc.company_id=m.company_id
      left join company_bank_accounts sb on sb.id=m.source_bank_account_id and sb.company_id=m.company_id
      left join company_bank_accounts db on db.id=m.destination_bank_account_id and db.company_id=m.company_id
      where m.id=${movement.id}::uuid and m.company_id=${companyId}::uuid
    `.execute(database);
    return result.rows[0] ?? {};
  }

  private async originalEventId(database: Kysely<DatabaseSchema>, movement: MovementRecord) {
    const { companyId } = this.support.context();
    const result = await sql<{ id: string }>`
      select id from accounting_events where company_id=${companyId}::uuid
       and source_entity_type='cash_bank_movement'
       and source_entity_id=${movement.id}::uuid
       and event_type<>'cash_bank_movement_reversed'
       order by event_version desc limit 1
    `.execute(database);
    if (result.rows[0] === undefined) this.conflict("accounting_cash_bank_original_event_missing");
    return result.rows[0]!.id;
  }

  private reverseShape(
    movement: MovementRecord,
  ): Pick<
    MovementRecord,
    | "movementType"
    | "sourceCashAccountId"
    | "sourceBankAccountId"
    | "destinationCashAccountId"
    | "destinationBankAccountId"
  > {
    const reversedType: Readonly<Record<CashBankMovementType, CashBankMovementType>> = {
      bank_deposit: "bank_withdrawal",
      bank_to_bank_transfer: "bank_to_bank_transfer",
      bank_to_cash_transfer: "cash_to_bank_transfer",
      bank_withdrawal: "bank_deposit",
      cash_deposit: "cash_withdrawal",
      cash_to_bank_transfer: "bank_to_cash_transfer",
      cash_to_cash_transfer: "cash_to_cash_transfer",
      cash_withdrawal: "cash_deposit",
      opening_balance: "opening_balance",
    };
    return {
      destinationBankAccountId: movement.sourceBankAccountId,
      destinationCashAccountId: movement.sourceCashAccountId,
      movementType: reversedType[movement.movementType],
      sourceBankAccountId: movement.destinationBankAccountId,
      sourceCashAccountId: movement.destinationCashAccountId,
    };
  }

  private async enforceConfirmationSegregation(
    database: Kysely<DatabaseSchema>,
    createdBy: string,
  ) {
    const { actorId } = this.support.context();
    if (
      actorId === createdBy &&
      (await this.support.hasAlternateAuthorizedActor(database, "accounting.approve"))
    ) {
      this.conflict("accounting_cash_bank_segregation_blocked");
    }
  }

  private async enforceMovementReversalSegregation(
    database: Kysely<DatabaseSchema>,
    movement: MovementRecord,
  ) {
    const { actorId } = this.support.context();
    if (
      (actorId === movement.createdBy || actorId === movement.confirmedBy) &&
      (await this.support.hasAlternateAuthorizedActor(database, "accounting.reverse"))
    ) {
      this.conflict("accounting_cash_bank_segregation_blocked");
    }
  }

  private async accountDependencies(
    database: Kysely<DatabaseSchema>,
    kind: "cash" | "bank",
    id: string,
    lock: boolean,
  ) {
    const { companyId } = this.support.context();
    const exists =
      kind === "cash"
        ? await sql<{ id: string }>`
          select id from company_cash_accounts
           where id=${id}::uuid and company_id=${companyId}::uuid
           ${lock ? sql`for update` : sql``}
        `.execute(database)
        : await sql<{ id: string }>`
          select id from company_bank_accounts
           where id=${id}::uuid and company_id=${companyId}::uuid
           ${lock ? sql`for update` : sql``}
        `.execute(database);
    if (exists.rows[0] === undefined) this.notFound(`accounting_${kind}_account_not_found`);
    const sourceColumn =
      kind === "cash" ? sql.ref("source_cash_account_id") : sql.ref("source_bank_account_id");
    const destinationColumn =
      kind === "cash"
        ? sql.ref("destination_cash_account_id")
        : sql.ref("destination_bank_account_id");
    const movement = await sql<{ pending: string; total: string }>`
      select count(*)::text as total,
        count(*) filter(where status='draft')::text as pending
      from cash_bank_movements where company_id=${companyId}::uuid
       and (${sourceColumn}=${id}::uuid or ${destinationColumn}=${id}::uuid)
    `.execute(database);
    const mapping = await sql<{ active: boolean }>`
      select exists(select 1 from accounting_configurations
       where company_id=${companyId}::uuid and ${id}::uuid in(default_cash_account_id,default_bank_account_id)) as active
    `.execute(database);
    const blockers = [
      ...(movement.rows[0]?.pending === "0" ? [] : ["draft_movements"]),
      ...(mapping.rows[0]?.active ? ["active_accounting_configuration"] : []),
    ];
    return {
      blockers,
      movementCount: movement.rows[0]?.total ?? "0",
      pendingMovementCount: movement.rows[0]?.pending ?? "0",
    };
  }

  private async linkAttachments(
    database: Kysely<DatabaseSchema>,
    movementId: string,
    attachments: readonly CashBankAttachmentDto[],
  ) {
    const { actorId, companyId } = this.support.context();
    const ids: string[] = [];
    for (const attachment of attachments) {
      const file = await sql<{ contentType: string; fileName: string; sizeBytes: string }>`
        select original_filename as "fileName",media_type as "contentType",
               size_bytes::text as "sizeBytes"
          from file_objects where id=${attachment.fileObjectId}::uuid
           and company_id=${companyId}::uuid and status='active'
      `.execute(database);
      if (file.rows[0] === undefined) this.conflict("accounting_cash_bank_attachment_invalid");
      const id = randomUUID();
      await sql`
        insert into cash_bank_movement_attachments(
          id,company_id,movement_id,file_object_id,attachment_type,description,
          file_name_snapshot,content_type_snapshot,size_bytes_snapshot,
          uploaded_by_account_id
        ) values(
          ${id}::uuid,${companyId}::uuid,${movementId}::uuid,
          ${attachment.fileObjectId}::uuid,${attachment.attachmentType},
          ${nonempty(attachment.description)},${file.rows[0]!.fileName},
          ${file.rows[0]!.contentType},${file.rows[0]!.sizeBytes}::bigint,${actorId}::uuid
        ) on conflict(company_id,movement_id,file_object_id) where is_active do nothing
      `.execute(database);
      ids.push(id);
    }
    return ids;
  }

  private async auditAndComplete(
    database: Kysely<DatabaseSchema>,
    input: {
      readonly action: string;
      readonly correlationId: string;
      readonly idempotencyKey: string;
      readonly operation: string;
      readonly resourceType: string;
      readonly response: {
        readonly id?: string;
        readonly originalMovementId?: string;
        readonly [key: string]: unknown;
      };
    },
  ) {
    const subjectId = input.response.id ?? input.response.originalMovementId!;
    await this.support.audit(database, {
      action: input.action,
      after: input.response,
      correlationId: input.correlationId,
      subjectId,
      subjectType: input.resourceType,
    });
    await this.support.completeIdempotency(database, {
      idempotencyKey: input.idempotencyKey,
      operation: input.operation,
      resourceId: subjectId,
      resourceType: input.resourceType,
      responseBody: input.response,
    });
  }

  private conflict(code: string): never {
    throw new ApplicationException(
      code,
      "The Cash/Bank operation conflicts with the current financial rules",
      HttpStatus.CONFLICT,
    );
  }

  private notFound(code: string): never {
    throw new ApplicationException(
      code,
      "The Cash/Bank record was not found",
      HttpStatus.NOT_FOUND,
    );
  }
}
