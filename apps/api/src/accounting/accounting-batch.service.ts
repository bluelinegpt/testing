import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, type Transaction, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingEventQueryService } from "./accounting-event-query.service.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import { AccountingRecoveryService } from "./accounting-recovery.service.js";
import {
  accountingBatchMaxItems,
  accountingBatchProcessingStaleMinutes,
  batchTypeServices,
  canTransitionBatch,
  editableBatchStatuses,
  executableBatchStatuses,
  terminalBatchStatuses,
  type AccountingBatchStatus,
  type AccountingBatchType,
  type AccountingBatchValidationStatus,
} from "./accounting-batch.constants.js";
import type {
  AccountingBatchItemQueryDto,
  AccountingBatchListQueryDto,
  AddAccountingBatchItemsDto,
  CancelAccountingBatchDto,
  CreateAccountingBatchDto,
  ExecuteAccountingBatchDto,
  RecoverAccountingBatchDto,
} from "./accounting-batch.dto.js";
import type { CreateRecoveryBatchDto } from "./accounting-recovery.dto.js";

/**
 * Accounting Batch Operations — foundation.
 *
 * ===========================================================================
 * IT OWNS NO ACCOUNTING ACTION
 * ===========================================================================
 *
 * A batch is a selection of existing records, a read-only classification of
 * each one, and -- once executed -- a per-item delegation to the SAME
 * single-item service a person would use on the Event screen. Nothing in this
 * file posts a Journal, moves a balance, or writes a financial record;
 * `execute()` re-queues Events through `reprocess`, and the normal processor
 * remains the only thing that posts.
 *
 * ===========================================================================
 * VALIDATION ASKS THE OWNER; IT DOES NOT JUDGE
 * ===========================================================================
 *
 * Eligibility is `AccountingEventQueryService.reprocessingReadiness`'s answer,
 * item by item, and its blocker codes are stored verbatim. This service adds
 * exactly three classifications that readiness cannot see, because they are
 * facts about the BATCH rather than about the Event: a source this Company
 * does not own (`invalid`), a source already enrolled in another live batch
 * (`duplicate`), and a source of the wrong shape for the batch type
 * (`invalid`).
 *
 * Nothing else is decided here. No status list, posting map, account
 * resolution or period rule is restated -- see `accounting-batch.constants.ts`
 * for the rule and its rationale.
 *
 * The cost of that is one readiness call per item, which is why a batch is
 * capped at ${accountingBatchMaxItems} items. A single set-based query over
 * `accounting_events` would be far cheaper and would also be a second copy of
 * the eligibility rule; the cheap version is the wrong one.
 *
 * ===========================================================================
 * COMPANY ISOLATION
 * ===========================================================================
 *
 * Every statement is filtered on `company_id`, and a batch belonging to another
 * Company is reported as not found rather than forbidden -- a 403 would confirm
 * the record exists. Items naming another Company's records are enrolled
 * silently and classified `invalid` at validation for the same reason: refusing
 * them at enrolment would turn the add-items endpoint into an existence oracle.
 */

interface BatchRow {
  readonly batchReference: string;
  readonly batchType: AccountingBatchType;
  readonly status: AccountingBatchStatus;
  readonly totalItems: number;
  readonly version: string;
}

interface ItemRow {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceType: string;
}

interface Classification {
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly id: string;
  readonly reasons: readonly string[];
  readonly sourceReference: string | null;
  readonly validationStatus: AccountingBatchValidationStatus;
}

/**
 * A `date` column read back through the driver arrives as a JS Date, whose
 * default string form is a locale/timezone rendering PostgreSQL refuses
 * ("time zone gmt+0400 not recognized"). Enrolling an eligible recovery row
 * therefore failed outright until this normalised it. Local calendar parts,
 * not toISOString(), so a UTC+4 midnight is not shifted into the day before.
 */
function isoDate(value: unknown): string {
  if (value instanceof Date) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, "0"),
      String(value.getDate()).padStart(2, "0"),
    ].join("-");
  }
  return String(value ?? "");
}

@Injectable()
export class AccountingBatchService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(AccountingOperationSupport) private readonly support: AccountingOperationSupport,
    @Inject(AccountingEventQueryService) private readonly events: AccountingEventQueryService,
    @Inject(AccountingRecoveryService) private readonly recovery: AccountingRecoveryService,
  ) {}

  /**
   * A batch may only be created by an actor who could perform the underlying
   * single-item action. Batching is an amplifier, never an escalation.
   */
  private assertBatchAuthority(): void {
    this.support.assertAnyPermission("accounting.post", "accounting.manage");
  }

  /** The generic path handles Event-sourced types only; recovery batches need
   *  full per-item facts and revalidation, so they have their own entry. */
  private assertGenericBatchType(batchType: AccountingBatchType): void {
    if (batchType === "historical_accounting_recovery") {
      throw new ApplicationException(
        "accounting_batch_type_requires_recovery_endpoint",
        "Historical Recovery batches are created from the Historical Recovery preview",
        HttpStatus.CONFLICT,
      );
    }
  }

  public async create(input: CreateAccountingBatchDto, idempotencyKey: string | undefined) {
    this.assertBatchAuthority();
    this.assertGenericBatchType(input.batchType);
    const requested = [...new Set(input.sourceIds ?? [])];
    const batchId = await this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency<{ id: string }>(transaction, {
        idempotencyKey,
        operation: "accounting.batch.create",
        payload: { batchType: input.batchType, reason: input.reason.trim(), sourceIds: requested },
      });
      if (reservation.replayResourceId !== undefined) return reservation.replayResourceId;
      const { actorId, companyId } = this.support.context();
      const reference = await this.nextBatchReference(transaction, companyId);
      const correlationId = idempotencyKey ?? randomUUID();
      const created = await sql<{ id: string }>`
        insert into accounting_batch_jobs (
          company_id, batch_reference, batch_type, status, requested_by_account_id,
          reason, correlation_id, created_by_account_id
        ) values (
          ${companyId}::uuid, ${reference}, ${input.batchType}, 'draft', ${actorId}::uuid,
          ${input.reason.trim()}, ${correlationId}::uuid, ${actorId}::uuid
        ) returning id
      `.execute(transaction);
      const id = created.rows[0]!.id;
      await this.recordTransition(transaction, {
        batchId: id,
        correlationId,
        from: null,
        note: input.reason.trim(),
        to: "draft",
      });
      if (requested.length > 0) {
        await this.insertItems(transaction, {
          batchId: id,
          batchType: input.batchType,
          companyId,
          sourceIds: requested,
        });
      }
      await this.support.audit(transaction, {
        action: "accounting.batch.created",
        after: {
          batchReference: reference,
          batchType: input.batchType,
          itemCount: requested.length,
          reason: input.reason.trim(),
        },
        correlationId,
        subjectId: id,
        subjectType: "accounting_batch_job",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "accounting.batch.create",
        resourceId: id,
        resourceType: "accounting_batch_job",
        responseBody: { batchReference: reference, id },
      });
      return id;
    });
    return this.detail(batchId);
  }

  /**
   * Historical Recovery batch creation.
   *
   * ==========================================================================
   * THE SNAPSHOT IS EVIDENCE; THE SERVER'S ANSWER IS THE TRUTH
   * ==========================================================================
   *
   * The client sends the preview rows it selected — classification, date and
   * amount included — but none of that is trusted. Every selected source is
   * reclassified through `AccountingRecoveryService.classifySources`, the SAME
   * fragment the preview renders, and only sources STILL `eligible` are
   * enrolled. The client's snapshot is stored alongside the server verdict in
   * `classification_snapshot`, so a later reviewer can see both what the user
   * believed they selected and what the server actually accepted. The item's
   * own columns (posting type, accounting date, amount) always carry the
   * server's values.
   *
   * Rejections are returned per item with the CURRENT classification as the
   * reason — a row that became `already_posted` between preview and creation
   * is an answer, not an error. Sources that do not resolve (nonexistent or
   * another Company's) reject as `not_found`, revealing nothing.
   *
   * The batch lands `ready`, through the lifecycle's own draft -> validating ->
   * ready moves rather than by fiat: it WAS validated, at creation, and
   * `last_validated_at` says when. No Accounting Event, Journal or financial
   * record is created — this method writes batch tables only. Execution for
   * this type does not exist and `execute()` refuses it.
   */
  public async createRecoveryBatch(input: CreateRecoveryBatchDto, idempotencyKey: string | undefined) {
    this.assertBatchAuthority();
    // Dedupe by identity; the same row selected twice is one selection.
    const selected = [
      ...new Map(input.items.map((item) => [`${item.sourceType}:${item.sourceId}`, item])).values(),
    ].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    const sourceIds = selected.map((item) => item.sourceId);

    // Revalidation happens OUTSIDE the write transaction: it is a multi-branch
    // read against committed state, and the classification is re-checked again
    // at execution time regardless.
    const [current, enrolled] = await Promise.all([
      this.recovery.classifySources(sourceIds),
      this.activeRecoveryEnrolments(sourceIds),
    ]);
    const verdicts = new Map(
      current.map((row) => [`${String(row.sourceType)}:${String(row.sourceId)}`, row]),
    );

    const accepted: { item: (typeof selected)[number]; row: Record<string, unknown> }[] = [];
    const rejected: { reason: string; sourceId: string; sourceReference: string; sourceType: string }[] = [];
    for (const item of selected) {
      const row = verdicts.get(`${item.sourceType}:${item.sourceId}`);
      if (row === undefined) {
        // Nonexistent and cross-Company look identical, deliberately.
        rejected.push({ reason: "not_found", sourceId: item.sourceId, sourceReference: item.sourceReference, sourceType: item.sourceType });
        continue;
      }
      if (enrolled.has(item.sourceId)) {
        rejected.push({ reason: "enrolled_in_active_recovery_batch", sourceId: item.sourceId, sourceReference: String(row.sourceReference ?? item.sourceReference), sourceType: item.sourceType });
        continue;
      }
      const classification = String(row.classification);
      if (classification !== "eligible") {
        rejected.push({ reason: classification, sourceId: item.sourceId, sourceReference: String(row.sourceReference ?? item.sourceReference), sourceType: item.sourceType });
        continue;
      }
      accepted.push({ item, row });
    }
    if (accepted.length === 0) {
      throw new ApplicationException(
        "accounting_recovery_no_eligible_items",
        "No selected row is still eligible for recovery",
        HttpStatus.CONFLICT,
        rejected.map((row) => `${row.sourceReference}: ${row.reason}`),
      );
    }

    const batchId = await this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency<{ id: string }>(transaction, {
        idempotencyKey,
        operation: "accounting.recovery.batch.create",
        payload: {
          items: selected.map((item) => `${item.sourceType}:${item.sourceId}`),
          reason: input.reason?.trim() ?? "",
        },
      });
      if (reservation.replayResourceId !== undefined) return reservation.replayResourceId;
      const { actorId, companyId } = this.support.context();
      const reference = await this.nextBatchReference(transaction, companyId);
      const correlationId = idempotencyKey ?? randomUUID();
      const reason =
        input.reason?.trim() ||
        "Historical Accounting recovery of preview-eligible records";
      const created = await sql<{ id: string }>`
        insert into accounting_batch_jobs (
          company_id, batch_reference, batch_type, status, requested_by_account_id,
          reason, correlation_id, created_by_account_id, total_items, last_validated_at
        ) values (
          ${companyId}::uuid, ${reference}, 'historical_accounting_recovery', 'draft',
          ${actorId}::uuid, ${reason}, ${correlationId}::uuid, ${actorId}::uuid,
          ${accepted.length}, now()
        ) returning id
      `.execute(transaction);
      const id = created.rows[0]!.id;
      for (const entry of accepted) {
        // Server values on the item's own columns; the client snapshot rides
        // inside classification_snapshot for audit comparison only.
        await sql`
          insert into accounting_batch_items (
            company_id, batch_job_id, source_type, source_id, source_reference,
            validation_status, validation_reasons, expected_posting_type,
            accounting_date, amount, classification_snapshot, validated_at
          ) values (
            ${companyId}::uuid, ${id}::uuid, ${entry.item.sourceType},
            ${entry.item.sourceId}::uuid, ${String(entry.row.sourceReference ?? "")},
            'eligible', '[]'::jsonb, ${String(entry.row.expectedPostingType ?? "")},
            ${isoDate(entry.row.accountingDate)}::date, ${String(entry.row.amount ?? "0")}::numeric,
            ${JSON.stringify({ clientSnapshot: entry.item, serverVerdict: entry.row })}::jsonb,
            now()
          )
          on conflict (batch_job_id, source_type, source_id) do nothing
        `.execute(transaction);
      }
      // The lifecycle's own moves, recorded, not skipped: the batch was
      // genuinely validated on the way in.
      await this.recordTransition(transaction, { batchId: id, correlationId, from: null, note: reason, to: "draft" });
      await this.setStatus(transaction, { batchId: id, correlationId, from: "draft", note: null, to: "validating" });
      await this.setStatus(transaction, { batchId: id, correlationId, from: "validating", note: null, to: "ready" });
      await this.support.audit(transaction, {
        action: "accounting.recovery.batch.created",
        after: {
          accepted: accepted.length,
          batchReference: reference,
          rejected: rejected.length,
          rejectedReasons: rejected,
        },
        correlationId,
        subjectId: id,
        subjectType: "accounting_batch_job",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "accounting.recovery.batch.create",
        resourceId: id,
        resourceType: "accounting_batch_job",
        responseBody: { accepted: accepted.length, id, rejected },
      });
      return id;
    });
    const detail = await this.detail(batchId);
    return {
      ...detail,
      creation: {
        accepted: accepted.map((entry) => ({
          sourceId: entry.item.sourceId,
          sourceReference: String(entry.row.sourceReference ?? ""),
          sourceType: entry.item.sourceType,
        })),
        rejected,
      },
    };
  }

  /** Sources already claimed by another LIVE recovery batch. A cancelled or
   *  finished batch holds no claim, so re-enrolment after one is legitimate —
   *  which is exactly why this is a service rule and not a unique index. */
  private async activeRecoveryEnrolments(sourceIds: readonly string[]): Promise<Set<string>> {
    if (sourceIds.length === 0) return new Set();
    const { companyId } = this.support.context();
    const result = await sql<{ sourceId: string }>`
      select distinct i.source_id as "sourceId"
        from accounting_batch_items i
        join accounting_batch_jobs j
          on j.id = i.batch_job_id and j.company_id = i.company_id
       where i.company_id = ${companyId}::uuid
         and i.source_id = any(${sourceIds}::uuid[])
         and j.batch_type = 'historical_accounting_recovery'
         and j.status not in ('cancelled', 'completed', 'failed', 'partially_completed')
    `.execute(this.database);
    return new Set(result.rows.map((row) => row.sourceId));
  }

  /**
   * Revalidation of an existing recovery batch, item by item, through the SAME
   * classifier the preview and the creation flow use. The verdict is stored
   * VERBATIM — `closed_period`, `invalid_source_data` and
   * `no_accounting_required` are real statuses here, not collapsed into
   * `blocked` — because the reason a person acts on must be the reason the
   * classifier actually gave.
   */
  private async classifyRecoveryItems(
    items: readonly ItemRow[],
  ): Promise<readonly Classification[]> {
    if (items.length === 0) return [];
    const current = await this.recovery.classifySources(items.map((item) => item.sourceId));
    const verdicts = new Map(
      current.map((row) => [`${String(row.sourceType)}:${String(row.sourceId)}`, row]),
    );
    return items.map((item) => {
      const row = verdicts.get(`${item.sourceType}:${item.sourceId}`);
      if (row === undefined) {
        return {
          errorCode: "accounting_recovery_source_not_found",
          errorMessage: "The source record was not found",
          id: item.id,
          reasons: ["source_not_found"],
          sourceReference: null,
          validationStatus: "invalid",
        };
      }
      const blocking = row.blockingCode === null ? [] : [String(row.blockingCode)];
      return {
        errorCode: null,
        errorMessage: null,
        id: item.id,
        reasons: blocking,
        sourceReference: String(row.sourceReference ?? "") || null,
        validationStatus: String(row.classification) as AccountingBatchValidationStatus,
      };
    });
  }

  public async addItems(
    batchId: string,
    input: AddAccountingBatchItemsDto,
    idempotencyKey: string | undefined,
  ) {
    this.assertBatchAuthority();
    const requested = [...new Set(input.sourceIds)];
    await this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.batch.add_items",
        payload: { batchId, sourceIds: requested },
      });
      if (reservation.replayResponse !== undefined) return;
      const { companyId } = this.support.context();
      const batch = await this.lockBatch(transaction, batchId);
      this.assertGenericBatchType(batch.batchType);
      if (!editableBatchStatuses.includes(batch.status)) {
        throw new ApplicationException(
          "accounting_batch_not_editable",
          "Items can only be added to a Draft or Ready batch",
          HttpStatus.CONFLICT,
        );
      }
      const correlationId = idempotencyKey ?? randomUUID();
      const added = await this.insertItems(transaction, {
        batchId,
        batchType: batch.batchType,
        companyId,
        sourceIds: requested,
      });
      // A validated batch that gains items is no longer the batch that was
      // reviewed, so it returns to Draft rather than keeping a classification
      // that does not cover everything in it.
      if (batch.status === "ready" && added.inserted > 0) {
        await this.setStatus(transaction, {
          batchId,
          correlationId,
          from: "ready",
          note: "items_added",
          to: "draft",
        });
      }
      await this.support.audit(transaction, {
        action: "accounting.batch.items_added",
        after: { duplicatesIgnored: added.ignored, inserted: added.inserted, requested: requested.length },
        correlationId,
        subjectId: batchId,
        subjectType: "accounting_batch_job",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "accounting.batch.add_items",
        resourceId: batchId,
        resourceType: "accounting_batch_job",
        responseBody: { duplicatesIgnored: added.ignored, inserted: added.inserted },
      });
    });
    return this.detail(batchId);
  }

  /**
   * Read-only validation.
   *
   * Creates no Accounting Event, no Journal and no financial record. It writes
   * only to the batch's own item rows, and it is safe to rerun: every item is
   * reclassified from scratch, so a rerun converges on the current truth rather
   * than accumulating stale verdicts.
   *
   * The readiness calls deliberately run OUTSIDE the writing transaction. Each
   * one is a multi-query read against committed state, and holding a write
   * transaction open across up to ${accountingBatchMaxItems} of them would pin
   * a connection and lock the batch row for the whole sweep.
   */
  public async validate(batchId: string, idempotencyKey: string | undefined) {
    this.assertBatchAuthority();

    // Phase 1 -- claim the batch. The row lock serialises concurrent validate
    // requests, and the `validating` status makes an interrupted sweep visible
    // rather than leaving a batch that silently looks reviewed.
    const claim = await this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.batch.validate",
        payload: { batchId },
      });
      if (reservation.replayResponse !== undefined) return undefined;
      const batch = await this.lockBatch(transaction, batchId);
      if (!canTransitionBatch(batch.status, "validating")) {
        throw new ApplicationException(
          "accounting_batch_not_validatable",
          "Only a Draft or Ready batch can be validated",
          HttpStatus.CONFLICT,
        );
      }
      const correlationId = idempotencyKey ?? randomUUID();
      await this.setStatus(transaction, {
        batchId,
        correlationId,
        from: batch.status,
        note: null,
        to: "validating",
      });
      const items = await sql<ItemRow>`
        select id, source_id as "sourceId", source_type as "sourceType"
          from accounting_batch_items
         where batch_job_id = ${batchId}::uuid
           and company_id = ${this.support.context().companyId}::uuid
         order by created_at, id
      `.execute(transaction);
      return { batch, correlationId, items: items.rows };
    });
    if (claim === undefined) return this.detail(batchId);

    // Phase 2 -- classify. No transaction, no write, no financial record.
    const classifications =
      claim.batch.batchType === "historical_accounting_recovery"
        ? await this.classifyRecoveryItems(claim.items)
        : await this.classify(batchId, claim.batch.batchType, claim.items);

    // Phase 3 -- record the verdicts.
    await this.transactions.execute(async (transaction) => {
      const { companyId } = this.support.context();
      for (const item of classifications) {
        await sql`
          update accounting_batch_items
             set validation_status = ${item.validationStatus},
                 validation_reasons = ${JSON.stringify(item.reasons)}::jsonb,
                 error_code = ${item.errorCode}, error_message = ${item.errorMessage},
                 source_reference = coalesce(${item.sourceReference}, source_reference),
                 validated_at = now(), updated_at = now(), version = version + 1
           where id = ${item.id}::uuid and company_id = ${companyId}::uuid
        `.execute(transaction);
      }
      await sql`
        update accounting_batch_jobs set last_validated_at = now()
         where id = ${batchId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      await this.setStatus(transaction, {
        batchId,
        correlationId: claim.correlationId,
        from: "validating",
        note: null,
        to: "ready",
      });
      await this.support.audit(transaction, {
        action: "accounting.batch.validated",
        after: this.summarise(classifications),
        correlationId: claim.correlationId,
        subjectId: batchId,
        subjectType: "accounting_batch_job",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "accounting.batch.validate",
        resourceId: batchId,
        resourceType: "accounting_batch_job",
        responseBody: this.summarise(classifications),
      });
    });
    return this.detail(batchId);
  }

  /**
   * Controlled execution.
   *
   * ==========================================================================
   * THE BATCH STILL POSTS NOTHING ITSELF
   * ==========================================================================
   *
   * Every item is executed by ONE call to
   * `AccountingEventQueryService.reprocess` -- the same method the single-Event
   * screen uses, with its own permission check, readiness enforcement,
   * idempotency reservation and audit. This module contributes claiming,
   * sequencing, outcome recording and the final tally. No mapping, posting,
   * Event or Journal calculation exists here, and `reprocess` itself only
   * re-queues the Event for the normal processor -- so a batch cannot create a
   * duplicate Event or Journal, because nothing in this path creates either:
   * the processor's own claim query and the Event's journal guard remain the
   * sole writers.
   *
   * A consequence worth stating: `resulting_journal_id` is usually null at
   * execution time. Success here means "the Event was accepted back into the
   * queue"; the Journal appears when the processor posts it, asynchronously.
   * The column records it where the Event already carries one.
   *
   * ==========================================================================
   * SHAPE: SHORT CLAIM, ITEM LOOP, SHORT FINALISATION
   * ==========================================================================
   *
   * One short transaction claims the batch (lock, idempotency, status+version
   * checks, `processing`, transition) and commits. Items are then processed one
   * at a time, each in its own small transactions, so a batch of 200 never
   * holds one database transaction open across 200 multi-query operations. A
   * failed item records its failure and the loop continues -- item N's error
   * can never roll back item N-1's success, because they never share a
   * transaction. Finalisation recounts from the item rows and commits the
   * final status.
   *
   * If the process dies mid-loop the batch is left visibly `processing` with
   * every completed item durably recorded; it cannot be silently re-entered,
   * because `processing` is not an executable status. Releasing such a batch is
   * a deliberate operator decision, not something a retry loop does by
   * accident.
   */
  public async execute(
    batchId: string,
    input: ExecuteAccountingBatchDto,
    idempotencyKey: string | undefined,
  ) {
    this.assertBatchAuthority();

    // Phase 1 -- claim.
    const claim = await this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.batch.execute",
        // The version is part of the payload, so the same key with a different
        // version is a PAYLOAD MISMATCH, refused -- never silently replayed.
        payload: { batchId, expectedVersion: input.expectedVersion },
      });
      if (reservation.replayResponse !== undefined) return undefined;
      const batch = await this.lockBatch(transaction, batchId);
      if (!executableBatchStatuses.includes(batch.status)) {
        throw new ApplicationException(
          "accounting_batch_not_executable",
          "Only a Ready, Partially Completed or Failed batch can be executed",
          HttpStatus.CONFLICT,
        );
      }
      if (Number(batch.version) !== input.expectedVersion) {
        throw new ApplicationException(
          "accounting_batch_version_conflict",
          "The batch changed after it was last reviewed. Reload it and try again.",
          HttpStatus.CONFLICT,
        );
      }
      const { companyId } = this.support.context();
      const validated = await sql<{ lastValidatedAt: string | null }>`
        select last_validated_at::text as "lastValidatedAt" from accounting_batch_jobs
         where id = ${batchId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      if (validated.rows[0]?.lastValidatedAt == null) {
        throw new ApplicationException(
          "accounting_batch_not_validated",
          "This batch has not been validated yet",
          HttpStatus.CONFLICT,
        );
      }
      // At least one unfinished RETRYABLE item, or there is nothing to run and
      // "execute" would only launder the status. Blocked, closed-period and
      // invalid verdicts count as retryable here deliberately: the item loop
      // revalidates every one of them, and a blocker that has genuinely been
      // fixed since the last run must be reachable without a separate
      // validation pass (a partially-completed batch cannot re-enter
      // `validating`). Settled verdicts never count.
      const runnable = await sql<{ total: number }>`
        select count(*)::int as total from accounting_batch_items
         where batch_job_id = ${batchId}::uuid and company_id = ${companyId}::uuid
           and validation_status not in ('duplicate', 'already_processed', 'no_accounting_required')
           and execution_status in ('pending', 'failed')
      `.execute(transaction);
      if ((runnable.rows[0]?.total ?? 0) === 0) {
        throw new ApplicationException(
          "accounting_batch_nothing_to_execute",
          "This batch has no unfinished eligible items",
          HttpStatus.CONFLICT,
        );
      }
      const correlationId = idempotencyKey ?? randomUUID();
      await this.setStatus(transaction, {
        batchId,
        correlationId,
        from: batch.status,
        note: null,
        to: "processing",
      });
      await sql`
        update accounting_batch_jobs set started_at = coalesce(started_at, now())
         where id = ${batchId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      return { batch, correlationId };
    });
    if (claim === undefined) return this.detail(batchId);

    // Phase 2 -- the item loop. Unfinished only: succeeded, skipped and
    // cancelled items are never touched again, and items validated `duplicate`
    // are settled to skipped without a readiness call -- their duplicate-ness
    // is about batch membership, not about the Event.
    const { companyId } = this.support.context();
    const unfinished = await sql<ItemRow & { readonly validationStatus: string }>`
      select id, source_id as "sourceId", source_type as "sourceType",
             validation_status as "validationStatus"
        from accounting_batch_items
       where batch_job_id = ${batchId}::uuid and company_id = ${companyId}::uuid
         and execution_status in ('pending', 'failed')
       order by created_at, id
    `.execute(this.database);
    for (const item of unfinished.rows) {
      if (claim.batch.batchType === "historical_accounting_recovery") {
        await this.executeRecoveryItem(batchId, item);
      } else {
        await this.executeItem(claim.batch, batchId, item, claim.correlationId);
      }
    }

    // Phase 3 -- finalise, from the authoritative item rows.
    await this.transactions.execute(async (transaction) => {
      const tallies = await sql<{ count: number; executionStatus: string }>`
        select execution_status as "executionStatus", count(*)::int as count
          from accounting_batch_items
         where batch_job_id = ${batchId}::uuid and company_id = ${companyId}::uuid
         group by execution_status
      `.execute(transaction);
      const duplicates = await sql<{ total: number }>`
        select count(*)::int as total from accounting_batch_items
         where batch_job_id = ${batchId}::uuid and company_id = ${companyId}::uuid
           and validation_status = 'duplicate'
      `.execute(transaction);
      const of = (status: string): number =>
        tallies.rows.find((row) => row.executionStatus === status)?.count ?? 0;
      const succeeded = of("succeeded");
      const failed = of("failed");
      const skipped = of("skipped");
      const pending = of("pending");
      // Nothing succeeded and something failed -> failed. Any failure or any
      // still-unfinished (blocked/invalid) item -> partially complete. Only a
      // batch whose every item is settled is complete.
      const finalStatus: AccountingBatchStatus =
        failed > 0 && succeeded === 0
          ? "failed"
          : failed > 0 || pending > 0
            ? "partially_completed"
            : "completed";
      await sql`
        update accounting_batch_jobs
           set succeeded_count = ${succeeded}, failed_count = ${failed},
               skipped_count = ${skipped}, duplicate_count = ${duplicates.rows[0]?.total ?? 0},
               completed_at = now()
         where id = ${batchId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      await this.setStatus(transaction, {
        batchId,
        correlationId: claim.correlationId,
        from: "processing",
        note: null,
        to: finalStatus,
      });
      const summary = { failed, finalStatus, pending, skipped, succeeded };
      await this.support.audit(transaction, {
        action: "accounting.batch.executed",
        after: summary,
        correlationId: claim.correlationId,
        subjectId: batchId,
        subjectType: "accounting_batch_job",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "accounting.batch.execute",
        resourceId: batchId,
        resourceType: "accounting_batch_job",
        responseBody: summary,
      });
    });
    return this.detail(batchId);
  }

  /**
   * One item, three small steps: claim, decide, record.
   *
   * The claim uses `for update skip locked` so two workers can never hold the
   * same item even if the batch-level gate were somehow bypassed. Readiness is
   * re-run at execution time -- the world has moved since validation, and the
   * verdict that matters is the one from NOW. The reprocess call carries its
   * own fresh idempotency key per attempt: a deterministic key would replay the
   * first attempt's stored answer forever and make retry impossible, and the
   * duplicate-protection this loop actually relies on is `reprocess`'s own
   * status guard, which refuses an Event that is not failed/blocked/retryable.
   */
  private async executeItem(
    batch: BatchRow,
    batchId: string,
    item: { readonly id: string; readonly sourceId: string; readonly validationStatus: string },
    correlationId: string,
  ): Promise<void> {
    const { companyId } = this.support.context();
    // Step 1 -- claim.
    const claimed = await this.transactions.execute(async (transaction) => {
      const row = await sql<{ id: string }>`
        select id from accounting_batch_items
         where id = ${item.id}::uuid and company_id = ${companyId}::uuid
           and execution_status in ('pending', 'failed')
         for update skip locked
      `.execute(transaction);
      return row.rows[0] !== undefined;
    });
    if (!claimed) return;

    // A duplicate enrolment is settled without touching the Event.
    if (item.validationStatus === "duplicate") {
      await this.recordItemOutcome(batchId, item.id, {
        errorCode: null,
        errorMessage: null,
        executionStatus: "skipped",
        reasons: ["source_enrolled_in_another_batch"],
        resultingEventId: null,
        resultingJournalId: null,
        validationStatus: "duplicate",
      });
      return;
    }

    // Step 2 -- revalidate through the authoritative service.
    let readiness: Awaited<ReturnType<AccountingEventQueryService["reprocessingReadiness"]>>;
    try {
      readiness = await this.events.reprocessingReadiness(item.sourceId);
    } catch (error) {
      // Not found covers "gone" and "another Company's" alike; either way the
      // item is invalid and stays unfinished so a later retry can revalidate.
      const code =
        error instanceof ApplicationException ? error.errorCode : "accounting_event_not_found";
      await this.recordItemOutcome(batchId, item.id, {
        errorCode: code,
        errorMessage: "The Accounting Event could not be read",
        executionStatus: null,
        reasons: ["source_not_found"],
        resultingEventId: null,
        resultingJournalId: null,
        validationStatus: "invalid",
      });
      return;
    }

    if (!readiness.eligible) {
      const alreadyDone =
        readiness.blockers.includes("event_already_posted") ||
        readiness.blockers.includes("event_journal_already_exists");
      // Already-processed is a SETTLED outcome -- the work exists, nothing to
      // do. Blocked stays unfinished so a retry revalidates it after the
      // blocker is fixed.
      await this.recordItemOutcome(batchId, item.id, {
        errorCode: null,
        errorMessage: null,
        executionStatus: alreadyDone ? "skipped" : null,
        reasons: readiness.blockers,
        resultingEventId: alreadyDone ? item.sourceId : null,
        resultingJournalId: null,
        validationStatus: alreadyDone ? "already_processed" : "blocked",
      });
      return;
    }

    // Step 3 -- execute through the SAME single-item service the Event screen
    // uses. Its own transaction, permission check, readiness enforcement,
    // idempotency record and audit apply unchanged.
    try {
      const reason = `Batch ${batch.batchReference}`.slice(0, 500);
      await this.events.reprocess(item.sourceId, { reason }, randomUUID());
      const journal = await sql<{ journalId: string | null }>`
        select journal_id as "journalId" from accounting_events
         where id = ${item.sourceId}::uuid and company_id = ${companyId}::uuid
      `.execute(this.database);
      await this.recordItemOutcome(batchId, item.id, {
        errorCode: null,
        errorMessage: null,
        executionStatus: "succeeded",
        reasons: [],
        resultingEventId: item.sourceId,
        resultingJournalId: journal.rows[0]?.journalId ?? null,
        validationStatus: "eligible",
      });
    } catch (error) {
      const applicationError = error instanceof ApplicationException ? error : undefined;
      await this.recordItemOutcome(batchId, item.id, {
        errorCode: applicationError?.errorCode ?? "accounting_batch_item_execution_failed",
        errorMessage: applicationError?.message ?? "The item could not be executed",
        executionStatus: "failed",
        reasons: [],
        resultingEventId: null,
        resultingJournalId: null,
        validationStatus: "eligible",
      });
    }
  }

  /**
   * One Historical Recovery item: claim, revalidate, capture, record.
   *
   * ==========================================================================
   * CAPTURE IS THE TRIGGERS' OWN HELPER, CALLED FOR A ROW THE TRIGGER MISSED
   * ==========================================================================
   *
   * `enqueue_operational_accounting_event` is the ONE capture service every
   * operational trigger delegates to. Recovery calls it with the EXACT
   * arguments the Order-delivery and Fee-accrual triggers pass -- same area,
   * event type, source reference, accounting date (the source's own, never
   * changed), actor and operation id -- so a recovered Event is
   * indistinguishable from one captured on time. Its internal
   * `on conflict … do nothing` on the event identity makes duplicate Events
   * impossible even under concurrent capture.
   *
   * No Journal is written here and none can be: the helper records the Event
   * as `received`, and only the normal processor posts it -- through the
   * source loader, mapping resolver, period guard and balance test, exactly
   * once, under its own claim conditions. That is why `resulting_journal_id`
   * stays null at execution time: Journal creation is asynchronous, and a
   * reference is never fabricated.
   *
   * Revalidation is the authoritative recovery classifier, per item, NOW --
   * the preview verdict and the enrolment snapshot are never trusted. A row
   * that stopped being eligible records its current classification verbatim:
   * settled outcomes (`already_processed`, `duplicate`,
   * `no_accounting_required`) are skipped and never retried; `blocked`,
   * `closed_period` and `invalid_source_data` stay unfinished so a retry
   * revalidates them once the real-world condition changes. Closed periods
   * are never bypassed and No Accounting Required Orders can never reach the
   * capture call.
   */
  private async executeRecoveryItem(
    batchId: string,
    item: { readonly id: string; readonly sourceId: string; readonly sourceType: string; readonly validationStatus: string },
  ): Promise<void> {
    const { companyId } = this.support.context();
    // Step 1 -- claim, identically to the generic path.
    const claimed = await this.transactions.execute(async (transaction) => {
      const row = await sql<{ id: string }>`
        select id from accounting_batch_items
         where id = ${item.id}::uuid and company_id = ${companyId}::uuid
           and execution_status in ('pending', 'failed')
         for update skip locked
      `.execute(transaction);
      return row.rows[0] !== undefined;
    });
    if (!claimed) return;

    // Step 2 -- final revalidation through the authoritative classifier.
    const verdicts = await this.recovery.classifySources([item.sourceId]);
    const verdict = verdicts.find(
      (row) => String(row.sourceId) === item.sourceId && String(row.sourceType) === item.sourceType,
    );
    if (verdict === undefined) {
      // Gone, reversed, or another Company's -- one answer, still unfinished.
      await this.recordItemOutcome(batchId, item.id, {
        errorCode: "accounting_recovery_source_not_found",
        errorMessage: "The source record was not found",
        executionStatus: null,
        reasons: ["source_not_found"],
        resultingEventId: null,
        resultingJournalId: null,
        validationStatus: "invalid",
      });
      return;
    }
    const classification = String(verdict.classification);
    if (classification !== "eligible") {
      const settled = ["already_processed", "duplicate", "no_accounting_required"].includes(
        classification,
      );
      await this.recordItemOutcome(batchId, item.id, {
        errorCode: verdict.blockingCode === null ? null : String(verdict.blockingCode),
        errorMessage: null,
        // Settled non-executions skip and never rerun; blocked, closed-period
        // and invalid stay unfinished for a future revalidating retry.
        executionStatus: settled ? "skipped" : null,
        reasons: verdict.blockingCode === null ? [] : [String(verdict.blockingCode)],
        resultingEventId:
          verdict.accountingEventId === null ? null : String(verdict.accountingEventId),
        resultingJournalId: verdict.journalId === null ? null : String(verdict.journalId),
        validationStatus: classification as AccountingBatchValidationStatus,
      });
      return;
    }

    // Step 3 -- capture, in the item's own transaction, then read the result.
    try {
      const eventId = await this.transactions.execute(async (transaction) => {
        if (item.sourceType === "order") {
          const order = await sql<{
            actorId: string;
            deliveredDate: string;
            orderNumber: string;
          }>`
            select order_number as "orderNumber",
                   coalesce((delivered_at at time zone 'Asia/Dubai')::date, order_date)::text
                     as "deliveredDate",
                   created_by_account_id as "actorId"
              from orders
             where id = ${item.sourceId}::uuid and company_id = ${companyId}::uuid
               and delivered_at is not null
          `.execute(transaction);
          const row = order.rows[0];
          if (row === undefined) throw new Error("order_not_recoverable");
          // The Order-delivery trigger's call, verbatim.
          await sql`
            select enqueue_operational_accounting_event(
              ${companyId}::uuid, 'orders', 'order_delivered', 'order',
              ${item.sourceId}::uuid, ${row.orderNumber}, ${row.deliveredDate}::date,
              ${row.actorId}::uuid, ${"order-delivery:" + item.sourceId}
            )
          `.execute(transaction);
        } else {
          const accrual = await sql<{
            accrualDate: string;
            actorId: string | null;
            reference: string | null;
          }>`
            select source_reference as reference,
                   accrual_business_date::text as "accrualDate",
                   created_by_account_id as "actorId"
              from outsourced_driver_fee_accruals
             where id = ${item.sourceId}::uuid and company_id = ${companyId}::uuid
               and status <> 'reversed'
          `.execute(transaction);
          const row = accrual.rows[0];
          if (row === undefined) throw new Error("accrual_not_recoverable");
          // The Fee-accrual trigger's call, verbatim. The immutable accrual is
          // untouched -- the processor reads `earned_amount` when it posts.
          await sql`
            select enqueue_operational_accounting_event(
              ${companyId}::uuid, 'outsourced_driver_fees', 'outsourced_driver_fee_accrued',
              'outsourced_driver_fee_accrual', ${item.sourceId}::uuid, ${row.reference},
              ${row.accrualDate}::date, ${row.actorId}::uuid,
              ${"driver-fee-accrual:" + item.sourceId}
            )
          `.execute(transaction);
        }
        const eventType =
          item.sourceType === "order" ? "order_delivered" : "outsourced_driver_fee_accrued";
        const created = await sql<{ id: string; journalId: string | null }>`
          select id, journal_id as "journalId" from accounting_events
           where company_id = ${companyId}::uuid and event_type = ${eventType}
             and source_entity_type = ${item.sourceType}
             and source_entity_id = ${item.sourceId}::uuid and event_version = 1
        `.execute(transaction);
        // The helper's only silent refusal is its Accounting-enabled gate; an
        // absent row after the call means capture was refused, not raced.
        if (created.rows[0] === undefined) throw new Error("capture_refused");
        return created.rows[0];
      });
      await this.recordItemOutcome(batchId, item.id, {
        errorCode: null,
        errorMessage: null,
        executionStatus: "succeeded",
        reasons: [],
        resultingEventId: eventId.id,
        // Almost always null here: the processor posts asynchronously, and no
        // Journal reference is ever fabricated.
        resultingJournalId: eventId.journalId,
        validationStatus: "eligible",
      });
    } catch (error) {
      const code =
        error instanceof Error && error.message === "capture_refused"
          ? "accounting_event_capture_refused"
          : "accounting_recovery_item_failed";
      await this.recordItemOutcome(batchId, item.id, {
        errorCode: code,
        errorMessage:
          code === "accounting_event_capture_refused"
            ? "Accounting is not enabled for this Company, so the Event could not be captured"
            : "The recovery item could not be executed",
        executionStatus: "failed",
        reasons: [],
        resultingEventId: null,
        resultingJournalId: null,
        validationStatus: "eligible",
      });
    }
  }

  /** One item outcome, in its own transaction. `executionStatus: null` keeps
   *  the item unfinished (blocked/invalid) while still recording the verdict. */
  private async recordItemOutcome(
    batchId: string,
    itemId: string,
    outcome: {
      readonly errorCode: string | null;
      readonly errorMessage: string | null;
      readonly executionStatus: "failed" | "skipped" | "succeeded" | null;
      readonly reasons: readonly string[];
      readonly resultingEventId: string | null;
      readonly resultingJournalId: string | null;
      readonly validationStatus: AccountingBatchValidationStatus;
    },
  ): Promise<void> {
    const { companyId } = this.support.context();
    await this.transactions.execute(async (transaction) => {
      await sql`
        update accounting_batch_items
           set validation_status = ${outcome.validationStatus},
               validation_reasons = ${JSON.stringify(outcome.reasons)}::jsonb,
               error_code = ${outcome.errorCode}, error_message = ${outcome.errorMessage},
               execution_status = coalesce(${outcome.executionStatus}, execution_status),
               resulting_accounting_event_id = ${outcome.resultingEventId}::uuid,
               resulting_journal_id = ${outcome.resultingJournalId}::uuid,
               executed_at = case when ${outcome.executionStatus}::text is null
                                  then executed_at else now() end,
               validated_at = now(), updated_at = now(), version = version + 1
         where id = ${itemId}::uuid and company_id = ${companyId}::uuid
           and batch_job_id = ${batchId}::uuid
      `.execute(transaction);
    });
  }

  /**
   * Operator recovery for a batch stuck in `processing`.
   *
   * ==========================================================================
   * IT RELEASES; IT NEVER RUNS
   * ==========================================================================
   *
   * This method executes no accounting work of any kind. It reconciles the
   * batch's status with what its item rows already durably say and moves it to
   * a lawful retryable state. The normal Retry action remains the ONLY way to
   * continue unfinished work — recovery never re-enters `draft` or `ready`,
   * and never touches an Event, Journal or source record.
   *
   * ==========================================================================
   * WHY THERE ARE NO CLAIMS TO CLEAR
   * ==========================================================================
   *
   * Item claims in this framework are TRANSACTION-SCOPED row locks
   * (`for update skip locked`), never persisted rows. When a worker dies, its
   * locks vanish with its connection and every item is left exactly at its
   * last durably recorded state — settled items settled, unfinished items
   * `pending`/`failed`. There is therefore no abandoned-claim row to clear
   * (the audited `clearedClaims` is 0 by construction), and no lease or
   * heartbeat column is missing: the schema already distinguishes active from
   * abandoned, through live locks and persisted `updated_at` activity.
   *
   * ==========================================================================
   * ACTIVE-WORKER PROTECTION, TWO INDEPENDENT FENCES
   * ==========================================================================
   *
   * 1. STALENESS — the batch must have shown no persisted activity (job row or
   *    any item row updated) for `accountingBatchProcessingStaleMinutes`. A
   *    live loop writes an item outcome every few seconds; fifteen minutes of
   *    silence is a dead worker, not a slow one.
   * 2. LOCK PROBE — every unfinished item is probed with
   *    `for update skip locked`. If any row cannot be locked, a live worker is
   *    holding it RIGHT NOW and recovery refuses, whatever the timestamps say.
   *
   * A claim that may still belong to an active worker is never cleared —
   * fence 2 makes that structurally true, not just unlikely.
   */
  public async recoverProcessing(
    batchId: string,
    input: RecoverAccountingBatchDto,
    idempotencyKey: string | undefined,
  ) {
    // Elevated permission only: releasing a stuck control record is an
    // operator decision, not a posting action.
    this.support.assertPermission("accounting.manage");
    await this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.batch.recover_processing",
        payload: {
          batchId,
          expectedVersion: input.expectedVersion,
          reason: input.reason.trim(),
        },
      });
      if (reservation.replayResponse !== undefined) return;
      const batch = await this.lockBatch(transaction, batchId);
      if (batch.status !== "processing") {
        throw new ApplicationException(
          terminalBatchStatuses.includes(batch.status)
            ? "accounting_batch_already_final"
            : "accounting_batch_not_interrupted",
          batch.status === "completed"
            ? "This batch already completed"
            : "Only a batch stuck in Processing can be recovered",
          HttpStatus.CONFLICT,
        );
      }
      if (Number(batch.version) !== input.expectedVersion) {
        throw new ApplicationException(
          "accounting_batch_version_conflict",
          "The batch changed after it was last reviewed. Reload it and try again.",
          HttpStatus.CONFLICT,
        );
      }
      const { companyId } = this.support.context();
      // Fence 1 — persisted staleness across the job row and every item row.
      const activity = await sql<{ minutesSilent: number }>`
        select floor(extract(epoch from (now() - greatest(
                 j.updated_at,
                 coalesce((select max(i.updated_at) from accounting_batch_items i
                            where i.batch_job_id = j.id and i.company_id = j.company_id),
                          j.updated_at)
               ))) / 60)::int as "minutesSilent"
          from accounting_batch_jobs j
         where j.id = ${batchId}::uuid and j.company_id = ${companyId}::uuid
      `.execute(transaction);
      const minutesSilent = activity.rows[0]?.minutesSilent ?? 0;
      if (minutesSilent < accountingBatchProcessingStaleMinutes) {
        throw new ApplicationException(
          "accounting_batch_processing_active",
          "This batch shows recent processing activity and cannot be recovered yet",
          HttpStatus.CONFLICT,
        );
      }
      // Fence 2 — probe the live locks. A row a live worker holds is skipped
      // by `skip locked`, so lockable < unfinished proves active execution.
      const unfinished = await sql<{ total: number }>`
        select count(*)::int as total from accounting_batch_items
         where batch_job_id = ${batchId}::uuid and company_id = ${companyId}::uuid
           and execution_status in ('pending', 'failed')
      `.execute(transaction);
      const lockable = await sql<{ total: number }>`
        select count(*)::int as total from (
          select id from accounting_batch_items
           where batch_job_id = ${batchId}::uuid and company_id = ${companyId}::uuid
             and execution_status in ('pending', 'failed')
           for update skip locked
        ) probe
      `.execute(transaction);
      if ((lockable.rows[0]?.total ?? 0) < (unfinished.rows[0]?.total ?? 0)) {
        throw new ApplicationException(
          "accounting_batch_processing_active",
          "A worker is still holding batch items and must not be interrupted",
          HttpStatus.CONFLICT,
        );
      }

      // Reconcile: item rows are already correct (settled stays settled,
      // unfinished stays retryable); only the batch's own story needs fixing.
      const tallies = await sql<{ count: number; executionStatus: string }>`
        select execution_status as "executionStatus", count(*)::int as count
          from accounting_batch_items
         where batch_job_id = ${batchId}::uuid and company_id = ${companyId}::uuid
         group by execution_status
      `.execute(transaction);
      const duplicates = await sql<{ total: number }>`
        select count(*)::int as total from accounting_batch_items
         where batch_job_id = ${batchId}::uuid and company_id = ${companyId}::uuid
           and validation_status = 'duplicate'
      `.execute(transaction);
      const of = (status: string): number =>
        tallies.rows.find((row) => row.executionStatus === status)?.count ?? 0;
      const succeeded = of("succeeded");
      const failed = of("failed");
      const skipped = of("skipped");
      const pending = of("pending");
      const unfinishedCount = failed + pending;
      // Spec'd recovery outcome: successes alongside unfinished work ->
      // partially complete; nothing succeeded but retryable work remains ->
      // failed (retryable); everything settled -> completed.
      const finalStatus: AccountingBatchStatus =
        unfinishedCount === 0
          ? "completed"
          : succeeded > 0
            ? "partially_completed"
            : "failed";
      await sql`
        update accounting_batch_jobs
           set succeeded_count = ${succeeded}, failed_count = ${failed},
               skipped_count = ${skipped}, duplicate_count = ${duplicates.rows[0]?.total ?? 0},
               completed_at = coalesce(completed_at, now())
         where id = ${batchId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      const correlationId = idempotencyKey ?? randomUUID();
      await this.setStatus(transaction, {
        batchId,
        correlationId,
        from: "processing",
        note: `recovered: ${input.reason.trim()}`.slice(0, 500),
        to: finalStatus,
      });
      const summary = {
        afterStatus: finalStatus,
        beforeStatus: "processing",
        beforeVersion: input.expectedVersion,
        clearedClaims: 0,
        counters: { failed, pending, skipped, succeeded },
        minutesSilent,
        reason: input.reason.trim(),
      };
      await this.support.audit(transaction, {
        action: "accounting.batch.processing_recovered",
        after: summary,
        correlationId,
        subjectId: batchId,
        subjectType: "accounting_batch_job",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "accounting.batch.recover_processing",
        resourceId: batchId,
        resourceType: "accounting_batch_job",
        responseBody: summary,
      });
    });
    return this.detail(batchId);
  }

  public async cancel(
    batchId: string,
    input: CancelAccountingBatchDto,
    idempotencyKey: string | undefined,
  ) {
    this.assertBatchAuthority();
    await this.transactions.execute(async (transaction) => {
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.batch.cancel",
        payload: { batchId, reason: input.reason.trim() },
      });
      if (reservation.replayResponse !== undefined) return;
      const batch = await this.lockBatch(transaction, batchId);
      if (terminalBatchStatuses.includes(batch.status)) {
        throw new ApplicationException(
          "accounting_batch_already_final",
          "This batch has already reached a final state",
          HttpStatus.CONFLICT,
        );
      }
      if (!canTransitionBatch(batch.status, "cancelled")) {
        throw new ApplicationException(
          "accounting_batch_not_cancellable",
          "This batch cannot be cancelled in its current state",
          HttpStatus.CONFLICT,
        );
      }
      const correlationId = idempotencyKey ?? randomUUID();
      const { actorId, companyId } = this.support.context();
      await sql`
        update accounting_batch_jobs
           set status = 'cancelled', cancelled_at = now(),
               cancellation_reason = ${input.reason.trim()},
               updated_by_account_id = ${actorId}::uuid, updated_at = now(), version = version + 1
         where id = ${batchId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      // Cancelling the batch cancels its outstanding work, so no item is left
      // claiming it is still waiting for an execution that will never come.
      await sql`
        update accounting_batch_items
           set execution_status = 'cancelled', updated_at = now(), version = version + 1
         where batch_job_id = ${batchId}::uuid and company_id = ${companyId}::uuid
           and execution_status = 'pending'
      `.execute(transaction);
      await this.recordTransition(transaction, {
        batchId,
        correlationId,
        from: batch.status,
        note: input.reason.trim(),
        to: "cancelled",
      });
      await this.support.audit(transaction, {
        action: "accounting.batch.cancelled",
        after: { priorStatus: batch.status, reason: input.reason.trim() },
        correlationId,
        subjectId: batchId,
        subjectType: "accounting_batch_job",
      });
      await this.support.completeIdempotency(transaction, {
        idempotencyKey: idempotencyKey!,
        operation: "accounting.batch.cancel",
        resourceId: batchId,
        resourceType: "accounting_batch_job",
        responseBody: { status: "cancelled" },
      });
    });
    return this.detail(batchId);
  }

  public async list(query: AccountingBatchListQueryDto) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const { limit, offset, page, pageSize } = this.support.pagination(query);
    const { column, direction, sortBy, sortDirection } = this.support.sorting(
      query,
      {
        batchReference: "j.batch_reference",
        createdAt: "j.created_at",
        status: "j.status",
        totalItems: "j.total_items",
      },
      "createdAt",
    );
    const status = query.status ?? null;
    const batchType = query.batchType ?? null;
    const requestedBy = query.requestedBy ?? null;
    const dateFrom = query.dateFrom ?? null;
    const dateTo = query.dateTo ?? null;
    const reference = query.reference?.trim() ?? "";
    const where = sql`
      j.company_id = ${companyId}::uuid
      and (${status}::text is null or j.status = ${status})
      and (${batchType}::text is null or j.batch_type = ${batchType})
      and (${requestedBy}::uuid is null or j.requested_by_account_id = ${requestedBy}::uuid)
      and (${dateFrom}::date is null or j.created_at >= ${dateFrom}::date)
      and (${dateTo}::date is null or j.created_at < (${dateTo}::date + interval '1 day'))
      and (${reference} = '' or j.batch_reference ilike '%' || ${reference} || '%')
    `;
    const [items, total] = await Promise.all([
      // Per-batch item counts ride a LATERAL over the paged rows only: the
      // aggregation happens in the database against persisted item rows (the
      // one authoritative source — retries UPDATE an item, so nothing is ever
      // double-counted), scoped by company on both sides, and it costs the
      // page (≤200 rows), never the history. Validation verdicts and
      // execution outcomes are DIFFERENT facts about an item and are exposed
      // as two separate maps rather than blended into one number.
      sql<Record<string, unknown>>`
        select j.id, j.batch_reference as "batchReference", j.batch_type as "batchType",
               j.status, j.reason, j.total_items as "totalItems",
               j.succeeded_count as "succeededCount", j.failed_count as "failedCount",
               j.skipped_count as "skippedCount", j.duplicate_count as "duplicateCount",
               j.correlation_id as "correlationId", j.created_at as "createdAt",
               j.started_at as "startedAt", j.completed_at as "completedAt",
               j.cancelled_at as "cancelledAt", j.last_validated_at as "lastValidatedAt",
               j.requested_by_account_id as "requestedByAccountId", j.version,
               ic.item_total as "itemTotal",
               ic.validation_counts as "validationCounts",
               ic.execution_counts as "executionCounts"
          from accounting_batch_jobs j
          left join lateral (
            select
              (select count(*)::int from accounting_batch_items i
                where i.batch_job_id = j.id and i.company_id = j.company_id) as item_total,
              (select coalesce(jsonb_object_agg(v.s, v.c), '{}'::jsonb)
                 from (select i.validation_status as s, count(*)::int as c
                         from accounting_batch_items i
                        where i.batch_job_id = j.id and i.company_id = j.company_id
                        group by i.validation_status) v) as validation_counts,
              (select coalesce(jsonb_object_agg(e.s, e.c), '{}'::jsonb)
                 from (select i.execution_status as s, count(*)::int as c
                         from accounting_batch_items i
                        where i.batch_job_id = j.id and i.company_id = j.company_id
                        group by i.execution_status) e) as execution_counts
          ) ic on true
         where ${where}
         order by ${sql.raw(column)} ${sql.raw(direction)}, j.id
         limit ${limit} offset ${offset}
      `.execute(this.database),
      sql<{ total: number }>`
        select count(*)::int as total from accounting_batch_jobs j where ${where}
      `.execute(this.database),
    ]);
    return {
      items: items.rows,
      page,
      pageSize,
      sortBy,
      sortDirection,
      total: total.rows[0]?.total ?? 0,
    };
  }

  public async detail(batchId: string, itemQuery: AccountingBatchItemQueryDto = {}) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const batch = await sql<Record<string, unknown>>`
      select j.id, j.batch_reference as "batchReference", j.batch_type as "batchType",
             j.status, j.reason, j.total_items as "totalItems",
             j.succeeded_count as "succeededCount", j.failed_count as "failedCount",
             j.skipped_count as "skippedCount", j.duplicate_count as "duplicateCount",
             j.correlation_id as "correlationId", j.created_at as "createdAt",
             j.started_at as "startedAt", j.completed_at as "completedAt",
             j.cancelled_at as "cancelledAt", j.cancellation_reason as "cancellationReason",
             j.last_validated_at as "lastValidatedAt",
             j.requested_by_account_id as "requestedByAccountId", j.version,
             j.updated_at as "updatedAt",
             (select max(i.updated_at) from accounting_batch_items i
               where i.batch_job_id = j.id and i.company_id = j.company_id)
               as "lastItemActivityAt"
        from accounting_batch_jobs j
       where j.id = ${batchId}::uuid and j.company_id = ${companyId}::uuid
    `.execute(this.database);
    // Another Company's batch is "not found", never "forbidden": a 403 would
    // confirm the record exists.
    if (batch.rows[0] === undefined) {
      throw new ApplicationException(
        "accounting_batch_not_found",
        "The Accounting batch was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const { limit, offset, page, pageSize } = this.support.pagination(itemQuery);
    const { column, direction, sortBy, sortDirection } = this.support.sorting(
      itemQuery,
      {
        createdAt: "i.created_at",
        sourceReference: "i.source_reference",
        validationStatus: "i.validation_status",
      },
      "createdAt",
    );
    const validationStatus = itemQuery.validationStatus ?? null;
    const itemWhere = sql`
      i.batch_job_id = ${batchId}::uuid and i.company_id = ${companyId}::uuid
      and (${validationStatus}::text is null or i.validation_status = ${validationStatus})
    `;
    const [items, itemTotal, counts, sourceTypes, transitions] = await Promise.all([
      sql<Record<string, unknown>>`
        select i.id, i.source_type as "sourceType", i.source_id as "sourceId",
               i.source_reference as "sourceReference",
               i.validation_status as "validationStatus",
               i.execution_status as "executionStatus",
               i.validation_reasons as "validationReasons",
               i.error_code as "errorCode", i.error_message as "errorMessage",
               i.resulting_accounting_event_id as "resultingAccountingEventId",
               i.resulting_journal_id as "resultingJournalId",
               i.correlation_id as "correlationId", i.created_at as "createdAt",
               i.validated_at as "validatedAt", i.executed_at as "executedAt"
          from accounting_batch_items i
         where ${itemWhere}
         order by ${sql.raw(column)} ${sql.raw(direction)}, i.id
         limit ${limit} offset ${offset}
      `.execute(this.database),
      sql<{ total: number }>`
        select count(*)::int as total from accounting_batch_items i where ${itemWhere}
      `.execute(this.database),
      // Classification counts come from the items, never from a column on the
      // job: one place to be right about what the batch currently contains.
      sql<{ count: number; validationStatus: string }>`
        select validation_status as "validationStatus", count(*)::int as count
          from accounting_batch_items
         where batch_job_id = ${batchId}::uuid and company_id = ${companyId}::uuid
         group by validation_status
      `.execute(this.database),
      // Source-type mix, for the execute confirmation's summary.
      sql<{ count: number; sourceType: string }>`
        select source_type as "sourceType", count(*)::int as count
          from accounting_batch_items
         where batch_job_id = ${batchId}::uuid and company_id = ${companyId}::uuid
         group by source_type
      `.execute(this.database),
      sql<Record<string, unknown>>`
        select from_status as "fromStatus", to_status as "toStatus", note,
               actor_account_id as "actorAccountId", occurred_at as "occurredAt"
          from accounting_batch_transitions
         where batch_job_id = ${batchId}::uuid and company_id = ${companyId}::uuid
         order by occurred_at, id
      `.execute(this.database),
    ]);
    const batchType = String(batch.rows[0]!.batchType) as AccountingBatchType;
    return {
      ...batch.rows[0]!,
      items: {
        items: items.rows,
        page,
        pageSize,
        sortBy,
        sortDirection,
        total: itemTotal.rows[0]?.total ?? 0,
      },
      metadata: {
        // The rule, restated in the response so a caller can see which service
        // owns the verdicts without reading the source.
        executionImplemented: true,
        maxItems: accountingBatchMaxItems,
        // The operator-recovery staleness threshold, so the UI can decide when
        // to OFFER recovery; the backend re-checks it and stays authoritative.
        processingStaleMinutes: accountingBatchProcessingStaleMinutes,
        singleItemService: batchTypeServices[batchType],
      },
      validationCounts: Object.fromEntries(
        counts.rows.map((row) => [row.validationStatus, row.count]),
      ),
      sourceTypeCounts: Object.fromEntries(
        sourceTypes.rows.map((row) => [row.sourceType, row.count]),
      ),
      transitions: transitions.rows,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Classification.
   *
   * Batch-level facts are resolved in TWO grouped queries for the whole item
   * set, not per item: which sources this Company actually owns, and which are
   * already enrolled in another live batch. Only the eligibility question --
   * the one this module is forbidden to answer itself -- costs a call per item.
   */
  private async classify(
    batchId: string,
    batchType: AccountingBatchType,
    items: readonly ItemRow[],
  ): Promise<readonly Classification[]> {
    if (items.length === 0) return [];
    const { companyId } = this.support.context();
    const ids = items.map((item) => item.sourceId);
    const [known, enrolled] = await Promise.all([
      sql<{ id: string; operationalArea: string | null; sourceReference: string | null }>`
        select id, operational_area as "operationalArea",
               source_reference as "sourceReference"
          from accounting_events
         where company_id = ${companyId}::uuid and id = any(${ids}::uuid[])
      `.execute(this.database),
      sql<{ sourceId: string }>`
        select distinct i.source_id as "sourceId"
          from accounting_batch_items i
          join accounting_batch_jobs j
            on j.id = i.batch_job_id and j.company_id = i.company_id
         where i.company_id = ${companyId}::uuid
           and i.source_id = any(${ids}::uuid[])
           -- Another batch, not this one: an item is not its own duplicate.
           and i.batch_job_id <> ${batchId}::uuid
           -- Only batches that could still act on the source. A cancelled or
           -- finished batch holds no claim on it.
           and j.status not in ('cancelled', 'completed', 'failed', 'partially_completed')
      `.execute(this.database),
    ]);
    const sources = new Map(known.rows.map((row) => [row.id, row]));
    const live = new Set(enrolled.rows.map((row) => row.sourceId));

    const results: Classification[] = [];
    for (const item of items) {
      const source = sources.get(item.sourceId);
      if (source === undefined) {
        // Covers "does not exist" and "belongs to another Company" with one
        // answer, so the endpoint never confirms a foreign record exists.
        results.push({
          errorCode: "accounting_event_not_found",
          errorMessage: "The Accounting Event was not found",
          id: item.id,
          reasons: ["source_not_found"],
          sourceReference: null,
          validationStatus: "invalid",
        });
        continue;
      }
      if (batchType === "operational_posting_retry" && source.operationalArea === null) {
        results.push({
          errorCode: "accounting_event_not_operational",
          errorMessage: "This Accounting Event carries no operational area",
          id: item.id,
          reasons: ["event_not_operational"],
          sourceReference: source.sourceReference,
          validationStatus: "invalid",
        });
        continue;
      }
      if (live.has(item.sourceId)) {
        results.push({
          errorCode: null,
          errorMessage: null,
          id: item.id,
          reasons: ["source_enrolled_in_another_batch"],
          sourceReference: source.sourceReference,
          validationStatus: "duplicate",
        });
        continue;
      }
      // The one question this module does not answer for itself.
      const readiness = await this.events.reprocessingReadiness(item.sourceId);
      const blockers = readiness.blockers;
      const alreadyDone =
        blockers.includes("event_already_posted") ||
        blockers.includes("event_journal_already_exists");
      results.push({
        errorCode: null,
        errorMessage: null,
        id: item.id,
        reasons: blockers,
        sourceReference: source.sourceReference,
        validationStatus: readiness.eligible
          ? "eligible"
          : alreadyDone
            ? "already_processed"
            : "blocked",
      });
    }
    return results;
  }

  private summarise(classifications: readonly Classification[]) {
    const counts: Record<string, number> = {};
    for (const item of classifications) {
      counts[item.validationStatus] = (counts[item.validationStatus] ?? 0) + 1;
    }
    return { counts, itemCount: classifications.length };
  }

  /**
   * Enrols sources, ignoring any already present.
   *
   * `on conflict do nothing` against the `(batch_job_id, source_type,
   * source_id)` unique index, so a repeated add is a no-op rather than a second
   * item -- and so the guarantee holds even for a caller that bypasses this
   * method.
   */
  private async insertItems(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly batchId: string;
      readonly batchType: AccountingBatchType;
      readonly companyId: string;
      readonly sourceIds: readonly string[];
    },
  ): Promise<{ readonly ignored: number; readonly inserted: number }> {
    const sourceType = batchTypeServices[input.batchType].sourceType;
    const existing = await sql<{ total: number }>`
      select count(*)::int as total from accounting_batch_items
       where batch_job_id = ${input.batchId}::uuid and company_id = ${input.companyId}::uuid
    `.execute(transaction);
    const current = existing.rows[0]?.total ?? 0;
    if (current + input.sourceIds.length > accountingBatchMaxItems) {
      throw new ApplicationException(
        "accounting_batch_item_limit_exceeded",
        `A batch cannot hold more than ${accountingBatchMaxItems} items`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const inserted = await sql<{ id: string }>`
      insert into accounting_batch_items (company_id, batch_job_id, source_type, source_id)
      select ${input.companyId}::uuid, ${input.batchId}::uuid, ${sourceType}, source_id
        from unnest(${input.sourceIds}::uuid[]) as source_id
      on conflict (batch_job_id, source_type, source_id) do nothing
      returning id
    `.execute(transaction);
    await sql`
      update accounting_batch_jobs
         set total_items = (
               select count(*)::int from accounting_batch_items
                where batch_job_id = ${input.batchId}::uuid
                  and company_id = ${input.companyId}::uuid),
             updated_at = now(), version = version + 1
       where id = ${input.batchId}::uuid and company_id = ${input.companyId}::uuid
    `.execute(transaction);
    return {
      ignored: input.sourceIds.length - inserted.rows.length,
      inserted: inserted.rows.length,
    };
  }

  private async lockBatch(
    transaction: Transaction<DatabaseSchema>,
    batchId: string,
  ): Promise<BatchRow> {
    const { companyId } = this.support.context();
    const result = await sql<BatchRow>`
      select batch_reference as "batchReference", batch_type as "batchType", status,
             total_items as "totalItems", version::text as version
        from accounting_batch_jobs
       where id = ${batchId}::uuid and company_id = ${companyId}::uuid
       for update
    `.execute(transaction);
    if (result.rows[0] === undefined) {
      throw new ApplicationException(
        "accounting_batch_not_found",
        "The Accounting batch was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return result.rows[0];
  }

  private async setStatus(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly batchId: string;
      readonly correlationId: string;
      readonly from: AccountingBatchStatus;
      readonly note: string | null;
      readonly to: AccountingBatchStatus;
    },
  ): Promise<void> {
    if (!canTransitionBatch(input.from, input.to)) {
      throw new ApplicationException(
        "accounting_batch_transition_not_allowed",
        `A batch cannot move from ${input.from} to ${input.to}`,
        HttpStatus.CONFLICT,
      );
    }
    const { actorId, companyId } = this.support.context();
    await sql`
      update accounting_batch_jobs
         set status = ${input.to}, updated_by_account_id = ${actorId}::uuid,
             updated_at = now(), version = version + 1
       where id = ${input.batchId}::uuid and company_id = ${companyId}::uuid
    `.execute(transaction);
    await this.recordTransition(transaction, input);
  }

  private async recordTransition(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly batchId: string;
      readonly correlationId: string;
      readonly from: AccountingBatchStatus | null;
      readonly note: string | null;
      readonly to: AccountingBatchStatus;
    },
  ): Promise<void> {
    const { actorId, companyId } = this.support.context();
    await sql`
      insert into accounting_batch_transitions (
        company_id, batch_job_id, from_status, to_status, actor_account_id, note, correlation_id
      ) values (
        ${companyId}::uuid, ${input.batchId}::uuid, ${input.from}, ${input.to},
        ${actorId}::uuid, ${input.note}, ${input.correlationId}::uuid
      )
    `.execute(transaction);
  }

  /**
   * The next batch reference for this Company.
   *
   * Derived from the table under an advisory lock rather than from
   * `company_reference_counters`, whose `type` CHECK does not permit a batch
   * counter. Adding a value to that constraint would be a schema change to a
   * shared table for one feature's numbering; the advisory lock gives the same
   * gap-free sequence per Company without it.
   */
  private async nextBatchReference(
    transaction: Transaction<DatabaseSchema>,
    companyId: string,
  ): Promise<string> {
    await sql`
      select pg_advisory_xact_lock(hashtextextended('accounting-batch-number:' || ${companyId}, 0))
    `.execute(transaction);
    const result = await sql<{ next: string }>`
      select coalesce(
        max(nullif(regexp_replace(batch_reference, '[^0-9]', '', 'g'), '')::bigint), 0
      ) + 1 as next
        from accounting_batch_jobs where company_id = ${companyId}::uuid
    `.execute(transaction);
    return `BATCH-${String(result.rows[0]?.next ?? "1").padStart(6, "0")}`;
  }
}
