import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, type Transaction, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { NotificationPublisher } from "../notifications/notification-event.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { normalizeUaeMobile } from "../shared/uae-mobile.js";
import { accessibleCommerceIds } from "../storefront/storefront-access.js";
import { resolveCommerceCustomerId } from "./store-order-access.js";
import { generateTrackingToken, hashTrackingToken } from "./store-order-tracking.js";
import {
  isValidStoreOrderTransition,
  type StoreOrderSource,
  type StoreOrderStatus,
} from "./store-order.constants.js";

/** Builds the same ready-to-use public media URL the Storefront/Product
 * domain already returns to the frontend (`product.service.ts`'s
 * `'/api/v1/public/commerce-media/' || file_id::text` convention) so a
 * Store Order item's frozen image snapshot renders exactly like a live
 * Product image, with no URL construction left to the client. */
function mediaUrl(fileId: string | null): string | null {
  return fileId === null ? null : `/api/v1/public/commerce-media/${fileId}`;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface CustomerOrderItemView {
  readonly brandSnapshot: string | null;
  readonly id: string;
  readonly imageUrl: string | null;
  readonly lineTotal: string;
  readonly productCodeSnapshot: string;
  readonly productNameSnapshot: string;
  readonly quantity: number;
  readonly selectedOptionsSnapshot: readonly { readonly group: string; readonly value: string }[];
  readonly skuSnapshot: string | null;
  readonly unitPriceSnapshot: string;
}

/** §37/§38: a narrow, read-only projection of a linked Delivery Order --
 * only present when `store_orders.delivery_order_id` is set, and only ever
 * built from a read, never a write. */
export interface LinkedDeliverySummaryView {
  readonly deliveredAt: string | null;
  readonly deliveryCompanyName: string | null;
  readonly deliveryStatus: string;
  readonly updatedAt: string | null;
}

/** §4/§5: the Customer- and guest-safe order summary/detail contract --
 * deliberately excludes `traderCommerceId`, `storefrontId`,
 * `deliveryCompanyId`/relationship id, `platformFee`,
 * `deliveryCompanyServiceFee`, and any accounting/settlement field, per §4/§5/§30. */
export interface CustomerOrderSummaryView {
  readonly codTotal: string;
  readonly createdAt: string;
  readonly customerDeliveryFee: string;
  readonly deliveryCompanyName: string | null;
  readonly id: string;
  readonly itemCount: number;
  readonly primaryImageUrl: string | null;
  readonly productSubtotal: string;
  readonly status: StoreOrderStatus;
  readonly storeDisplayName: string;
  readonly storeOrderNumber: string;
  readonly storeSlug: string;
}

export interface CustomerOrderDetailView {
  readonly codTotal: string;
  readonly createdAt: string;
  readonly customerDeliveryFee: string;
  readonly customerMobile: string;
  readonly customerName: string;
  readonly deliveryAddress: string;
  readonly deliveryArea: string;
  readonly deliveryCompanyName: string | null;
  readonly deliveryEmirate: string;
  readonly deliveryInstructions: string | null;
  readonly deliverySummary: LinkedDeliverySummaryView | null;
  readonly id: string;
  readonly items: readonly CustomerOrderItemView[];
  readonly productSubtotal: string;
  readonly status: StoreOrderStatus;
  readonly storeDisplayName: string;
  readonly storeOrderNumber: string;
  readonly storeSlug: string;
  readonly submittedAt: string | null;
}

/** §27/§30: the tracking API returns the SAME narrow contract as Order
 * detail minus the Customer's own identity fields -- the requester already
 * supplied their own mobile number to get here, so it is not echoed back. */
export type TrackingResultView = Omit<CustomerOrderDetailView, "customerMobile" | "customerName">;

export interface CreateStoreOrderItemInput {
  readonly productId: string;
  readonly quantity: number;
  readonly selectedOptionValueIds?: readonly string[];
}

export interface CreateStoreOrderInput {
  readonly customerAddressId?: string;
  readonly customerDeliveryFee?: number;
  readonly customerEmail?: string;
  readonly customerMobile: string;
  readonly customerName: string;
  readonly deliveryAddress: string;
  readonly deliveryArea: string;
  readonly deliveryCompanyId?: string;
  readonly deliveryEmirate: string;
  readonly deliveryInstructions?: string;
  readonly deliveryLocationLink?: string;
  readonly items: readonly CreateStoreOrderItemInput[];
  readonly orderSource?: StoreOrderSource;
  readonly storefrontId: string;
}

export interface StoreOrderItemView {
  readonly brandSnapshot: string | null;
  readonly id: string;
  readonly lineTotal: string;
  readonly productCodeSnapshot: string;
  readonly productId: string;
  readonly productNameSnapshot: string;
  readonly quantity: number;
  readonly selectedOptionsSnapshot: readonly { readonly group: string; readonly value: string }[];
  readonly skuSnapshot: string | null;
  readonly unitPriceSnapshot: string;
}

/** Returned only once, at creation -- the raw tracking token given to the
 * caller (to be emailed/SMSed by a future Checkout flow) is never stored;
 * only its hash is (§24). */
export interface CreatedStoreOrder extends StoreOrderView {
  readonly trackingToken: string;
}

export interface StoreOrderView {
  readonly codTotal: string;
  readonly customerDeliveryFee: string;
  readonly customerId: string | null;
  readonly customerMobile: string;
  readonly customerName: string;
  readonly deliveryCompanyId: string | null;
  readonly deliveryCompanyServiceFee: string;
  readonly id: string;
  readonly items: readonly StoreOrderItemView[];
  readonly platformFee: string;
  readonly productSubtotal: string;
  readonly status: StoreOrderStatus;
  readonly storeDisplayNameSnapshot: string;
  readonly storeOrderNumber: string;
  readonly storefrontId: string;
  readonly traderCommerceId: string;
}

/**
 * The Store Order domain -- Shared Commerce Foundation Prompt 3B.
 *
 * ---------------------------------------------------------------------------
 * "INTERNAL" ON PURPOSE
 * ---------------------------------------------------------------------------
 *
 * This is a domain/service layer, not the public Checkout endpoint (§41).
 * `createStoreOrder`'s caller is trusted to have already resolved and
 * verified `callerCustomerId` (undefined for a guest) -- exactly the way
 * `createTraderPortalOrder` resolves `trader.id` server-side rather than
 * accepting one from the request body. No HTTP controller is added in 3B;
 * Cart/Checkout (which WOULD be that trusted caller) belongs to a later
 * prompt.
 */
@Injectable()
export class StoreOrderService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(NotificationPublisher) private readonly notifications: NotificationPublisher,
  ) {}

  /**
   * §41-43: transactional creation. Storefront -> Trader Commerce ownership
   * is resolved server-side (never trusted from the caller); Product price,
   * name, code, sku, brand are read from the current Product row at this
   * instant and frozen onto the Item (§17/§50); option selections are
   * validated against the Product's own current option definitions (§20)
   * before being snapshotted.
   */
  public async createStoreOrder(
    input: CreateStoreOrderInput,
    callerCustomerId: string | undefined,
  ): Promise<CreatedStoreOrder> {
    if (input.items.length === 0) {
      throw new ApplicationException(
        "store_order_items_required",
        "A Store Order must have at least one item",
        HttpStatus.BAD_REQUEST,
      );
    }
    const normalizedMobile = normalizeUaeMobile(input.customerMobile);
    if (normalizedMobile === undefined) {
      throw new ApplicationException(
        "invalid_mobile",
        "Enter a valid UAE mobile number",
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.transactions.execute(async (transaction) => {
      const storefront = await sql<{
        id: string;
        slug: string;
        displayName: string;
        traderCommerceId: string;
      }>`
        select id, slug, display_name as "displayName", trader_commerce_id as "traderCommerceId"
          from trader_storefronts where id = ${input.storefrontId}::uuid
      `.execute(transaction);
      const storefrontRow = storefront.rows[0];
      if (storefrontRow === undefined) {
        throw new ApplicationException(
          "storefront_not_found",
          "The selected Store was not found",
          HttpStatus.NOT_FOUND,
        );
      }

      // §22: a registered Customer may only order for themselves -- the
      // caller-resolved id is the only one ever trusted; nothing in
      // `CreateStoreOrderInput` names a Customer at all.
      if (callerCustomerId !== undefined) {
        const customer = await sql<{ id: string }>`
          select id from commerce_customers where id = ${callerCustomerId}::uuid
        `.execute(transaction);
        if (customer.rows[0] === undefined) {
          throw new ApplicationException(
            "customer_not_found",
            "The authenticated Customer was not found",
            HttpStatus.NOT_FOUND,
          );
        }
      }

      const items: {
        productId: string;
        name: string;
        code: string;
        sku: string | null;
        brand: string | null;
        imageFileId: string | null;
        price: string;
        quantity: number;
        lineTotal: string;
        options: readonly { readonly group: string; readonly value: string }[];
      }[] = [];
      let productSubtotal = 0;

      for (const item of input.items) {
        if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
          throw new ApplicationException(
            "store_order_item_quantity_invalid",
            "Quantity must be a positive whole number",
            HttpStatus.BAD_REQUEST,
          );
        }
        // §49/§50: Product ownership and price authority, server-resolved.
        // A Product from a different Storefront -- or one that is not
        // currently active/available -- does not resolve here at all.
        const product = await sql<{
          id: string;
          name: string;
          code: string;
          sku: string | null;
          brand: string | null;
          price: string;
        }>`
          select id, name, product_code as code, sku, brand, selling_price::text as price
            from trader_storefront_products
           where id = ${item.productId}::uuid
             and storefront_id = ${storefrontRow.id}::uuid
             and lifecycle_status = 'active'
             and availability_status = 'available'
        `.execute(transaction);
        const productRow = product.rows[0];
        if (productRow === undefined) {
          throw new ApplicationException(
            "store_order_product_not_available",
            "One of the selected Products is not available in this Store",
            HttpStatus.BAD_REQUEST,
          );
        }

        // §20: required option groups must be satisfied; every supplied
        // selection must belong to an active group/value on THIS Product --
        // a foreign or inactive option is rejected, never trusted as a raw
        // label/value pair from the caller.
        const groups = await sql<{
          id: string;
          name: string;
          isRequired: boolean;
        }>`
          select id, name, is_required as "isRequired"
            from trader_storefront_product_option_groups
           where product_id = ${productRow.id}::uuid and is_active
        `.execute(transaction);

        const selectedValueIds = item.selectedOptionValueIds ?? [];
        const selectedValues = await sql<{
          id: string;
          groupId: string;
          groupName: string;
          value: string;
        }>`
          select v.id, v.option_group_id as "groupId", g.name as "groupName", v.value
            from trader_storefront_product_option_values v
            join trader_storefront_product_option_groups g on g.id = v.option_group_id
           where v.id = any(${selectedValueIds}::uuid[])
             and g.product_id = ${productRow.id}::uuid
             and v.is_active and g.is_active
        `.execute(transaction);
        if (selectedValues.rows.length !== selectedValueIds.length) {
          throw new ApplicationException(
            "store_order_option_invalid",
            "One of the selected options does not belong to this Product",
            HttpStatus.BAD_REQUEST,
          );
        }
        const selectedGroupIds = new Set(selectedValues.rows.map((row) => row.groupId));
        // At most one selection per group -- a Product option group is a
        // single choice ("Size: M"), not a multi-select.
        if (selectedGroupIds.size !== selectedValues.rows.length) {
          throw new ApplicationException(
            "store_order_option_invalid",
            "Only one value may be selected per option group",
            HttpStatus.BAD_REQUEST,
          );
        }
        const missingRequired = groups.rows.filter(
          (group) => group.isRequired && !selectedGroupIds.has(group.id),
        );
        if (missingRequired.length > 0) {
          throw new ApplicationException(
            "store_order_option_required",
            "A required option was not selected",
            HttpStatus.BAD_REQUEST,
          );
        }

        const primaryImage = await sql<{ fileId: string | null }>`
          select file_id as "fileId" from trader_storefront_product_media
           where product_id = ${productRow.id}::uuid and is_primary and is_active
           limit 1
        `.execute(transaction);

        const lineTotal = (Number(productRow.price) * item.quantity).toFixed(2);
        productSubtotal += Number(lineTotal);
        items.push({
          productId: productRow.id,
          name: productRow.name,
          code: productRow.code,
          sku: productRow.sku,
          brand: productRow.brand,
          imageFileId: primaryImage.rows[0]?.fileId ?? null,
          price: productRow.price,
          quantity: item.quantity,
          lineTotal,
          options: selectedValues.rows.map((row) => ({ group: row.groupName, value: row.value })),
        });
      }

      const customerDeliveryFee = input.customerDeliveryFee ?? 0;
      if (customerDeliveryFee < 0) {
        throw new ApplicationException(
          "store_order_delivery_fee_invalid",
          "The delivery fee cannot be negative",
          HttpStatus.BAD_REQUEST,
        );
      }
      // §29's documented current rule: COD total = product subtotal + the
      // customer-facing delivery amount. No Checkout pricing rule is
      // invented here -- this matches the DB's own
      // store_orders_cod_total_identity_check exactly.
      const codTotal = (productSubtotal + customerDeliveryFee).toFixed(2);

      // §33: a selected Delivery Company must be an ACTIVE, Store-Order-
      // enabled relationship belonging to THIS Trader Commerce identity --
      // resolved and validated server-side, never trusted as a bare id.
      let deliveryCompanyId: string | null = null;
      let deliveryCompanyRelationshipId: string | null = null;
      if (input.deliveryCompanyId !== undefined) {
        const relationship = await sql<{ id: string }>`
          select id from trader_delivery_company_relationships
           where trader_commerce_id = ${storefrontRow.traderCommerceId}::uuid
             and company_id = ${input.deliveryCompanyId}::uuid
             and status = 'active'
             and enabled_for_store_orders
        `.execute(transaction);
        const relationshipRow = relationship.rows[0];
        if (relationshipRow === undefined) {
          throw new ApplicationException(
            "store_order_delivery_company_not_linked",
            "The selected Delivery Company is not an active relationship for this Store",
            HttpStatus.BAD_REQUEST,
          );
        }
        deliveryCompanyId = input.deliveryCompanyId;
        deliveryCompanyRelationshipId = relationshipRow.id;
      }

      // §35: no Delivery Company selected lands directly at
      // "awaiting_trader_confirmation" -- the documented foundation state
      // for the zero-Company creation path. A Company already resolved and
      // active is treated as ready to fulfil ("confirmed") without an
      // additional manual step, since 3B does not yet build the Trader
      // confirmation UI that would otherwise perform that transition.
      const status: StoreOrderStatus =
        deliveryCompanyId === null ? "awaiting_trader_confirmation" : "confirmed";
      const now = new Date();

      const storeOrderId = randomUUID();
      const storeOrderNumber = await this.nextStoreOrderNumber(transaction);
      // §25/§26: EVERY Store Order gets a tracking credential at creation --
      // registered-Customer or guest alike -- so guest Checkout (a later
      // prompt) never has to retrofit one onto rows that predate it.
      const tracking = generateTrackingToken();
      await sql`
        insert into store_orders (
          id, store_order_number, trader_commerce_id, storefront_id,
          store_display_name_snapshot, store_slug_snapshot,
          customer_id, order_source, status, currency,
          customer_name, customer_mobile, customer_email,
          delivery_emirate, delivery_area, delivery_address,
          delivery_location_link, delivery_instructions,
          product_subtotal, customer_delivery_fee, delivery_company_service_fee,
          platform_fee, cod_total,
          delivery_company_id, delivery_company_relationship_id,
          tracking_token_hash, tracking_token_created_at,
          submitted_at, confirmed_at
        ) values (
          ${storeOrderId}::uuid, ${storeOrderNumber}, ${storefrontRow.traderCommerceId}::uuid, ${storefrontRow.id}::uuid,
          ${storefrontRow.displayName}, ${storefrontRow.slug},
          ${callerCustomerId ?? null}::uuid, ${input.orderSource ?? "store_web"}, ${status}, 'AED',
          ${input.customerName}, ${normalizedMobile}, ${input.customerEmail ?? null},
          ${input.deliveryEmirate}, ${input.deliveryArea}, ${input.deliveryAddress},
          ${input.deliveryLocationLink ?? null}, ${input.deliveryInstructions ?? null},
          ${productSubtotal.toFixed(2)}, ${customerDeliveryFee.toFixed(2)}, 0,
          0, ${codTotal},
          ${deliveryCompanyId}::uuid, ${deliveryCompanyRelationshipId}::uuid,
          ${tracking.hash}, ${now},
          ${now}, ${status === "confirmed" ? now : null}
        )
      `.execute(transaction);

      const itemViews: StoreOrderItemView[] = [];
      for (const item of items) {
        const itemId = randomUUID();
        await sql`
          insert into store_order_items (
            id, store_order_id, storefront_id, product_id,
            product_name_snapshot, product_code_snapshot, sku_snapshot, brand_snapshot,
            product_image_snapshot, unit_price_snapshot, quantity, line_total,
            selected_options_snapshot
          ) values (
            ${itemId}::uuid, ${storeOrderId}::uuid, ${storefrontRow.id}::uuid, ${item.productId}::uuid,
            ${item.name}, ${item.code}, ${item.sku}, ${item.brand},
            ${item.imageFileId}::uuid, ${item.price}, ${item.quantity}, ${item.lineTotal},
            ${JSON.stringify(item.options)}::jsonb
          )
        `.execute(transaction);
        itemViews.push({
          id: itemId,
          brandSnapshot: item.brand,
          lineTotal: item.lineTotal,
          productCodeSnapshot: item.code,
          productId: item.productId,
          productNameSnapshot: item.name,
          quantity: item.quantity,
          selectedOptionsSnapshot: item.options,
          skuSnapshot: item.sku,
          unitPriceSnapshot: item.price,
        });
      }

      return {
        codTotal,
        customerDeliveryFee: customerDeliveryFee.toFixed(2),
        customerId: callerCustomerId ?? null,
        customerMobile: normalizedMobile,
        customerName: input.customerName,
        deliveryCompanyId,
        deliveryCompanyServiceFee: "0.00",
        id: storeOrderId,
        items: itemViews,
        platformFee: "0.00",
        productSubtotal: productSubtotal.toFixed(2),
        status,
        storeDisplayNameSnapshot: storefrontRow.displayName,
        storeOrderNumber,
        storefrontId: storefrontRow.id,
        traderCommerceId: storefrontRow.traderCommerceId,
        trackingToken: tracking.token,
      };
    }).then(async (created) => {
      // Published AFTER the transaction commits, never inside it -- a
      // notification is not part of the Store Order's own atomicity, and
      // today's no-op publisher makes this safe either way (§37/§39).
      await this.notifications.publish({
        occurredAt: new Date().toISOString(),
        storeOrderId: created.id,
        storeOrderNumber: created.storeOrderNumber,
        type: created.status === "confirmed" ? "store_order_confirmed" : "store_order_submitted",
      });
      return created;
    });
  }

  /** §44/§47: Trader Commerce-safe read -- own Store's Store Orders only. */
  public async traderListStoreOrders(
    callerTraderId: string | null,
    companyId: string,
  ): Promise<readonly StoreOrderView[]> {
    const result = await sql<{ id: string }>`
      select o.id from store_orders o
       where o.trader_commerce_id in (${accessibleCommerceIds({ callerTraderId, companyId })})
       order by o.created_at desc
    `.execute(this.database);
    return Promise.all(result.rows.map((row) => this.loadStoreOrder(row.id)));
  }

  public async traderStoreOrderDetail(
    callerTraderId: string | null,
    companyId: string,
    storeOrderId: string,
  ): Promise<StoreOrderView> {
    const result = await sql<{ id: string }>`
      select o.id from store_orders o
       where o.id = ${storeOrderId}::uuid
         and o.trader_commerce_id in (${accessibleCommerceIds({ callerTraderId, companyId })})
    `.execute(this.database);
    if (result.rows[0] === undefined) {
      throw new ApplicationException(
        "store_order_not_found",
        "The Store Order was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return this.loadStoreOrder(storeOrderId);
  }

  /** §45/§48: Customer-safe read -- own Orders only, resolved from the session account. */
  public async customerListStoreOrders(accountId: string): Promise<readonly StoreOrderView[]> {
    const customerId = await resolveCommerceCustomerId(this.database, accountId);
    if (customerId === undefined) return [];
    const result = await sql<{ id: string }>`
      select id from store_orders where customer_id = ${customerId}::uuid order by created_at desc
    `.execute(this.database);
    return Promise.all(result.rows.map((row) => this.loadStoreOrder(row.id)));
  }

  public async customerStoreOrderDetail(
    accountId: string,
    storeOrderId: string,
  ): Promise<StoreOrderView> {
    const customerId = await resolveCommerceCustomerId(this.database, accountId);
    const result =
      customerId === undefined
        ? { rows: [] }
        : await sql<{ id: string }>`
            select id from store_orders where id = ${storeOrderId}::uuid and customer_id = ${customerId}::uuid
          `.execute(this.database);
    if (result.rows[0] === undefined) {
      throw new ApplicationException(
        "store_order_not_found",
        "The Store Order was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return this.loadStoreOrder(storeOrderId);
  }

  /**
   * §3/§6: Customer My Orders list -- server-side paginated, newest first,
   * Customer-safe fields only. Ownership is resolved from the session
   * account exactly like `customerListStoreOrders`; `status` is an optional
   * exact-match filter over the real enum (never a client-trusted label).
   */
  public async customerOrderSummaryPage(
    accountId: string,
    options: { readonly page?: number; readonly pageSize?: number; readonly status?: StoreOrderStatus } = {},
  ): Promise<Page<CustomerOrderSummaryView>> {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE));
    const customerId = await resolveCommerceCustomerId(this.database, accountId);
    if (customerId === undefined) return { items: [], page, pageSize, total: 0 };

    const statusFilter = options.status === undefined ? sql`true` : sql`o.status = ${options.status}`;
    const total = await sql<{ count: string }>`
      select count(*)::text as count from store_orders o
       where o.customer_id = ${customerId}::uuid and ${statusFilter}
    `.execute(this.database);

    const rows = await sql<{
      id: string;
      storeOrderNumber: string;
      createdAt: Date;
      storeDisplayName: string;
      storeSlug: string;
      status: StoreOrderStatus;
      productSubtotal: string;
      customerDeliveryFee: string;
      codTotal: string;
      deliveryCompanyName: string | null;
      itemCount: string;
      primaryImageFileId: string | null;
    }>`
      select o.id, o.store_order_number as "storeOrderNumber", o.created_at as "createdAt",
             o.store_display_name_snapshot as "storeDisplayName", o.store_slug_snapshot as "storeSlug",
             o.status, o.product_subtotal::text as "productSubtotal",
             o.customer_delivery_fee::text as "customerDeliveryFee", o.cod_total::text as "codTotal",
             c.name_en as "deliveryCompanyName",
             (select count(*) from store_order_items i where i.store_order_id = o.id)::text as "itemCount",
             (select i.product_image_snapshot from store_order_items i
                where i.store_order_id = o.id order by i.created_at limit 1) as "primaryImageFileId"
        from store_orders o
        left join companies c on c.id = o.delivery_company_id
       where o.customer_id = ${customerId}::uuid and ${statusFilter}
       order by o.created_at desc
       limit ${pageSize} offset ${(page - 1) * pageSize}
    `.execute(this.database);

    return {
      items: rows.rows.map((row) => ({
        codTotal: row.codTotal,
        createdAt: row.createdAt.toISOString(),
        customerDeliveryFee: row.customerDeliveryFee,
        deliveryCompanyName: row.deliveryCompanyName,
        id: row.id,
        itemCount: Number(row.itemCount),
        primaryImageUrl: mediaUrl(row.primaryImageFileId),
        productSubtotal: row.productSubtotal,
        status: row.status,
        storeDisplayName: row.storeDisplayName,
        storeOrderNumber: row.storeOrderNumber,
        storeSlug: row.storeSlug,
      })),
      page,
      pageSize,
      total: Number(total.rows[0]?.count ?? "0"),
    };
  }

  /**
   * §7/§9/§42: Customer Order detail by human-readable number, still scoped
   * server-side to the caller's OWN resolved Customer id -- a valid Order
   * number belonging to a different Customer resolves to the same
   * "not found" as a nonexistent one (§8/§42), never a distinguishing error.
   */
  public async customerOrderDetailView(
    accountId: string,
    storeOrderNumber: string,
  ): Promise<CustomerOrderDetailView> {
    const customerId = await resolveCommerceCustomerId(this.database, accountId);
    if (customerId === undefined) {
      throw new ApplicationException(
        "store_order_not_found",
        "The Store Order was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const row = await sql<{ id: string }>`
      select id from store_orders
       where store_order_number = ${storeOrderNumber} and customer_id = ${customerId}::uuid
    `.execute(this.database);
    const orderId = row.rows[0]?.id;
    if (orderId === undefined) {
      throw new ApplicationException(
        "store_order_not_found",
        "The Store Order was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return this.loadCustomerOrderDetail(orderId);
  }

  /**
   * §27-30: enumeration-safe public tracking lookup. A Store Order number
   * alone (sequential, guessable) is never sufficient -- the caller must
   * ALSO supply the exact frozen Customer mobile snapshot and the raw
   * tracking token whose hash matches a live (non-revoked) credential, all
   * three checked in a single predicate so no individual field's
   * correctness is revealed by a different failure shape (§28/§56).
   */
  public async trackStoreOrder(input: {
    readonly storeOrderNumber: string;
    readonly mobile: string;
    readonly trackingToken: string;
  }): Promise<TrackingResultView> {
    const normalizedMobile = normalizeUaeMobile(input.mobile);
    const genericFailure = () =>
      new ApplicationException(
        "store_order_tracking_failed",
        "We couldn't verify this Order with the information provided",
        HttpStatus.NOT_FOUND,
      );
    if (normalizedMobile === undefined) throw genericFailure();

    const tokenHash = hashTrackingToken(input.trackingToken);
    const row = await sql<{ id: string }>`
      select id from store_orders
       where store_order_number = ${input.storeOrderNumber}
         and customer_mobile = ${normalizedMobile}
         and tracking_token_hash = ${tokenHash}
         and tracking_token_revoked_at is null
    `.execute(this.database);
    const orderId = row.rows[0]?.id;
    if (orderId === undefined) throw genericFailure();

    const detail = await this.loadCustomerOrderDetail(orderId);
    const { customerMobile: _customerMobile, customerName: _customerName, ...tracking } = detail;
    return tracking;
  }

  /**
   * Tracking-token lifecycle foundation (§24: "can be rotated/revoked").
   * Not called by any route in 3C -- kept here so the DB shape's rotate/
   * revoke story is provably real rather than aspirational.
   */
  public async revokeStoreOrderTrackingToken(storeOrderId: string): Promise<void> {
    await sql`
      update store_orders set tracking_token_revoked_at = now()
       where id = ${storeOrderId}::uuid and tracking_token_revoked_at is null
    `.execute(this.database);
  }

  private async loadCustomerOrderDetail(storeOrderId: string): Promise<CustomerOrderDetailView> {
    const order = await sql<{
      id: string;
      storeOrderNumber: string;
      createdAt: Date;
      submittedAt: Date | null;
      status: StoreOrderStatus;
      storeDisplayName: string;
      storeSlug: string;
      customerName: string;
      customerMobile: string;
      deliveryEmirate: string;
      deliveryArea: string;
      deliveryAddress: string;
      deliveryInstructions: string | null;
      deliveryCompanyName: string | null;
      productSubtotal: string;
      customerDeliveryFee: string;
      codTotal: string;
      deliveryOrderId: string | null;
    }>`
      select o.id, o.store_order_number as "storeOrderNumber", o.created_at as "createdAt",
             o.submitted_at as "submittedAt", o.status,
             o.store_display_name_snapshot as "storeDisplayName", o.store_slug_snapshot as "storeSlug",
             o.customer_name as "customerName", o.customer_mobile as "customerMobile",
             o.delivery_emirate as "deliveryEmirate", o.delivery_area as "deliveryArea",
             o.delivery_address as "deliveryAddress", o.delivery_instructions as "deliveryInstructions",
             c.name_en as "deliveryCompanyName",
             o.product_subtotal::text as "productSubtotal",
             o.customer_delivery_fee::text as "customerDeliveryFee", o.cod_total::text as "codTotal",
             o.delivery_order_id as "deliveryOrderId"
        from store_orders o
        left join companies c on c.id = o.delivery_company_id
       where o.id = ${storeOrderId}::uuid
    `.execute(this.database);
    const orderRow = order.rows[0];
    if (orderRow === undefined) {
      throw new ApplicationException(
        "store_order_not_found",
        "The Store Order was not found",
        HttpStatus.NOT_FOUND,
      );
    }

    const items = await sql<{
      id: string;
      productNameSnapshot: string;
      productCodeSnapshot: string;
      skuSnapshot: string | null;
      brandSnapshot: string | null;
      unitPriceSnapshot: string;
      quantity: number;
      lineTotal: string;
      selectedOptionsSnapshot: readonly { readonly group: string; readonly value: string }[];
      productImageSnapshot: string | null;
    }>`
      select id, product_name_snapshot as "productNameSnapshot",
             product_code_snapshot as "productCodeSnapshot", sku_snapshot as "skuSnapshot",
             brand_snapshot as "brandSnapshot", unit_price_snapshot::text as "unitPriceSnapshot",
             quantity, line_total::text as "lineTotal",
             selected_options_snapshot as "selectedOptionsSnapshot",
             product_image_snapshot as "productImageSnapshot"
        from store_order_items where store_order_id = ${storeOrderId}::uuid
       order by created_at
    `.execute(this.database);

    // §36-38: read-only, and only if a Delivery Order is actually linked.
    let deliverySummary: LinkedDeliverySummaryView | null = null;
    if (orderRow.deliveryOrderId !== null) {
      const linked = await sql<{
        deliveryStatus: string;
        deliveryCompanyName: string | null;
        deliveredAt: Date | null;
        updatedAt: Date | null;
      }>`
        select d.delivery_status as "deliveryStatus", c.name_en as "deliveryCompanyName",
               d.delivered_at as "deliveredAt", d.updated_at as "updatedAt"
          from orders d
          join companies c on c.id = d.company_id
         where d.id = ${orderRow.deliveryOrderId}::uuid
      `.execute(this.database);
      const linkedRow = linked.rows[0];
      if (linkedRow !== undefined) {
        deliverySummary = {
          deliveredAt: linkedRow.deliveredAt?.toISOString() ?? null,
          deliveryCompanyName: linkedRow.deliveryCompanyName,
          deliveryStatus: linkedRow.deliveryStatus,
          updatedAt: linkedRow.updatedAt?.toISOString() ?? null,
        };
      }
    }

    return {
      codTotal: orderRow.codTotal,
      createdAt: orderRow.createdAt.toISOString(),
      customerDeliveryFee: orderRow.customerDeliveryFee,
      customerMobile: orderRow.customerMobile,
      customerName: orderRow.customerName,
      deliveryAddress: orderRow.deliveryAddress,
      deliveryArea: orderRow.deliveryArea,
      deliveryCompanyName: orderRow.deliveryCompanyName,
      deliveryEmirate: orderRow.deliveryEmirate,
      deliveryInstructions: orderRow.deliveryInstructions,
      deliverySummary,
      id: orderRow.id,
      items: items.rows.map((item) => ({
        brandSnapshot: item.brandSnapshot,
        id: item.id,
        imageUrl: mediaUrl(item.productImageSnapshot),
        lineTotal: item.lineTotal,
        productCodeSnapshot: item.productCodeSnapshot,
        productNameSnapshot: item.productNameSnapshot,
        quantity: item.quantity,
        selectedOptionsSnapshot: item.selectedOptionsSnapshot,
        skuSnapshot: item.skuSnapshot,
        unitPriceSnapshot: item.unitPriceSnapshot,
      })),
      productSubtotal: orderRow.productSubtotal,
      status: orderRow.status,
      storeDisplayName: orderRow.storeDisplayName,
      storeOrderNumber: orderRow.storeOrderNumber,
      storeSlug: orderRow.storeSlug,
      submittedAt: orderRow.submittedAt?.toISOString() ?? null,
    };
  }

  /**
   * §13: applies an explicit, validated status transition. Used by tests to
   * prove the transition graph (§13, invalid transitions rejected); no
   * public endpoint calls this in 3B.
   */
  public async transitionStoreOrderStatus(
    storeOrderId: string,
    to: StoreOrderStatus,
  ): Promise<void> {
    let storeOrderNumber: string | undefined;
    await this.transactions.execute(async (transaction) => {
      const current = await sql<{ status: StoreOrderStatus; storeOrderNumber: string }>`
        select status, store_order_number as "storeOrderNumber"
          from store_orders where id = ${storeOrderId}::uuid for update
      `.execute(transaction);
      const row = current.rows[0];
      if (row === undefined) {
        throw new ApplicationException(
          "store_order_not_found",
          "The Store Order was not found",
          HttpStatus.NOT_FOUND,
        );
      }
      if (!isValidStoreOrderTransition(row.status, to)) {
        throw new ApplicationException(
          "store_order_transition_invalid",
          `Cannot move a Store Order from ${row.status} to ${to}`,
          HttpStatus.BAD_REQUEST,
        );
      }
      await sql`
        update store_orders set
          status = ${to},
          confirmed_at = case when ${to} = 'confirmed' then now() else confirmed_at end,
          cancelled_at = case when ${to} = 'cancelled' then now() else cancelled_at end,
          updated_at = now(), version = version + 1
         where id = ${storeOrderId}::uuid
      `.execute(transaction);
      storeOrderNumber = row.storeOrderNumber;
    });

    // §37/§39: published after commit; only the two transitions with a
    // matching conceptual event are announced -- `converted_to_delivery`/
    // `completed_external` have no event name in this prompt's list and are
    // left for whichever future prompt defines the Delivery-conversion flow.
    if (storeOrderNumber !== undefined && (to === "confirmed" || to === "cancelled")) {
      await this.notifications.publish({
        occurredAt: new Date().toISOString(),
        storeOrderId,
        storeOrderNumber,
        type: to === "confirmed" ? "store_order_confirmed" : "store_order_cancelled",
      });
    }
  }

  private async nextStoreOrderNumber(transaction: Transaction<DatabaseSchema>): Promise<string> {
    const result = await sql<{ nextValue: string; prefix: string }>`
      insert into store_order_number_counters (reference_type, next_value, prefix)
      values ('store_order', 2, 'SO')
      on conflict (reference_type)
      do update set next_value = store_order_number_counters.next_value + 1, updated_at = now()
      returning prefix, (next_value - 1)::text as "nextValue"
    `.execute(transaction);
    const counter = result.rows[0];
    if (counter === undefined) throw new Error("Store Order number counter did not return a row");
    return `${counter.prefix}-${counter.nextValue.padStart(6, "0")}`;
  }

  private async loadStoreOrder(storeOrderId: string): Promise<StoreOrderView> {
    const order = await sql<{
      id: string;
      storeOrderNumber: string;
      traderCommerceId: string;
      storefrontId: string;
      storeDisplayNameSnapshot: string;
      customerId: string | null;
      status: StoreOrderStatus;
      customerName: string;
      customerMobile: string;
      productSubtotal: string;
      customerDeliveryFee: string;
      deliveryCompanyServiceFee: string;
      platformFee: string;
      codTotal: string;
      deliveryCompanyId: string | null;
    }>`
      select id, store_order_number as "storeOrderNumber", trader_commerce_id as "traderCommerceId",
             storefront_id as "storefrontId", store_display_name_snapshot as "storeDisplayNameSnapshot",
             customer_id as "customerId", status, customer_name as "customerName",
             customer_mobile as "customerMobile",
             product_subtotal::text as "productSubtotal", customer_delivery_fee::text as "customerDeliveryFee",
             delivery_company_service_fee::text as "deliveryCompanyServiceFee",
             platform_fee::text as "platformFee", cod_total::text as "codTotal",
             delivery_company_id as "deliveryCompanyId"
        from store_orders where id = ${storeOrderId}::uuid
    `.execute(this.database);
    const orderRow = order.rows[0];
    if (orderRow === undefined) {
      throw new ApplicationException(
        "store_order_not_found",
        "The Store Order was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    const items = await sql<{
      id: string;
      productId: string;
      productNameSnapshot: string;
      productCodeSnapshot: string;
      skuSnapshot: string | null;
      brandSnapshot: string | null;
      unitPriceSnapshot: string;
      quantity: number;
      lineTotal: string;
      selectedOptionsSnapshot: readonly { readonly group: string; readonly value: string }[];
    }>`
      select id, product_id as "productId", product_name_snapshot as "productNameSnapshot",
             product_code_snapshot as "productCodeSnapshot", sku_snapshot as "skuSnapshot",
             brand_snapshot as "brandSnapshot", unit_price_snapshot::text as "unitPriceSnapshot",
             quantity, line_total::text as "lineTotal",
             selected_options_snapshot as "selectedOptionsSnapshot"
        from store_order_items where store_order_id = ${storeOrderId}::uuid
       order by created_at
    `.execute(this.database);

    return {
      codTotal: orderRow.codTotal,
      customerDeliveryFee: orderRow.customerDeliveryFee,
      customerId: orderRow.customerId,
      customerMobile: orderRow.customerMobile,
      customerName: orderRow.customerName,
      deliveryCompanyId: orderRow.deliveryCompanyId,
      deliveryCompanyServiceFee: orderRow.deliveryCompanyServiceFee,
      id: orderRow.id,
      items: items.rows,
      platformFee: orderRow.platformFee,
      productSubtotal: orderRow.productSubtotal,
      status: orderRow.status,
      storeDisplayNameSnapshot: orderRow.storeDisplayNameSnapshot,
      storeOrderNumber: orderRow.storeOrderNumber,
      storefrontId: orderRow.storefrontId,
      traderCommerceId: orderRow.traderCommerceId,
    };
  }
}
