import { storeConfiguration } from "../config/environment.js";

/**
 * The Store's Customer authentication client.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SEPARATE FROM `commerce-client.ts`
 * ---------------------------------------------------------------------------
 *
 * `commerce-client.ts` is deliberately `credentials: "omit"` and collapses
 * every failure into two generic reasons (`not_found`/`unavailable`) — right
 * for anonymous browsing, wrong here: a login/registration form needs to
 * tell a wrong password apart from a duplicate email, and every call here IS
 * a Customer session request, so `credentials: "include"` is exactly as
 * deliberate here as `"omit"` is there.
 *
 * ---------------------------------------------------------------------------
 * CSRF: THE SAME `X-Blueline-Session` HEADER THE API ALREADY REQUIRES
 * ---------------------------------------------------------------------------
 *
 * The API's cookie-authenticated mutation guard requires a
 * `X-Blueline-Session: cookie` header on every non-GET request once a
 * session cookie exists (see `apps/api/src/authentication/session-cookie.ts`).
 * Sending it unconditionally on every mutating call here is harmless before
 * login (the request is `@Public()` and the header is simply ignored) and
 * required after it.
 */

const sessionCsrfHeader = "x-blueline-session";
const sessionCsrfValue = "cookie";

export interface CustomerAuthError {
  readonly errorCode: string;
  readonly message: string;
}

export type CustomerAuthResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "error"; readonly error: CustomerAuthError };

/**
 * The API's actual error envelope (`apps/api/src/presentation/errors/
 * api-exception.filter.ts`, `ApiExceptionFilter.catch`): every non-2xx
 * response body is `{ error: { code, message, correlationId, details? } }`,
 * never a flat `{errorCode, message}` -- matching that exactly here (rather
 * than a guessed shape) is what makes `t(`auth.errors.${errorCode}`)`
 * resolve to the correct translated message instead of always falling
 * through to the generic fallback.
 */
interface RawErrorBody {
  readonly error?: { readonly code?: string; readonly message?: string };
}

async function request<T>(
  method: "DELETE" | "GET" | "PATCH" | "POST",
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
    if (response.status === 204) return { kind: "ok", value: undefined as T };
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

export interface CustomerSession {
  readonly companyId: null;
  readonly id: string;
  readonly kind: "customer";
}

export interface CustomerProfile {
  readonly email: string | null;
  readonly mobile: string;
  readonly name: string;
  readonly preferredLanguage: string;
  readonly status: string;
}

export interface CustomerAddress {
  readonly address: string;
  readonly area: string | null;
  readonly deliveryInstructions: string | null;
  readonly emirate: string;
  readonly id: string;
  readonly isDefault: boolean;
  readonly label: string | null;
  readonly locationLink: string | null;
  readonly mobile: string;
  readonly recipientName: string;
}

export function registerCustomer(input: {
  readonly acceptedTerms: true;
  readonly email?: string;
  readonly mobile: string;
  readonly name: string;
  readonly password: string;
  readonly preferredLanguage?: "ar" | "en";
}): Promise<CustomerAuthResult<CustomerSession>> {
  return request("POST", "commerce/customer-auth/register", input);
}

export function loginCustomer(input: {
  readonly identifier: string;
  readonly password: string;
}): Promise<CustomerAuthResult<CustomerSession>> {
  return request("POST", "commerce/customer-auth/login", input);
}

export function fetchCustomerSession(): Promise<CustomerAuthResult<CustomerSession>> {
  return request("POST", "commerce/customer-auth/me");
}

export function logoutCustomer(): Promise<CustomerAuthResult<undefined>> {
  return request("POST", "commerce/customer-auth/logout");
}

export function requestCustomerPasswordReset(
  identifier: string,
): Promise<CustomerAuthResult<{ readonly acknowledged: true }>> {
  return request("POST", "commerce/customer-auth/password-reset/request", { identifier });
}

export function completeCustomerPasswordReset(input: {
  readonly newPassword: string;
  readonly token: string;
}): Promise<CustomerAuthResult<undefined>> {
  return request("POST", "commerce/customer-auth/password-reset/complete", input);
}

export function fetchCustomerProfile(): Promise<CustomerAuthResult<CustomerProfile>> {
  return request("GET", "commerce/customer/profile");
}

export function updateCustomerProfile(input: {
  readonly email?: string;
  readonly name?: string;
  readonly preferredLanguage?: "ar" | "en";
}): Promise<CustomerAuthResult<CustomerProfile>> {
  return request("PATCH", "commerce/customer/profile", input);
}

export function fetchCustomerAddresses(): Promise<CustomerAuthResult<readonly CustomerAddress[]>> {
  return request("GET", "commerce/customer/addresses");
}
