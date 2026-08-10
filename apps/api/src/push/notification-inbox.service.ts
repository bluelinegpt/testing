import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { IdentityContextAccessor } from "../security/identity-context.js";

export interface NotificationInboxItem {
  readonly id: string;
  readonly notificationType: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly titleKey: string;
  readonly bodyKey: string | null;
  readonly bodyParams: Record<string, unknown>;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export interface NotificationInboxPage {
  readonly items: readonly NotificationInboxItem[];
  readonly nextCursor: string | null;
}

const pageSize = 30;

/**
 * The durable Notification Inbox — Section W/X: push delivery and the Inbox
 * are different responsibilities, so this reads `notification_outbox_events`
 * directly (the durable record) rather than any local push-received history.
 * A Firebase delivery failure changes only that row's `status`/`attempts`;
 * it is never deleted, so the Inbox stays a complete, trustworthy history
 * regardless of whether the push itself ever arrived.
 */
@Injectable()
export class NotificationInboxService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  public async page(cursor: string | undefined): Promise<NotificationInboxPage> {
    const identity = this.identities.current();
    if (identity.companyId === null) return { items: [], nextCursor: null };
    const result = await sql<{
      id: string;
      notificationType: string;
      targetType: string;
      targetId: string | null;
      titleKey: string;
      bodyKey: string | null;
      bodyParams: Record<string, unknown>;
      createdAt: string;
      readAt: string | null;
    }>`
      select id, notification_type as "notificationType", target_type as "targetType",
             target_id as "targetId", title_key as "titleKey", body_key as "bodyKey",
             body_params as "bodyParams", created_at::text as "createdAt", read_at::text as "readAt"
        from notification_outbox_events
       where company_id = ${identity.companyId}::uuid
         and recipient_account_id = ${identity.identityId}::uuid
         and (${cursor ?? null}::timestamptz is null or created_at < ${cursor ?? null}::timestamptz)
       order by created_at desc
       limit ${pageSize + 1}
    `.execute(this.database);
    const hasMore = result.rows.length > pageSize;
    const items = result.rows.slice(0, pageSize);
    return {
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.createdAt ?? null) : null,
    };
  }

  public async markRead(id: string): Promise<void> {
    const identity = this.identities.current();
    if (identity.companyId === null) return;
    await sql`
      update notification_outbox_events
         set read_at = now()
       where id = ${id}::uuid and company_id = ${identity.companyId}::uuid
         and recipient_account_id = ${identity.identityId}::uuid
         and read_at is null
    `.execute(this.database);
  }

  public async markAllRead(): Promise<void> {
    const identity = this.identities.current();
    if (identity.companyId === null) return;
    await sql`
      update notification_outbox_events
         set read_at = now()
       where company_id = ${identity.companyId}::uuid
         and recipient_account_id = ${identity.identityId}::uuid
         and read_at is null
    `.execute(this.database);
  }
}
