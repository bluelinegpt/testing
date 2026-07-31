import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

export interface EffectiveOutsourcedDriverFeeRate {
  readonly feePerOrder: string;
  readonly id: string;
}

export interface ExistingOutsourcedDriverFeeAccrual {
  readonly id: string;
  readonly status: string;
}

/**
 * Read-only fee foundation lookups. Operational delivery accrual, backfill,
 * payment, and Driver Collection workflows are intentionally deferred.
 */
@Injectable()
export class OutsourcedDriverFeeFoundationRepository {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async effectiveRate(
    companyId: string,
    driverId: string,
    effectiveOn: string,
  ): Promise<EffectiveOutsourcedDriverFeeRate | undefined> {
    const result = await sql<EffectiveOutsourcedDriverFeeRate>`
      select id, fee_per_order::text as "feePerOrder"
        from outsourced_driver_fee_versions
       where company_id = ${companyId}::uuid and driver_id = ${driverId}::uuid
         and status = 'active' and effective_from <= ${effectiveOn}::date
         and coalesce(effective_to, 'infinity'::date) >= ${effectiveOn}::date
       order by effective_from desc
       limit 1
    `.execute(this.database);
    return result.rows[0];
  }

  public async existingAccrual(
    companyId: string,
    orderId: string,
  ): Promise<ExistingOutsourcedDriverFeeAccrual | undefined> {
    const result = await sql<ExistingOutsourcedDriverFeeAccrual>`
      select id, status from outsourced_driver_fee_accruals
       where company_id = ${companyId}::uuid and order_id = ${orderId}::uuid
       limit 1
    `.execute(this.database);
    return result.rows[0];
  }

  public async representedByLegacyCommission(
    companyId: string,
    orderId: string,
  ): Promise<boolean> {
    const result = await sql<{ represented: boolean }>`
      select exists(
        select 1
          from driver_commission_orders o
          join driver_commission_calculations c
            on c.id = o.calculation_id and c.company_id = o.company_id
         where o.company_id = ${companyId}::uuid and o.order_id = ${orderId}::uuid
           and (
             c.status in ('payable','paid','consumed')
             or o.allocation_kind = 'payment'
             or exists (
               select 1 from outsourced_driver_payments p
                where p.company_id = c.company_id
                  and p.commission_calculation_id = c.id
             )
             or exists (
               select 1 from payroll_commission_links l
                where l.company_id = c.company_id
                  and l.commission_calculation_id = c.id
             )
           )
      ) as represented
    `.execute(this.database);
    return result.rows[0]?.represented ?? false;
  }
}
