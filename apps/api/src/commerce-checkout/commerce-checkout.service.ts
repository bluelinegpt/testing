import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { Money } from "../shared/money/money.js";

import { resolveCommerceCustomerId } from "../store-order/store-order-access.js";
import type { ValidateCheckoutDto } from "./commerce-checkout.dto.js";

/**
 * Customer Commerce Prompt C2 — the Checkout revalidation/preview engine.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE EVERYTHING HERE EXISTS TO ENFORCE
 * ---------------------------------------------------------------------------
 *
 * A C1 Cart is `localStorage`. Every field on it — Product name, price,
 * image, Store name — is something a Customer's own browser produced and can
 * edit at will. Nothing here ever reads a price, a name, an availability
 * flag, or a Company selection from the request as fact. The request supplies
 * LOOKUP KEYS ONLY (`storeSlug`, `productSlug`, option text, a Company id to
 * select) — every field this method returns is re-derived from the database,
 * fresh, on every call. See `ValidateCheckoutDto`'s own doc comment: there is
 * no money field on the request DTO to strip, because none is accepted.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PREVIEW, NOT A WRITE
 * ---------------------------------------------------------------------------
 *
 * Nothing here inserts a row. `validate()` can be called any number of times
 * — re-opening the Checkout page, changing the address, switching Delivery
 * Company — and always recomputes from current data. C3 (Store Order
 * creation) will call `StoreOrderService.createStoreOrder` and MUST
 * revalidate everything again inside its own transaction; this method's
 * result is informational for the Customer, never a reservation.
 */

export interface CheckoutLineResult {
  readonly productSlug: string;
  readonly productName: string;
  readonly selectedOptions: readonly { readonly groupName: string; readonly value: string }[];
  readonly quantity: number;
  readonly unitPrice: string;
  readonly lineSubtotal: string;
  readonly priceChanged: boolean;
  readonly valid: boolean;
  readonly issue: string | null;
  /** Internal ids, resolved fresh by this same revalidation -- `null`/`[]`
   * on an invalid line. Never serialized over HTTP (stripped in
   * `CommerceCheckoutController.toPublicResult`); exists solely so Customer
   * Commerce Prompt C3's Store Order submission can hand these straight to
   * `StoreOrderService.createStoreOrder` without a second product/option
   * lookup racing against a slightly different snapshot of the same data. */
  readonly productId: string | null;
  readonly selectedOptionValueIds: readonly string[];
}

export interface CheckoutDeliveryOption {
  readonly companyId: string;
  readonly name: string;
  readonly customerDeliveryFee: string;
  readonly isDefault: boolean;
}

export interface CheckoutResult {
  readonly store: { readonly slug: string; readonly displayName: string };
  readonly customer: { readonly name: string; readonly mobile: string; readonly isGuest: boolean };
  readonly address: {
    readonly emirate: string;
    readonly area: string | null;
    readonly address: string;
    readonly locationLink: string | null;
    readonly deliveryInstructions: string | null;
  };
  readonly lines: readonly CheckoutLineResult[];
  readonly productSubtotal: string;
  readonly deliveryOptions: readonly CheckoutDeliveryOption[];
  readonly selectedDeliveryCompany: CheckoutDeliveryOption | null;
  readonly customerDeliveryFee: string;
  readonly codTotal: string;
  readonly zeroCompanyMessage: string | null;
  readonly validationWarnings: readonly string[];
  readonly canProceed: boolean;
}

/**
 * §39/§42: the internal-only counterpart of `customerDeliveryFee`. No
 * `delivery_fee_payer` field exists in the schema (confirmed absent), so
 * today this always equals `customerDeliveryFee` exactly -- there is no
 * Trader-pays split to apply yet. Kept as a SEPARATE field internally (never
 * collapsed into `customerDeliveryFee`) purely so a future fee-payer split
 * has somewhere to diverge without a money-model rewrite; C3 should read
 * `customerDeliveryFee` for what the Customer is charged and treat this as
 * the Company's own service-fee record. This type, unlike `CheckoutResult`,
 * is never returned over HTTP.
 */
export interface CheckoutResultWithInternalFees extends CheckoutResult {
  readonly deliveryCompanyServiceFee: string;
}

const UAE_MOBILE = /^9715[0-9]{8}$/;

function normalizeUaeMobile(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/gu, "");
  const candidate = digits.startsWith("0")
    ? `971${digits.slice(1)}`
    : digits.startsWith("971")
      ? digits
      : digits;
  return UAE_MOBILE.test(candidate) ? candidate : null;
}

@Injectable()
export class CommerceCheckoutService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(RequestSecurityContextStore)
    private readonly securityContext: RequestSecurityContextStore,
  ) {}

  public async validate(input: ValidateCheckoutDto): Promise<CheckoutResultWithInternalFees> {
    const store = await this.resolveStore(input.storeSlug);
    const customer = await this.resolveCustomer(input);
    const address = await this.resolveAddress(input, customer.commerceCustomerId);
    const lines = await this.revalidateLines(store.id, input.cartLines);

    const warnings: string[] = [];
    for (const line of lines) {
      if (!line.valid) warnings.push(`${line.productName}: ${line.issue}`);
    }

    const productSubtotal = lines
      .filter((line) => line.valid)
      .reduce((total, line) => total.add(Money.from(line.lineSubtotal)), Money.from("0.00"));

    const delivery = await this.resolveDelivery(
      store,
      address,
      input.selectedDeliveryCompanyId,
      warnings,
    );

    const codTotal = productSubtotal.add(Money.from(delivery.customerDeliveryFee));
    const canProceed = lines.every((line) => line.valid) && lines.length > 0;

    return {
      address: {
        address: address.address,
        area: address.area,
        deliveryInstructions: address.deliveryInstructions,
        locationLink: address.locationLink,
        emirate: address.emirate,
      },
      canProceed,
      codTotal: codTotal.toString(),
      customer: {
        isGuest: customer.commerceCustomerId === undefined,
        mobile: customer.mobile,
        name: customer.name,
      },
      customerDeliveryFee: delivery.customerDeliveryFee,
      deliveryCompanyServiceFee: delivery.customerDeliveryFee,
      deliveryOptions: delivery.deliveryOptions,
      lines,
      productSubtotal: productSubtotal.toString(),
      selectedDeliveryCompany: delivery.selectedDeliveryCompany,
      store: { displayName: store.displayName, slug: store.slug },
      validationWarnings: warnings,
      zeroCompanyMessage: delivery.zeroCompanyMessage,
    };
  }

  // ------------------------------------------------------------- Store

  /** Public: reused directly by `StoreOrderSubmissionService` (C3) so both
   * the Checkout preview and the actual Store Order submission agree on
   * exactly what "checkout-eligible" means, from one fresh database read
   * each time -- not from each other's cached result. */
  public async resolveStore(storeSlug: string): Promise<{
    readonly id: string;
    readonly displayName: string;
    readonly slug: string;
    readonly traderCommerceId: string;
  }> {
    const result = await sql<{
      id: string;
      displayName: string;
      slug: string;
      status: string;
      traderCommerceId: string;
    }>`
      select id, display_name as "displayName", slug, status,
             trader_commerce_id as "traderCommerceId"
        from trader_storefronts
       where lower(slug) = lower(${storeSlug})
    `.execute(this.database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "checkout_store_not_found",
        "This store could not be found.",
        HttpStatus.NOT_FOUND,
      );
    }
    // A temporarily-closed Store still resolves publicly (T6), but cannot be
    // checked out against -- it is not accepting Orders right now. Only
    // 'published' is checkout-eligible.
    if (row.status !== "published") {
      throw new ApplicationException(
        "checkout_store_unavailable",
        "This store is not accepting orders right now.",
        HttpStatus.CONFLICT,
      );
    }
    return row;
  }

  /**
   * Which Company's Areas the public Checkout Area picker should search for
   * this Store. Reuses the exact same eligibility query `resolveDelivery`
   * runs (`trader_delivery_company_relationships`, active + enabled), taking
   * the Trader's own default eligible Company (or the first eligible one if
   * none is marked default) -- the same "Trader Commerce → enabled Delivery
   * Company relationships → Company-scoped Trader" precedence Part 3 of this
   * fix describes. `null` when the Store has no eligible Delivery Company at
   * all -- the picker then has nothing to search, matching the approved
   * zero-Company path (never fabricates a Company to search against).
   */
  public async resolveAreaSearchCompanyId(storeSlug: string): Promise<string | null> {
    const store = await this.resolveStore(storeSlug);
    const relationships = await sql<{ companyId: string; isDefault: boolean }>`
      select r.company_id as "companyId", r.is_default_for_store_orders as "isDefault"
        from trader_delivery_company_relationships r
       where r.trader_commerce_id = ${store.traderCommerceId}::uuid
         and r.status = 'active' and r.enabled_for_store_orders and r.trader_id is not null
       order by r.is_default_for_store_orders desc
       limit 1
    `.execute(this.database);
    return relationships.rows[0]?.companyId ?? null;
  }

  // ------------------------------------------------------------- Customer

  /** Public: reused by C3's Store Order submission for the identical
   * mobile-normalization + best-effort session read. */
  public async resolveCustomer(input: ValidateCheckoutDto): Promise<{
    readonly commerceCustomerId: string | undefined;
    readonly mobile: string;
    readonly name: string;
  }> {
    const mobile = normalizeUaeMobile(input.customerMobile);
    if (mobile === null) {
      throw new ApplicationException(
        "checkout_invalid_mobile",
        "Enter a valid UAE mobile number.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const name = input.customerName.trim();
    if (name === "") {
      throw new ApplicationException(
        "checkout_name_required",
        "Enter your name.",
        HttpStatus.BAD_REQUEST,
      );
    }
    let commerceCustomerId: string | undefined;
    try {
      const identity = this.securityContext.current().identity;
      if (identity.kind === "customer") {
        commerceCustomerId = await resolveCommerceCustomerId(this.database, identity.identityId);
      }
    } catch {
      commerceCustomerId = undefined; // No session -- a guest Checkout, entirely normal.
    }
    return { commerceCustomerId, mobile, name };
  }

  // ------------------------------------------------------------- Address

  /** Public: reused by C3 so a `savedAddressId` submitted at Place Order
   * time is re-verified against the session again -- never trusted from the
   * earlier C2 review. */
  public async resolveAddress(
    input: ValidateCheckoutDto,
    commerceCustomerId: string | undefined,
  ): Promise<{
    readonly address: string;
    readonly area: string | null;
    readonly areaId: string | null;
    readonly deliveryInstructions: string | null;
    readonly emirate: string;
    readonly emirateId: string;
    readonly locationLink: string | null;
  }> {
    if (input.savedAddressId !== undefined) {
      if (commerceCustomerId === undefined) {
        // A guest has no saved addresses to own -- never even attempt the
        // lookup, so no timing/existence signal about the id leaks (§74).
        throw new ApplicationException(
          "checkout_address_required",
          "Enter a delivery address.",
          HttpStatus.BAD_REQUEST,
        );
      }
      // Saved addresses are a pre-existing, separate feature
      // (`commerce_customer_addresses`) that still stores Emirate/Area as
      // free text -- out of scope for this pass (no migration is permitted
      // here, and this prompt is scoped to the Checkout's OWN new-address
      // entry, not the saved-address model). Its emirate/area therefore
      // still resolve to `null` ids -- `resolveDeliveryFee` falls back to
      // its pre-existing name-matching path for exactly this case, unchanged
      // from before this fix, and ONLY this case.
      const result = await sql<{
        address: string;
        area: string | null;
        deliveryInstructions: string | null;
        emirate: string;
        locationLink: string | null;
      }>`
        select address, area, delivery_instructions as "deliveryInstructions",
               emirate, location_link as "locationLink"
          from commerce_customer_addresses
         where id = ${input.savedAddressId}::uuid and commerce_customer_id = ${commerceCustomerId}::uuid
      `.execute(this.database);
      const row = result.rows[0];
      if (row === undefined) {
        // Deliberately the SAME "not found" a nonexistent id would produce --
        // never distinguishes "belongs to someone else" from "doesn't exist"
        // (§74).
        throw new ApplicationException(
          "checkout_address_not_found",
          "That saved address could not be found.",
          HttpStatus.NOT_FOUND,
        );
      }
      const emirateRow = await sql<{ id: string }>`
        select id from emirates where lower(name_en) = lower(${row.emirate}) or lower(name_ar) = lower(${row.emirate})
      `.execute(this.database);
      return { ...row, areaId: null, emirateId: emirateRow.rows[0]?.id ?? "" };
    }
    if (input.newAddress === undefined) {
      throw new ApplicationException(
        "checkout_address_required",
        "Enter a delivery address.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const address = input.newAddress.address.trim();
    if (address === "") {
      throw new ApplicationException(
        "checkout_address_required",
        "Enter your delivery address.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const emirateRow = await sql<{ id: string; nameEn: string; nameAr: string }>`
      select id, name_en as "nameEn", name_ar as "nameAr"
        from emirates where id = ${input.newAddress.emirateId}::uuid and is_active
    `.execute(this.database);
    const emirate = emirateRow.rows[0];
    if (emirate === undefined) {
      // Same generic message a customer sees for "no Emirate chosen" -- an
      // id for a disabled/unknown Emirate carries no more information than
      // that.
      throw new ApplicationException(
        "checkout_area_invalid",
        "Select a valid Emirate.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const areaRow = await sql<{ id: string; nameEn: string; nameAr: string | null }>`
      select a.id, a.name_en as "nameEn", a.name_ar as "nameAr"
        from areas a
       where a.id = ${input.newAddress.areaId}::uuid
         and a.emirate_id = ${input.newAddress.emirateId}::uuid
         and a.is_active
    `.execute(this.database);
    const area = areaRow.rows[0];
    if (area === undefined) {
      // §4: typed-but-unselected text must never resolve to a guessed Area --
      // an id that does not belong to this Emirate (or does not exist, or is
      // disabled) is a normal validation failure, not a fabricated match.
      throw new ApplicationException(
        "checkout_area_invalid",
        "Select a valid Area from the list.",
        HttpStatus.BAD_REQUEST,
      );
    }
    return {
      address,
      area: area.nameEn,
      areaId: area.id,
      deliveryInstructions: input.newAddress.deliveryInstructions?.trim() || null,
      emirate: emirate.nameEn,
      emirateId: emirate.id,
      locationLink: input.newAddress.locationLink?.trim() || null,
    };
  }

  // ------------------------------------------------------------- Cart lines

  /** Public: reused by C3 immediately before Store Order creation -- the
   * SAME re-resolution the Checkout preview performs, run fresh again at
   * submission time so a Product/option/price change between Review and
   * Place Order is caught, never carried over from the earlier call. */
  public async revalidateLines(
    storefrontId: string,
    cartLines: ValidateCheckoutDto["cartLines"],
  ): Promise<readonly CheckoutLineResult[]> {
    const results: CheckoutLineResult[] = [];
    for (const line of cartLines) {
      const product = await sql<{
        availabilityStatus: string;
        id: string;
        lifecycleStatus: string;
        maximumQuantity: number | null;
        minimumQuantity: number | null;
        name: string;
        sellingPrice: string;
      }>`
        select availability_status as "availabilityStatus", id, lifecycle_status as "lifecycleStatus",
               maximum_quantity as "maximumQuantity", minimum_quantity as "minimumQuantity",
               name, selling_price as "sellingPrice"
          from trader_storefront_products
         where storefront_id = ${storefrontId}::uuid and lower(slug) = lower(${line.productSlug})
      `.execute(this.database);
      const productRow = product.rows[0];
      if (productRow === undefined) {
        results.push(
          this.invalidLine(line, "product_not_found", "This product is no longer listed.", "0.00"),
        );
        continue;
      }
      if (productRow.lifecycleStatus !== "active") {
        results.push(
          this.invalidLine(
            line,
            "product_inactive",
            "This product is no longer listed.",
            productRow.sellingPrice,
          ),
        );
        continue;
      }
      if (productRow.availabilityStatus !== "available") {
        results.push(
          this.invalidLine(
            line,
            "product_unavailable",
            "This product is currently unavailable.",
            productRow.sellingPrice,
          ),
        );
        continue;
      }
      const min = productRow.minimumQuantity ?? 1;
      const max = productRow.maximumQuantity;
      if (line.quantity < min || (max !== null && line.quantity > max)) {
        results.push(
          this.invalidLine(
            line,
            "invalid_quantity",
            "The quantity requested is not available for this product.",
            productRow.sellingPrice,
          ),
        );
        continue;
      }

      const optionResult = await this.revalidateOptions(productRow.id, line);
      if (optionResult.issue !== null) {
        results.push(
          this.invalidLine(line, "option_invalid", optionResult.issue, productRow.sellingPrice),
        );
        continue;
      }

      const unitPrice = Money.from(productRow.sellingPrice);
      results.push({
        issue: null,
        lineSubtotal: unitPrice.multiplyByInteger(line.quantity).toString(),
        priceChanged: false,
        productId: productRow.id,
        productName: productRow.name,
        productSlug: line.productSlug,
        quantity: line.quantity,
        selectedOptionValueIds: optionResult.optionValueIds,
        selectedOptions: line.selectedOptions,
        unitPrice: unitPrice.toString(),
        valid: true,
      });
    }
    return results;
  }

  private invalidLine(
    line: ValidateCheckoutDto["cartLines"][number],
    issue: string,
    message: string,
    lastKnownPrice: string,
  ): CheckoutLineResult {
    return {
      issue: message,
      lineSubtotal: "0.00",
      priceChanged: false,
      productId: null,
      productName: line.productSlug,
      productSlug: line.productSlug,
      quantity: line.quantity,
      selectedOptionValueIds: [],
      selectedOptions: line.selectedOptions,
      unitPrice: lastKnownPrice,
      valid: false,
    };
  }

  /** Returns a human-readable issue (or `null`) plus the resolved internal
   * option-value ids for every submitted selection -- never substitutes a
   * removed value silently (§15/§20 of C3). */
  private async revalidateOptions(
    productId: string,
    line: ValidateCheckoutDto["cartLines"][number],
  ): Promise<{ readonly issue: string | null; readonly optionValueIds: readonly string[] }> {
    const groups = await sql<{ id: string; isRequired: boolean; name: string }>`
      select id, is_required as "isRequired", name
        from trader_storefront_product_option_groups
       where product_id = ${productId}::uuid and is_active
    `.execute(this.database);

    const optionValueIds: string[] = [];
    for (const group of groups.rows) {
      const selected = line.selectedOptions.find((option) => option.groupName === group.name);
      if (selected === undefined) {
        if (group.isRequired) return { issue: `Select a ${group.name}.`, optionValueIds: [] };
        continue;
      }
      const value = await sql<{ id: string }>`
        select id from trader_storefront_product_option_values
         where option_group_id = ${group.id}::uuid and value = ${selected.value} and is_active
      `.execute(this.database);
      const valueRow = value.rows[0];
      if (valueRow === undefined) {
        return {
          issue: `The selected ${group.name} is no longer available. Choose again.`,
          optionValueIds: [],
        };
      }
      optionValueIds.push(valueRow.id);
    }
    return { issue: null, optionValueIds };
  }

  // ------------------------------------------------------------- Delivery

  /**
   * Public (not `private`) so `StoreOrderSubmissionService` (Customer
   * Commerce Prompt C3) can call the EXACT SAME eligibility/pricing logic a
   * moment before creating a Store Order, rather than re-implementing it a
   * second time. Every query inside reads `this.database` fresh on every
   * call -- calling this from C3 is reuse of CODE, not reuse of a stale C2
   * preview result; the C2 preview itself is never passed in or trusted.
   */
  public async resolveDelivery(
    store: { readonly id: string; readonly traderCommerceId: string },
    address: {
      readonly area: string | null;
      readonly areaId: string | null;
      readonly emirate: string;
      readonly emirateId: string;
    },
    selectedDeliveryCompanyId: string | undefined,
    warnings: string[],
  ): Promise<{
    readonly customerDeliveryFee: string;
    readonly deliveryOptions: readonly CheckoutDeliveryOption[];
    readonly selectedDeliveryCompany: CheckoutDeliveryOption | null;
    readonly zeroCompanyMessage: string | null;
  }> {
    const relationships = await sql<{
      companyId: string;
      companyName: string;
      isDefault: boolean;
      traderId: string | null;
    }>`
      select r.company_id as "companyId", c.name_en as "companyName",
             r.is_default_for_store_orders as "isDefault", r.trader_id as "traderId"
        from trader_delivery_company_relationships r
        join companies c on c.id = r.company_id
       where r.trader_commerce_id = ${store.traderCommerceId}::uuid
         and r.status = 'active' and r.enabled_for_store_orders
       order by r.is_default_for_store_orders desc, c.name_en
    `.execute(this.database);

    const priced: CheckoutDeliveryOption[] = [];
    for (const relationship of relationships.rows) {
      if (relationship.traderId === null) continue; // No Company-scoped Trader mapping -- cannot price safely.
      const fee = await this.resolveDeliveryFee(
        relationship.companyId,
        relationship.traderId,
        address.emirateId,
        address.areaId,
        address.area,
      );
      if (fee === null) continue; // §43: no pricing rule -> ineligible for this destination, never guessed.
      priced.push({
        companyId: relationship.companyId,
        customerDeliveryFee: fee.toString(),
        isDefault: relationship.isDefault,
        name: relationship.companyName,
      });
    }

    if (priced.length === 0) {
      return {
        customerDeliveryFee: "0.00",
        deliveryOptions: [],
        selectedDeliveryCompany: null,
        zeroCompanyMessage: "Delivery will be confirmed by the store after you place the order.",
      };
    }
    if (priced.length === 1) {
      return {
        customerDeliveryFee: priced[0]!.customerDeliveryFee,
        deliveryOptions: priced,
        selectedDeliveryCompany: priced[0]!,
        zeroCompanyMessage: null,
      };
    }
    // Multiple eligible: an explicit, valid selection wins; otherwise the
    // Trader's own default (already sorted first); otherwise the first
    // eligible option. An unrelated id is a normal business error, not
    // silently ignored (§76).
    let chosen: CheckoutDeliveryOption;
    if (selectedDeliveryCompanyId !== undefined) {
      const match = priced.find((option) => option.companyId === selectedDeliveryCompanyId);
      if (match === undefined) {
        throw new ApplicationException(
          "checkout_delivery_company_invalid",
          "The selected delivery company is not available for this store.",
          HttpStatus.BAD_REQUEST,
        );
      }
      chosen = match;
    } else {
      chosen = priced.find((option) => option.isDefault) ?? priced[0]!;
      if (!priced.some((option) => option.isDefault)) {
        // Contradictory data: multiple eligible relationships, none marked
        // default. Not a crash -- an unhandled exception here would be, so
        // this is intentionally NOT thrown; the caller still gets a usable
        // Checkout (first eligible option), and the inconsistency is
        // recorded as a warning for support to see (§34).
        warnings.push(
          "No default delivery company is configured; the first eligible option was used.",
        );
      }
    }
    return {
      customerDeliveryFee: chosen.customerDeliveryFee,
      deliveryOptions: priced,
      selectedDeliveryCompany: chosen,
      zeroCompanyMessage: null,
    };
  }

  /** Area → Emirate → global, the same hierarchy `resolveServiceFee`
   * (Trader Portal Order pricing) already uses against `trader_service_prices`
   * -- reimplemented here permission-agnostically because that method is
   * private and coupled to authenticated Trader-Portal Order semantics
   * (override/zero-fee-reason gating that does not apply to a Customer
   * Checkout preview). Returns `null` when no row resolves at all -- never a
   * guessed fee (§43).
   *
   * Pre-production fix: `areas` rows are Company-scoped, so a customer's ONE
   * structured Area selection (resolved against whichever Company's Areas the
   * public picker searched) does not necessarily share a row id with every
   * OTHER eligible Company's own Area configuration for the same place. When
   * this Company's own `areaId` is known directly (the common case -- the
   * picker searched exactly this Company's Areas), pricing is a pure id
   * lookup, never text. Only for a genuinely DIFFERENT eligible Company is a
   * name match performed -- and even then against the canonical resolved
   * Area name from the database (`resolveAddress`'s own lookup), never
   * against anything the customer typed. The pre-existing saved-address path
   * (no structured id at all, `resolvedAreaId === null`) uses the same name
   * fallback, unchanged from before this fix. */
  private async resolveDeliveryFee(
    companyId: string,
    traderId: string,
    emirateId: string,
    resolvedAreaId: string | null,
    areaText: string | null,
  ): Promise<Money | null> {
    let areaId: string | null = null;
    if (resolvedAreaId !== null) {
      const owned = await sql<{ id: string }>`
        select id from areas where id = ${resolvedAreaId}::uuid and company_id = ${companyId}::uuid
      `.execute(this.database);
      areaId = owned.rows[0]?.id ?? null;
    }
    if (areaId === null && areaText !== null && areaText !== "") {
      const area = await sql<{ id: string }>`
        select id from areas
         where company_id = ${companyId}::uuid and emirate_id = ${emirateId}::uuid
           and (lower(name_en) = lower(${areaText}) or lower(name_ar) = lower(${areaText}))
           and is_active
      `.execute(this.database);
      areaId = area.rows[0]?.id ?? null;
    }

    const price = await sql<{ serviceFee: string }>`
      select service_fee::text as "serviceFee" from trader_service_prices
       where company_id = ${companyId}::uuid and trader_id = ${traderId}::uuid
         and (area_id = ${areaId}::uuid or (area_id is null and emirate_id = ${emirateId}::uuid) or (area_id is null and emirate_id is null))
       order by (area_id is not null) desc, (emirate_id is not null) desc
       limit 1
    `.execute(this.database);
    const row = price.rows[0];
    return row === undefined ? null : Money.from(row.serviceFee);
  }
}
