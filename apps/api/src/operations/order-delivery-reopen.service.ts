import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";

import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { DriverCashReconciliationService } from "./driver-cash-reconciliation.service.js";
import { OperationsService } from "./operations.service.js";

@Injectable()
export class OrderDeliveryReopenService {
  public constructor(
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(DriverCashReconciliationService)
    private readonly reconciliations: DriverCashReconciliationService,
    @Inject(OperationsService) private readonly operations: OperationsService,
  ) {}

  public async reopen(orderId: string, reason: string, correlationId: string) {
    const identity = this.identities.current();
    if (!identity.permissions.has("users_roles.manage")) {
      throw new ApplicationException(
        "order_reopen_admin_required",
        "Only an administrator can reopen a delivered Order",
        HttpStatus.FORBIDDEN,
      );
    }
    const trimmedReason = reason.trim();
    if (trimmedReason === "") {
      throw new ApplicationException(
        "order_reopen_reason_required",
        "A reason is required to reopen a delivered Order",
        HttpStatus.BAD_REQUEST,
      );
    }
    const { companyId } = this.tenants.current();
    return this.transactions.execute(async (transaction) => {
      const plan = (
        await sql<{
          deliveryStatus: string;
          reconciliationId: string | null;
          reconciliationOrderCount: number;
          traderSettlementStatus: string;
        }>`
        select o.delivery_status as "deliveryStatus",
               o.trader_settlement_status as "traderSettlementStatus",
               (select r.id from driver_reconciliation_orders ro
                 join driver_reconciliations r on r.id=ro.reconciliation_id and r.company_id=ro.company_id
                where ro.company_id=o.company_id and ro.order_id=o.id and r.status='confirmed'
                  and r.reversal_of_id is null
                  and not exists(select 1 from driver_reconciliations rr where rr.company_id=r.company_id and rr.reversal_of_id=r.id)
                order by r.confirmed_at desc limit 1) as "reconciliationId",
               coalesce((
                 select count(*)::int
                   from driver_reconciliation_orders all_ro
                  where all_ro.company_id=o.company_id
                    and all_ro.reconciliation_id=(
                      select r.id from driver_reconciliation_orders ro
                      join driver_reconciliations r
                        on r.id=ro.reconciliation_id and r.company_id=ro.company_id
                      where ro.company_id=o.company_id and ro.order_id=o.id
                        and r.status='confirmed' and r.reversal_of_id is null
                        and not exists(
                          select 1 from driver_reconciliations rr
                           where rr.company_id=r.company_id and rr.reversal_of_id=r.id
                        )
                      order by r.confirmed_at desc limit 1
                    )
               ),0) as "reconciliationOrderCount"
          from orders o where o.id=${orderId}::uuid and o.company_id=${companyId}::uuid
          for update of o
      `.execute(transaction)
      ).rows[0];
      if (plan === undefined) {
        throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
      }
      if (plan.deliveryStatus !== "delivered") {
        throw new ApplicationException(
          "order_reopen_requires_delivered",
          "Only a Delivered Order can be reopened",
          HttpStatus.CONFLICT,
        );
      }
      if (!["unsettled", "not_eligible", "reversed"].includes(plan.traderSettlementStatus)) {
        throw new ApplicationException(
          "order_reopen_blocked_by_trader_payment",
          "Reverse the Trader settlement before reopening this Order",
          HttpStatus.CONFLICT,
        );
      }
      if (plan.reconciliationOrderCount > 1) {
        throw new ApplicationException(
          "order_reopen_blocked_by_shared_driver_collection",
          "The Driver collection also contains other Orders. Reverse that collection separately before reopening this Order.",
          HttpStatus.CONFLICT,
        );
      }
      if (plan.reconciliationId !== null) {
        await this.reconciliations.reverse(
          plan.reconciliationId,
          trimmedReason,
          correlationId,
          `reopen-order:${orderId}:collection`,
          transaction,
        );
      }
      // Reopening never changes outsourced-driver fee payments/accruals or
      // payroll. Only an active Driver collection is reversed here; a Trader
      // settlement must already be reversed before reaching this point.
      return this.operations.reopenDeliveredOrder(
        orderId,
        trimmedReason,
        correlationId,
        transaction,
      );
    });
  }
}
