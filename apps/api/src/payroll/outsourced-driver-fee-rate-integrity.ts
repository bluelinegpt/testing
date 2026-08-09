import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * Detects the exact defect this repository repaired once already: an
 * outsourced-Driver fee accrual whose own authoritative business date falls
 * OUTSIDE the validity window of the fee-rate version it references.
 *
 * Deliberately a plain, on-demand query -- not a trigger, not a view queried on
 * every page load. It exists to be run from a certification test or an admin
 * diagnostic, the same two places that would otherwise need to hand-write this
 * join. `protect_outsourced_driver_fee_foundations` now blocks the write that
 * used to CREATE this state (see migration `20260810900000`); this function is
 * what proves that state cannot silently reappear some other way.
 */
export interface OrphanedFeeAccrual {
  readonly accrualBusinessDate: string;
  readonly accrualId: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly driverId: string;
  readonly driverName: string;
  readonly earnedAmount: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly versionEffectiveFrom: string;
  readonly versionEffectiveTo: string | null;
  readonly versionFeePerOrder: string;
  readonly versionId: string;
}

export async function findOrphanedFeeAccruals(
  database: Kysely<DatabaseSchema>,
  companyId?: string,
): Promise<readonly OrphanedFeeAccrual[]> {
  const result = await sql<{
    accrualBusinessDate: string;
    accrualId: string;
    companyId: string;
    companyName: string;
    driverId: string;
    driverName: string;
    earnedAmount: string;
    orderId: string;
    orderNumber: string;
    versionEffectiveFrom: string;
    versionEffectiveTo: string | null;
    versionFeePerOrder: string;
    versionId: string;
  }>`
    select a.id as "accrualId", a.company_id as "companyId", c.name_en as "companyName",
           a.driver_id as "driverId", d.name_en as "driverName",
           a.order_id as "orderId", o.order_number as "orderNumber",
           a.accrual_business_date::text as "accrualBusinessDate",
           a.earned_amount::text as "earnedAmount",
           v.id as "versionId", v.effective_from::text as "versionEffectiveFrom",
           v.effective_to::text as "versionEffectiveTo", v.fee_per_order::text as "versionFeePerOrder"
      from outsourced_driver_fee_accruals a
      join companies c on c.id = a.company_id
      join drivers d on d.id = a.driver_id and d.company_id = a.company_id
      join orders o on o.id = a.order_id and o.company_id = a.company_id
      join outsourced_driver_fee_versions v
        on v.id = a.fee_rate_version_id and v.company_id = a.company_id
     where a.status not in ('reversed', 'recovery_required')
       and not (
         v.effective_from <= a.accrual_business_date
         and coalesce(v.effective_to, 'infinity'::date) >= a.accrual_business_date
       )
       and (${companyId ?? null}::uuid is null or a.company_id = ${companyId ?? null}::uuid)
     order by c.name_en, d.name_en, a.accrual_business_date
  `.execute(database);
  return result.rows;
}
