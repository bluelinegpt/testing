import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor, type IdentityContext } from "../security/identity-context.js";
import type {
  ConversationListQueryDto,
  EventRecoveryQueryDto,
  MarkConversationReadDto,
  MessageHistoryQueryDto,
  ResolveConversationDto,
  SendTextMessageDto,
  CreateCustomerMessagingSessionDto,
} from "./communication.dto.js";

const COMMUNICATION_OPERATOR_READ = "communication.operator.read";
const COMMUNICATION_OPERATOR_SEND = "communication.operator.send";
const MAX_PAGE_SIZE = 50;

type ParticipantRole = "office" | "trader" | "driver" | "customer";
type ParticipantContextType = "trader" | "driver" | "customer";

export interface ConversationSummary {
  readonly id: string;
  readonly type: string;
  readonly participantContextType: ParticipantContextType;
  readonly orderId: string | null;
  readonly orderNumber: string | null;
  readonly subject: string | null;
  readonly status: string;
  readonly priority: string;
  readonly lastMessageAt: string | null;
  readonly lastMessagePreview: string | null;
  readonly unreadCount: number;
}

export interface MessageView {
  readonly id: string;
  readonly conversationId: string;
  readonly senderRole: string;
  readonly messageType: string;
  readonly text: string | null;
  readonly clientMessageId: string | null;
  readonly systemEventType: string | null;
  readonly sequence: number;
  readonly createdAt: string;
}

export interface CustomerMessagingSessionView {
  readonly customerMessagingToken: string;
  readonly expiresAt: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly companyName: string;
}

export interface CustomerMessagingPrincipal {
  readonly kind: "customer_messaging";
  readonly sessionId: string;
  readonly companyId: string;
  readonly orderId: string;
  readonly customerId: string | null;
  readonly conversationId: string | null;
  readonly expiresAt: string;
}

@Injectable()
export class CommunicationService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(IdentityContextAccessor) private readonly identityAccessor: IdentityContextAccessor,
  ) {}

  public async resolveConversation(dto: ResolveConversationDto): Promise<ConversationSummary> {
    const identity = this.requireCompanyIdentity();
    const contextType = this.resolveParticipantContextType(identity, dto.participantContextType);
    if (contextType === "customer") {
      throw this.denied("customer_communication_requires_trusted_customer_identity");
    }

    if (dto.conversationType === "general_support") {
      throw new ApplicationException(
        "general_support_not_enabled",
        "General support conversations require an approved support category",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (dto.orderId === undefined) {
      throw new ApplicationException(
        "order_required",
        "Order ID is required",
        HttpStatus.BAD_REQUEST,
      );
    }

    const order = await this.authorizeOrderConversation(identity, dto.orderId, contextType);
    const existing = await sql<{ id: string }>`
      select id from conversations
       where company_id = ${identity.companyId}
         and order_id = ${dto.orderId}
         and participant_context_type = ${contextType}
         and status <> 'resolved'
       limit 1
    `.execute(this.database);
    if (existing.rows[0]?.id !== undefined) {
      return this.getConversationSummary(existing.rows[0].id, identity);
    }

    const created = await sql<{ id: string }>`
      insert into conversations (
        company_id, conversation_type, order_id, participant_context_type,
        subject, created_by_account_id
      ) values (
        ${identity.companyId}, 'order', ${dto.orderId}, ${contextType},
        ${dto.subject ?? `Order ${order.order_number}`}, ${identity.identityId}
      )
      returning id
    `.execute(this.database);
    const conversationId = this.requiredId(created.rows[0]?.id);
    await this.ensureParticipant(
      conversationId,
      identity.companyId,
      identity.identityId,
      this.senderRole(identity),
      identity.profileId,
    );
    await this.addOfficeParticipants(conversationId, identity.companyId);
    await this.writeEventsForParticipants(
      conversationId,
      "conversation.created",
      conversationId,
      identity.identityId,
    );
    return this.getConversationSummary(conversationId, identity);
  }

  public async listConversations(
    query: ConversationListQueryDto,
  ): Promise<{ items: ConversationSummary[]; nextCursor: string | null }> {
    const identity = this.requireCompanyIdentity();
    const limit = this.parseLimit(query.limit);
    const cursor = this.parseCursor(query.cursor);
    const isOperator = this.isOperatorReader(identity);
    const participantFilter = isOperator
      ? sql``
      : sql`and exists (
      select 1 from conversation_participants cp
       where cp.conversation_id = c.id and cp.company_id = c.company_id
         and cp.account_id = ${identity.identityId} and cp.is_active = true and cp.revoked_at is null
    )`;
    const roleFilter =
      query.participantContextType === undefined
        ? sql``
        : sql`and c.participant_context_type = ${query.participantContextType}`;
    const statusFilter = query.status === undefined ? sql`` : sql`and c.status = ${query.status}`;
    const unreadFilter =
      query.unreadOnly === "true"
        ? sql`and ${this.unreadCountSql(identity.identityId)} > 0`
        : sql``;
    const cursorFilter =
      cursor === null ? sql`` : sql`and coalesce(c.last_message_at, c.created_at) < ${cursor}`;
    const searchFilter =
      query.search === undefined || query.search.trim() === ""
        ? sql``
        : sql`and (o.order_number ilike ${`%${query.search.trim()}%`} or c.subject ilike ${`%${query.search.trim()}%`})`;

    const rows = await sql<ConversationSummary & { sort_at: Date }>`
      select c.id,
             c.conversation_type as "type",
             c.participant_context_type as "participantContextType",
             c.order_id as "orderId",
             o.order_number as "orderNumber",
             c.subject,
             c.status,
             c.priority,
             c.last_message_at as "lastMessageAt",
             case when m.message_type = 'text' then left(m.text_body, 120)
                  when m.message_type = 'system' then m.system_event_type
                  when m.message_type = 'voice_placeholder' then 'voice_message'
                  else null end as "lastMessagePreview",
             ${this.unreadCountSql(identity.identityId)} as "unreadCount",
             coalesce(c.last_message_at, c.created_at) as sort_at
        from conversations c
        left join orders o on o.id = c.order_id and o.company_id = c.company_id
        left join messages m on m.id = c.last_message_id and m.company_id = c.company_id
       where c.company_id = ${identity.companyId}
         ${participantFilter}
         ${roleFilter}
         ${statusFilter}
         ${unreadFilter}
         ${cursorFilter}
         ${searchFilter}
       order by coalesce(c.last_message_at, c.created_at) desc, c.id desc
       limit ${limit + 1}
    `.execute(this.database);
    const items = rows.rows.slice(0, limit).map(this.mapConversation);
    const nextCursor =
      rows.rows.length > limit ? (rows.rows[limit]?.sort_at.toISOString() ?? null) : null;
    return { items, nextCursor };
  }

  public async getMessages(
    conversationId: string,
    query: MessageHistoryQueryDto,
  ): Promise<{ items: MessageView[]; nextCursor: string | null }> {
    const identity = this.requireCompanyIdentity();
    await this.authorizeConversation(identity, conversationId);
    const limit = this.parseLimit(query.limit);
    const before = this.parseNumberCursor(query.before);
    const after = this.parseNumberCursor(query.after);
    const beforeFilter = before === null ? sql`` : sql`and conversation_sequence < ${before}`;
    const afterFilter = after === null ? sql`` : sql`and conversation_sequence > ${after}`;
    const rows = await sql<MessageView & { sequence: number }>`
      select id,
             conversation_id as "conversationId",
             sender_role as "senderRole",
             message_type as "messageType",
             text_body as "text",
             client_message_id as "clientMessageId",
             system_event_type as "systemEventType",
             conversation_sequence::int as sequence,
             created_at as "createdAt"
        from messages
       where company_id = ${identity.companyId}
         and conversation_id = ${conversationId}
         ${beforeFilter}
         ${afterFilter}
       order by conversation_sequence desc
       limit ${limit + 1}
    `.execute(this.database);
    const page = rows.rows.slice(0, limit);
    const items = page.reverse().map(this.mapMessage);
    const nextCursor =
      rows.rows.length > limit ? String(page[page.length - 1]?.sequence ?? "") : null;
    return { items, nextCursor };
  }

  public async sendTextMessage(
    conversationId: string,
    dto: SendTextMessageDto,
  ): Promise<MessageView> {
    const identity = this.requireCompanyIdentity();
    const conversation = await this.authorizeConversation(identity, conversationId);
    this.requireSendPermission(identity, conversation.participant_context_type);
    if (conversation.status === "resolved") {
      throw new ApplicationException(
        "conversation_resolved",
        "Resolved conversations must be reopened first",
        HttpStatus.CONFLICT,
      );
    }
    const text = dto.text.split(String.fromCharCode(0)).join("").trim();
    if (text.length === 0)
      throw new ApplicationException(
        "message_empty",
        "Message text is required",
        HttpStatus.BAD_REQUEST,
      );
    if (text.length > 4000)
      throw new ApplicationException(
        "message_too_long",
        "Message text is too long",
        HttpStatus.BAD_REQUEST,
      );

    const existing = await sql<MessageView & { stored_text: string | null }>`
      select id, conversation_id as "conversationId", sender_role as "senderRole", message_type as "messageType",
             text_body as "text", text_body as stored_text, client_message_id as "clientMessageId",
             system_event_type as "systemEventType", conversation_sequence::int as sequence, created_at as "createdAt"
        from messages
       where company_id = ${identity.companyId} and idempotency_key = ${dto.idempotencyKey}
       limit 1
    `.execute(this.database);
    if (existing.rows[0] !== undefined) {
      // An idempotency key is scoped to the conversation it was first used
      // in. Matching it against a *different* conversation must never
      // silently hand back that other conversation's message — this is the
      // same cross-conversation defect already closed on the Customer path.
      if (existing.rows[0].conversationId !== conversationId) {
        throw new ApplicationException(
          "idempotency_key_scope_denied",
          "Idempotency key was already used in a different conversation",
          HttpStatus.CONFLICT,
        );
      }
      if (
        existing.rows[0].stored_text !== text ||
        existing.rows[0].clientMessageId !== dto.clientMessageId
      ) {
        throw new ApplicationException(
          "idempotency_conflict",
          "Idempotency key was reused with a different payload",
          HttpStatus.CONFLICT,
        );
      }
      return this.mapMessage(existing.rows[0]);
    }

    const inserted = await sql<MessageView>`
      with next_sequence as (
        select coalesce(max(conversation_sequence), 0) + 1 as value
          from messages
         where company_id = ${identity.companyId} and conversation_id = ${conversationId}
      ), inserted_message as (
        insert into messages (
          company_id, conversation_id, sender_account_id, sender_role, message_type,
          text_body, client_message_id, idempotency_key, original_client_time, conversation_sequence
        )
        select ${identity.companyId}, ${conversationId}, ${identity.identityId}, ${this.senderRole(identity)}, 'text',
               ${text}, ${dto.clientMessageId}, ${dto.idempotencyKey},
               ${dto.originalClientTime ?? null}, value
          from next_sequence
        returning *
      )
      select id, conversation_id as "conversationId", sender_role as "senderRole", message_type as "messageType",
             text_body as "text", client_message_id as "clientMessageId",
             system_event_type as "systemEventType", conversation_sequence::int as sequence, created_at as "createdAt"
        from inserted_message
    `.execute(this.database);
    const message = this.mapMessage(inserted.rows[0]);
    await sql`
      update conversations
         set last_message_id = ${message.id}, last_message_at = ${message.createdAt}, updated_at = now(),
             status = case when ${this.senderRole(identity)} = 'office' then 'waiting_for_user' else 'waiting_for_office' end,
             version = version + 1
       where id = ${conversationId} and company_id = ${identity.companyId}
    `.execute(this.database);
    await this.writeEventsForParticipants(
      conversationId,
      "message.created",
      message.id,
      identity.identityId,
    );
    await this.writeEventsForCustomerSessions(conversationId, "message.created", message.id);
    await this.writeEventsForParticipants(
      conversationId,
      "conversation.updated",
      conversationId,
      identity.identityId,
    );
    await this.writeEventsForCustomerSessions(
      conversationId,
      "conversation.updated",
      conversationId,
    );
    await this.writeNotificationOutbox(conversationId, message.id, identity.identityId);
    return message;
  }

  public async markRead(
    conversationId: string,
    dto: MarkConversationReadDto,
  ): Promise<{ unreadCount: number }> {
    const identity = this.requireCompanyIdentity();
    await this.authorizeConversation(identity, conversationId);
    const message = await sql<{ sequence: number }>`
      select conversation_sequence::int as sequence from messages
       where company_id = ${identity.companyId} and conversation_id = ${conversationId} and id = ${dto.throughMessageId}
    `.execute(this.database);
    if (message.rows[0] === undefined)
      throw new ApplicationException(
        "message_not_found",
        "Message was not found",
        HttpStatus.NOT_FOUND,
      );
    // The target sequence is already known from the lookup above, so the
    // "don't move the cursor backward" guard can live entirely in the WHERE
    // clause as a subquery correlated to the UPDATE target (`cp`) — a plain
    // SQL UPDATE ... FROM cannot correlate a FROM-list JOIN's ON clause back
    // to the target table itself, which is what the previous version of
    // this query attempted and Postgres rejects at execution time.
    const targetSequence = message.rows[0].sequence;
    await sql`
      update conversation_participants cp
         set last_read_message_id = ${dto.throughMessageId},
             last_read_at = now()
       where cp.company_id = ${identity.companyId}
         and cp.conversation_id = ${conversationId}
         and cp.account_id = ${identity.identityId}
         and (
           cp.last_read_message_id is null
           or coalesce(
                (select m.conversation_sequence from messages m
                  where m.id = cp.last_read_message_id and m.company_id = cp.company_id),
                0
              ) <= ${targetSequence}
         )
    `.execute(this.database);
    await this.writeEventsForParticipants(
      conversationId,
      "message.read",
      dto.throughMessageId,
      identity.identityId,
    );
    await this.writeEventsForCustomerSessions(conversationId, "message.read", dto.throughMessageId);
    await this.writeEventsForParticipants(
      conversationId,
      "unread_count.updated",
      conversationId,
      identity.identityId,
    );
    await this.writeEventsForCustomerSessions(
      conversationId,
      "unread_count.updated",
      conversationId,
    );
    return { unreadCount: await this.unreadCount(identity, conversationId) };
  }

  public async unreadSummary(): Promise<{ unreadMessages: number; unreadConversations: number }> {
    const identity = this.requireCompanyIdentity();
    const row = await sql<{ unread_messages: string; unread_conversations: string }>`
      select coalesce(sum(counts.unread_count), 0)::text as unread_messages,
             count(*) filter (where counts.unread_count > 0)::text as unread_conversations
        from (
          select c.id, ${this.unreadCountSql(identity.identityId)} as unread_count
            from conversations c
           where c.company_id = ${identity.companyId}
             and exists (
               select 1 from conversation_participants cp
                where cp.company_id = c.company_id and cp.conversation_id = c.id
                  and cp.account_id = ${identity.identityId} and cp.is_active = true and cp.revoked_at is null
             )
        ) counts
    `.execute(this.database);
    return {
      unreadMessages: Number(row.rows[0]?.unread_messages ?? "0"),
      unreadConversations: Number(row.rows[0]?.unread_conversations ?? "0"),
    };
  }

  public async recoverEvents(
    query: EventRecoveryQueryDto,
  ): Promise<{ events: unknown[]; nextCursor: string | null; fullRefreshRequired: boolean }> {
    const identity = this.requireCompanyIdentity();
    return this.recoverEventsForIdentity(identity, query);
  }

  public async recoverEventsForIdentity(
    identity: IdentityContext & { companyId: string },
    query: EventRecoveryQueryDto,
  ): Promise<{ events: unknown[]; nextCursor: string | null; fullRefreshRequired: boolean }> {
    const after = this.parseNumberCursor(query.after) ?? 0;
    const limit = this.parseLimit(query.limit);
    const expired = await sql<{ expired: boolean }>`
      select exists (
        select 1 from realtime_event_log
         where company_id = ${identity.companyId} and audience_account_id = ${identity.identityId}
           and sequence_number <= ${after} and expires_at < now()
      ) as expired
    `.execute(this.database);
    if (expired.rows[0]?.expired === true) {
      return { events: [], nextCursor: null, fullRefreshRequired: true };
    }
    const rows = await sql<{
      sequence_number: string;
      event_type: string;
      entity_type: string;
      entity_id: string;
      payload: unknown;
      created_at: Date;
    }>`
      select sequence_number::text, event_type, entity_type, entity_id::text, payload, created_at
        from realtime_event_log
       where company_id = ${identity.companyId}
         and audience_account_id = ${identity.identityId}
         and sequence_number > ${after}
       order by sequence_number asc
       limit ${limit + 1}
    `.execute(this.database);
    const page = rows.rows.slice(0, limit);
    return {
      events: page.map((event) => ({
        sequence: event.sequence_number,
        type: event.event_type,
        entityType: event.entity_type,
        entityId: event.entity_id,
        payload: event.payload,
        createdAt: event.created_at.toISOString(),
      })),
      nextCursor:
        rows.rows.length > limit ? (page[page.length - 1]?.sequence_number ?? null) : null,
      fullRefreshRequired: false,
    };
  }

  public async authorizeRealtimeConversation(
    identity: IdentityContext & { companyId: string },
    conversationId: string,
  ): Promise<void> {
    await this.authorizeConversation(identity, conversationId);
  }

  public async createCustomerMessagingSession(
    dto: CreateCustomerMessagingSessionDto,
  ): Promise<CustomerMessagingSessionView> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(dto.trackingToken)) {
      throw new ApplicationException(
        "customer_messaging_token_invalid",
        "Customer messaging access is not available",
        HttpStatus.NOT_FOUND,
      );
    }
    const trackingHash = this.sha256(dto.trackingToken);
    const tracking = await sql<{
      tracking_token_id: string;
      company_id: string;
      order_id: string;
      customer_id: string | null;
      order_number: string;
      company_name: string;
    }>`
      select tt.id as tracking_token_id,
             tt.company_id,
             tt.order_id,
             o.customer_id,
             o.order_number,
             c.name_en as company_name
        from tracking_tokens tt
        join orders o on o.id = tt.order_id and o.company_id = tt.company_id
        join companies c on c.id = tt.company_id and c.status = 'active'
       where tt.token_hash = ${trackingHash}
         and tt.revoked_at is null
         and (tt.expires_at is null or tt.expires_at > now())
       limit 1
    `.execute(this.database);
    const row = tracking.rows[0];
    if (row === undefined || row.customer_id === null) {
      throw new ApplicationException(
        "customer_messaging_token_invalid",
        "Customer messaging access is not available",
        HttpStatus.NOT_FOUND,
      );
    }
    const token = randomBytes(32).toString("base64url");
    const tokenHash = this.sha256(token);
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await sql`
      insert into customer_messaging_sessions (
        company_id, order_id, customer_id, tracking_token_id, token_hash, expires_at
      ) values (
        ${row.company_id}, ${row.order_id}, ${row.customer_id}, ${row.tracking_token_id},
        ${tokenHash}, ${expiresAt}
      )
    `.execute(this.database);
    return {
      customerMessagingToken: token,
      expiresAt: expiresAt.toISOString(),
      orderId: row.order_id,
      orderNumber: row.order_number,
      companyName: row.company_name,
    };
  }

  /** Validates the bearer token and all of the trusted tracking context on every use. */
  public async validateCustomerMessagingSession(
    token: string,
  ): Promise<CustomerMessagingPrincipal> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw this.customerSessionDenied("invalid");
    const row = await sql<{
      id: string;
      company_id: string;
      order_id: string;
      customer_id: string | null;
      conversation_id: string | null;
      expires_at: Date;
    }>`
      select cms.id, cms.company_id, cms.order_id, cms.customer_id, cms.conversation_id, cms.expires_at
        from customer_messaging_sessions cms
        join tracking_tokens tt on tt.id = cms.tracking_token_id and tt.company_id = cms.company_id
        join orders o on o.id = cms.order_id and o.company_id = cms.company_id
        join companies co on co.id = cms.company_id and co.status = 'active'
        left join customers cu on cu.id = cms.customer_id and cu.company_id = cms.company_id
       where cms.token_hash = ${this.sha256(token)}
         and cms.revoked_at is null and cms.expires_at > now()
         and tt.revoked_at is null and (tt.expires_at is null or tt.expires_at > now())
         and (cms.customer_id is null or cu.status = 'active')
       limit 1
    `.execute(this.database);
    const session = row.rows[0];
    if (session === undefined) throw this.customerSessionDenied("invalid");
    await sql`update customer_messaging_sessions set last_seen_at = now() where id = ${session.id}`.execute(
      this.database,
    );
    return {
      kind: "customer_messaging",
      sessionId: session.id,
      companyId: session.company_id,
      orderId: session.order_id,
      customerId: session.customer_id,
      conversationId: session.conversation_id,
      expiresAt: session.expires_at.toISOString(),
    };
  }

  public async customerResolveConversation(token: string): Promise<ConversationSummary> {
    const principal = await this.validateCustomerMessagingSession(token);
    if (principal.conversationId !== null)
      return this.customerConversationSummary(principal, principal.conversationId);
    const office = await sql<{ id: string }>`
      select a.id from accounts a join account_roles ar on ar.account_id = a.id
      join role_permissions rp on rp.role_id = ar.role_id
       where a.company_id = ${principal.companyId} and a.status = 'active'
         and rp.permission_code = ${COMMUNICATION_OPERATOR_READ} limit 1
    `.execute(this.database);
    const officeAccountId = office.rows[0]?.id;
    if (officeAccountId === undefined) throw this.denied("customer_messaging_office_unavailable");
    const existing = await sql<{ id: string }>`
      select id from conversations where company_id=${principal.companyId} and order_id=${principal.orderId}
       and participant_context_type='customer' and status <> 'resolved' limit 1
    `.execute(this.database);
    const conversationId =
      existing.rows[0]?.id ??
      this.requiredId(
        (
          await sql<{ id: string }>`
      insert into conversations (company_id, conversation_type, order_id, participant_context_type, subject, created_by_account_id)
      values (${principal.companyId}, 'order', ${principal.orderId}, 'customer', 'Customer order conversation', ${officeAccountId}) returning id
    `.execute(this.database)
        ).rows[0]?.id,
      );
    await sql`
      update customer_messaging_sessions set conversation_id=${conversationId} where id=${principal.sessionId}
    `.execute(this.database);
    await sql`
      insert into conversation_participants (company_id, conversation_id, account_id, participant_role, customer_id, customer_messaging_session_id)
      select ${principal.companyId}, ${conversationId}, null, 'customer', ${principal.customerId}, ${principal.sessionId}
       where not exists (
         select 1 from conversation_participants where company_id=${principal.companyId}
           and conversation_id=${conversationId} and customer_messaging_session_id=${principal.sessionId}
       )
    `.execute(this.database);
    await this.addOfficeParticipants(conversationId, principal.companyId);
    return this.customerConversationSummary({ ...principal, conversationId }, conversationId);
  }

  public async customerMessages(token: string, query: MessageHistoryQueryDto) {
    const principal = await this.customerPrincipalForConversation(token);
    return this.customerMessagesForPrincipal(principal, query);
  }

  public async customerSendText(token: string, dto: SendTextMessageDto): Promise<MessageView> {
    const principal = await this.customerPrincipalForConversation(token);
    const text = dto.text.replaceAll(String.fromCharCode(0), "").trim();
    if (text.length === 0 || text.length > 4000)
      throw this.customerSessionDenied("message_invalid");
    const existing =
      await sql<MessageView>`select id, conversation_id as "conversationId", sender_role as "senderRole", message_type as "messageType", text_body as text, client_message_id as "clientMessageId", system_event_type as "systemEventType", conversation_sequence::int as sequence, created_at as "createdAt" from messages where company_id=${principal.companyId} and idempotency_key=${dto.idempotencyKey} limit 1`.execute(
        this.database,
      );
    if (existing.rows[0] !== undefined) {
      if (existing.rows[0].conversationId !== principal.conversationId) {
        throw this.customerSessionDenied("idempotency_key_scope_denied");
      }
      return this.mapMessage(existing.rows[0]);
    }
    const inserted = await sql<MessageView>`
      with next_sequence as (select coalesce(max(conversation_sequence),0)+1 value from messages where company_id=${principal.companyId} and conversation_id=${principal.conversationId}),
      created as (insert into messages (company_id, conversation_id, sender_role, message_type, text_body, client_message_id, idempotency_key, original_client_time, conversation_sequence)
        select ${principal.companyId}, ${principal.conversationId}, 'customer', 'text', ${text}, ${dto.clientMessageId}, ${dto.idempotencyKey}, ${dto.originalClientTime ?? null}, value from next_sequence returning *)
      select id, conversation_id as "conversationId", sender_role as "senderRole", message_type as "messageType", text_body as text, client_message_id as "clientMessageId", system_event_type as "systemEventType", conversation_sequence::int as sequence, created_at as "createdAt" from created
    `.execute(this.database);
    const message = this.mapMessage(inserted.rows[0]);
    await sql`update conversations set last_message_id=${message.id}, last_message_at=${message.createdAt}, status='waiting_for_office', updated_at=now(), version=version+1 where id=${principal.conversationId} and company_id=${principal.companyId}`.execute(
      this.database,
    );
    await this.writeEventsForParticipants(
      principal.conversationId,
      "message.created",
      message.id,
      null,
    );
    await this.writeEventsForCustomerSessions(
      principal.conversationId,
      "message.created",
      message.id,
    );
    await this.writeNotificationOutbox(principal.conversationId, message.id, null);
    return message;
  }

  public async customerMarkRead(
    token: string,
    dto: MarkConversationReadDto,
  ): Promise<{ unreadCount: number }> {
    const principal = await this.customerPrincipalForConversation(token);
    const message = await sql<{
      id: string;
    }>`select id from messages where id=${dto.throughMessageId} and company_id=${principal.companyId} and conversation_id=${principal.conversationId} limit 1`.execute(
      this.database,
    );
    if (message.rows[0] === undefined) throw this.customerSessionDenied("message_denied");
    await sql`update customer_messaging_sessions set last_read_message_id=${dto.throughMessageId}, last_seen_at=now() where id=${principal.sessionId}`.execute(
      this.database,
    );
    await this.writeEventsForCustomerSessions(
      principal.conversationId,
      "message.read",
      dto.throughMessageId,
    );
    await this.writeEventsForCustomerSessions(
      principal.conversationId,
      "unread_count.updated",
      principal.conversationId,
    );
    const unread = await this.customerUnread(token);
    return { unreadCount: unread.unreadMessages };
  }

  public async customerUnread(
    token: string,
  ): Promise<{ unreadMessages: number; unreadConversations: number }> {
    const principal = await this.customerPrincipalForConversation(token);
    const result = await sql<{ count: string }>`
      select count(*)::text as count from messages m
       where m.company_id=${principal.companyId} and m.conversation_id=${principal.conversationId} and m.sender_role='office'
       and m.conversation_sequence > coalesce((select conversation_sequence from messages where id=(select last_read_message_id from customer_messaging_sessions where id=${principal.sessionId})),0)
    `.execute(this.database);
    const unreadMessages = Number(result.rows[0]?.count ?? "0");
    return { unreadMessages, unreadConversations: unreadMessages > 0 ? 1 : 0 };
  }

  public async customerRecoverEvents(token: string, query: EventRecoveryQueryDto) {
    const principal = await this.customerPrincipalForConversation(token);
    const after = this.parseNumberCursor(query.after) ?? 0;
    const expired = await sql<{ expired: boolean }>`
      select exists (
        select 1 from realtime_event_log
         where company_id=${principal.companyId}
           and customer_messaging_session_id=${principal.sessionId}
           and sequence_number <= ${after} and expires_at < now()
      ) as expired
    `.execute(this.database);
    if (expired.rows[0]?.expired === true) {
      return { events: [], nextCursor: null, fullRefreshRequired: true };
    }
    const rows = await sql<{
      sequence_number: string;
      event_type: string;
      entity_type: string;
      entity_id: string;
      payload: unknown;
      created_at: Date;
    }>`
      select sequence_number::text, event_type, entity_type, entity_id::text, payload, created_at from realtime_event_log
       where company_id=${principal.companyId} and customer_messaging_session_id=${principal.sessionId} and sequence_number > ${after}
       order by sequence_number asc limit ${this.parseLimit(query.limit) + 1}
    `.execute(this.database);
    const page = rows.rows.slice(0, this.parseLimit(query.limit));
    return {
      events: page.map((event) => ({
        sequence: event.sequence_number,
        type: event.event_type,
        entityType: event.entity_type,
        entityId: event.entity_id,
        payload: event.payload,
        createdAt: event.created_at.toISOString(),
      })),
      nextCursor: rows.rows.length > page.length ? (page.at(-1)?.sequence_number ?? null) : null,
      fullRefreshRequired: false,
    };
  }

  private requireCompanyIdentity(): IdentityContext & { companyId: string } {
    const identity = this.identityAccessor.current();
    if (identity.companyId === null) throw this.denied("company_context_required");
    return identity as IdentityContext & { companyId: string };
  }

  private resolveParticipantContextType(
    identity: IdentityContext,
    requested: ParticipantContextType | undefined,
  ): ParticipantContextType {
    if (identity.kind === "trader") {
      this.requirePermission(identity, "communication.trader.read");
      return "trader";
    }
    if (identity.kind === "driver") {
      this.requirePermission(identity, "communication.driver.read");
      return "driver";
    }
    if (this.isOperatorReader(identity)) {
      if (requested === undefined)
        throw new ApplicationException(
          "participant_context_required",
          "Participant context is required",
          HttpStatus.BAD_REQUEST,
        );
      return requested;
    }
    throw this.denied("unsupported_communication_role");
  }

  private async authorizeOrderConversation(
    identity: IdentityContext & { companyId: string },
    orderId: string,
    contextType: ParticipantContextType,
  ): Promise<{ order_number: string }> {
    const profileFilter =
      contextType === "trader"
        ? sql`and o.trader_id = ${identity.profileId}`
        : contextType === "driver"
          ? sql`and o.assigned_driver_id = ${identity.profileId}`
          : sql`and o.customer_id = ${identity.profileId}`;
    const filter = this.isOperatorReader(identity) ? sql`` : profileFilter;
    const row = await sql<{ order_number: string }>`
      select o.order_number
        from orders o
       where o.company_id = ${identity.companyId}
         and o.id = ${orderId}
         ${filter}
       limit 1
    `.execute(this.database);
    if (row.rows[0] === undefined) throw this.denied("order_access_denied");
    return row.rows[0];
  }

  private async authorizeConversation(
    identity: IdentityContext & { companyId: string },
    conversationId: string,
  ): Promise<{ status: string; participant_context_type: ParticipantContextType }> {
    const participantFilter = this.isOperatorReader(identity)
      ? sql``
      : sql`and exists (
          select 1 from conversation_participants cp
           where cp.company_id = c.company_id and cp.conversation_id = c.id
             and cp.account_id = ${identity.identityId} and cp.is_active = true and cp.revoked_at is null
        )`;
    const row = await sql<{ status: string; participant_context_type: ParticipantContextType }>`
      select c.status, c.participant_context_type from conversations c
       where c.company_id = ${identity.companyId}
         and c.id = ${conversationId}
         ${participantFilter}
       limit 1
    `.execute(this.database);
    if (row.rows[0] === undefined) throw this.denied("conversation_access_denied");
    return row.rows[0];
  }

  private async ensureParticipant(
    conversationId: string,
    companyId: string,
    accountId: string,
    role: ParticipantRole,
    profileId: string | undefined,
  ): Promise<void> {
    await sql`
      insert into conversation_participants (
        company_id, conversation_id, account_id, participant_role, trader_id, driver_id, customer_id
      ) values (
        ${companyId}, ${conversationId}, ${accountId}, ${role},
        ${role === "trader" ? profileId : null},
        ${role === "driver" ? profileId : null},
        ${role === "customer" ? profileId : null}
      )
      on conflict (company_id, conversation_id, account_id) do nothing
    `.execute(this.database);
  }

  private async addOfficeParticipants(conversationId: string, companyId: string): Promise<void> {
    await sql`
      insert into conversation_participants (company_id, conversation_id, account_id, participant_role)
      select ${companyId}, ${conversationId}, a.id, 'office'
        from accounts a
        join account_roles ar on ar.account_id = a.id
        join role_permissions rp on rp.role_id = ar.role_id
       where a.company_id = ${companyId}
         and a.status = 'active'
         and rp.permission_code = ${COMMUNICATION_OPERATOR_READ}
      on conflict (company_id, conversation_id, account_id) do nothing
    `.execute(this.database);
  }

  private async writeEventsForParticipants(
    conversationId: string,
    eventType: string,
    entityId: string,
    actorAccountId: string | null,
  ): Promise<void> {
    await sql`
      insert into realtime_event_log (company_id, audience_account_id, event_type, entity_type, entity_id, payload)
      select cp.company_id, cp.account_id, ${eventType}, 'conversation', ${entityId}::uuid,
             jsonb_build_object('conversationId', ${conversationId}::uuid, 'actorAccountId', ${actorAccountId}::uuid)
        from conversation_participants cp
       where cp.conversation_id = ${conversationId} and cp.account_id is not null
         and cp.is_active = true
         and cp.revoked_at is null
    `.execute(this.database);
  }

  private async writeEventsForCustomerSessions(
    conversationId: string,
    eventType: string,
    entityId: string,
  ): Promise<void> {
    await sql`
      insert into realtime_event_log (company_id, audience_account_id, customer_messaging_session_id, event_type, entity_type, entity_id, payload)
      select cms.company_id, null, cms.id, ${eventType}, 'conversation', ${entityId}::uuid,
             jsonb_build_object('conversationId', ${conversationId}::uuid)
        from customer_messaging_sessions cms
       where cms.conversation_id=${conversationId} and cms.revoked_at is null and cms.expires_at > now()
    `.execute(this.database);
  }

  private async writeNotificationOutbox(
    conversationId: string,
    messageId: string,
    senderAccountId: string | null,
  ): Promise<void> {
    await sql`
      insert into communication_notification_outbox (company_id, conversation_id, message_id, recipient_account_id, payload)
      select cp.company_id, cp.conversation_id, ${messageId}, cp.account_id,
             jsonb_build_object('conversationId', cp.conversation_id, 'messageId', ${messageId}::uuid)
        from conversation_participants cp
       where cp.conversation_id = ${conversationId}
         and cp.account_id is not null and (${senderAccountId}::uuid is null or cp.account_id <> ${senderAccountId})
         and cp.is_active = true
         and cp.revoked_at is null
      on conflict (company_id, message_id, recipient_account_id) do nothing
    `.execute(this.database);
  }

  private async customerPrincipalForConversation(
    token: string,
  ): Promise<CustomerMessagingPrincipal & { conversationId: string }> {
    const principal = await this.validateCustomerMessagingSession(token);
    if (principal.conversationId === null) {
      await this.customerResolveConversation(token);
      return this.customerPrincipalForConversation(token);
    }
    await this.customerConversationSummary(principal, principal.conversationId);
    return principal as CustomerMessagingPrincipal & { conversationId: string };
  }

  private async customerConversationSummary(
    principal: CustomerMessagingPrincipal,
    conversationId: string,
  ): Promise<ConversationSummary> {
    const row = await sql<ConversationSummary>`
      select c.id, c.conversation_type as "type", c.participant_context_type as "participantContextType", c.order_id as "orderId", o.order_number as "orderNumber", c.subject, c.status, c.priority, c.last_message_at as "lastMessageAt",
        case when m.message_type='text' then left(m.text_body,120) else null end as "lastMessagePreview", 0::int as "unreadCount"
      from conversations c join orders o on o.id=c.order_id and o.company_id=c.company_id
      left join messages m on m.id=c.last_message_id and m.company_id=c.company_id
      where c.id=${conversationId} and c.company_id=${principal.companyId} and c.order_id=${principal.orderId} and c.participant_context_type='customer'
      limit 1
    `.execute(this.database);
    if (row.rows[0] === undefined) throw this.customerSessionDenied("conversation_denied");
    return this.mapConversation(row.rows[0]);
  }

  private async customerMessagesForPrincipal(
    principal: CustomerMessagingPrincipal & { conversationId: string },
    query: MessageHistoryQueryDto,
  ) {
    const limit = this.parseLimit(query.limit);
    const after = this.parseNumberCursor(query.after);
    const before = this.parseNumberCursor(query.before);
    const rows =
      await sql<MessageView>`select id, conversation_id as "conversationId", sender_role as "senderRole", message_type as "messageType", text_body as text, client_message_id as "clientMessageId", system_event_type as "systemEventType", conversation_sequence::int as sequence, created_at as "createdAt" from messages where company_id=${principal.companyId} and conversation_id=${principal.conversationId} ${after === null ? sql`` : sql`and conversation_sequence > ${after}`} ${before === null ? sql`` : sql`and conversation_sequence < ${before}`} order by conversation_sequence desc limit ${limit + 1}`.execute(
        this.database,
      );
    const page = rows.rows.slice(0, limit);
    return {
      items: page.reverse().map((row) => this.mapMessage(row)),
      nextCursor: rows.rows.length > limit ? String(page.at(-1)?.sequence ?? "") : null,
    };
  }

  private customerSessionDenied(reason: string): ApplicationException {
    void reason;
    return new ApplicationException(
      "customer_messaging_session_invalid",
      "Customer messaging access is not available",
      HttpStatus.NOT_FOUND,
    );
  }

  private async getConversationSummary(
    conversationId: string,
    identity: IdentityContext & { companyId: string },
  ): Promise<ConversationSummary> {
    const row = await sql<ConversationSummary>`
      select c.id,
             c.conversation_type as "type",
             c.participant_context_type as "participantContextType",
             c.order_id as "orderId",
             o.order_number as "orderNumber",
             c.subject,
             c.status,
             c.priority,
             c.last_message_at as "lastMessageAt",
             case when m.message_type = 'text' then left(m.text_body, 120)
                  when m.message_type = 'system' then m.system_event_type
                  when m.message_type = 'voice_placeholder' then 'voice_message'
                  else null end as "lastMessagePreview",
             ${this.unreadCountSql(identity.identityId)} as "unreadCount"
        from conversations c
        left join orders o on o.id = c.order_id and o.company_id = c.company_id
        left join messages m on m.id = c.last_message_id and m.company_id = c.company_id
       where c.company_id = ${identity.companyId} and c.id = ${conversationId}
    `.execute(this.database);
    if (row.rows[0] === undefined) throw this.denied("conversation_not_found");
    return this.mapConversation(row.rows[0]);
  }

  private async unreadCount(
    identity: IdentityContext & { companyId: string },
    conversationId: string,
  ): Promise<number> {
    const row = await sql<{ count: string }>`
      select ${this.unreadCountSql(identity.identityId)}::text as count
        from conversations c
       where c.company_id = ${identity.companyId} and c.id = ${conversationId}
    `.execute(this.database);
    return Number(row.rows[0]?.count ?? "0");
  }

  private unreadCountSql(accountId: string) {
    return sql<number>`(
      select count(*)::int
        from messages unread_message
        join conversation_participants reader
          on reader.company_id = unread_message.company_id
         and reader.conversation_id = unread_message.conversation_id
         and reader.account_id = ${accountId}
       where unread_message.company_id = c.company_id
         and unread_message.conversation_id = c.id
         and unread_message.sender_account_id is distinct from ${accountId}
         and unread_message.conversation_sequence > coalesce((
           select read_message.conversation_sequence
             from messages read_message
            where read_message.id = reader.last_read_message_id
              and read_message.company_id = reader.company_id
         ), 0)
    )`;
  }

  private isOperatorReader(identity: IdentityContext): boolean {
    return (
      identity.kind === "company_user" && identity.permissions.has(COMMUNICATION_OPERATOR_READ)
    );
  }

  private senderRole(identity: IdentityContext): ParticipantRole {
    if (identity.kind === "trader") return "trader";
    if (identity.kind === "driver") return "driver";
    if (identity.kind === "company_user" && identity.permissions.has(COMMUNICATION_OPERATOR_SEND)) {
      return "office";
    }
    throw this.denied("unsupported_communication_role");
  }

  private requirePermission(identity: IdentityContext, permission: string): void {
    if (!identity.permissions.has(permission)) throw this.denied("communication_permission_denied");
  }

  private requireSendPermission(
    identity: IdentityContext,
    contextType: ParticipantContextType,
  ): void {
    if (identity.kind === "trader" && contextType === "trader") {
      this.requirePermission(identity, "communication.trader.send");
      return;
    }
    if (identity.kind === "driver" && contextType === "driver") {
      this.requirePermission(identity, "communication.driver.send");
      return;
    }
    if (identity.kind === "company_user") {
      this.requirePermission(identity, COMMUNICATION_OPERATOR_SEND);
      return;
    }
    throw this.denied("communication_send_permission_denied");
  }

  private parseLimit(raw: string | undefined): number {
    const parsed = Number.parseInt(raw ?? "25", 10);
    if (!Number.isFinite(parsed)) return 25;
    return Math.min(Math.max(parsed, 1), MAX_PAGE_SIZE);
  }

  private parseCursor(raw: string | undefined): string | null {
    if (raw === undefined || raw.trim() === "") return null;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime()))
      throw new ApplicationException("invalid_cursor", "Cursor is invalid", HttpStatus.BAD_REQUEST);
    return date.toISOString();
  }

  private parseNumberCursor(raw: string | undefined): number | null {
    if (raw === undefined || raw.trim() === "") return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0)
      throw new ApplicationException("invalid_cursor", "Cursor is invalid", HttpStatus.BAD_REQUEST);
    return parsed;
  }

  private requiredId(id: string | undefined): string {
    if (id === undefined) throw new Error("Expected database row ID");
    return id;
  }

  private sha256(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }

  private denied(code: string): ApplicationException {
    return new ApplicationException(
      code,
      "Conversation access is not allowed",
      HttpStatus.FORBIDDEN,
    );
  }

  private mapConversation(row: ConversationSummary): ConversationSummary {
    return {
      ...row,
      lastMessageAt: row.lastMessageAt === null ? null : new Date(row.lastMessageAt).toISOString(),
      unreadCount: Number(row.unreadCount),
    };
  }

  private mapMessage(row: MessageView | undefined): MessageView {
    if (row === undefined) throw new Error("Expected message row");
    return {
      ...row,
      sequence: Number(row.sequence),
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }
}
