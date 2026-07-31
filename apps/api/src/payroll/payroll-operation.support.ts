import { createHash } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,200}$/;

@Injectable()
export class PayrollOperationSupport {
  public constructor(
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  public context(): {
    readonly actorId: string;
    readonly companyId: string;
  } {
    return {
      actorId: this.identities.current().identityId,
      companyId: this.tenants.current().companyId,
    };
  }

  public assertPermission(permission: string): void {
    const permissions = this.identities.current().permissions;
    if (!permissions.has(permission) && !permissions.has("users_roles.manage")) {
      throw new ApplicationException(
        "permission_denied",
        "The authenticated account does not have permission for this Payroll operation",
        HttpStatus.FORBIDDEN,
      );
    }
  }

  public monthRange(payrollMonth: string): {
    readonly end: string;
    readonly reference: string;
    readonly start: string;
  } {
    const [yearText, monthText] = payrollMonth.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return {
      end: `${payrollMonth}-${String(lastDay).padStart(2, "0")}`,
      reference: `PAY-${payrollMonth}`,
      start: `${payrollMonth}-01`,
    };
  }

  public async reserveIdempotency<TResponse = unknown>(
    database: Kysely<DatabaseSchema>,
    input: {
      readonly companyId: string;
      readonly idempotencyKey: string | undefined;
      readonly operation: string;
      readonly payload: unknown;
    },
  ): Promise<{
    readonly replayResourceId?: string;
    readonly replayResponse?: TResponse;
  }> {
    const key = input.idempotencyKey?.trim() ?? "";
    if (!idempotencyKeyPattern.test(key)) {
      throw new ApplicationException(
        "idempotency_key_invalid",
        "A valid idempotency key is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    const requestHash = createHash("sha256")
      .update(JSON.stringify(input.payload))
      .digest("hex");
    const inserted = await sql<{ id: string }>`
      insert into idempotency_records (
        company_id, operation, idempotency_key, request_hash, expires_at
      ) values (
        ${input.companyId}::uuid, ${input.operation}, ${key}, ${requestHash},
        now() + interval '24 hours'
      )
      on conflict (company_id, operation, idempotency_key) do nothing
      returning id
    `.execute(database);
    if (inserted.rows[0] !== undefined) return {};

    const existing = await sql<{
      requestHash: string;
      resourceId: string | null;
      responseBody: TResponse | null;
    }>`
      select request_hash as "requestHash", resource_id as "resourceId",
             response_body as "responseBody"
        from idempotency_records
       where company_id=${input.companyId}::uuid
         and operation=${input.operation} and idempotency_key=${key}
       for update
    `.execute(database);
    const record = existing.rows[0];
    if (record === undefined || record.requestHash !== requestHash) {
      throw new ApplicationException(
        "idempotency_key_reused",
        "This idempotency key was already used for different Payroll details",
        HttpStatus.CONFLICT,
      );
    }
    if (record.resourceId === null) {
      throw new ApplicationException(
        "payroll_submission_in_progress",
        "This Payroll submission is already being processed",
        HttpStatus.CONFLICT,
      );
    }
    return {
      replayResourceId: record.resourceId,
      ...(record.responseBody === null ? {} : { replayResponse: record.responseBody }),
    };
  }

  public async completeIdempotency(
    database: Kysely<DatabaseSchema>,
    input: {
      readonly companyId: string;
      readonly idempotencyKey: string;
      readonly operation: string;
      readonly resourceId: string;
      readonly resourceType: string;
      readonly responseBody?: unknown;
      readonly responseStatus?: number;
    },
  ): Promise<void> {
    await sql`
      update idempotency_records
         set response_status=${input.responseStatus ?? 200},
             resource_type=${input.resourceType}, resource_id=${input.resourceId}::uuid,
             response_body=${JSON.stringify(input.responseBody ?? null)}::jsonb,
             completed_at=now()
       where company_id=${input.companyId}::uuid and operation=${input.operation}
         and idempotency_key=${input.idempotencyKey.trim()}
    `.execute(database);
  }

  public pagination(input: { page?: number; pageSize?: number }, defaultSize = 50): {
    readonly limit: number;
    readonly offset: number;
    readonly page: number;
    readonly pageSize: number;
  } {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, input.pageSize ?? defaultSize));
    return { limit: pageSize, offset: (page - 1) * pageSize, page, pageSize };
  }
}
