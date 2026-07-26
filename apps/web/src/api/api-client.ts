import { webConfiguration } from "../configuration/environment.js";

const defaultTimeoutMs = 10_000;

interface ApiErrorPayload {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
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

  public put<TResponse>(path: string, body?: unknown): Promise<TResponse> {
    return this.request<TResponse>(path, { body, method: "PUT" });
  }

  public patch<TResponse>(path: string, body?: unknown): Promise<TResponse> {
    return this.request<TResponse>(path, { body, method: "PATCH" });
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

    const headers: Record<string, string> = { Accept: "application/json" };
    Object.assign(headers, input.headers);
    if (this.accessToken !== undefined) headers.Authorization = `Bearer ${this.accessToken}`;
    if (input.body !== undefined) headers["Content-Type"] = "application/json";

    try {
      const response = await fetch(`${webConfiguration.apiBaseUrl}/${path.replace(/^\//, "")}`, {
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
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
        );
      }
      if (response.status === 204) return undefined as TResponse;
      if (!this.isJson(response.headers.get("content-type"))) {
        throw new Error("The API returned an unsupported content type");
      }
      return (await response.json()) as TResponse;
    } finally {
      globalThis.clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abortRequest);
    }
  }

  private isJson(contentType: string | null): boolean {
    const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
    return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
  }
}
