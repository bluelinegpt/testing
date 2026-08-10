import { webConfiguration } from "../configuration/environment.js";

const defaultTimeoutMs = 10_000;

interface ApiErrorPayload {
  readonly error?: {
    readonly code?: string;
    readonly details?: readonly string[];
    readonly message?: string;
  };
}

export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly details?: readonly string[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  private accessToken: string | undefined;

  public constructor(private readonly timeoutMs = defaultTimeoutMs) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("API timeout must be a positive integer");
    }
  }

  public setAccessToken(accessToken: string | undefined): void {
    this.accessToken = accessToken;
  }

  public get<TResponse>(path: string, signal?: AbortSignal): Promise<TResponse> {
    return this.request<TResponse>(path, { method: "GET", signal });
  }

  public post<TResponse>(
    path: string,
    body?: unknown,
    headers?: Readonly<Record<string, string>>,
  ): Promise<TResponse> {
    return this.request<TResponse>(path, { body, headers, method: "POST" });
  }

  public put<TResponse>(
    path: string,
    body?: unknown,
    headers?: Readonly<Record<string, string>>,
  ): Promise<TResponse> {
    return this.request<TResponse>(path, { body, headers, method: "PUT" });
  }

  public patch<TResponse>(
    path: string,
    body?: unknown,
    headers?: Readonly<Record<string, string>>,
  ): Promise<TResponse> {
    return this.request<TResponse>(path, { body, headers, method: "PATCH" });
  }

  public delete<TResponse>(path: string): Promise<TResponse> {
    return this.request<TResponse>(path, { method: "DELETE" });
  }

  /**
   * Upload multipart/form-data (e.g. a logo file). The browser sets the
   * multipart boundary itself, so no Content-Type header is added here.
   */
  public postMultipart<TResponse>(path: string, form: FormData): Promise<TResponse> {
    return this.request<TResponse>(path, { body: form, method: "POST" });
  }

  /** Fetch raw bytes (e.g. an authenticated logo stream) as a Blob. */
  public async getBinary(path: string, signal?: AbortSignal): Promise<Blob> {
    return this.requestBinary(path, { method: "GET", signal });
  }

  /**
   * Fetch raw bytes for a report that needs a request body (e.g. a PDF built
   * from a selected-Order list too large for a query string).
   */
  public async postBinary(path: string, body: unknown, signal?: AbortSignal): Promise<Blob> {
    return this.requestBinary(path, { body, method: "POST", signal });
  }

  private async requestBinary(
    path: string,
    input: { body?: unknown; method: string; signal?: AbortSignal | undefined },
  ): Promise<Blob> {
    const controller = new AbortController();
    const abortRequest = () => controller.abort(input.signal?.reason);
    const timeout = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);
    if (input.signal?.aborted === true) abortRequest();
    else input.signal?.addEventListener("abort", abortRequest, { once: true });
    const headers: Record<string, string> = { Accept: "application/pdf,image/png,image/jpeg,*/*" };
    if (this.accessToken !== undefined) headers.Authorization = `Bearer ${this.accessToken}`;
    // Names the request as coming from this application. A cross-site form
    // cannot set it, which is what makes the HttpOnly session cookie safe to
    // rely on for state-changing calls.
    headers["X-Blueline-Session"] = "cookie";
    if (input.body !== undefined) headers["Content-Type"] = "application/json";
    try {
      const response = await fetch(`${webConfiguration.apiBaseUrl}/${path.replace(/^\//, "")}`, {
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        cache: "no-store",
        // Carries the HttpOnly session cookie, which is what survives a
        // reload, a pasted URL and a new tab. The token itself is never
        // readable by page scripts.
        credentials: "include",
        headers,
        method: input.method,
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = this.isJson(response.headers.get("content-type"))
          ? ((await response.json()) as ApiErrorPayload)
          : undefined;
        throw new ApiError(
          payload?.error?.message ?? "The request could not be completed",
          payload?.error?.code ?? "request_failed",
          response.status,
          payload?.error?.details,
        );
      }
      return await response.blob();
    } catch (error) {
      if (this.isAbortError(error)) {
        throw new ApiError("The request timed out. Please try again.", "request_timeout", 408);
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortRequest);
    }
  }

  private async request<TResponse>(
    path: string,
    input: {
      body?: unknown;
      headers?: Readonly<Record<string, string>> | undefined;
      method: string;
      signal?: AbortSignal | undefined;
    },
  ): Promise<TResponse> {
    const controller = new AbortController();
    const abortRequest = () => controller.abort(input.signal?.reason);
    const timeout = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);
    if (input.signal?.aborted === true) abortRequest();
    else input.signal?.addEventListener("abort", abortRequest, { once: true });

    const isFormData = input.body instanceof FormData;
    const headers: Record<string, string> = { Accept: "application/json" };
    Object.assign(headers, input.headers);
    if (this.accessToken !== undefined) headers.Authorization = `Bearer ${this.accessToken}`;
    // Names the request as coming from this application. A cross-site form
    // cannot set it, which is what makes the HttpOnly session cookie safe to
    // rely on for state-changing calls.
    headers["X-Blueline-Session"] = "cookie";
    // FormData sets its own multipart Content-Type (with boundary); JSON bodies
    // are serialized and declared as application/json.
    if (input.body !== undefined && !isFormData) headers["Content-Type"] = "application/json";

    try {
      const body =
        input.body === undefined
          ? {}
          : { body: isFormData ? (input.body as FormData) : JSON.stringify(input.body) };
      const response = await fetch(`${webConfiguration.apiBaseUrl}/${path.replace(/^\//, "")}`, {
        ...body,
        cache: "no-store",
        // Carries the HttpOnly session cookie, which is what survives a
        // reload, a pasted URL and a new tab. The token itself is never
        // readable by page scripts.
        credentials: "include",
        headers,
        method: input.method,
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = this.isJson(response.headers.get("content-type"))
          ? ((await response.json()) as ApiErrorPayload)
          : undefined;
        throw new ApiError(
          payload?.error?.message ?? "The request could not be completed",
          payload?.error?.code ?? "request_failed",
          response.status,
          payload?.error?.details,
        );
      }
      if (response.status === 204) return undefined as TResponse;
      const contentType = response.headers.get("content-type");
      if (!this.isJson(contentType)) {
        const text = await response.text();
        if (text.trim() === "") return undefined as TResponse;
        throw new Error("The API returned an unsupported content type");
      }
      return (await response.json()) as TResponse;
    } catch (error) {
      if (this.isAbortError(error)) {
        throw new ApiError("The request timed out. Please try again.", "request_timeout", 408);
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortRequest);
    }
  }

  private isJson(contentType: string | null): boolean {
    const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
    return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
  }

  private isAbortError(error: unknown): boolean {
    return (
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError") ||
      (error instanceof Error && error.message.toLowerCase().includes("signal is aborted"))
    );
  }
}
