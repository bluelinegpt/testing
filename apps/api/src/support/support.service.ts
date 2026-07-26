import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import type { CreateSupportCaseDto, UpdateSupportCaseDto } from "./support.dto.js";

export interface SupportCaseView {
  readonly caseNumber: string;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly description: string;
  readonly id: string;
  readonly priority: string;
  readonly resolutionNotes: string | null;
  readonly resolvedAt: string | null;
  readonly status: string;
  readonly title: string;
  readonly updatedAt: string;
}

@Injectable()
export class SupportService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  public async list(): Promise<readonly SupportCaseView[]> {
    const { companyId } = this.tenants.current();
    const result = await sql<SupportCaseView>`
      select c.id,
             c.case_number as "caseNumber",
             c.title,
             c.description,
             c.priority,
             c.status,
             c.resolution_notes as "resolutionNotes",
             c.resolved_at::text as "resolvedAt",
             c.closed_at::text as "closedAt",
             c.created_at::text as "createdAt",
             c.updated_at::text as "updatedAt",
             a.username as "createdBy"
      from support_cases c
      join accounts a on a.id = c.created_by_account_id and a.company_id = c.company_id
      where c.company_id = ${companyId}::uuid
      order by
        case c.status when 'open' then 1 when 'in_progress' then 2 when 'resolved' then 3 else 4 end,
        c.updated_at desc
      limit 200
    `.execute(this.database);
    return result.rows;
  }

  public async create(
    input: CreateSupportCaseDto,
    correlationId: string,
  ): Promise<SupportCaseView> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const title = input.title.trim();
    const description = input.description.trim();
    if (title.length === 0 || description.length === 0) {
      throw new ApplicationException(
        "support_case_invalid",
        "Support case title and description are required",
        HttpStatus.BAD_REQUEST,
      );
    }
    const caseId = await this.transactions.execute(async (transaction) => {
      const caseNumber = `SUP-${Date.now().toString(36).toUpperCase()}-${randomUUID()
        .slice(0, 8)
        .toUpperCase()}`;
      const created = await sql<{ id: string }>`
        insert into support_cases (
          company_id, case_number, title, description, priority, created_by_account_id
        ) values (
          ${companyId}::uuid, ${caseNumber}, ${title}, ${description},
          ${input.priority ?? "normal"}, ${identity.identityId}::uuid
        )
        returning id
      `.execute(transaction);
      const id = created.rows[0]?.id;
      if (id === undefined) {
        throw new Error("Support case creation did not return an identifier");
      }
      await this.audit(transaction, {
        action: "support_case.create",
        actorId: identity.identityId,
        after: { caseNumber, priority: input.priority ?? "normal", title },
        companyId,
        correlationId,
        subjectId: id,
      });
      return id;
    });
    return this.byId(companyId, caseId);
  }

  public async update(
    caseId: string,
    input: UpdateSupportCaseDto,
    correlationId: string,
  ): Promise<SupportCaseView> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const result = await this.transactions.execute(async (transaction) => {
      const updated = await sql<{ id: string }>`
        update support_cases
           set status = ${input.status},
               resolution_notes = ${input.resolutionNotes?.trim() ?? null},
               resolved_at = case
                 when ${input.status} in ('resolved', 'closed') then coalesce(resolved_at, now())
                 else null
               end,
               closed_at = case when ${input.status} = 'closed' then coalesce(closed_at, now()) else null end,
               updated_at = now(),
               version = version + 1
         where id = ${caseId}::uuid and company_id = ${companyId}::uuid
         returning id
      `.execute(transaction);
      const id = updated.rows[0]?.id;
      if (id === undefined) {
        throw new ApplicationException(
          "support_case_not_found",
          "Support case not found",
          HttpStatus.NOT_FOUND,
        );
      }
      await this.audit(transaction, {
        action: "support_case.update",
        actorId: identity.identityId,
        after: { status: input.status },
        companyId,
        correlationId,
        subjectId: id,
      });
      return id;
    });
    return this.byId(companyId, result);
  }

  private async byId(companyId: string, caseId: string): Promise<SupportCaseView> {
    const result = await sql<SupportCaseView>`
      select c.id,
             c.case_number as "caseNumber",
             c.title,
             c.description,
             c.priority,
             c.status,
             c.resolution_notes as "resolutionNotes",
             c.resolved_at::text as "resolvedAt",
             c.closed_at::text as "closedAt",
             c.created_at::text as "createdAt",
             c.updated_at::text as "updatedAt",
             a.username as "createdBy"
      from support_cases c
      join accounts a on a.id = c.created_by_account_id and a.company_id = c.company_id
      where c.id = ${caseId}::uuid and c.company_id = ${companyId}::uuid
      limit 1
    `.execute(this.database);
    const supportCase = result.rows[0];
    if (supportCase === undefined) {
      throw new ApplicationException(
        "support_case_not_found",
        "Support case not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return supportCase;
  }

  private async audit(
    database: Parameters<Parameters<KyselyTransactionManager["execute"]>[0]>[0],
    input: {
      action: string;
      actorId: string;
      after: object;
      companyId: string;
      correlationId: string;
      subjectId: string;
    },
  ): Promise<void> {
    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id, after_data, correlation_id
      ) values (
        ${input.companyId}::uuid, ${input.actorId}::uuid, ${input.action}, 'support_case',
        ${input.subjectId}, ${JSON.stringify(input.after)}::jsonb, ${input.correlationId}
      )
    `.execute(database);
  }
}
