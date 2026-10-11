import { createHash } from "node:crypto";

import { HttpStatus, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { AccountingEventType } from "./accounting.constants.js";
import { isAccountingCaptureEnabled, wasAccountingEnabledAt } from "./accounting-capture.js";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, current]) => current !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, current]) => `${JSON.stringify(key)}:${stableJson(current)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

@Injectable()
export class GeneralExpenseAccountingEventWriter {
  public async enqueue(
    database: Kysely<DatabaseSchema>,
    input: {
      readonly accountingDate: string;
      readonly actorId: string;
      readonly companyId: string;
      readonly correlationId: string;
      readonly description: string;
      readonly eventType: AccountingEventType;
      readonly metadata: Readonly<Record<string, unknown>>;
      /**
       * The original Event a reversal points at. `null` means the original
       * was recorded while GL Accounting was OFF (see `originalEventId`):
       * there is nothing to reverse in the ledger, so no Event is written.
       */
      readonly reversalOfEventId?: string | null;
      readonly sourceEntityId: string;
      readonly sourceEntityType: "general_expense" | "general_expense_payment";
      readonly sourceReference: string;
    },
  ): Promise<string | null> {
    // GL Accounting OFF: the operational record stands on its own and no
    // Event is captured -- the same gate, and the same per-Company lock, the
    // operational capture triggers use. ON: unchanged below.
    if (input.reversalOfEventId === null) return null;
    if (!(await isAccountingCaptureEnabled(database, input.companyId))) return null;
    const identity = {
      accountingDate: input.accountingDate,
      eventType: input.eventType,
      metadata: input.metadata,
      sourceEntityId: input.sourceEntityId,
      sourceEntityType: input.sourceEntityType,
      sourceReference: input.sourceReference,
    };
    const eventHash = createHash("sha256").update(stableJson(identity)).digest("hex");
    const idempotencyKey = `general-expense:${input.eventType}:${input.sourceEntityId}:v1`;
    const inserted = await sql<{ id: string }>`
      insert into accounting_events (
        company_id,event_type,event_version,source_entity_type,source_entity_id,
        source_reference,effective_accounting_date,currency,correlation_id,
        idempotency_key,event_hash,actor_id,actor_type,description,
        reversal_of_event_id,supplementary_metadata,processing_status,
        operational_area,source_operation_id
      ) values (
        ${input.companyId}::uuid,${input.eventType},1,${input.sourceEntityType},
        ${input.sourceEntityId}::uuid,${input.sourceReference},
        ${input.accountingDate}::date,'AED',${input.correlationId},
        ${idempotencyKey},${eventHash},${input.actorId}::uuid,'company_user',
        ${input.description},
        ${input.reversalOfEventId ?? null}::uuid,
        ${JSON.stringify(input.metadata)}::jsonb,'received',
        'general_expenses',${idempotencyKey}
      )
      on conflict (
        company_id,event_type,source_entity_type,source_entity_id,event_version
      ) do nothing
      returning id
    `.execute(database);
    if (inserted.rows[0] !== undefined) return inserted.rows[0].id;

    const existing = await sql<{ eventHash: string; id: string }>`
      select id,event_hash as "eventHash"
        from accounting_events
       where company_id=${input.companyId}::uuid
         and event_type=${input.eventType}
         and source_entity_type=${input.sourceEntityType}
         and source_entity_id=${input.sourceEntityId}::uuid
         and event_version=1
       for update
    `.execute(database);
    const row = existing.rows[0];
    if (row === undefined || row.eventHash !== eventHash) {
      throw new ApplicationException(
        "accounting_general_expense_event_payload_mismatch",
        "This General Expense Accounting Event already exists with different facts",
        HttpStatus.CONFLICT,
      );
    }
    return row.id;
  }

  public async originalEventId(
    database: Kysely<DatabaseSchema>,
    input: {
      readonly companyId: string;
      readonly eventType: AccountingEventType;
      readonly sourceEntityId: string;
      readonly sourceEntityType: "general_expense" | "general_expense_payment";
    },
  ): Promise<string | null> {
    const result = await sql<{ id: string }>`
      select id from accounting_events
       where company_id=${input.companyId}::uuid
         and event_type=${input.eventType}
         and source_entity_type=${input.sourceEntityType}
         and source_entity_id=${input.sourceEntityId}::uuid
       order by event_version desc limit 1
       for share
    `.execute(database);
    const id = result.rows[0]?.id;
    if (id !== undefined) return id;
    // No original Event. That is only an accounting failure if the original
    // was recorded while GL Accounting was ON. Recorded while OFF -- or being
    // reversed while OFF -- it is a valid operational record with nothing in
    // the ledger to reverse, so the caller writes no reversal Event.
    if (!(await isAccountingCaptureEnabled(database, input.companyId))) return null;
    const recorded = await sql<{ recordedAt: string | null }>`
      select ${
        input.sourceEntityType === "general_expense" ? sql`approved_at` : sql`confirmed_at`
      }::text as "recordedAt"
        from ${
          input.sourceEntityType === "general_expense"
            ? sql`general_expenses`
            : sql`general_expense_payments`
        }
       where id=${input.sourceEntityId}::uuid and company_id=${input.companyId}::uuid
    `.execute(database);
    const recordedAt = recorded.rows[0]?.recordedAt ?? null;
    if (
      recordedAt !== null &&
      !(await wasAccountingEnabledAt(database, input.companyId, recordedAt))
    ) {
      return null;
    }
    throw new ApplicationException(
      "accounting_general_expense_original_event_missing",
      "The original General Expense Accounting Event was not found",
      HttpStatus.CONFLICT,
    );
  }
}
