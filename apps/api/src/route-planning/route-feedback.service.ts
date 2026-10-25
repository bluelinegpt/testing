import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import type { RouteFeedbackReason } from "./route-planning.dto.js";

export interface RouteFeedbackArea {
  readonly areaId: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
}

export interface RouteFeedbackRow {
  readonly runId: string;
  readonly referenceNumber: string;
  readonly businessDate: string;
  readonly driverNameEn: string;
  readonly driverNameAr: string | null;
  readonly rating: "like" | "dislike";
  readonly reason: RouteFeedbackReason | null;
  readonly comment: string | null;
  readonly direction: "recommended" | "reversed";
  readonly updatedAt: string;
  /** Areas the Driver said are in the wrong place on the map. */
  readonly flaggedAreas: readonly RouteFeedbackArea[];
  /** The route as planned when he answered. */
  readonly plannedAreas: readonly RouteFeedbackArea[];
  /** The order he actually delivered in (first delivery in each Area). */
  readonly actualAreas: readonly RouteFeedbackArea[];
}

export interface RouteFeedbackReport {
  readonly days: number;
  readonly runCount: number;
  readonly likeCount: number;
  readonly dislikeCount: number;
  readonly reasons: readonly { readonly reason: RouteFeedbackReason; readonly count: number }[];
  /** Areas most often reported as "wrong location". */
  readonly flaggedAreas: readonly (RouteFeedbackArea & { readonly count: number })[];
  readonly rows: readonly RouteFeedbackRow[];
}

const REPORT_DAYS = 30;
const REPORT_ROWS = 200;

/**
 * Driver route feedback for administrators (Aiman, 25 Oct 2026): how many
 * routes were liked or disliked, why, which Area pins Drivers say are wrong,
 * and -- per route -- the planned Area order next to the order the Driver
 * actually delivered in. Read-only.
 */
@Injectable()
export class RouteFeedbackService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  public async report(): Promise<RouteFeedbackReport> {
    const companyId = this.companyId();
    const [counts, rows] = await Promise.all([
      sql<{ runCount: string; likeCount: string; dislikeCount: string }>`
        select
          (select count(*) from driver_route_runs r
            where r.company_id = ${companyId}::uuid
              and r.business_date > current_date - ${REPORT_DAYS}::int)::text as "runCount",
          count(*) filter (where f.rating = 'like')::text as "likeCount",
          count(*) filter (where f.rating = 'dislike')::text as "dislikeCount"
          from driver_route_feedback f
         where f.company_id = ${companyId}::uuid
           and f.created_at > now() - make_interval(days => ${REPORT_DAYS}::int)
      `.execute(this.database),
      sql<{
        runId: string;
        referenceNumber: string;
        businessDate: string;
        driverId: string;
        computedAt: string;
        driverNameEn: string;
        driverNameAr: string | null;
        rating: "like" | "dislike";
        reason: RouteFeedbackReason | null;
        comment: string | null;
        direction: "recommended" | "reversed";
        updatedAt: string;
        areaIds: readonly string[];
        plannedAreaIds: readonly string[];
      }>`
        select r.id as "runId", r.reference_number as "referenceNumber",
               r.business_date::text as "businessDate", r.driver_id as "driverId",
               r.computed_at::text as "computedAt",
               d.name_en as "driverNameEn", d.name_ar as "driverNameAr",
               f.rating, f.reason, f.comment, f.direction, f.updated_at::text as "updatedAt",
               f.area_ids as "areaIds", f.planned_area_ids as "plannedAreaIds"
          from driver_route_feedback f
          join driver_route_runs r on r.company_id = f.company_id and r.id = f.run_id
          join drivers d on d.company_id = f.company_id and d.id = f.driver_id
         where f.company_id = ${companyId}::uuid
           and f.created_at > now() - make_interval(days => ${REPORT_DAYS}::int)
         order by f.updated_at desc
         limit ${REPORT_ROWS}
      `.execute(this.database),
    ]);

    const runIds = rows.rows.map((row) => row.runId);
    const actual =
      runIds.length === 0
        ? []
        : (
            await sql<{ runId: string; areaId: string }>`
              select r.id as "runId", o.area_id as "areaId"
                from driver_route_runs r
                join orders o
                  on o.company_id = r.company_id
                 and o.assigned_driver_id = r.driver_id
                 and o.delivered_at >= r.computed_at
                 and o.delivered_at < r.computed_at + interval '20 hours'
                 and o.area_id is not null
               where r.company_id = ${companyId}::uuid
                 and r.id in (${sql.join(runIds.map((id) => sql`${id}::uuid`))})
               group by r.id, o.area_id
               order by r.id, min(o.delivered_at)
            `.execute(this.database)
          ).rows;
    const actualByRun = new Map<string, string[]>();
    for (const row of actual) {
      const list = actualByRun.get(row.runId) ?? [];
      list.push(row.areaId);
      actualByRun.set(row.runId, list);
    }

    const areaIds = new Set<string>();
    for (const row of rows.rows) {
      for (const id of [...row.areaIds, ...row.plannedAreaIds]) areaIds.add(id);
    }
    for (const row of actual) areaIds.add(row.areaId);
    const areas =
      areaIds.size === 0
        ? []
        : (
            await sql<RouteFeedbackArea>`
              select a.id as "areaId", a.name_en as "nameEn", a.name_ar as "nameAr"
                from areas a
               where a.company_id = ${companyId}::uuid
                 and a.id in (${sql.join([...areaIds].map((id) => sql`${id}::uuid`))})
            `.execute(this.database)
          ).rows;
    const areaById = new Map(areas.map((area) => [area.areaId, area]));
    const named = (ids: readonly string[]): RouteFeedbackArea[] =>
      ids.flatMap((id) => {
        const area = areaById.get(id);
        return area === undefined ? [] : [area];
      });

    const reasonCounts = new Map<RouteFeedbackReason, number>();
    const flagged = new Map<string, number>();
    for (const row of rows.rows) {
      if (row.rating !== "dislike") continue;
      if (row.reason !== null) reasonCounts.set(row.reason, (reasonCounts.get(row.reason) ?? 0) + 1);
      for (const id of row.areaIds) flagged.set(id, (flagged.get(id) ?? 0) + 1);
    }
    const count = counts.rows[0];
    return {
      days: REPORT_DAYS,
      runCount: Number(count?.runCount ?? 0),
      likeCount: Number(count?.likeCount ?? 0),
      dislikeCount: Number(count?.dislikeCount ?? 0),
      reasons: [...reasonCounts.entries()]
        .map(([reason, total]) => ({ reason, count: total }))
        .sort((a, b) => b.count - a.count),
      flaggedAreas: [...flagged.entries()]
        .flatMap(([id, total]) => {
          const area = areaById.get(id);
          return area === undefined ? [] : [{ ...area, count: total }];
        })
        .sort((a, b) => b.count - a.count || a.nameEn.localeCompare(b.nameEn)),
      rows: rows.rows.map((row) => ({
        runId: row.runId,
        referenceNumber: row.referenceNumber,
        businessDate: row.businessDate,
        driverNameEn: row.driverNameEn,
        driverNameAr: row.driverNameAr,
        rating: row.rating,
        reason: row.reason,
        comment: row.comment,
        direction: row.direction,
        updatedAt: row.updatedAt,
        flaggedAreas: named(row.areaIds),
        plannedAreas: named(row.plannedAreaIds),
        actualAreas: named(actualByRun.get(row.runId) ?? []),
      })),
    };
  }

  private companyId(): string {
    const identity = this.identities.current();
    if (identity.kind !== "company_user" || identity.companyId === null) {
      throw new ApplicationException(
        "route_setup_company_user_required",
        "A Company user is required",
        HttpStatus.FORBIDDEN,
      );
    }
    return identity.companyId;
  }
}
