import { storeConfiguration } from "../config/environment.js";

/**
 * Customer Commerce Prompt C2 -- the Checkout validation/preview client.
 *
 * Modeled on `customer-auth-client.ts`'s `request()`, not on
 * `commerce-client.ts`'s anonymous `get()`: Checkout must read a logged-in
 * Customer's session when one exists (`credentials: "include"`, the same
 * `X-Blueline-Session` CSRF header every authenticated mutation already
 * requires), while still working perfectly for a guest with no cookie at
 * all -- the API resolves identity best-effort either way (see
 * `CommerceCheckoutController`'s own doc comment).
 *
 * Every call carries a client-generated `x-correlation-id` (§60 of the
 * Error Handler audit): if `validate()` throws unexpectedly, the resulting
 * Platform Error Handler report carries the SAME id this function returns
 * on failure, so a Customer can hand support one short code instead of a
 * timestamp-and-guesswork description.
 */

const sessionCsrfHeader = "x-blueline-session";
const sessionCsrfValue = "cookie";
const correlationIdHeader = "x-correlation-id";

export interface CheckoutSelectedOption {
  readonly groupName: string;
  readonly value: string;
}

export interface CheckoutCartLine {
  readonly productSlug: string;
  readonly quantity: number;
  readonly selectedOptions: readonly CheckoutSelectedOption[];
}

/**
 * Pre-production fix: Emirate/Area are structured, server-validated
 * selections -- `emirateId`/`areaId`, resolved from `fetchEmirates()`/
 * `searchAreas()` below, never free text the customer typed.
 */
export interface CheckoutAddressInput {
  readonly address: string;
  readonly areaId: string;
  readonly deliveryInstructions?: string;
  readonly emirateId: string;
  readonly locationLink?: string;
}

export interface ValidateCheckoutInput {
  readonly cartLines: readonly CheckoutCartLine[];
  readonly customerMobile: string;
  readonly customerName: string;
  readonly newAddress?: CheckoutAddressInput;
  readonly paymentMethod: "cod";
  readonly savedAddressId?: string;
  readonly selectedDeliveryCompanyId?: string;
  readonly storeSlug: string;
}

export interface CheckoutLine {
  readonly issue: string | null;
  readonly lineSubtotal: string;
  readonly productName: string;
  readonly productSlug: string;
  readonly quantity: number;
  readonly selectedOptions: readonly CheckoutSelectedOption[];
  readonly unitPrice: string;
  readonly valid: boolean;
}

export interface CheckoutDeliveryOption {
  readonly companyId: string;
  readonly customerDeliveryFee: string;
  readonly isDefault: boolean;
  readonly name: string;
}

export interface CheckoutResult {
  readonly address: {
    readonly address: string;
    readonly area: string | null;
    readonly deliveryInstructions: string | null;
    readonly emirate: string;
    readonly locationLink: string | null;
  };
  readonly canProceed: boolean;
  readonly codTotal: string;
  readonly customer: { readonly isGuest: boolean; readonly mobile: string; readonly name: string };
  readonly customerDeliveryFee: string;
  readonly deliveryOptions: readonly CheckoutDeliveryOption[];
  readonly lines: readonly CheckoutLine[];
  readonly productSubtotal: string;
  readonly selectedDeliveryCompany: CheckoutDeliveryOption | null;
  readonly store: { readonly displayName: string; readonly slug: string };
  readonly validationWarnings: readonly string[];
  readonly zeroCompanyMessage: string | null;
}

export interface CheckoutError {
  readonly correlationId: string;
  readonly errorCode: string;
  readonly message: string;
}

export type CheckoutRequestResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "error"; readonly error: CheckoutError };

export type CheckoutValidateResult = CheckoutRequestResult<CheckoutResult>;

interface RawErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly correlationId?: string;
    readonly message?: string;
  };
}

async function request<T>(path: string, input: unknown): Promise<CheckoutRequestResult<T>> {
  const correlationId = crypto.randomUUID();
  try {
    const response = await fetch(`${storeConfiguration.apiBaseUrl}/${path}`, {
      body: JSON.stringify(input),
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        [correlationIdHeader]: correlationId,
        [sessionCsrfHeader]: sessionCsrfValue,
      },
      method: "POST",
    });
    const payload = (await response.json().catch(() => ({}))) as RawErrorBody & T;
    if (!response.ok) {
      return {
        error: {
          correlationId: payload.error?.correlationId ?? correlationId,
          errorCode: payload.error?.code ?? "unknown_error",
          message: payload.error?.message ?? "Something went wrong. Please try again.",
        },
        kind: "error",
      };
    }
    return { kind: "ok", value: payload };
  } catch {
    return {
      error: {
        correlationId,
        errorCode: "network_error",
        message: "Could not reach the server. Please try again.",
      },
      kind: "error",
    };
  }
}

export function validateCheckout(input: ValidateCheckoutInput): Promise<CheckoutValidateResult> {
  return request("commerce/checkout/validate", input);
}

// ------------------------------------------------------- Emirate / Area

export interface Emirate {
  readonly code: string;
  readonly id: string;
  readonly nameAr: string;
  readonly nameEn: string;
}

export interface CheckoutArea {
  readonly code: string;
  readonly emirateId: string;
  readonly id: string;
  readonly nameAr: string | null;
  readonly nameEn: string;
}

export interface AreaSearchResult {
  readonly hasMore: boolean;
  readonly items: readonly CheckoutArea[];
}

/**
 * Pre-production fix: the read-only UAE Emirate master for the Checkout
 * address form's Emirate dropdown. A plain `GET`, unlike `validateCheckout`
 * -- there is no session/CSRF concern for a read-only public reference list.
 */
export async function fetchEmirates(): Promise<readonly Emirate[]> {
  const response = await fetch(`${storeConfiguration.apiBaseUrl}/commerce/checkout/emirates`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return [];
  return (await response.json().catch(() => [])) as readonly Emirate[];
}

/**
 * Typeahead search for the Checkout's searchable Area combobox, scoped to
 * this Store's own priceable Delivery Company server-side -- `storeSlug` is
 * the only scoping input this function ever sends.
 */
export async function searchAreas(input: {
  readonly storeSlug: string;
  readonly emirateId?: string;
  readonly search?: string;
}): Promise<AreaSearchResult> {
  const params = new URLSearchParams({ storeSlug: input.storeSlug });
  if (input.emirateId !== undefined) params.set("emirateId", input.emirateId);
  if (input.search !== undefined && input.search !== "") params.set("search", input.search);
  const response = await fetch(
    `${storeConfiguration.apiBaseUrl}/commerce/checkout/areas?${params.toString()}`,
    {
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) return { hasMore: false, items: [] };
  const payload = (await response
    .json()
    .catch(() => ({ hasMore: false, items: [] }))) as AreaSearchResult;
  return { hasMore: payload.hasMore ?? false, items: payload.items ?? [] };
}

/** Customer Commerce Prompt C3 -- "Place Order". A separate call to a
 * separate, persisting endpoint (never the preview route above); the
 * request shape reuses `ValidateCheckoutInput`'s fields plus the two C3
 * additions -- `expectedCodTotal` (the Review total the Customer just saw,
 * a UX safety check only, never authoritative) and a client-generated
 * `idempotencyKey` so a double click or a network retry cannot create two
 * Store Orders. */
export interface PlaceStoreOrderInput extends ValidateCheckoutInput {
  readonly expectedCodTotal: string;
  readonly idempotencyKey: string;
}

export interface PlaceStoreOrderItem {
  readonly brandSnapshot: string | null;
  readonly id: string;
  readonly imageUrl: string | null;
  readonly lineTotal: string;
  readonly productCodeSnapshot: string;
  readonly productNameSnapshot: string;
  readonly quantity: number;
  /** `{group, value}`, NOT `{groupName, value}` -- this is
   * `CustomerOrderItemView.selectedOptionsSnapshot`'s own shape
   * (`store-order.service.ts`), a different, older contract than C2's
   * `CheckoutSelectedOption`. Do not unify the two without also fixing
   * every existing My Orders/tracking caller of this exact shape. */
  readonly selectedOptionsSnapshot: readonly { readonly group: string; readonly value: string }[];
  readonly skuSnapshot: string | null;
  readonly unitPriceSnapshot: string;
}

export interface PlaceStoreOrderResult {
  readonly codTotal: string;
  readonly createdAt: string;
  readonly customerDeliveryFee: string;
  readonly deliveryAddress: string;
  readonly deliveryArea: string;
  readonly deliveryCompanyName: string | null;
  readonly deliveryEmirate: string;
  readonly deliveryInstructions: string | null;
  readonly id: string;
  readonly items: readonly PlaceStoreOrderItem[];
  readonly productSubtotal: string;
  /** The API's `StoreOrderStatus` union -- a raw string here deliberately,
   * translated to a friendly customer-facing label by the caller (never
   * shown raw), same convention `orders/order-status.ts` already uses. */
  readonly status: string;
  readonly storeDisplayName: string;
  readonly storeOrderNumber: string;
  readonly storeSlug: string;
  readonly submittedAt: string | null;
  /**
   * C3 corrective (Part B/N): `string` only on the ONE submission that
   * actually creates the Store Order -- `null` on every idempotent replay.
   * The raw token is never persisted anywhere after the response that
   * carries it, so a replay structurally cannot reissue it; a Customer
   * whose response was lost still has their full Store Order (every other
   * field here is identical to the original) and recovers tracking through
   * My Orders (logged in) or the Store's own support contact (guest).
   * Never stored beyond the current confirmation flow's in-memory state.
   */
  readonly trackingToken: string | null;
}

export function placeStoreOrder(
  input: PlaceStoreOrderInput,
): Promise<CheckoutRequestResult<PlaceStoreOrderResult>> {
  return request("commerce/store-orders", input);
}
