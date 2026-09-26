import { storeConfiguration } from "../config/environment.js";

import type { CustomerAuthResult } from "./customer-auth-client.js";

/**
 * Shared Commerce Foundation Prompt 3C: Customer My Orders/Detail and public
 * guest tracking.
 *
 * Reuses the exact `request()` shape `customer-auth-client.ts` already
 * established (`credentials: "include"`, the `X-Blueline-Session` CSRF
 * header, the `{error:{code,message}}` envelope) rather than inventing a
 * second convention -- the only difference is that the tracking call is
 * unauthenticated, which needs no special handling since the header is
 * ignored server-side when there is no session cookie.
 */

const sessionCsrfHeader = "x-blueline-session";
const sessionCsrfValue = "cookie";

interface RawErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<CustomerAuthResult<T>> {
  try {
    const response = await fetch(`${storeConfiguration.apiBaseUrl}/${path}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        [sessionCsrfHeader]: sessionCsrfValue,
      },
      method,
    });
    const payload = (await response.json().catch(() => ({}))) as RawErrorBody & T;
    if (!response.ok) {
      return {
        error: {
          errorCode: payload.error?.code ?? "unknown_error",
          message: payload.error?.message ?? "Something went wrong. Please try again.",
        },
        kind: "error",
      };
    }
    return { kind: "ok", value: payload };
  } catch {
    return {
      error: { errorCode: "network_error", message: "Could not reach the server. Please try again." },
      kind: "error",
    };
  }
}

/** Mirrors the API's `StoreOrderStatus` union (`store-order.constants.ts`) --
 * kept as a plain string union here rather than importing across the
 * apps/api boundary, matching how every other Store-side type in this app
 * (`commerce-types.ts`) is its own hand-kept mirror of the API contract. */
export type StoreOrderStatus =
  | "awaiting_trader_confirmation"
  | "cancelled"
  | "completed_external"
  | "confirmed"
  | "converted_to_delivery"
  | "draft"
  | "submitted";

export interface CustomerOrderSummary {
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

export interface CustomerOrderSummaryPage {
  readonly items: readonly CustomerOrderSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface CustomerOrderItem {
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

export interface LinkedDeliverySummary {
  readonly deliveredAt: string | null;
  readonly deliveryCompanyName: string | null;
  readonly deliveryStatus: string;
  readonly updatedAt: string | null;
}

export interface CustomerOrderDetail {
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
  readonly deliverySummary: LinkedDeliverySummary | null;
  readonly id: string;
  readonly items: readonly CustomerOrderItem[];
  readonly productSubtotal: string;
  readonly status: StoreOrderStatus;
  readonly storeDisplayName: string;
  readonly storeOrderNumber: string;
  readonly storeSlug: string;
  readonly submittedAt: string | null;
}

export type TrackingResult = Omit<CustomerOrderDetail, "customerMobile" | "customerName">;

export function fetchCustomerOrders(options: {
  readonly page?: number;
  readonly pageSize?: number;
  readonly status?: StoreOrderStatus;
} = {}): Promise<CustomerAuthResult<CustomerOrderSummaryPage>> {
  const params = new URLSearchParams();
  if (options.page !== undefined) params.set("page", String(options.page));
  if (options.pageSize !== undefined) params.set("pageSize", String(options.pageSize));
  if (options.status !== undefined) params.set("status", options.status);
  const query = params.toString();
  return request("GET", `commerce/customer/orders${query === "" ? "" : `?${query}`}`);
}

export function fetchCustomerOrderDetail(
  storeOrderNumber: string,
): Promise<CustomerAuthResult<CustomerOrderDetail>> {
  return request("GET", `commerce/customer/orders/${encodeURIComponent(storeOrderNumber)}`);
}

export function trackStoreOrder(input: {
  readonly mobile: string;
  readonly storeOrderNumber: string;
  readonly trackingToken: string;
}): Promise<CustomerAuthResult<TrackingResult>> {
  return request("POST", "public/store-orders/track", input);
}
