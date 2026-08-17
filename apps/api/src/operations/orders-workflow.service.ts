import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { PushOutboxWriter } from "../push/push-outbox-writer.service.js";
import { OutsourcedDriverFeeService } from "../payroll/outsourced-driver-fee.service.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import type {
  BulkAssignDriverDto,
  BulkChangeOrderStatusDto,
  OrderSelectionDto,
  ReactivateHoldOrdersDto,
} from "./operations.dto.js";

interface SelectedOrder {
  readonly assignedDriverId: string | null;
  readonly deliveryStatus: string;
  readonly driverCost: string;
  readonly driverReconciliationStatus: string;
  readonly id: string;
  readonly isFreeOrder: boolean;
  readonly orderNumber: string;
  readonly orderType: "collect_order" | "delivery";
  readonly returnStatus: string;
  readonly settlementStatus: string;
  readonly amountCollected: string;
  readonly customerAmountDue: string;
  readonly traderNetPayable: string;
}

export interface BulkActionPreview {
  readonly eligibleCount: number;
  readonly ineligible: readonly { readonly orderNumber: string; readonly reason: string }[];
  readonly selectedCount: number;
  readonly selectedAmountToCollect: string;
}

export interface BulkActionResult extends BulkActionPreview {
  readonly bulkActionId: string;
  readonly processedCount: number;
}

@Injectable()
export class OrdersWorkflowService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
    @Inject(OutsourcedDriverFeeService)
    private readonly outsourcedDriverFees: OutsourcedDriverFeeService,
    @Inject(PushOutboxWriter) private readonly pushOutbox: PushOutboxWriter,
  ) {}

  public async reactivateHoldOrders(input: ReactivateHoldOrdersDto, correlationId: string) {
    this.assertAnyPermission("orders.update_delivery_status");
    if (input.orders.length === 0)
      throw new ApplicationException(
        "hold_reactivation_empty",
        "Select at least one Hold Order",
        HttpStatus.BAD_REQUEST,
      );
    const { companyId } = this.tenants.current();
    const actor = this.identities.current();
    const normalized = input.orders.map((row) => ({
      ...row,
      normalized: row.newSerialNumber
        .normalize("NFKC")
        .trim()
        .replace(/\s+/gu, " ")
        .toLocaleLowerCase("en-US"),
    }));
    const batchKeys = new Set(normalized.map((row) => `${row.newSerialDate}:${row.normalized}`));
    if (batchKeys.size !== normalized.length)
      throw new ApplicationException(
        "hold_reactivation_duplicate_serial",
        "Serial Numbers must be unique inside the batch",
        HttpStatus.CONFLICT,
      );
    return this.transactions.execute(async (transaction) => {
      const ids = normalized.map((row) => row.orderId);
      const current = await sql<{
        assignedDriverId: string | null;
        id: string;
        orderDate: string;
        orderNumber: string;
        serialNumber: string | null;
        status: string;
      }>`
        select id,order_number "orderNumber",serial_number "serialNumber",order_date::text "orderDate",
          delivery_status status,assigned_driver_id "assignedDriverId" from orders
        where company_id=${companyId}::uuid and id in (${sql.join(ids.map((id) => sql`${id}::uuid`))}) order by id for update`.execute(
        transaction,
      );
      if (current.rows.length !== ids.length || current.rows.some((row) => row.status !== "hold"))
        throw new ApplicationException(
          "hold_reactivation_requires_hold",
          "Every selected Order must still be on Hold",
          HttpStatus.CONFLICT,
        );
      const conflicts = await sql<{
        id: string;
      }>`select o.id from orders o where o.company_id=${companyId}::uuid
        and o.id not in (${sql.join(ids.map((id) => sql`${id}::uuid`))}) and exists(select 1 from jsonb_to_recordset(${JSON.stringify(normalized)}::jsonb)
          as x("newSerialDate" date,normalized text) where x."newSerialDate"=o.order_date and x.normalized=o.serial_number_normalized) limit 1`.execute(
        transaction,
      );
      if (conflicts.rows[0])
        throw new ApplicationException(
          "hold_reactivation_serial_exists",
          "A Serial Number already exists for its selected date",
          HttpStatus.CONFLICT,
        );
      const actorRole = await this.history.actorRole(transaction, companyId, actor.identityId);
      await sql`select set_config('blueline.hold_reactivation','on',true)`.execute(transaction);
      for (const next of normalized) {
        const old = current.rows.find((row) => row.id === next.orderId)!;
        if (next.newStatus !== "in_branch" && old.assignedDriverId === null)
          throw new ApplicationException(
            "hold_reactivation_driver_required",
            `Order ${old.orderNumber} requires a Driver for the selected status`,
            HttpStatus.CONFLICT,
          );
        await sql`insert into order_serial_history(company_id,order_id,old_serial_number,old_serial_date,new_serial_number,new_serial_date,old_status,new_status,reason,changed_by_account_id)
          values(${companyId}::uuid,${old.id}::uuid,${old.serialNumber},${old.orderDate}::date,${next.newSerialNumber},${next.newSerialDate}::date,'hold',${next.newStatus},'Hold Reactivation',${actor.identityId}::uuid)`.execute(
          transaction,
        );
        await sql`update orders set serial_number=${next.newSerialNumber},serial_number_normalized=${next.normalized},order_date=${next.newSerialDate}::date,
          delivery_status=${next.newStatus},delivery_reason=null,updated_at=now(),version=version+1 where id=${old.id}::uuid and company_id=${companyId}::uuid`.execute(
          transaction,
        );
        await this.history.statusHistory(transaction, {
          actorId: actor.identityId,
          companyId,
          from: "hold",
          orderId: old.id,
          reason: "Hold Reactivation",
          to: next.newStatus,
        });
        await this.history.orderEvent(transaction, {
          actorId: actor.identityId,
          actorRole,
          category: "status_change",
          companyId,
          correlationId,
          eventType: "order.hold_reactivated",
          fieldName: "serial_number",
          newValue: `${next.newSerialNumber} / ${next.newSerialDate}`,
          orderId: old.id,
          previousValue: `${old.serialNumber ?? "—"} / ${old.orderDate}`,
          reason: "Hold Reactivation",
          source: "web_portal",
        });
      }
      return { processedCount: normalized.length };
    });
  }

  public async assignmentPreview(input: BulkAssignDriverDto): Promise<BulkActionPreview> {
    this.assertAnyPermission("orders.assign_driver");
    const { companyId } = this.tenants.current();
    const driver = await this.activeDriver(this.database, companyId, input.driverIdToAssign);
    const orders = await this.resolveSelection(this.database, companyId, input, false);
    return this.assignmentAssessment(orders, driver.id);
  }

  public async selectionSummary(input: OrderSelectionDto): Promise<BulkActionPreview> {
    const { companyId } = this.tenants.current();
    const orders = await this.resolveSelection(this.database, companyId, input, false);
    return {
      eligibleCount: orders.length,
      ineligible: [],
      selectedAmountToCollect: orders
        .reduce((total, order) => total.plus(order.customerAmountDue), new Decimal(0))
        .toFixed(2),
      selectedCount: orders.length,
    };
  }

  public async bulkAssignDriver(
    input: BulkAssignDriverDto,
    correlationId: string,
  ): Promise<BulkActionResult> {
    this.assertAnyPermission("orders.assign_driver");
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const bulkActionId = randomUUID();
    return this.transactions.execute(async (transaction) => {
      const driver = await this.activeDriver(transaction, companyId, input.driverIdToAssign);
      const orders = await this.resolveSelection(transaction, companyId, input, true);
      const assessment = this.assignmentAssessment(orders, driver.id);
      const actorRole = await this.history.actorRole(transaction, companyId, identity.identityId);
      let processedCount = 0;
      for (const order of orders) {
        const isReassignment = order.assignedDriverId !== null;
        if (this.assignmentIneligibilityReason(order, driver.id) !== null) continue;
        // A fresh assignment moves New/In-Branch into Assigned (Hold stays
        // Hold); a reassignment only changes the Driver — the Order's own
        // delivery status is untouched, matching how the single-order status
        // machine treats driver changes as orthogonal to status changes.
        const nextStatus =
          isReassignment || order.deliveryStatus === "hold"
            ? order.deliveryStatus
            : order.orderType === "collect_order" || order.deliveryStatus === "collect_order"
              ? "collect_order"
              : "assigned_to_driver";
        await sql`
          update orders
             set assigned_driver_id = ${driver.id}::uuid,
                 delivery_status = ${nextStatus},
                 updated_at = now(), version = version + 1
           where id = ${order.id}::uuid and company_id = ${companyId}::uuid
        `.execute(transaction);
        if (isReassignment) {
          // Only one active (unassigned_at is null) assignment row may exist
          // per Order (`order_assignments_active_unique`) — close the
          // previous one out before the new active row is inserted below.
          await sql`
            update order_assignments
               set unassigned_at = now(), reason = 'Reassigned to a different Driver'
             where company_id = ${companyId}::uuid and order_id = ${order.id}::uuid
               and unassigned_at is null
          `.execute(transaction);
        }
        await sql`
          insert into order_assignments (
            company_id, order_id, driver_id, assigned_by_account_id
          ) values (
            ${companyId}::uuid, ${order.id}::uuid, ${driver.id}::uuid,
            ${identity.identityId}::uuid
          )
        `.execute(transaction);
        if (nextStatus !== order.deliveryStatus) {
          await this.history.statusHistory(transaction, {
            actorId: identity.identityId,
            companyId,
            from: order.deliveryStatus,
            orderId: order.id,
            to: nextStatus,
          });
        }
        await this.history.orderEvent(transaction, {
          actorId: identity.identityId,
          actorRole,
          bulkActionId,
          category: "driver_assignment",
          companyId,
          correlationId,
          eventType: isReassignment ? "order.driver_reassigned" : "order.driver_assigned",
          fieldName: "assigned_driver_id",
          newValue: { driverId: driver.id, driverName: driver.name },
          orderId: order.id,
          previousValue: isReassignment ? { driverId: order.assignedDriverId } : null,
          relatedDriverId: driver.id,
          source: "web_portal",
        });
        await this.pushOutbox.writeOrderAssigned(transaction, {
          companyId,
          orderId: order.id,
          driverAccountId: driver.accountId,
          isReassignment,
          correlationId,
        });
        processedCount += 1;
      }
      await this.history.audit(transaction, {
        action: "orders.bulk_assign_driver",
        actorId: identity.identityId,
        after: { bulkActionId, driverId: driver.id, processedCount },
        companyId,
        correlationId,
        subjectId: bulkActionId,
        subjectType: "bulk_order_action",
      });
      return { ...assessment, bulkActionId, processedCount };
    });
  }

  public async bulkChangeStatus(
    input: BulkChangeOrderStatusDto,
    correlationId: string,
  ): Promise<BulkActionResult> {
    this.assertAnyPermission("orders.update_delivery_status");
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const reason = input.reason?.trim() || null;
    if (
      ["hold", "cancelled", "returned_to_branch", "returned_to_trader"].includes(
        input.targetStatus,
      ) &&
      reason === null
    ) {
      throw new ApplicationException(
        input.targetStatus === "hold"
          ? "hold_reason_required"
          : input.targetStatus === "cancelled"
            ? "cancellation_reason_required"
            : "return_reason_required",
        input.targetStatus === "hold"
          ? "A Hold reason is required."
          : input.targetStatus === "cancelled"
            ? "A cancellation reason is required"
            : "A return reason is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    const bulkActionId = randomUUID();
    return this.transactions.execute(async (transaction) => {
      const orders = await this.resolveSelection(transaction, companyId, input, true);
      const ineligible = orders
        .map((order) => ({ order, reason: this.statusIneligibility(order, input.targetStatus) }))
        .filter((item): item is { order: SelectedOrder; reason: string } => item.reason !== null);
      if (ineligible.length > 0 && input.allowPartial !== true) {
        throw new ApplicationException(
          "bulk_status_ineligible",
          "One or more selected Orders cannot move to the requested status",
          HttpStatus.CONFLICT,
          ineligible.map((item) => `${item.order.orderNumber}: ${item.reason}`),
        );
      }
      const actorRole = await this.history.actorRole(transaction, companyId, identity.identityId);
      let processedCount = 0;
      for (const order of orders) {
        if (this.statusIneligibility(order, input.targetStatus) !== null) continue;
        await this.applyOperationsStatus(transaction, {
          actorId: identity.identityId,
          actorRole,
          bulkActionId,
          companyId,
          correlationId,
          order,
          reason,
          targetStatus: input.targetStatus,
        });
        processedCount += 1;
      }
      const selectedAmount = orders.reduce(
        (total, order) => total.plus(order.customerAmountDue),
        new Decimal(0),
      );
      const skipped = ineligible.map((item) => ({
        orderNumber: item.order.orderNumber,
        reason: item.reason,
      }));
      await this.history.audit(transaction, {
        action: "orders.bulk_status_change",
        actorId: identity.identityId,
        after: { bulkActionId, processedCount, targetStatus: input.targetStatus },
        companyId,
        correlationId,
        subjectId: bulkActionId,
        subjectType: "bulk_order_action",
      });
      return {
        bulkActionId,
        eligibleCount: orders.length - skipped.length,
        ineligible: skipped,
        processedCount,
        selectedAmountToCollect: selectedAmount.toFixed(2),
        selectedCount: orders.length,
      };
    });
  }

  /**
   * A fresh assignment (no Driver yet) is eligible while New/In-Branch/Hold.
   * A reassignment (already has a Driver) is eligible only while
   * Assigned-to-Driver or Hold — matching `enforce_initial_order_assignment`,
   * which only permits a new active `order_assignments` row while the Order
   * is in one of those two states. Once Out for Delivery or later, the
   * Driver is locked in and can only change through a status transition.
   */
  private assignmentIneligibilityReason(
    order: SelectedOrder,
    targetDriverId: string,
  ): string | null {
    if (order.assignedDriverId === targetDriverId) {
      return "Driver is already assigned to this Order";
    }
    if (order.assignedDriverId === null) {
      return ["new", "in_branch", "hold", "collect_order"].includes(order.deliveryStatus)
        ? null
        : "Only New, In-Branch, Hold, or Collect Orders are eligible for assignment";
    }
    return ["assigned_to_driver", "hold"].includes(order.deliveryStatus)
      ? null
      : "Only Assigned-to-Driver or Hold Orders are eligible for reassignment";
  }

  private assignmentAssessment(
    orders: readonly SelectedOrder[],
    targetDriverId: string,
  ): BulkActionPreview {
    const ineligible = orders
      .map((order) => ({
        order,
        reason: this.assignmentIneligibilityReason(order, targetDriverId),
      }))
      .filter((entry): entry is { order: SelectedOrder; reason: string } => entry.reason !== null)
      .map(({ order, reason }) => ({ orderNumber: order.orderNumber, reason }));
    return {
      eligibleCount: orders.length - ineligible.length,
      ineligible,
      selectedAmountToCollect: orders
        .reduce((total, order) => total.plus(order.customerAmountDue), new Decimal(0))
        .toFixed(2),
      selectedCount: orders.length,
    };
  }

  private statusIneligibility(order: SelectedOrder, target: string): string | null {
    // Each transition is allowed only from the states the single-order workflow
    // permits, so a bulk change is exactly a batch of the per-row transitions.
    const from: Readonly<Record<string, readonly string[]>> = {
      cancelled: ["new", "in_branch", "assigned_to_driver", "out_for_delivery", "hold"],
      delivered: ["out_for_delivery", "hold"],
      hold: ["new", "assigned_to_driver", "out_for_delivery"],
      in_branch: ["new"],
      out_for_delivery: ["assigned_to_driver", "hold"],
      returned_to_branch: ["out_for_delivery"],
      returned_to_trader: ["returned_to_branch", "hold"],
    };
    if (target in from) {
      if (from[target]?.includes(order.deliveryStatus) !== true) {
        return `Order is ${order.deliveryStatus} and cannot move to ${target}`;
      }
      if (target === "delivered" && order.assignedDriverId === null) {
        return "A Driver must be assigned before this Order can be delivered.";
      }
      if (target === "out_for_delivery" && order.assignedDriverId === null) {
        return "A Driver must be assigned before this Order can be moved Out for Delivery.";
      }
      return null;
    }
    if (target === "closed") {
      if (!["delivered", "returned_to_trader", "collect_order"].includes(order.deliveryStatus)) {
        return "Only Delivered, Returned to Trader, or Collect Orders can be closed";
      }
      if (!["reconciled", "not_applicable"].includes(order.driverReconciliationStatus)) {
        return "Driver Cash is not complete";
      }
      if (
        !["money_sent_to_trader", "money_received_by_trader", "not_eligible"].includes(
          order.settlementStatus,
        )
      ) {
        return "Trader Settlement is not complete";
      }
      if (
        order.deliveryStatus === "returned_to_trader" &&
        order.returnStatus !== "returned_to_trader"
      ) {
        return "The physical return is not complete";
      }
      return null;
    }
    return "Unsupported status";
  }

  private async applyOperationsStatus(
    database: Kysely<DatabaseSchema>,
    input: {
      readonly actorId: string;
      readonly actorRole: string;
      readonly bulkActionId: string;
      readonly companyId: string;
      readonly correlationId: string;
      readonly order: SelectedOrder;
      readonly reason: string | null;
      readonly targetStatus: string;
    },
  ): Promise<void> {
    // Same side effects as the single-order workflow, so a bulk change to a status
    // leaves each order exactly as a per-row change would.
    const status = input.targetStatus;
    const order = input.order;
    const amountDue = Number(order.customerAmountDue);
    const traderPayable = Number(order.traderNetPayable);
    const deliveredFreeNoValue =
      status === "delivered" &&
      order.isFreeOrder === true &&
      amountDue === 0 &&
      traderPayable === 0;
    const reconciliationStatus =
      status === "hold"
        ? order.driverReconciliationStatus
        : status === "delivered" &&
            order.assignedDriverId !== null &&
            amountDue > 0 &&
            !deliveredFreeNoValue
          ? "pending"
          : status === "closed"
            ? order.driverReconciliationStatus
            : "not_applicable";
    const returnStatus =
      status === "hold"
        ? order.returnStatus
        : status === "returned_to_branch" || status === "returned_to_trader"
          ? status
          : status === "closed"
            ? order.returnStatus
            : "not_applicable";
    const settlementStatus =
      status === "hold"
        ? order.settlementStatus
        : status === "cancelled" ||
            status === "returned_to_branch" ||
            status === "returned_to_trader"
          ? "not_eligible"
          : deliveredFreeNoValue
            ? "not_eligible"
            : status === "closed" || status === "in_branch"
              ? order.settlementStatus
              : "unsettled";
    await sql`
      update orders
         set delivery_status = ${status}, delivery_reason = ${input.reason},
             driver_reconciliation_status = ${reconciliationStatus},
             trader_settlement_status = ${settlementStatus},
             return_status = ${returnStatus},
             amount_collected = case when ${status} in ('closed', 'hold') then amount_collected
               when ${status} = 'delivered' then ${amountDue.toFixed(2)}::numeric else 0 end,
             delivered_at = case when ${status} = 'delivered' then now() else delivered_at end,
             operational_completed_at = case
               when ${status} in ('delivered', 'returned_to_trader', 'cancelled')
               then coalesce(operational_completed_at, now()) else operational_completed_at end,
             closed_at = case when ${status} = 'closed' then now() else null end,
             updated_at = now(), version = version + 1
       where id = ${order.id}::uuid and company_id = ${input.companyId}::uuid
    `.execute(database);
    await this.history.statusHistory(database, {
      actorId: input.actorId,
      companyId: input.companyId,
      from: input.order.deliveryStatus,
      orderId: input.order.id,
      reason: input.reason,
      to: input.targetStatus,
    });
    await this.history.orderEvent(database, {
      actorId: input.actorId,
      actorRole: input.actorRole,
      bulkActionId: input.bulkActionId,
      category: "status_change",
      companyId: input.companyId,
      correlationId: input.correlationId,
      eventType: `order.${input.targetStatus}`,
      fieldName: "delivery_status",
      newValue: input.targetStatus,
      orderId: input.order.id,
      previousValue: input.order.deliveryStatus,
      reason: input.reason,
      source: "web_portal",
    });
    if (status === "delivered") {
      await this.outsourcedDriverFees.createForDeliveredOrder(
        database,
        order.id,
        input.actorId,
        input.correlationId,
      );
    }
  }

  private async resolveSelection(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    input: OrderSelectionDto,
    lock: boolean,
  ): Promise<readonly SelectedOrder[]> {
    const excluded = new Set(input.excludedOrderIds ?? []);
    if (input.selectionMode === "ids") {
      const ids = (input.orderIds ?? []).filter((id) => !excluded.has(id));
      if (ids.length === 0) return [];
      const result = await sql<SelectedOrder>`
        select id, order_number as "orderNumber", assigned_driver_id as "assignedDriverId",
               order_type as "orderType",
               delivery_status as "deliveryStatus", return_status as "returnStatus",
               driver_reconciliation_status as "driverReconciliationStatus",
               trader_settlement_status as "settlementStatus",
               is_free_order as "isFreeOrder",
               amount_collected::text as "amountCollected",
               customer_amount_due::text as "customerAmountDue",
               trader_net_payable::text as "traderNetPayable",
               driver_cost::text as "driverCost"
        from orders
        where company_id = ${companyId}::uuid
          and id in (${sql.join(ids.map((id) => sql`${id}::uuid`))})
        order by id
        ${sql.raw(lock ? "for update" : "")}
      `.execute(database);
      return result.rows;
    }
    const search = input.search?.trim() || null;
    const quickView = input.quickView ?? "active";
    const result = await sql<SelectedOrder>`
      select o.id, o.order_number as "orderNumber", o.assigned_driver_id as "assignedDriverId",
             o.order_type as "orderType",
             o.delivery_status as "deliveryStatus", o.return_status as "returnStatus",
             o.driver_reconciliation_status as "driverReconciliationStatus",
             o.trader_settlement_status as "settlementStatus",
             o.is_free_order as "isFreeOrder",
             o.amount_collected::text as "amountCollected",
             o.customer_amount_due::text as "customerAmountDue",
             o.trader_net_payable::text as "traderNetPayable",
             o.driver_cost::text as "driverCost"
      from orders o
      join traders t on t.id = o.trader_id and t.company_id = o.company_id
      where o.company_id = ${companyId}::uuid
        and (${quickView} = 'all'
          or (${quickView} = 'active' and o.delivery_status in ('new','in_branch','assigned_to_driver','out_for_delivery','hold','delivered','returned_to_branch','returned_to_trader','collect_order'))
          or (${quickView} = 'closed' and o.delivery_status = 'closed')
          or (${quickView} = 'hold' and o.delivery_status = 'hold')
          or (${quickView} = 'cancelled' and o.delivery_status = 'cancelled'))
        and (${search}::text is null or o.order_number ilike '%' || ${search} || '%'
          or o.customer_name ilike '%' || ${search} || '%'
          or o.customer_mobile_number ilike '%' || ${search} || '%'
          or t.name_en ilike '%' || ${search} || '%')
        and (${input.deliveryStatus ?? null}::text is null or o.delivery_status = ${input.deliveryStatus ?? null})
        and (${input.orderType ?? null}::text is null or o.order_type=${input.orderType ?? null})
        and (${input.cashStatus ?? null}::text is null or o.driver_reconciliation_status = ${input.cashStatus ?? null})
        and (${input.settlementStatus ?? null}::text is null or o.trader_settlement_status = ${input.settlementStatus ?? null})
        and (${input.traderId ?? null}::uuid is null or o.trader_id = ${input.traderId ?? null}::uuid)
        and (${input.driverId ?? null}::uuid is null or o.assigned_driver_id = ${input.driverId ?? null}::uuid)
        and (${input.areaId ?? null}::uuid is null or o.area_id = ${input.areaId ?? null}::uuid)
        and (${input.dateFrom ?? null}::date is null or o.order_date >= ${input.dateFrom ?? null}::date)
        and (${input.dateTo ?? null}::date is null or o.order_date <= ${input.dateTo ?? null}::date)
        and (${input.excludedOrderIds?.length ?? 0} = 0 or o.id not in (
          ${sql.join(
            (input.excludedOrderIds?.length ?? 0) > 0
              ? (input.excludedOrderIds ?? []).map((id) => sql`${id}::uuid`)
              : [sql`null::uuid`],
          )}
        ))
      order by o.id
      ${sql.raw(lock ? "for update of o" : "")}
    `.execute(database);
    return result.rows;
  }

  private async activeDriver(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    driverId: string,
  ): Promise<{ readonly id: string; readonly name: string; readonly accountId: string | null }> {
    const result = await sql<{ id: string; name: string; accountId: string | null }>`
      select id, name_en as name, account_id as "accountId" from drivers
      where id = ${driverId}::uuid and company_id = ${companyId}::uuid
        and account_status = 'active'
    `.execute(database);
    const driver = result.rows[0];
    if (driver === undefined) {
      throw new ApplicationException(
        "driver_not_found",
        "The selected Driver is not active in this Company",
        HttpStatus.BAD_REQUEST,
      );
    }
    return driver;
  }

  private assertAnyPermission(permission: string): void {
    const permissions = this.identities.current().permissions;
    if (!permissions.has("users_roles.manage") && !permissions.has(permission)) {
      throw new ApplicationException(
        "permission_denied",
        "The authenticated account does not have permission for this operation",
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
