import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import { OperationsService } from "../operations/operations.service.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";

/** Same abandoned-reservation timeout as C3's Store Order idempotency --
 * reuses that exact table (`store_order_idempotency_keys`), scoped under a
 * distinct `scope_key` so the two concerns (Place Order dedup, conversion
 * dedup) never collide even though they share the mechanism. */
const PENDING_RESERVATION_TIMEOUT_SECONDS = 30;
const CONVERSION_SCOPE_KEY = "c4-convert-to-delivery";

export interface ConvertedStoreOrder {
  readonly deliveryOrderId: string;
  readonly deliveryOrderNumber: string;
  readonly deliveryStatus: string;
  readonly replay: boolean;
  readonly storeOrderId: string;
  readonly storeOrderNumber: string;
  readonly storeOrderStatus: string;
}

/**
 * Customer Commerce Prompt C4 -- converts one `confirmed`, Company-assigned
 * Store Order into exactly one normal Tawseelhub Delivery Order.
 *
 * ---------------------------------------------------------------------------
 * REUSE, NOT A SECOND ENGINE
 * ---------------------------------------------------------------------------
 *
 * The actual Order row is created by calling `OperationsService.createOrder`
 * -- the SAME method every manually-created Trader Portal Order goes
 * through -- inside a manually-constructed `RequestSecurityContext` (tenant
 * = the frozen Delivery Company, identity = that Company's own linked
 * Trader account for the frozen relationship). This is the exact
 * "cross-Company write bridge" `createTraderPortalOrder` already uses
 * (`operations.service.ts`, `resolveTraderPortalDeliveryCompany` /
 * `actingAccountIdOverride`) — reused here rather than duplicated, just
 * driven by a frozen Store Order relationship instead of a live Trader
 * session.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CANNOT BE ONE ACID TRANSACTION, AND WHAT REPLACES IT
 * ---------------------------------------------------------------------------
 *
 * `createOrder` opens and commits its own transaction (same reason C3's
 * `StoreOrderSubmissionService` could not wrap `createStoreOrder` in a
 * second one -- Kysely does not support nested transactions). So this
 * service cannot literally roll back an already-committed Delivery Order if
 * the SUBSEQUENT `store_orders.delivery_order_id` link-update fails.
 * Instead: (1) a reservation row (reusing C3's `store_order_idempotency_keys`
 * table, a DIFFERENT scope) is claimed BEFORE `createOrder` runs, so no
 * second concurrent request can even attempt a second Delivery Order for the
 * same Store Order; (2) `createOrder` itself is called with a deterministic
 * idempotency key derived from the Store Order number, so if this service
 * crashes after `createOrder` commits but before the link-update runs, a
 * RETRY re-enters `createOrder` with the same key and gets back the SAME
 * Order (its own `idempotency_records` table guarantees this) rather than a
 * second one -- the retry then completes the link. The net guarantee is:
 * at most one Delivery Order ever exists per Store Order, and a crash
 * mid-flight is self-healing on retry, even though it is not a single SQL
 * transaction end to end.
 */
@Injectable()
export class StoreOrderConversionService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(OperationsService) private readonly operations: OperationsService,
    @Inject(RequestSecurityContextStore)
    private readonly securityContext: RequestSecurityContextStore,
  ) {}

  public async convertToDeliveryOrder(
    storeOrderNumber: string,
    correlationId: string,
  ): Promise<ConvertedStoreOrder> {
    const storeOrder = await this.loadStoreOrder(storeOrderNumber);

    // §12/§39: an already-converted Store Order is a safe, idempotent
    // success -- read straight back, no reservation needed at all.
    if (storeOrder.deliveryOrderId !== null) {
      const linked = await this.loadLinkedDeliveryOrder(storeOrder.deliveryOrderId);
      return {
        deliveryOrderId: storeOrder.deliveryOrderId,
        deliveryOrderNumber: linked.orderNumber,
        deliveryStatus: linked.deliveryStatus,
        replay: true,
        storeOrderId: storeOrder.id,
        storeOrderNumber: storeOrder.storeOrderNumber,
        storeOrderStatus: storeOrder.status,
      };
    }

    // §11/§69: zero-Company Store Orders are C5's concern, never converted here.
    if (
      storeOrder.deliveryCompanyId === null ||
      storeOrder.deliveryCompanyRelationshipId === null
    ) {
      throw new ApplicationException(
        "store_order_not_ready_for_delivery_conversion",
        "This order has no Delivery Company assigned yet and cannot be converted.",
        HttpStatus.CONFLICT,
      );
    }
    // §10/§12: only `confirmed` converts -- cancelled/awaiting/anything else
    // is a normal, expected rejection, never a crash.
    if (storeOrder.status !== "confirmed") {
      throw new ApplicationException(
        "store_order_not_ready_for_delivery_conversion",
        `This order cannot be converted from its current status (${storeOrder.status}).`,
        HttpStatus.CONFLICT,
      );
    }

    const reservation = await this.reserve(storeOrder.id);
    if (reservation.kind === "replay") {
      // The reservation completed between our initial read above and now
      // (a genuine concurrent race) -- re-read the now-current link rather
      // than trusting the stale snapshot.
      return this.convertToDeliveryOrder(storeOrderNumber, correlationId);
    }

    try {
      // §8/§9: the ONLY source of Company/Trader ownership -- resolved from
      // the Store Order's own FROZEN relationship id, never from a current
      // default, never by name.
      const relationship = await sql<{
        accountId: string;
        companyId: string;
        traderId: string | null;
      }>`
        select r.company_id as "companyId", r.trader_id as "traderId", t.account_id as "accountId"
          from trader_delivery_company_relationships r
          left join traders t on t.id = r.trader_id and t.company_id = r.company_id
         where r.id = ${storeOrder.deliveryCompanyRelationshipId}::uuid
      `.execute(this.database);
      const relationshipRow = relationship.rows[0];
      if (
        relationshipRow === undefined ||
        relationshipRow.companyId !== storeOrder.deliveryCompanyId
      ) {
        // The frozen relationship no longer resolves, or points at a
        // different Company than the frozen `delivery_company_id` -- an
        // invariant the domain itself should never allow to break. Never
        // guessed around; reported centrally as unexpected (§9/§59).
        throw new Error(
          `Store Order ${storeOrder.storeOrderNumber} relationship invariant broken: ` +
            `relationship ${storeOrder.deliveryCompanyRelationshipId} does not resolve to Company ${storeOrder.deliveryCompanyId}`,
        );
      }
      if (relationshipRow.traderId === null || relationshipRow.accountId === null) {
        throw new Error(
          `Store Order ${storeOrder.storeOrderNumber}'s frozen relationship has no Company-scoped Trader mapping`,
        );
      }
      const target = {
        accountId: relationshipRow.accountId,
        companyId: relationshipRow.companyId,
        traderId: relationshipRow.traderId,
      };

      // §23/§24: resolve the frozen destination text against THIS Company's
      // OWN current Area configuration -- never another Company's Area id,
      // never guessed if it no longer resolves.
      const areaId = await this.resolveArea(
        target.companyId,
        storeOrder.deliveryEmirate,
        storeOrder.deliveryArea,
      );
      if (areaId === null) {
        throw new ApplicationException(
          "store_order_delivery_area_unavailable",
          "The delivery destination for this order is no longer configured for the assigned Delivery Company.",
          HttpStatus.CONFLICT,
        );
      }

      // §7/§20/§21/§22: every Order field below comes from the Store
      // Order's own FROZEN snapshot -- never a live Customer profile, never
      // a live saved address.
      const identity = {
        companyId: null,
        forcePasswordChange: false,
        identityId: target.accountId,
        // §65/§66: this identity's ONLY purpose is to satisfy `createOrder`'s
        // actor/permission checks for a system-initiated conversion -- it is
        // never derived from, or influenced by, the HTTP caller's own
        // identity. `orders.override_service_fee` is granted here (and ONLY
        // here) so the frozen Company fee can be written as-is even when it
        // no longer matches the Company's live configured price (§25/§26) --
        // exactly the same override mechanism a real Company user would use,
        // with the override reason making the provenance explicit.
        kind: "trader" as const,
        permissions: new Set(["orders.override_service_fee"]),
        sessionId: randomUUID(),
      };
      const tenant = { companyId: target.companyId, identityId: target.accountId };

      const created = await this.securityContext.run({ identity, tenant }, async () => {
        const serialEnabled =
          (
            await sql<{ enabled: boolean }>`select shipment_serial_enabled_at is not null enabled
          from companies where id=${target.companyId}::uuid`.execute(this.database)
          ).rows[0]?.enabled === true;
        const legacySerial = serialEnabled ? {} : await this.operations.nextSerialNumber();
        return this.operations.createOrder(
          {
            areaId,
            codAmount: Number(storeOrder.codTotal),
            customerAddress: storeOrder.deliveryAddress,
            ...(storeOrder.deliveryInstructions === null
              ? {}
              : { customerDeliveryNotes: storeOrder.deliveryInstructions }),
            ...(storeOrder.deliveryLocationLink === null
              ? {}
              : { customerLocationLink: storeOrder.deliveryLocationLink }),
            customerMobileNumber: storeOrder.customerMobile,
            customerName: storeOrder.customerName,
            packageCount: 1, // §35: conservative default -- Store Order carries Product quantities, not shipment/package counts.
            referenceNumber: storeOrder.storeOrderNumber, // §17: the Store Order number, preserved as the Trader-facing external reference.
            ...legacySerial,
            // §25-27: the Company's own FROZEN service fee, never re-priced.
            serviceFee: Number(storeOrder.deliveryCompanyServiceFee),
            serviceFeeOverrideReason:
              "Customer Commerce Store Order conversion: fee frozen at Store Order creation.",
            traderId: target.traderId,
          },
          correlationId,
          `c4-convert-${storeOrder.storeOrderNumber}`,
          target.accountId,
        );
      });

      const linkResult = await sql<{ id: string }>`
        update store_orders
           set delivery_order_id = ${created.id}::uuid, status = 'converted_to_delivery',
               updated_at = now(), version = version + 1
         where id = ${storeOrder.id}::uuid and delivery_order_id is null
        returning id
      `.execute(this.database);
      if (linkResult.rows[0] === undefined) {
        // Unreachable under normal operation -- the reservation above is
        // the only path into this branch, and it is exclusive per Store
        // Order. If this ever fires, `created` (a real, valid, correctly
        // priced Delivery Order) exists without its link -- exactly the
        // "orphan" scenario the reservation exists to prevent, so this is
        // deliberately a genuine thrown Error (reaches the Platform Error
        // Handler as unexpected), not a swallowed business outcome. A retry
        // of THIS SAME conversion call is self-healing: `createOrder`'s own
        // idempotency key returns the same `created.id` again, and the
        // link-update is attempted again.
        throw new Error(
          `Store Order ${storeOrder.storeOrderNumber} link-update matched no row after Delivery Order ${created.orderNumber} was created`,
        );
      }

      await this.finalize(reservation.id);
      return {
        deliveryOrderId: created.id,
        deliveryOrderNumber: created.orderNumber,
        deliveryStatus: created.deliveryStatus,
        replay: false,
        storeOrderId: storeOrder.id,
        storeOrderNumber: storeOrder.storeOrderNumber,
        storeOrderStatus: "converted_to_delivery",
      };
    } catch (error) {
      await this.releaseReservation(reservation.id);
      throw error;
    }
  }

  private async loadStoreOrder(storeOrderNumber: string): Promise<{
    readonly codTotal: string;
    readonly customerMobile: string;
    readonly customerName: string;
    readonly deliveryArea: string;
    readonly deliveryAddress: string;
    readonly deliveryCompanyId: string | null;
    readonly deliveryCompanyRelationshipId: string | null;
    readonly deliveryCompanyServiceFee: string;
    readonly deliveryEmirate: string;
    readonly deliveryInstructions: string | null;
    readonly deliveryLocationLink: string | null;
    readonly deliveryOrderId: string | null;
    readonly id: string;
    readonly status: string;
    readonly storeOrderNumber: string;
  }> {
    const result = await sql<{
      codTotal: string;
      customerMobile: string;
      customerName: string;
      deliveryArea: string;
      deliveryAddress: string;
      deliveryCompanyId: string | null;
      deliveryCompanyRelationshipId: string | null;
      deliveryCompanyServiceFee: string;
      deliveryEmirate: string;
      deliveryInstructions: string | null;
      deliveryLocationLink: string | null;
      deliveryOrderId: string | null;
      id: string;
      status: string;
      storeOrderNumber: string;
    }>`
      select cod_total::text as "codTotal", customer_mobile as "customerMobile",
             customer_name as "customerName", delivery_area as "deliveryArea",
             delivery_address as "deliveryAddress", delivery_company_id as "deliveryCompanyId",
             delivery_company_relationship_id as "deliveryCompanyRelationshipId",
             delivery_company_service_fee::text as "deliveryCompanyServiceFee",
             delivery_emirate as "deliveryEmirate", delivery_instructions as "deliveryInstructions",
             delivery_location_link as "deliveryLocationLink", delivery_order_id as "deliveryOrderId",
             id, status, store_order_number as "storeOrderNumber"
        from store_orders where store_order_number = ${storeOrderNumber}
    `.execute(this.database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "store_order_not_found",
        "The Store Order was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  private async loadLinkedDeliveryOrder(
    deliveryOrderId: string,
  ): Promise<{ readonly deliveryStatus: string; readonly orderNumber: string }> {
    const result = await sql<{ deliveryStatus: string; orderNumber: string }>`
      select delivery_status as "deliveryStatus", order_number as "orderNumber"
        from orders where id = ${deliveryOrderId}::uuid
    `.execute(this.database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(
        `store_orders.delivery_order_id ${deliveryOrderId} does not resolve to an Order`,
      );
    }
    return row;
  }

  /** §23/§24: name-matched against the TARGET Company's own Area rows --
   * the exact same pattern `CommerceCheckoutService`'s pricing resolver
   * already uses, reimplemented here because that resolver is scoped to a
   * Checkout preview, not a conversion action. Unlike Checkout's fallback
   * hierarchy (Area → Emirate → global), a Delivery Order's `area_id` is a
   * real foreign key (§23 of the audit) -- there is no "global" Area row to
   * fall back to, so an unresolvable Area is a genuine conversion blocker,
   * not merely a missing price tier. */
  private async resolveArea(
    companyId: string,
    emirateText: string,
    areaText: string,
  ): Promise<string | null> {
    const result = await sql<{ id: string }>`
      select a.id from areas a
        join emirates e on e.id = a.emirate_id
       where a.company_id = ${companyId}::uuid and a.is_active
         and (lower(e.name_en) = lower(${emirateText}) or lower(e.name_ar) = lower(${emirateText}))
         and (lower(a.name_en) = lower(${areaText}) or lower(a.name_ar) = lower(${areaText}))
       limit 1
    `.execute(this.database);
    return result.rows[0]?.id ?? null;
  }

  private async reserve(
    storeOrderId: string,
  ): Promise<{ readonly id: string; readonly kind: "reserved" } | { readonly kind: "replay" }> {
    // `store_order_id` is set immediately, not only on completion: the
    // table's own `completed_has_order` CHECK requires it whenever
    // `status = 'completed'`, and it is already known here -- it IS the key
    // this reservation is scoped to.
    const inserted = await sql<{ id: string }>`
      insert into store_order_idempotency_keys (id, scope_key, idempotency_key, payload_hash, status, store_order_id)
      values (${randomUUID()}::uuid, ${CONVERSION_SCOPE_KEY}, ${storeOrderId}, 'n/a', 'pending', ${storeOrderId}::uuid)
      on conflict (scope_key, idempotency_key) do nothing
      returning id
    `.execute(this.database);
    const insertedRow = inserted.rows[0];
    if (insertedRow !== undefined) return { id: insertedRow.id, kind: "reserved" };

    const existing = await sql<{ id: string; status: string; updatedAt: Date }>`
      select id, status, updated_at as "updatedAt" from store_order_idempotency_keys
       where scope_key = ${CONVERSION_SCOPE_KEY} and idempotency_key = ${storeOrderId}
    `.execute(this.database);
    const existingRow = existing.rows[0];
    if (existingRow === undefined || existingRow.status === "completed") return { kind: "replay" };

    const ageSeconds = (Date.now() - existingRow.updatedAt.getTime()) / 1000;
    if (ageSeconds < PENDING_RESERVATION_TIMEOUT_SECONDS) {
      throw new ApplicationException(
        "store_order_conversion_in_progress",
        "This order is already being converted. Please wait a moment and try again.",
        HttpStatus.CONFLICT,
      );
    }
    const reclaimed = await sql<{ id: string }>`
      update store_order_idempotency_keys
         set updated_at = now()
       where id = ${existingRow.id}::uuid and status = 'pending'
      returning id
    `.execute(this.database);
    const reclaimedRow = reclaimed.rows[0];
    if (reclaimedRow === undefined) return { kind: "replay" };
    return { id: reclaimedRow.id, kind: "reserved" };
  }

  private async finalize(reservationId: string): Promise<void> {
    await sql`
      update store_order_idempotency_keys set status = 'completed', updated_at = now()
       where id = ${reservationId}::uuid
    `.execute(this.database);
  }

  private async releaseReservation(reservationId: string): Promise<void> {
    await sql`delete from store_order_idempotency_keys where id = ${reservationId}::uuid and status = 'pending'`.execute(
      this.database,
    );
  }
}
