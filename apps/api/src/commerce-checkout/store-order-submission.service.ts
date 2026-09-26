import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { Money } from "../shared/money/money.js";
import type { CustomerOrderDetailView } from "../store-order/store-order.service.js";
import { StoreOrderService } from "../store-order/store-order.service.js";

import { CommerceCheckoutService } from "./commerce-checkout.service.js";
import type { PlaceStoreOrderDto } from "./store-order-submission.dto.js";

/** A `pending` reservation older than this is treated as an abandoned
 * request (the process crashed between reserving and finishing) and may be
 * reclaimed by a fresh attempt with the same key -- otherwise a genuine
 * crash would permanently brick that idempotency key. 30s is generously
 * above any realistic Store Order transaction time. */
const PENDING_RESERVATION_TIMEOUT_SECONDS = 30;

export interface PlaceStoreOrderResult extends CustomerOrderDetailView {
  /**
   * C3 corrective (Part B): returned ONCE, on the submission that actually
   * creates the Store Order -- `null` on every idempotent replay of that
   * same `(scopeKey, idempotencyKey)` pair.
   *
   * The raw token is never persisted anywhere, in any form, once the
   * response that carried it has been sent -- not encrypted, not in a
   * "narrowly scoped" column, nowhere. A replay genuinely cannot reissue it,
   * by design: idempotency's guarantee is "same request -> same Store
   * Order", not "same request -> same secret handed out twice". A guest
   * whose first response was lost still has their Store Order (this same
   * response's `storeOrderNumber`/`status`/items/totals are all present on
   * a replay, exactly as on the original) and can recover tracking through
   * the existing guest support/Store contact path; a logged-in Customer
   * simply finds it in My Orders, which has never depended on the token.
   */
  readonly trackingToken: string | null;
}

/**
 * Customer Commerce Prompt C3 -- turns a reviewed C2 Checkout into a real
 * Store Order.
 *
 * ---------------------------------------------------------------------------
 * C2's RESULT IS NEVER FINAL AUTHORITY
 * ---------------------------------------------------------------------------
 *
 * Every fact used to create the Store Order -- Store eligibility, Product
 * price/availability/options, Delivery Company eligibility and pricing -- is
 * re-resolved here from scratch, by calling the EXACT SAME public methods
 * `CommerceCheckoutService` exposes for the C2 preview (`resolveStore`,
 * `resolveCustomer`, `resolveAddress`, `revalidateLines`, `resolveDelivery`).
 * That is reuse of CODE, never of a cached RESULT: nothing from a prior
 * `checkout/validate` call is accepted or trusted here — the request payload
 * has no field to carry one. `expectedCodTotal` is the one deliberate
 * exception, and it is a UX safety check only (§17/§18), never a source of
 * truth for money.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES NOT WRAP `StoreOrderService.createStoreOrder` IN ITS OWN TRANSACTION
 * ---------------------------------------------------------------------------
 *
 * `createStoreOrder` already opens and commits its own transaction (Store
 * re-resolution, Product/option re-validation, snapshotting, numbering and
 * tracking-token issuance all happen inside it). Kysely does not support a
 * true nested transaction on the same connection, so this service does not
 * attempt to wrap that call in a second one; instead, idempotency reservation
 * happens as a short, separate, atomic statement BEFORE `createStoreOrder`
 * runs, and finalization happens as a second short statement immediately
 * after it returns. The reservation's own uniqueness constraint
 * (`scope_key`, `idempotency_key`) is what actually prevents a duplicate --
 * a concurrent second request loses the `INSERT ... ON CONFLICT` race before
 * it does any Store Order work at all, never after.
 */
@Injectable()
export class StoreOrderSubmissionService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(CommerceCheckoutService) private readonly checkout: CommerceCheckoutService,
    @Inject(StoreOrderService) private readonly storeOrders: StoreOrderService,
  ) {}

  public async placeOrder(input: PlaceStoreOrderDto): Promise<PlaceStoreOrderResult> {
    const customer = await this.checkout.resolveCustomer(input);
    const scopeKey = customer.commerceCustomerId ?? `guest:${customer.mobile}`;
    const payloadHash = hashPayload(input);

    const reservation = await this.reserve(scopeKey, input.idempotencyKey, payloadHash);
    if (reservation.kind === "replay") {
      // §8/Part N: the Store Order itself replays in full; the raw tracking
      // token deliberately does not, because it no longer exists anywhere
      // to replay from (see `PlaceStoreOrderResult.trackingToken`'s own
      // comment).
      return { ...reservation.detail, trackingToken: null };
    }
    // reservation.kind === "reserved" past this point -- this request now
    // OWNS the (scopeKey, idempotencyKey) pair until it finalizes or fails.

    try {
      const store = await this.checkout.resolveStore(input.storeSlug);
      const address = await this.checkout.resolveAddress(input, customer.commerceCustomerId);
      const lines = await this.checkout.revalidateLines(store.id, input.cartLines);

      const invalidLine = lines.find((line) => !line.valid);
      if (invalidLine !== undefined) {
        throw new ApplicationException(
          "checkout_changed",
          invalidLine.issue ?? "Your Cart has changed. Please review your order again.",
          HttpStatus.CONFLICT,
        );
      }

      const productSubtotal = lines.reduce(
        (total, line) => total.add(Money.from(line.lineSubtotal)),
        Money.from("0.00"),
      );
      const delivery = await this.checkout.resolveDelivery(store, address, input.selectedDeliveryCompanyId, []);
      // C3 corrective, Part D/E: `resolveDelivery` is the ONE authoritative
      // pricing read (Area/Emirate/global hierarchy against
      // `trader_service_prices`, scoped to the resolved Company + its own
      // Company-scoped Trader) -- no second pricing engine is built here.
      // Today `customerDeliveryFee` IS the Company's own resolved Trader
      // fee, because no `delivery_fee_payer` split exists in the schema
      // (confirmed absent again this segment). Both are persisted as
      // SEPARATE Store Order columns from the SAME resolved number, rather
      // than one being derived from the other at read time later -- a
      // future fee-payer policy only has to change what is computed HERE,
      // never how C4 reads an already-frozen historical Store Order.
      const deliveryCompanyServiceFee = delivery.customerDeliveryFee;
      const codTotal = productSubtotal.add(Money.from(delivery.customerDeliveryFee));

      // §41: decimal-safe invariant, defensive -- codTotal is already
      // constructed AS this sum, so this can only fail if Money itself is
      // broken, but it is cheap insurance against a future refactor.
      if (!codTotal.equals(productSubtotal.add(Money.from(delivery.customerDeliveryFee)))) {
        throw new Error("Store Order money invariant violated: codTotal != productSubtotal + customerDeliveryFee");
      }

      // §17: the Customer must see and re-confirm a changed total, never be
      // silently charged one. A malformed/absent `expectedCodTotal` fails
      // this the same way a genuine mismatch does -- there is no case where
      // skipping the check is the safe choice.
      if (!Money.from(input.expectedCodTotal).equals(codTotal)) {
        throw new ApplicationException(
          "checkout_changed",
          "Your order total has changed. Please review your order again.",
          HttpStatus.CONFLICT,
        );
      }

      const created = await this.storeOrders.createStoreOrder(
        {
          customerDeliveryFee: Number(delivery.customerDeliveryFee),
          ...(delivery.selectedDeliveryCompany === null
            ? {}
            : { deliveryCompanyServiceFee: Number(deliveryCompanyServiceFee) }),
          customerMobile: customer.mobile,
          customerName: customer.name,
          deliveryAddress: address.address,
          deliveryArea: address.area ?? "",
          ...(delivery.selectedDeliveryCompany === null
            ? {}
            : { deliveryCompanyId: delivery.selectedDeliveryCompany.companyId }),
          deliveryEmirate: address.emirate,
          ...(address.deliveryInstructions === null ? {} : { deliveryInstructions: address.deliveryInstructions }),
          ...(address.locationLink === null ? {} : { deliveryLocationLink: address.locationLink }),
          items: lines.map((line) => {
            if (line.productId === null) {
              // Unreachable: every line passed the `invalidLine` check
              // above, and only a valid line ever has a non-null
              // `productId`. Guarded explicitly rather than asserted away,
              // so a future change to that invariant fails loudly here
              // instead of inserting a null product id.
              throw new Error("A valid Checkout line was missing its resolved Product id");
            }
            return {
              productId: line.productId,
              quantity: line.quantity,
              selectedOptionValueIds: line.selectedOptionValueIds,
            };
          }),
          orderSource: "store_web",
          storefrontId: store.id,
        },
        customer.commerceCustomerId,
      );

      await this.finalize(reservation.id, created.id);
      const detail = await this.storeOrders.loadCustomerOrderDetail(created.id);
      return { ...detail, trackingToken: created.trackingToken };
    } catch (error) {
      // §1: no partial Store Order, no partial items, and no idempotency
      // residue blocking a legitimate retry -- `createStoreOrder`'s own
      // transaction already guarantees the first two on any thrown error;
      // this guarantees the third.
      await this.releaseReservation(reservation.id);
      throw error;
    }
  }

  /** Atomically claims `(scopeKey, idempotencyKey)`, or reports what the
   * caller should do instead of claiming it. */
  private async reserve(
    scopeKey: string,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<{ readonly kind: "reserved"; readonly id: string } | { readonly detail: CustomerOrderDetailView; readonly kind: "replay" }> {
    const inserted = await sql<{ id: string }>`
      insert into store_order_idempotency_keys (id, scope_key, idempotency_key, payload_hash, status)
      values (${randomUUID()}::uuid, ${scopeKey}, ${idempotencyKey}, ${payloadHash}, 'pending')
      on conflict (scope_key, idempotency_key) do nothing
      returning id
    `.execute(this.database);
    const insertedRow = inserted.rows[0];
    if (insertedRow !== undefined) return { id: insertedRow.id, kind: "reserved" };

    const existing = await sql<{
      id: string;
      payloadHash: string;
      status: string;
      storeOrderId: string | null;
      updatedAt: Date;
    }>`
      select id, payload_hash as "payloadHash", status, store_order_id as "storeOrderId",
             updated_at as "updatedAt"
        from store_order_idempotency_keys
       where scope_key = ${scopeKey} and idempotency_key = ${idempotencyKey}
    `.execute(this.database);
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      // Lost the insert race AND the immediate re-select race (vanishingly
      // rare) -- safe to treat as a normal "try again" rather than a crash.
      throw new ApplicationException(
        "checkout_submission_in_progress",
        "Your order is already being submitted. Please wait a moment and try again.",
        HttpStatus.CONFLICT,
      );
    }

    if (existingRow.status === "completed") {
      if (existingRow.payloadHash !== payloadHash) {
        throw new ApplicationException(
          "checkout_idempotency_conflict",
          "This submission does not match an earlier order placed with the same request. Please review your order again.",
          HttpStatus.CONFLICT,
        );
      }
      if (existingRow.storeOrderId === null) {
        // Should be impossible given the table's own `completed_has_order`
        // constraint -- treated as a genuine, reportable failure rather
        // than silently degraded.
        throw new Error("Idempotency record marked completed without a Store Order");
      }
      const detail = await this.storeOrders.loadCustomerOrderDetail(existingRow.storeOrderId);
      return { detail, kind: "replay" };
    }

    // status === "pending": either a concurrent in-flight duplicate (reject,
    // retryable) or an abandoned reservation from a crashed request past the
    // timeout (reclaim it for this attempt).
    const ageSeconds = (Date.now() - existingRow.updatedAt.getTime()) / 1000;
    if (ageSeconds < PENDING_RESERVATION_TIMEOUT_SECONDS) {
      throw new ApplicationException(
        "checkout_submission_in_progress",
        "Your order is already being submitted. Please wait a moment and try again.",
        HttpStatus.CONFLICT,
      );
    }
    const reclaimed = await sql<{ id: string }>`
      update store_order_idempotency_keys
         set status = 'pending', payload_hash = ${payloadHash}, updated_at = now()
       where id = ${existingRow.id}::uuid and status = 'pending'
      returning id
    `.execute(this.database);
    const reclaimedRow = reclaimed.rows[0];
    if (reclaimedRow === undefined) {
      // Someone else reclaimed or completed it in the moment between our
      // read and this update -- ask the caller to retry rather than racing
      // further; the next attempt will see the now-current row.
      throw new ApplicationException(
        "checkout_submission_in_progress",
        "Your order is already being submitted. Please wait a moment and try again.",
        HttpStatus.CONFLICT,
      );
    }
    return { id: reclaimedRow.id, kind: "reserved" };
  }

  private async finalize(reservationId: string, storeOrderId: string): Promise<void> {
    // C3 corrective: the raw tracking token is NEVER passed to or stored by
    // this statement -- see `PlaceStoreOrderResult.trackingToken`'s own
    // comment for why a replay does not (and structurally cannot) reissue
    // it.
    await sql`
      update store_order_idempotency_keys
         set status = 'completed', store_order_id = ${storeOrderId}::uuid, updated_at = now()
       where id = ${reservationId}::uuid
    `.execute(this.database);
  }

  private async releaseReservation(reservationId: string): Promise<void> {
    await sql`delete from store_order_idempotency_keys where id = ${reservationId}::uuid and status = 'pending'`.execute(
      this.database,
    );
  }
}

/** A stable hash of everything that determines the OUTCOME of a submission
 * -- deliberately excludes `idempotencyKey` (that's the lookup key, not part
 * of what it protects) and `expectedCodTotal` (a UX check, not a fact about
 * what was ordered). Two submissions with the same key and the same hash are
 * the same request; a different hash is a materially different one (§11). */
function hashPayload(input: PlaceStoreOrderDto): string {
  const canonical = JSON.stringify({
    cartLines: input.cartLines,
    customerMobile: input.customerMobile,
    customerName: input.customerName,
    newAddress: input.newAddress ?? null,
    paymentMethod: input.paymentMethod,
    savedAddressId: input.savedAddressId ?? null,
    selectedDeliveryCompanyId: input.selectedDeliveryCompanyId ?? null,
    storeSlug: input.storeSlug,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
