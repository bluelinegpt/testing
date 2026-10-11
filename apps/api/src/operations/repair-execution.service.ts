import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql, type Transaction } from "kysely";

import {
  type AccountingInspection,
  type AccountingRecoveryOutcome,
  PlatformAccountingRepairAdapter,
} from "../accounting/platform-accounting-repair.adapter.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import {
  CompanyOrderHealthService,
  ORDER_HEALTH_REASONS,
  type OrderHealthReasonCode,
} from "./company-order-health.service.js";
import { OperationsService } from "./operations.service.js";
import { canonicalJson, type RepairFinding } from "./repair-center.model.js";
import { type CapabilityCode, REPAIR_CAPABILITIES } from "./repair-capability.registry.js";
import {
  ACCOUNTING_CAPABILITY,
  ACCOUNTING_FINDING_REASON,
  accountingFindingOf,
} from "./repair-accounting-recovery.service.js";
import { RepairAttemptRecorder } from "./repair-attempt.recorder.js";
import { RepairOrderingService } from "./repair-ordering.service.js";
import { RepairPreviewService } from "./repair-preview.service.js";
import { TraderReceivableService } from "./trader-receivable.service.js";
import { expectedReceivableStatus } from "./trader-receivable-reconciliation.js";

/**
 * REPAIR CENTER -- SAFE REPAIR EXECUTION (Phase 2, Prompt 3).
 *
 * Executes ONE certified capability for ONE Order of ONE Company, only after
 * re-proving -- inside the same transaction, with the Order row locked --
 * everything the preview showed:
 *
 *   lock Order (Company, id) -> idempotency ledger -> recompute finding,
 *   graph, capability, repairability and previewVersion -> compare with the
 *   request -> validate inputs -> run the certified domain operation ->
 *   recompute and verify the target finding is gone -> write the immutable
 *   repair audit -> COMMIT.
 *
 * Any failure throws, and the single transaction rolls back everything: there
 * is no half-repaired Order, no audit without a repair and no repair without
 * an audit. Nothing the browser sent is trusted beyond WHICH finding /
 * capability it asks for and the fingerprint it saw. No business table is
 * written here: the capability's `execute` calls the certified domain service.
 */

export interface RepairExecutionRequest {
  readonly findingId: string;
  readonly capabilityCode: string;
  readonly previewVersion: string;
  readonly reason: string;
  readonly inputs?: Readonly<Record<string, string>> | undefined;
  readonly idempotencyKey: string;
}

export interface RepairExecutionActor {
  readonly accountId: string;
  readonly correlationId: string;
  /** The Platform permission that authorised the call. */
  readonly authority: string;
}

export interface RepairExecutionResult {
  readonly repairExecutionId: string;
  readonly auditId: string;
  readonly companyId: string;
  /** For an accounting recovery: the source Order when the event's source resolves to one, else "". */
  readonly orderId: string;
  readonly orderNumber: string;
  readonly findingId: string;
  readonly reasonCode: string;
  readonly capabilityCode: string;
  readonly status: "succeeded";
  readonly beforeHealth: string;
  readonly afterHealth: string;
  readonly beforeClassification: string;
  readonly afterClassification: string;
  readonly beforePreviewVersion: string;
  readonly afterPreviewVersion: string;
  readonly executedAt: string;
  /** True when this response replays an earlier execution (same key + request). */
  readonly replayed: boolean;
  readonly nextRecommendedAction: string;
}

type Recomputed = Awaited<ReturnType<RepairPreviewService["computeIn"]>>;

/** Where an execution got to, for classifying a refusal vs a failure (Prompt 5). */
interface AttemptProgress {
  readonly entityType: "order" | "accounting_event";
  readonly entityId: string;
  entityNumber: string | null;
  reasonCode: string | null;
  stage: "checking" | "executing";
}

const STALE_MESSAGE =
  "The order changed after the repair preview. Refresh and review the new state before repairing.";
const SENSITIVE_INPUT = /pass|secret|token|key|pin|otp|card|iban|account/iu;

@Injectable()
export class RepairExecutionService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(RepairPreviewService) private readonly previews: RepairPreviewService,
    @Inject(OperationsService) private readonly operations: OperationsService,
    @Inject(PlatformAccountingRepairAdapter) private readonly accounting: PlatformAccountingRepairAdapter,
    @Inject(CompanyOrderHealthService) private readonly health: CompanyOrderHealthService,
    @Inject(RepairAttemptRecorder) private readonly attempts: RepairAttemptRecorder,
    @Inject(TraderReceivableService) private readonly traderReceivables: TraderReceivableService,
    @Inject(RepairOrderingService) private readonly ordering: RepairOrderingService,
  ) {}

  /**
   * Order repair entry point. Runs the atomic execution, then -- OUTSIDE its
   * (committed or rolled back) transaction -- records a REFUSED / FAILED /
   * REPLAYED attempt (Prompt 5). The outcome returned or thrown is always the
   * execution's own; the attempt record can never change it.
   */
  public async execute(
    companyId: string,
    orderId: string,
    request: RepairExecutionRequest,
    actor: RepairExecutionActor,
  ): Promise<RepairExecutionResult> {
    const progress: AttemptProgress = {
      entityId: orderId,
      entityNumber: null,
      entityType: "order",
      reasonCode: null,
      stage: "checking",
    };
    try {
      const result = await this.runOrder(companyId, orderId, request, actor, progress);
      if (result.replayed) {
        progress.entityNumber = result.orderNumber;
        await this.attempts.record(
          this.attemptOf(companyId, request, actor, progress, "REPLAYED", undefined, result.repairExecutionId),
        );
      }
      return result;
    } catch (error) {
      await this.attempts.record(
        this.attemptOf(companyId, request, actor, progress, progress.stage === "executing" ? "FAILED" : "REFUSED", error),
      );
      throw error;
    }
  }

  private attemptOf(
    companyId: string,
    request: RepairExecutionRequest,
    actor: RepairExecutionActor,
    progress: AttemptProgress,
    result: "REFUSED" | "FAILED" | "REPLAYED",
    error?: unknown,
    repairExecutionId?: string,
  ) {
    return {
      actorAccountId: actor.accountId,
      actorAuthority: actor.authority,
      capabilityCode: typeof request.capabilityCode === "string" ? request.capabilityCode : null,
      companyId,
      correlationId: actor.correlationId,
      entityId: progress.entityId,
      entityNumber: progress.entityNumber,
      entityType: progress.entityType,
      error,
      findingId: typeof request.findingId === "string" ? request.findingId : null,
      idempotencyKey: typeof request.idempotencyKey === "string" ? request.idempotencyKey : null,
      previewVersion: typeof request.previewVersion === "string" ? request.previewVersion : null,
      reason: typeof request.reason === "string" ? request.reason : null,
      reasonCode: progress.reasonCode,
      repairExecutionId: repairExecutionId ?? null,
      result,
    };
  }

  private async runOrder(
    companyId: string,
    orderId: string,
    request: RepairExecutionRequest,
    actor: RepairExecutionActor,
    progress: AttemptProgress,
  ): Promise<RepairExecutionResult> {
    const reason = request.reason.trim();
    if (reason === "") {
      throw new ApplicationException("repair_reason_required", "A reason is required", HttpStatus.BAD_REQUEST);
    }
    const capability = REPAIR_CAPABILITIES.find((item) => item.capabilityCode === request.capabilityCode);
    if (capability === undefined) {
      throw new ApplicationException("repair_capability_unknown", "Unknown repair capability", HttpStatus.BAD_REQUEST);
    }
    const inputs = request.inputs ?? {};
    const requestHash = createHash("sha256")
      .update(
        canonicalJson({
          capabilityCode: request.capabilityCode,
          findingId: request.findingId,
          inputs,
          orderId,
          previewVersion: request.previewVersion,
          reason,
        }),
      )
      .digest("hex");

    return this.database.transaction().execute(async (transaction) => {
      await sql`select set_config('statement_timeout', '30s', true), set_config('jit', 'off', true)`.execute(
        transaction,
      );
      // 1. Lock the Order inside its Company. Concurrent executions for the
      //    same Order serialise here; the loser re-reads committed state.
      const locked = await sql<{ id: string }>`
        select id from orders where id = ${orderId}::uuid and company_id = ${companyId}::uuid for update
      `.execute(transaction);
      if (locked.rows[0] === undefined) {
        throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
      }

      // 2. Idempotency: the same key for this Company / capability / Order.
      const prior = await sql<{ requestHash: string; resultSummary: RepairExecutionResult }>`
        select request_hash as "requestHash", result_summary as "resultSummary"
          from platform_repair_executions
         where company_id = ${companyId}::uuid and capability_code = ${request.capabilityCode}
           and order_id = ${orderId}::uuid and idempotency_key = ${request.idempotencyKey}
      `.execute(transaction);
      if (prior.rows[0] !== undefined) {
        if (prior.rows[0].requestHash !== requestHash) {
          throw new ApplicationException(
            "repair_idempotency_conflict",
            "This idempotency key was already used for a different repair request",
            HttpStatus.CONFLICT,
          );
        }
        const { domainOutcome, ...original } = prior.rows[0].resultSummary as RepairExecutionResult & {
          readonly domainOutcome?: unknown;
        };
        void domainOutcome;
        return { ...original, replayed: true };
      }

      // 3. Recompute everything from the database; never trust the preview.
      const before = await this.previews.computeIn(transaction, companyId, orderId);
      progress.entityNumber = before.analysis.orderNumber;
      const finding = before.analysis.findings.find((item) => item.findingId === request.findingId);
      progress.reasonCode = finding?.reasonCode ?? null;
      if (finding === undefined) {
        throw new ApplicationException(
          "repair_finding_not_current",
          "That finding is not current for this order any more; refresh the Order details",
          HttpStatus.CONFLICT,
        );
      }
      if (finding.repairCapability !== capability.capabilityCode) {
        throw new ApplicationException(
          "repair_capability_not_applicable",
          "That capability does not apply to this finding",
          HttpStatus.CONFLICT,
        );
      }
      if (before.analysis.previewVersion !== request.previewVersion) {
        throw new ApplicationException("repair_preview_stale", STALE_MESSAGE, HttpStatus.CONFLICT);
      }
      if (finding.repairability !== "READY") {
        throw new ApplicationException(
          "repair_not_ready",
          `This repair is ${finding.repairability}; only a READY repair can be executed`,
          HttpStatus.CONFLICT,
          finding.blockers.map((blocker) => blocker.code),
        );
      }
      if (!capability.execution.available) {
        throw new ApplicationException(
          "repair_capability_not_executable",
          capability.execution.reason,
          HttpStatus.CONFLICT,
        );
      }

      // 4. Inputs: only what the plan declares, and every required one.
      const plan = before.plans.get(finding.reasonCode);
      const declared = new Set((plan?.requiredInputs ?? []).map((input) => input.name));
      const unknown = Object.keys(inputs).filter((name) => name !== "reason" && !declared.has(name));
      const missing = (plan?.requiredInputs ?? []).filter(
        (input) => input.required && input.name !== "reason" && (inputs[input.name] ?? "").trim() === "",
      );
      if (unknown.length > 0 || missing.length > 0) {
        throw new ApplicationException(
          "repair_inputs_invalid",
          "The repair inputs do not match what this repair requires",
          HttpStatus.BAD_REQUEST,
          [...unknown.map((name) => `unknown input: ${name}`), ...missing.map((input) => `missing input: ${input.name}`)],
        );
      }

      // 5. The certified domain operation, in THIS transaction. From here on a
      //    failure is FAILED (rolled back), not REFUSED.
      progress.stage = "executing";
      const outcome = await capability.execution.execute({
        companyId,
        correlationId: actor.correlationId,
        operations: this.operations,
        orderId,
        traderReceivables: this.traderReceivables,
        transaction,
      });
      if (!outcome.changed) {
        throw new ApplicationException(
          "repair_no_change",
          "The certified repair made no change; nothing was recorded",
          HttpStatus.CONFLICT,
        );
      }

      // 6. Verify again, same transaction, before anything commits.
      const after = await this.previews.computeIn(transaction, companyId, orderId);
      this.verifyRepaired(finding, before, after);

      // 7. Immutable audit + idempotency record, same transaction.
      return this.writeAudit(transaction, {
        actor,
        after,
        before,
        companyId,
        finding,
        inputs,
        orderId,
        // Positive evidence for "Platform Repair" display (Prompt 4, Part Q):
        // the exact receivable this repair created.
        outcome: {
          ...outcome.summary,
          receivableId:
            capability.capabilityCode === "REPAIR_TRADER_RECEIVABLE" ||
            capability.capabilityCode === "REPLACE_UNUSED_TRADER_RECEIVABLE"
              ? (after.graph.receivables.find((row) => row.current)?.id ?? null)
              : null,
        },
        reason,
        request,
        requestHash,
      });
    });
  }

  /**
   * The target finding must be gone and the Order's Trader-receivable
   * classification must be HEALTHY; for a receivable repair, exactly one
   * current receivable for exactly the amount the financial model says the
   * Trader owes. Otherwise the repair is NOT reported as a success.
   */
  protected verifyRepaired(finding: RepairFinding, before: Recomputed, after: Recomputed): void {
    const failures: string[] = [];
    if (after.analysis.findings.some((item) => item.reasonCode === finding.reasonCode && item.health !== "HEALTHY")) {
      failures.push(`${finding.reasonCode} is still present`);
    }
    if (ORDER_HEALTH_REASONS[after.evaluation.financialCode].health !== "HEALTHY") {
      failures.push(`receivable classification is ${after.evaluation.financialCode}`);
    }
    if ((finding.repairCapability as CapabilityCode) === "REPAIR_TRADER_RECEIVABLE") {
      const current = after.graph.receivables.filter((row) => row.current);
      if (current.length !== 1) failures.push(`${current.length} current receivables`);
      else if (!new Decimal(current[0]!.amountDue).equals(new Decimal(before.evaluation.traderDue))) {
        failures.push("receivable amount differs from the financial model");
      }
      if (after.graph.order.deliveryStatus !== before.graph.order.deliveryStatus) {
        failures.push("order delivery status changed");
      }
    }
    if ((finding.repairCapability as CapabilityCode) === "RECONCILE_TRADER_RECEIVABLE") {
      // Status only: the receivable now follows the domain status rule; its
      // amounts and every clearing record are exactly as before.
      const beforeCurrent = before.graph.receivables.filter((row) => row.current);
      const afterCurrent = after.graph.receivables.filter((row) => row.current);
      if (afterCurrent.length !== 1 || beforeCurrent.length !== 1 || afterCurrent[0]!.id !== beforeCurrent[0]!.id) {
        failures.push("the current receivable changed");
      } else {
        const row = afterCurrent[0]!;
        if (row.status !== expectedReceivableStatus(row.amountCollected, row.amountDue)) {
          failures.push("receivable status does not follow the domain status rule");
        }
        if (row.amountDue !== beforeCurrent[0]!.amountDue || row.amountCollected !== beforeCurrent[0]!.amountCollected) {
          failures.push("receivable amounts changed");
        }
      }
      const shape = (graph: Recomputed["graph"]) =>
        canonicalJson({ allocations: graph.allocations, credits: graph.credits, events: graph.events, offsets: graph.offsets });
      if (shape(after.graph) !== shape(before.graph)) failures.push("a clearing or accounting record changed");
    }
    const capabilityCode = finding.repairCapability as CapabilityCode;
    if (capabilityCode === "CANCEL_DUPLICATE_TRADER_RECEIVABLE" || capabilityCode === "REPLACE_UNUSED_TRADER_RECEIVABLE") {
      // Phase 3 Prompt 3: exactly one receivable was cancelled (row kept), it
      // carried no clearing record, and no collection, allocation, offset or
      // credit changed. CANCEL keeps the canonical receivable byte-identical;
      // REPLACE leaves exactly one new receivable for the model amount.
      const beforeCurrent = before.graph.receivables.filter((row) => row.current);
      const afterCurrent = after.graph.receivables.filter((row) => row.current);
      const cancelled = before.graph.receivables.filter(
        (row) => row.current && after.graph.receivables.find((next) => next.id === row.id)?.status === "cancelled",
      );
      if (cancelled.length !== 1) failures.push(`${cancelled.length} receivable(s) were cancelled; exactly one is expected`);
      if (afterCurrent.length !== 1) failures.push(`${afterCurrent.length} current receivables`);
      if (after.graph.receivables.length - before.graph.receivables.length !== (capabilityCode === "REPLACE_UNUSED_TRADER_RECEIVABLE" ? 1 : 0)) {
        failures.push("an unexpected receivable was created");
      }
      const removed = cancelled[0];
      if (removed !== undefined && (!new Decimal(removed.amountCollected).isZero() || removed.status !== "outstanding")) {
        failures.push("the cancelled receivable carried money");
      }
      if (capabilityCode === "CANCEL_DUPLICATE_TRADER_RECEIVABLE") {
        const kept = beforeCurrent.find((row) => row.id === afterCurrent[0]?.id);
        if (kept === undefined || canonicalJson(kept) !== canonicalJson(afterCurrent[0])) {
          failures.push("the canonical receivable changed");
        }
      } else if (afterCurrent[0] !== undefined) {
        if (beforeCurrent.some((row) => row.id === afterCurrent[0]!.id)) failures.push("the receivable was not replaced");
        if (!new Decimal(afterCurrent[0].amountDue).equals(new Decimal(before.evaluation.traderDue))) {
          failures.push("receivable amount differs from the financial model");
        }
      }
      const clearing = (graph: Recomputed["graph"]) =>
        canonicalJson({ allocations: graph.allocations, credits: graph.credits, offsets: graph.offsets });
      if (clearing(after.graph) !== clearing(before.graph)) failures.push("a collection, offset or credit changed");
      if (after.graph.order.deliveryStatus !== before.graph.order.deliveryStatus) failures.push("order delivery status changed");
    }
    if (failures.length > 0) {
      throw new ApplicationException(
        "repair_verification_failed",
        "The repair did not resolve the finding; everything was rolled back",
        HttpStatus.CONFLICT,
        failures,
      );
    }
  }

  protected async writeAudit(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly actor: RepairExecutionActor;
      readonly before: Recomputed;
      readonly after: Recomputed;
      readonly companyId: string;
      readonly finding: RepairFinding;
      readonly inputs: Readonly<Record<string, string>>;
      readonly orderId: string;
      readonly outcome: Readonly<Record<string, string | number | boolean | null>>;
      readonly reason: string;
      readonly request: RepairExecutionRequest;
      readonly requestHash: string;
    },
  ): Promise<RepairExecutionResult> {
    const { after, before, finding } = input;
    const redacted = Object.fromEntries(
      Object.entries(input.inputs).map(([name, value]) => [name, SENSITIVE_INPUT.test(name) ? "[REDACTED]" : value]),
    );
    const afterCode: OrderHealthReasonCode = after.evaluation.financialCode;
    const id = randomUUID();
    const executedAt = new Date().toISOString();
    const result: RepairExecutionResult = {
      afterClassification: afterCode,
      afterHealth: after.evaluation.health,
      afterPreviewVersion: after.analysis.previewVersion,
      auditId: id,
      beforeClassification: before.evaluation.financialCode,
      beforeHealth: before.evaluation.health,
      beforePreviewVersion: before.analysis.previewVersion,
      capabilityCode: finding.repairCapability ?? "",
      companyId: input.companyId,
      executedAt,
      findingId: finding.findingId,
      nextRecommendedAction: after.evaluation.health === "HEALTHY" ? "none" : "review_remaining_findings",
      orderId: input.orderId,
      orderNumber: before.analysis.orderNumber,
      reasonCode: finding.reasonCode,
      repairExecutionId: id,
      replayed: false,
      status: "succeeded",
    };
    // Append-only: written once, complete. `result_summary` is exactly what an
    // idempotent retry with the same key and request returns.
    await sql`
      insert into platform_repair_executions (
        id, company_id, order_id, entity_type, entity_id, entity_number, finding_id, reason_code,
        capability_code, preview_version, actor_account_id, actor_authority, reason, requested_inputs,
        before_state_fingerprint, after_state_fingerprint, before_health, after_health,
        before_classification, after_classification, result, result_summary, idempotency_key,
        request_hash, correlation_id, created_at
      ) values (
        ${id}::uuid, ${input.companyId}::uuid, ${input.orderId}::uuid, ${finding.entityType},
        ${finding.entityId}::uuid, ${finding.entityNumber}, ${finding.findingId}, ${finding.reasonCode},
        ${finding.repairCapability}, ${input.request.previewVersion}, ${input.actor.accountId}::uuid,
        ${input.actor.authority}, ${input.reason}, ${JSON.stringify(redacted)}::jsonb,
        ${before.analysis.previewVersion}, ${after.analysis.previewVersion},
        ${before.evaluation.health}, ${after.evaluation.health}, ${before.evaluation.financialCode}, ${afterCode},
        'succeeded', ${JSON.stringify({ ...result, domainOutcome: input.outcome })}::jsonb,
        ${input.request.idempotencyKey}, ${input.requestHash}, ${input.actor.correlationId},
        ${executedAt}::timestamptz
      )
    `.execute(transaction);
    return result;
  }

  // ===================================================================
  // ACCOUNTING EVENT RECOVERY (Phase 2, Prompt 4)
  // ===================================================================

  /**
   * Recover ONE unresolved accounting event of ONE Company through the
   * certified pipeline, atomically:
   *
   *   lock Event -> idempotency ledger -> re-inspect (certified precheck)
   *   -> compare finding / capability / previewVersion / READY -> reason only
   *   -> adapter.reprocessInTransaction (re-queue, claim, certified posting)
   *   -> verify (event posted, one balanced journal, finding resolved)
   *   -> re-run the source Order's health -> immutable audit -> COMMIT.
   *
   * Any failure -- including a posting refusal -- rolls back EVERYTHING; the
   * Event keeps its previous status, failure details and attempt count.
   */
  public async executeAccountingEvent(
    companyId: string,
    eventId: string,
    request: RepairExecutionRequest,
    actor: RepairExecutionActor,
  ): Promise<AccountingRecoveryResult> {
    const progress: AttemptProgress = {
      entityId: eventId,
      entityNumber: null,
      entityType: "accounting_event",
      reasonCode: ACCOUNTING_FINDING_REASON,
      stage: "checking",
    };
    try {
      const result = await this.runAccounting(companyId, eventId, request, actor, progress);
      if (result.replayed) {
        // A replay returns before recompute: take the business reference from
        // the one authoritative execution it replays.
        progress.entityNumber ??= (
          await sql<{ entityNumber: string | null }>`
            select entity_number as "entityNumber" from platform_repair_executions
             where id = ${result.repairExecutionId}::uuid and company_id = ${companyId}::uuid`.execute(this.database)
        ).rows[0]?.entityNumber ?? null;
        await this.attempts.record(
          this.attemptOf(companyId, request, actor, progress, "REPLAYED", undefined, result.repairExecutionId),
        );
      }
      return result;
    } catch (error) {
      await this.attempts.record(
        this.attemptOf(companyId, request, actor, progress, progress.stage === "executing" ? "FAILED" : "REFUSED", error),
      );
      throw error;
    }
  }

  private async runAccounting(
    companyId: string,
    eventId: string,
    request: RepairExecutionRequest,
    actor: RepairExecutionActor,
    progress: AttemptProgress,
  ): Promise<AccountingRecoveryResult> {
    const reason = request.reason.trim();
    if (reason === "") {
      throw new ApplicationException("repair_reason_required", "A reason is required", HttpStatus.BAD_REQUEST);
    }
    if (request.capabilityCode !== ACCOUNTING_CAPABILITY) {
      throw new ApplicationException(
        "repair_capability_not_applicable",
        "Only REPROCESS_ACCOUNTING_EVENT applies to an accounting event",
        HttpStatus.CONFLICT,
      );
    }
    const inputs = request.inputs ?? {};
    if (Object.keys(inputs).some((name) => name !== "reason")) {
      throw new ApplicationException(
        "repair_inputs_invalid",
        "The repair inputs do not match what this repair requires",
        HttpStatus.BAD_REQUEST,
        Object.keys(inputs).map((name) => `unknown input: ${name}`),
      );
    }
    const requestHash = createHash("sha256")
      .update(
        canonicalJson({
          capabilityCode: request.capabilityCode,
          eventId,
          findingId: request.findingId,
          inputs,
          previewVersion: request.previewVersion,
          reason,
        }),
      )
      .digest("hex");

    return this.database.transaction().execute(async (transaction) => {
      await sql`select set_config('statement_timeout', '60s', true), set_config('jit', 'off', true)`.execute(
        transaction,
      );
      // 1. Lock the Event inside its Company (serialises concurrent attempts;
      //    the background processor skips a locked row).
      if (!(await this.accounting.lockEvent(transaction, companyId, eventId))) {
        throw new ApplicationException("accounting_event_not_found", "The Accounting Event was not found", HttpStatus.NOT_FOUND);
      }
      // 2. Idempotency, scoped to (Company, capability, Event, key).
      const prior = await sql<{ requestHash: string; resultSummary: AccountingRecoveryResult & { domainOutcome?: unknown } }>`
        select request_hash as "requestHash", result_summary as "resultSummary"
          from platform_repair_executions
         where company_id = ${companyId}::uuid and capability_code = ${ACCOUNTING_CAPABILITY}
           and entity_id = ${eventId}::uuid and idempotency_key = ${request.idempotencyKey}
      `.execute(transaction);
      if (prior.rows[0] !== undefined) {
        if (prior.rows[0].requestHash !== requestHash) {
          throw new ApplicationException(
            "repair_idempotency_conflict",
            "This idempotency key was already used for a different repair request",
            HttpStatus.CONFLICT,
          );
        }
        const { domainOutcome, ...original } = prior.rows[0].resultSummary;
        void domainOutcome;
        return { ...original, replayed: true };
      }
      // 3. Re-inspect from the database (certified precheck), under the lock.
      // Phase 6 ordering, re-evaluated under the event lock: a source with an open
      // operational finding makes a READY recovery BLOCKED (operational truth first).
      const before = await this.ordering.apply(
        transaction,
        companyId,
        (await this.accounting.inspect(transaction, companyId, eventId))!,
      );
      progress.entityNumber = before.state.event.sourceReference;
      const finding = accountingFindingOf(companyId, eventId, before, new Date().toISOString());
      if (!finding.current || finding.findingId !== request.findingId) {
        throw new ApplicationException(
          "repair_finding_not_current",
          "That finding is not current for this accounting event any more; refresh the details",
          HttpStatus.CONFLICT,
        );
      }
      if (finding.repairCapability !== ACCOUNTING_CAPABILITY) {
        throw new ApplicationException(
          "repair_capability_not_applicable",
          "No certified Platform recovery applies to this accounting event",
          HttpStatus.CONFLICT,
        );
      }
      if (before.previewVersion !== request.previewVersion) {
        throw new ApplicationException(
          "repair_preview_stale",
          "The accounting event or its configuration changed after the repair preview. Refresh and review the new state before repairing.",
          HttpStatus.CONFLICT,
        );
      }
      if (before.repairability !== "READY") {
        throw new ApplicationException(
          "repair_not_ready",
          `This recovery is ${before.repairability}; only a READY recovery can be executed`,
          HttpStatus.CONFLICT,
          before.blockers.map((blocker) => blocker.code),
        );
      }
      // 4. The certified recovery, in THIS transaction (failures from here
      //    on are FAILED, everything rolled back).
      progress.stage = "executing";
      const outcome = await this.accounting.reprocessInTransaction(transaction, {
        companyId,
        correlationId: actor.correlationId,
        eventId,
        reason,
      });
      // 5. Verify, same transaction, before anything commits.
      const after = (await this.accounting.inspect(transaction, companyId, eventId))!;
      await this.verifyAccountingRecovery(transaction, companyId, eventId, outcome, after);
      const orderHealthAfter =
        after.state.sourceOrderId === null
          ? null
          : ((await this.health.orderEvaluation(transaction, companyId, after.state.sourceOrderId))?.health ?? null);
      // 6. Immutable audit + idempotency record.
      return this.writeAccountingAudit(transaction, {
        actor,
        after,
        before,
        companyId,
        eventId,
        findingId: finding.findingId,
        orderHealthAfter,
        outcome,
        reason,
        request,
        requestHash,
      });
    });
  }

  protected async verifyAccountingRecovery(
    transaction: Kysely<DatabaseSchema>,
    companyId: string,
    eventId: string,
    outcome: AccountingRecoveryOutcome,
    after: AccountingInspection,
  ): Promise<void> {
    const failures = [...(await this.accounting.verifyPosted(transaction, companyId, eventId, outcome))];
    if (after.repairability !== "NOT_REQUIRED" || after.state.event.processingStatus !== "posted") {
      failures.push(`finding still ${after.repairability} (${after.classificationCode})`);
    }
    if (failures.length > 0) {
      throw new ApplicationException(
        "repair_verification_failed",
        "The accounting recovery did not verify; everything was rolled back",
        HttpStatus.CONFLICT,
        failures,
      );
    }
  }

  protected async writeAccountingAudit(
    transaction: Kysely<DatabaseSchema>,
    input: {
      readonly actor: RepairExecutionActor;
      readonly before: AccountingInspection;
      readonly after: AccountingInspection;
      readonly companyId: string;
      readonly eventId: string;
      readonly findingId: string;
      readonly orderHealthAfter: string | null;
      readonly outcome: AccountingRecoveryOutcome;
      readonly reason: string;
      readonly request: RepairExecutionRequest;
      readonly requestHash: string;
    },
  ): Promise<AccountingRecoveryResult> {
    const id = randomUUID();
    const executedAt = new Date().toISOString();
    const { after, before } = input;
    const orderNumber =
      before.state.sourceOrderId === null
        ? null
        : ((
            await sql<{ n: string }>`select order_number as n from orders
              where id = ${before.state.sourceOrderId}::uuid and company_id = ${input.companyId}::uuid`.execute(
              transaction,
            )
          ).rows[0]?.n ?? null);
    const result: AccountingRecoveryResult = {
      afterClassification: after.state.event.processingStatus,
      afterHealth: "HEALTHY",
      afterPreviewVersion: after.previewVersion,
      auditId: id,
      beforeClassification: before.state.event.processingStatus,
      beforeHealth: "ISSUE",
      beforePreviewVersion: before.previewVersion,
      capabilityCode: ACCOUNTING_CAPABILITY,
      companyId: input.companyId,
      eventId: input.eventId,
      eventType: before.state.event.eventType,
      executedAt,
      findingId: input.findingId,
      journalNumber: input.outcome.journalNumber,
      nextRecommendedAction:
        input.orderHealthAfter === null || input.orderHealthAfter === "HEALTHY" ? "none" : "review_order_health",
      orderHealthAfter: input.orderHealthAfter,
      orderId: before.state.sourceOrderId ?? "",
      orderNumber: orderNumber ?? "",
      reasonCode: ACCOUNTING_FINDING_REASON,
      repairExecutionId: id,
      replayed: false,
      status: "succeeded",
    };
    await sql`
      insert into platform_repair_executions (
        id, company_id, order_id, entity_type, entity_id, entity_number, finding_id, reason_code,
        capability_code, preview_version, actor_account_id, actor_authority, reason, requested_inputs,
        before_state_fingerprint, after_state_fingerprint, before_health, after_health,
        before_classification, after_classification, result, result_summary, idempotency_key,
        request_hash, correlation_id, created_at
      ) values (
        ${id}::uuid, ${input.companyId}::uuid, ${before.state.sourceOrderId}::uuid, 'accounting_event',
        ${input.eventId}::uuid, ${before.state.event.sourceReference ?? input.eventId}, ${input.findingId},
        ${ACCOUNTING_FINDING_REASON}, ${ACCOUNTING_CAPABILITY}, ${input.request.previewVersion},
        ${input.actor.accountId}::uuid, ${input.actor.authority}, ${input.reason}, '{}'::jsonb,
        ${before.previewVersion}, ${after.previewVersion}, 'ISSUE', 'HEALTHY',
        ${before.state.event.processingStatus}, ${after.state.event.processingStatus}, 'succeeded',
        ${JSON.stringify({ ...result, domainOutcome: input.outcome })}::jsonb,
        ${input.request.idempotencyKey}, ${input.requestHash}, ${input.actor.correlationId},
        ${executedAt}::timestamptz
      )
    `.execute(transaction);
    return result;
  }
}

export interface AccountingRecoveryResult extends RepairExecutionResult {
  readonly eventId: string;
  readonly eventType: string;
  readonly journalNumber: string;
  /** The source Order's health after the recovery, when the source is an Order. */
  readonly orderHealthAfter: string | null;
}
