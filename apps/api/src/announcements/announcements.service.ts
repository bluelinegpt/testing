import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql, type Transaction } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import {
  ANNOUNCEMENT_SEVERITY,
  type AnnouncementAudience,
  type AnnouncementDisplayStatus,
  type AnnouncementInput,
  type AnnouncementSurface,
  type AnnouncementType,
  announcementDisplayStatus,
  type NormalizedAnnouncement,
  validateAnnouncement,
} from "./announcements.js";

export interface PlatformAnnouncementActor {
  readonly accountId: string;
  readonly correlationId: string;
}

/** One announcement as the Platform screen sees it. */
export interface PlatformAnnouncement {
  readonly id: string;
  readonly type: AnnouncementType;
  readonly titleEn: string | null;
  readonly titleAr: string | null;
  readonly bodyEn: string | null;
  readonly bodyAr: string | null;
  readonly showFrom: string;
  readonly showUntil: string;
  readonly surfaces: AnnouncementSurface[];
  readonly audience: AnnouncementAudience;
  readonly companies: { readonly id: string; readonly nameEn: string }[];
  readonly status: "active" | "cancelled";
  readonly displayStatus: AnnouncementDisplayStatus;
  readonly version: number;
  readonly createdBy: string | null;
  readonly updatedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What a Company app receives: no audience, no target list, no authors. */
export interface ActiveAnnouncement {
  readonly id: string;
  readonly version: number;
  readonly type: AnnouncementType;
  readonly titleEn: string | null;
  readonly titleAr: string | null;
  readonly bodyEn: string | null;
  readonly bodyAr: string | null;
  readonly showFrom: string;
  readonly showUntil: string;
}

interface AnnouncementRow {
  id: string;
  type: AnnouncementType;
  titleEn: string | null;
  titleAr: string | null;
  bodyEn: string | null;
  bodyAr: string | null;
  showFrom: Date;
  showUntil: Date;
  surfaces: AnnouncementSurface[];
  audience: AnnouncementAudience;
  status: "active" | "cancelled";
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Platform announcements to Companies.
 *
 * Written by Platform administrators (no tenant: the caller's company is
 * null), read by every signed-in Company account through
 * `GET /announcements/active`, which never sees the audience or the list of
 * targeted Companies. Nothing is hard-deleted; an announcement is ended or
 * cancelled. Every change records a `platform.announcement.*` audit event in
 * the same transaction as the change.
 */
@Injectable()
export class AnnouncementsService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
  ) {}

  /** Every announcement, newest first, with its status at this moment. */
  public async list(now: Date = new Date()): Promise<PlatformAnnouncement[]> {
    const rows = (
      await sql<AnnouncementRow>`
        ${this.selectAnnouncements()}
        order by a.show_from desc, a.created_at desc
        limit 200
      `.execute(this.database)
    ).rows;
    const companies = await this.companiesFor(
      this.database,
      rows.map((row) => row.id),
    );
    return rows.map((row) => this.present(row, companies.get(row.id) ?? [], now));
  }

  public async get(id: string, now: Date = new Date()): Promise<PlatformAnnouncement> {
    return this.read(this.database, id, now);
  }

  public async create(
    input: AnnouncementInput,
    actor: PlatformAnnouncementActor,
  ): Promise<PlatformAnnouncement> {
    const value = this.validated(input);
    return this.transactions.execute(async (transaction) => {
      await this.assertCompaniesExist(transaction, value.companyIds);
      const inserted = await sql<{ id: string }>`
        insert into platform_announcements (
          type, title_en, title_ar, body_en, body_ar, show_from, show_until,
          surfaces, audience, created_by_account_id, updated_by_account_id
        ) values (
          ${value.type}, ${value.titleEn}, ${value.titleAr}, ${value.bodyEn}, ${value.bodyAr},
          ${value.showFrom.toISOString()}::timestamptz, ${value.showUntil.toISOString()}::timestamptz,
          ${value.surfaces}::text[], ${value.audience},
          ${actor.accountId}::uuid, ${actor.accountId}::uuid
        )
        returning id
      `.execute(transaction);
      const id = inserted.rows[0]!.id;
      await this.writeCompanies(transaction, id, value.companyIds);
      await this.audit(transaction, actor, "platform.announcement.create", id, {
        after: this.auditShape(value),
      });
      return this.read(transaction, id);
    });
  }

  public async update(
    id: string,
    input: AnnouncementInput,
    actor: PlatformAnnouncementActor,
  ): Promise<PlatformAnnouncement> {
    const value = this.validated(input);
    return this.transactions.execute(async (transaction) => {
      const before = await this.lockActive(transaction, id);
      await this.assertCompaniesExist(transaction, value.companyIds);
      await sql`
        update platform_announcements
           set type = ${value.type},
               title_en = ${value.titleEn}, title_ar = ${value.titleAr},
               body_en = ${value.bodyEn}, body_ar = ${value.bodyAr},
               show_from = ${value.showFrom.toISOString()}::timestamptz,
               show_until = ${value.showUntil.toISOString()}::timestamptz,
               surfaces = ${value.surfaces}::text[],
               audience = ${value.audience},
               version = version + 1,
               updated_by_account_id = ${actor.accountId}::uuid,
               updated_at = now()
         where id = ${id}::uuid
      `.execute(transaction);
      await this.writeCompanies(transaction, id, value.companyIds);
      await this.audit(transaction, actor, "platform.announcement.update", id, {
        after: this.auditShape(value),
        before: { showFrom: before.showFrom, showUntil: before.showUntil, version: before.version },
      });
      return this.read(transaction, id);
    });
  }

  /** Stops showing it now. A scheduled announcement simply never starts. */
  public async endNow(id: string, actor: PlatformAnnouncementActor): Promise<PlatformAnnouncement> {
    return this.transactions.execute(async (transaction) => {
      const before = await this.lockActive(transaction, id);
      // show_until must stay after show_from: ending a not-yet-started
      // announcement pulls both to now.
      await sql`
        update platform_announcements
           set show_from = least(show_from, now() - interval '1 second'),
               show_until = now(),
               updated_by_account_id = ${actor.accountId}::uuid,
               updated_at = now()
         where id = ${id}::uuid
      `.execute(transaction);
      await this.audit(transaction, actor, "platform.announcement.end_now", id, {
        after: { showUntil: "now" },
        before: { showFrom: before.showFrom, showUntil: before.showUntil },
      });
      return this.read(transaction, id);
    });
  }

  public async cancel(id: string, actor: PlatformAnnouncementActor): Promise<PlatformAnnouncement> {
    return this.transactions.execute(async (transaction) => {
      await this.lockActive(transaction, id);
      await sql`
        update platform_announcements
           set status = 'cancelled',
               updated_by_account_id = ${actor.accountId}::uuid,
               updated_at = now()
         where id = ${id}::uuid
      `.execute(transaction);
      await this.audit(transaction, actor, "platform.announcement.cancel", id, {
        after: { status: "cancelled" },
        before: { status: "active" },
      });
      return this.read(transaction, id);
    });
  }

  /**
   * The announcements one Company account should see now on one surface.
   * The Company comes from the caller's session, never from the request.
   */
  public async active(companyId: string, surface: AnnouncementSurface): Promise<ActiveAnnouncement[]> {
    const rows = (
      await sql<{
        id: string;
        version: number;
        type: AnnouncementType;
        titleEn: string | null;
        titleAr: string | null;
        bodyEn: string | null;
        bodyAr: string | null;
        showFrom: Date;
        showUntil: Date;
      }>`
        select a.id, a.version, a.type,
               a.title_en as "titleEn", a.title_ar as "titleAr",
               a.body_en as "bodyEn", a.body_ar as "bodyAr",
               a.show_from as "showFrom", a.show_until as "showUntil"
          from platform_announcements a
         where a.status = 'active'
           and a.show_from <= now()
           and a.show_until > now()
           and ${surface} = any(a.surfaces)
           and (
             a.audience = 'all_companies'
             or exists (
               select 1 from platform_announcement_companies target
                where target.announcement_id = a.id
                  and target.company_id = ${companyId}::uuid
             )
           )
         limit 20
      `.execute(this.database)
    ).rows;
    return rows
      .sort(
        (left, right) =>
          ANNOUNCEMENT_SEVERITY[left.type] - ANNOUNCEMENT_SEVERITY[right.type] ||
          left.showFrom.getTime() - right.showFrom.getTime(),
      )
      .map((row) => ({
        bodyAr: row.bodyAr,
        bodyEn: row.bodyEn,
        id: row.id,
        showFrom: row.showFrom.toISOString(),
        showUntil: row.showUntil.toISOString(),
        titleAr: row.titleAr,
        titleEn: row.titleEn,
        type: row.type,
        version: row.version,
      }));
  }

  private validated(input: AnnouncementInput): NormalizedAnnouncement {
    const validation = validateAnnouncement(input);
    if (!validation.ok) {
      throw new ApplicationException(
        "announcement_invalid",
        "The announcement has problems that must be fixed before saving",
        HttpStatus.BAD_REQUEST,
        validation.errors,
      );
    }
    return validation.value;
  }

  private selectAnnouncements() {
    return sql`
      select a.id, a.type,
             a.title_en as "titleEn", a.title_ar as "titleAr",
             a.body_en as "bodyEn", a.body_ar as "bodyAr",
             a.show_from as "showFrom", a.show_until as "showUntil",
             a.surfaces, a.audience, a.status, a.version,
             creator.username as "createdBy", editor.username as "updatedBy",
             a.created_at as "createdAt", a.updated_at as "updatedAt"
        from platform_announcements a
        left join accounts creator on creator.id = a.created_by_account_id
        left join accounts editor on editor.id = a.updated_by_account_id
    `;
  }

  private async read(
    database: Kysely<DatabaseSchema>,
    id: string,
    now: Date = new Date(),
  ): Promise<PlatformAnnouncement> {
    const row = (
      await sql<AnnouncementRow>`
        ${this.selectAnnouncements()}
        where a.id = ${id}::uuid
      `.execute(database)
    ).rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "announcement_not_found",
        "This announcement does not exist",
        HttpStatus.NOT_FOUND,
      );
    }
    const companies = await this.companiesFor(database, [id]);
    return this.present(row, companies.get(id) ?? [], now);
  }

  private async companiesFor(
    database: Kysely<DatabaseSchema>,
    ids: readonly string[],
  ): Promise<Map<string, { id: string; nameEn: string }[]>> {
    const result = new Map<string, { id: string; nameEn: string }[]>();
    if (ids.length === 0) return result;
    const rows = (
      await sql<{ announcementId: string; id: string; nameEn: string }>`
        select target.announcement_id as "announcementId", c.id, c.name_en as "nameEn"
          from platform_announcement_companies target
          join companies c on c.id = target.company_id
         where target.announcement_id in (${sql.join(ids.map((id) => sql`${id}::uuid`))})
         order by c.name_en
      `.execute(database)
    ).rows;
    for (const row of rows) {
      const list = result.get(row.announcementId) ?? [];
      list.push({ id: row.id, nameEn: row.nameEn });
      result.set(row.announcementId, list);
    }
    return result;
  }

  private present(
    row: AnnouncementRow,
    companies: { id: string; nameEn: string }[],
    now: Date,
  ): PlatformAnnouncement {
    return {
      audience: row.audience,
      bodyAr: row.bodyAr,
      bodyEn: row.bodyEn,
      companies,
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy,
      displayStatus: announcementDisplayStatus(row, now),
      id: row.id,
      showFrom: row.showFrom.toISOString(),
      showUntil: row.showUntil.toISOString(),
      status: row.status,
      surfaces: row.surfaces,
      titleAr: row.titleAr,
      titleEn: row.titleEn,
      type: row.type,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
      version: row.version,
    };
  }

  /** Locks the row; refuses a missing or cancelled announcement. */
  private async lockActive(
    transaction: Transaction<DatabaseSchema>,
    id: string,
  ): Promise<{ showFrom: Date; showUntil: Date; version: number }> {
    const row = (
      await sql<{ status: string; showFrom: Date; showUntil: Date; version: number }>`
        select status, show_from as "showFrom", show_until as "showUntil", version
          from platform_announcements
         where id = ${id}::uuid
         for update
      `.execute(transaction)
    ).rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "announcement_not_found",
        "This announcement does not exist",
        HttpStatus.NOT_FOUND,
      );
    }
    if (row.status === "cancelled") {
      throw new ApplicationException(
        "announcement_cancelled",
        "A cancelled announcement cannot be changed",
        HttpStatus.CONFLICT,
      );
    }
    return row;
  }

  private async assertCompaniesExist(
    transaction: Transaction<DatabaseSchema>,
    companyIds: readonly string[],
  ): Promise<void> {
    if (companyIds.length === 0) return;
    const found = (
      await sql<{ id: string }>`
        select id from companies
         where id in (${sql.join(companyIds.map((id) => sql`${id}::uuid`))})
      `.execute(transaction)
    ).rows.map((row) => row.id.toLowerCase());
    const missing = companyIds.filter((id) => !found.includes(id));
    if (missing.length > 0) {
      throw new ApplicationException(
        "announcement_company_unknown",
        "One or more selected Companies do not exist",
        HttpStatus.BAD_REQUEST,
        missing,
      );
    }
  }

  /**
   * Replaces the target list. These rows belong to the announcement (its
   * audience), not to the Company's business data, so replacing them on an
   * edit is the announcement changing its own audience.
   */
  private async writeCompanies(
    transaction: Transaction<DatabaseSchema>,
    id: string,
    companyIds: readonly string[],
  ): Promise<void> {
    await sql`
      delete from platform_announcement_companies where announcement_id = ${id}::uuid
    `.execute(transaction);
    if (companyIds.length === 0) return;
    await sql`
      insert into platform_announcement_companies (announcement_id, company_id)
      select ${id}::uuid, target.company_id
        from unnest(${companyIds}::uuid[]) as target(company_id)
      on conflict do nothing
    `.execute(transaction);
  }

  private auditShape(value: NormalizedAnnouncement): Record<string, unknown> {
    return {
      audience: value.audience,
      companyCount: value.companyIds.length,
      companyIds: value.companyIds,
      showFrom: value.showFrom.toISOString(),
      showUntil: value.showUntil.toISOString(),
      surfaces: value.surfaces,
      titleAr: value.titleAr,
      titleEn: value.titleEn,
      type: value.type,
    };
  }

  private async audit(
    transaction: Transaction<DatabaseSchema>,
    actor: PlatformAnnouncementActor,
    action: string,
    subjectId: string,
    data: { before?: object; after: object },
  ): Promise<void> {
    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        before_data, after_data, correlation_id, actor_role, source, result,
        source_application
      ) values (
        null, ${actor.accountId}::uuid, ${action},
        'platform_announcement', ${subjectId},
        ${data.before === undefined ? null : JSON.stringify(data.before)}::jsonb,
        ${JSON.stringify(data.after)}::jsonb, ${actor.correlationId},
        'platform_administrator', 'platform_portal', 'success', 'platform-web'
      )
    `.execute(transaction);
  }
}
