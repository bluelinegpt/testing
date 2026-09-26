import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";

type StoredMessage = { role: "user" | "assistant"; content: string };

@Injectable()
export class CompanyWebsiteAgentInboxService {
  public constructor(
    @Inject(DATABASE) private readonly db: Kysely<DatabaseSchema>,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  public async list() {
    const companyId = this.companyId();
    const result = await sql<{
      id: string;
      contactNumber: string | null;
      language: "en" | "ar";
      messageCount: number;
      handoffState: string;
      sourceHostname: string | null;
      createdAt: string;
      updatedAt: string;
    }>`
      select id,
             visitor_contact_number as "contactNumber",
             language,
             message_count as "messageCount",
             handoff_state as "handoffState",
             source_hostname as "sourceHostname",
             created_at as "createdAt",
             updated_at as "updatedAt"
      from company_website_agent_conversations
      where company_id=${companyId}::uuid
      order by updated_at desc
      limit 100
    `.execute(this.db);
    return result.rows;
  }

  public async get(id: string) {
    const companyId = this.companyId();
    const row = (
      await sql<{
        id: string;
        contactNumber: string | null;
        language: "en" | "ar";
        messages: unknown;
        messageCount: number;
        handoffState: string;
        sourceHostname: string | null;
        createdAt: string;
        updatedAt: string;
      }>`
        select id,
               visitor_contact_number as "contactNumber",
               language,
               messages,
               message_count as "messageCount",
               handoff_state as "handoffState",
               source_hostname as "sourceHostname",
               created_at as "createdAt",
               updated_at as "updatedAt"
        from company_website_agent_conversations
        where id=${id}::uuid and company_id=${companyId}::uuid
        limit 1
      `.execute(this.db)
    ).rows[0];
    if (!row) {
      throw new ApplicationException(
        "company_website_agent_conversation_not_found",
        "Conversation not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return { ...row, messages: safeMessages(row.messages) };
  }

  private companyId(): string {
    const companyId = this.identities.current().companyId;
    if (!companyId) {
      throw new ApplicationException(
        "company_context_required",
        "Company context is required",
        HttpStatus.FORBIDDEN,
      );
    }
    return companyId;
  }
}

function safeMessages(value: unknown): readonly StoredMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): StoredMessage[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    if (
      (candidate.role !== "user" && candidate.role !== "assistant") ||
      typeof candidate.content !== "string"
    )
      return [];
    return [{ role: candidate.role, content: candidate.content }];
  });
}
