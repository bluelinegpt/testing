import { Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
// NOT `import type`: the class must exist at runtime for Nest's constructor
// design:paramtypes metadata — a type-only import would break provider
// resolution and silently disable the WhatsApp notification hook.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { WhatsAppOutboxWriter } from "../whatsapp/whatsapp-outbox-writer.service.js";

export interface StatusHistoryInput {
  readonly actorId: string;
  readonly companyId: string;
  readonly from: string | null;
  readonly orderId: string;
  readonly reason?: string | null;
  readonly statusDimension?: string;
  readonly to: string;
}

export interface OrderEventInput {
  readonly actorId: string;
  readonly actorRole: string;
  readonly bulkActionId?: string;
  readonly category: string;
  readonly companyId: string;
  readonly correlationId: string;
  readonly eventType: string;
  readonly fieldName?: string;
  readonly newValue: unknown;
  readonly orderId: string;
  readonly previousValue: unknown;
  readonly reason?: string | null;
  readonly relatedDriverId?: string | null;
  readonly relatedPaymentId?: string | null;
  readonly relatedReconciliationId?: string | null;
  readonly relatedSettlementId?: string | null;
  readonly source: string;
}

export interface AuditEventInput {
  readonly action: string;
  readonly actorId: string;
  readonly after: object;
  readonly companyId: string;
  readonly correlationId: string;
  readonly subjectId: string;
  readonly subjectType: string;
}

/**
 * Append-only history, event and audit writers shared by the operations services.
 *
 * These are deliberately the only writers for these tables so that every
 * operational workflow produces history in the same shape.
 *
 * `statusHistory` is ALSO the single canonical hook for automatic Trader
 * WhatsApp notifications (Prompt 4): the moment a confirmed `delivery`
 * status-history event becomes durable, the eligible-status outbox intent is
 * written in the SAME transaction — one hook point, so single, bulk, driver
 * and portal paths all behave identically and no path can double-hook (the
 * outbox's status-history-scoped idempotency key backstops even that).
 * The parameter is TypeScript-optional so long-standing manual
 * `new OperationsHistoryWriter()` constructions (tests, harnesses) keep
 * compiling with the hook simply absent — but it is deliberately NOT
 * `@Optional()` for Nest: every DI module that provides this class must also
 * provide `WhatsAppOutboxWriter` (all five do), and forgetting it fails
 * loudly at bootstrap instead of silently dropping Trader notifications.
 */
@Injectable()
export class OperationsHistoryWriter {
  public constructor(private readonly whatsappOutbox?: WhatsAppOutboxWriter) {}

  public async actorRole(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    accountId: string,
  ): Promise<string> {
    const result = await sql<{ role: string }>`
      select coalesce(string_agg(distinct r.name, ', ' order by r.name), a.account_kind) as role
      from accounts a
      left join account_roles ar on ar.account_id = a.id and ar.company_id = a.company_id
      left join roles r on r.id = ar.role_id and r.company_id = ar.company_id
      where a.id = ${accountId}::uuid and a.company_id = ${companyId}::uuid
      group by a.id
    `.execute(database);
    return result.rows[0]?.role ?? "Company User";
  }

  public async statusHistory(
    database: Kysely<DatabaseSchema>,
    input: StatusHistoryInput,
  ): Promise<{ readonly id: string }> {
    const inserted = await sql<{ id: string; occurredAt: Date }>`
      insert into order_status_history (
        company_id, order_id, status_dimension, from_status, to_status,
        reason, changed_by_account_id
      ) values (
        ${input.companyId}::uuid, ${input.orderId}::uuid,
        ${input.statusDimension ?? "delivery"}, ${input.from}, ${input.to},
        ${input.reason ?? null}, ${input.actorId}::uuid
      )
      returning id, occurred_at as "occurredAt"
    `.execute(database);
    const event = inserted.rows[0];
    if (event === undefined) throw new Error("order_status_history_insert_failed");
    if ((input.statusDimension ?? "delivery") === "delivery" && this.whatsappOutbox !== undefined) {
      await this.whatsappOutbox.writeOrderStatusChanged(database, {
        companyId: input.companyId,
        occurredAt: event.occurredAt,
        orderId: input.orderId,
        orderStatusHistoryId: event.id,
        toStatus: input.to,
      });
    }
    return { id: event.id };
  }

  public async orderEvent(database: Kysely<DatabaseSchema>, input: OrderEventInput): Promise<void> {
    await sql`
      insert into order_events (
        company_id, order_id, event_type, event_category, field_name,
        previous_value, new_value, actor_account_id, actor_role, source, reason,
        related_driver_id, related_reconciliation_id, related_settlement_id, related_payment_id,
        correlation_id, bulk_action_id
      ) values (
        ${input.companyId}::uuid, ${input.orderId}::uuid, ${input.eventType},
        ${input.category}, ${input.fieldName ?? null},
        ${input.previousValue === null ? null : JSON.stringify(input.previousValue)}::jsonb,
        ${JSON.stringify(input.newValue)}::jsonb, ${input.actorId}::uuid,
        ${input.actorRole}, ${input.source}, ${input.reason ?? null},
        ${input.relatedDriverId ?? null}::uuid,
        ${input.relatedReconciliationId ?? null}::uuid,
        ${input.relatedSettlementId ?? null}::uuid,
        ${input.relatedPaymentId ?? null}::uuid, ${input.correlationId},
        ${input.bulkActionId ?? null}::uuid
      )
    `.execute(database);
  }

  public async audit(database: Kysely<DatabaseSchema>, input: AuditEventInput): Promise<void> {
    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        after_data, correlation_id
      ) values (
        ${input.companyId}::uuid, ${input.actorId}::uuid, ${input.action},
        ${input.subjectType}, ${input.subjectId}, ${JSON.stringify(input.after)}::jsonb,
        ${input.correlationId}
      )
    `.execute(database);
  }

  public async nextReferenceNumber(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    referenceType: string,
    prefix: string,
  ): Promise<string> {
    const result = await sql<{ nextValue: string; prefix: string }>`
      insert into company_reference_counters (company_id, reference_type, next_value, prefix)
      values (${companyId}::uuid, ${referenceType}, 2, ${prefix})
      on conflict (company_id, reference_type)
      do update set next_value = company_reference_counters.next_value + 1, updated_at = now()
      returning (next_value - 1)::text as "nextValue", prefix
    `.execute(database);
    const counter = result.rows[0];
    if (counter === undefined) throw new Error("Reference counter did not return a value");
    return `${counter.prefix}-${counter.nextValue.padStart(6, "0")}`;
  }
}
