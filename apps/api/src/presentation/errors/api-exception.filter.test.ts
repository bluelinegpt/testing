import { BadRequestException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import type { Logger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";

import { ApiExceptionFilter } from "./api-exception.filter.js";
import type { ClientErrorReportService } from "../../observability/client-error-report.service.js";
import type { RequestSecurityContextStore } from "../../security/request-security-context.js";

describe("ApiExceptionFilter", () => {
  it("translates PostgreSQL integrity failures without exposing database details", () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: {}, id: "correlation-1", path: "/orders" }),
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;
    const databaseError = {
      code: "23514",
      detail: "internal table and column names",
      message: "Order current Driver must match its active assignment history",
    };

    new ApiExceptionFilter(logger).catch(databaseError, host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: "database_integrity_conflict",
        correlationId: "correlation-1",
        message: "The operation conflicts with current data integrity rules.",
      },
    });
    expect(JSON.stringify(json.mock.calls)).not.toContain(databaseError.message);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  /* ---------------------------------------------------------------------
     System-Wide Error Handler Audit prompt, §56/§57/§59/§35 -- the ONE test
     file this filter had (above) constructs it with no `errorReports` at
     all, so none of these behaviours were exercised anywhere before now.
     --------------------------------------------------------------------- */

  function buildHost(overrides: Partial<{ headers: Record<string, string>; id: string; path: string }> = {}) {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: overrides.headers ?? {},
          id: overrides.id ?? "correlation-1",
          method: "GET",
          path: overrides.path ?? "/orders",
        }),
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;
    return { host, json, status };
  }

  it("captures an unexpected 500 into the central Error Handler, with the real message and correlation id", async () => {
    const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const reportServerError = vi.fn().mockResolvedValue(undefined);
    const errorReports = { reportServerError } as unknown as ClientErrorReportService;
    const securityContext = {
      current: () => ({ identity: { companyId: "company-1", identityId: "account-1", kind: "trader" } }),
    } as unknown as RequestSecurityContextStore;
    const { host, json, status } = buildHost();

    const unexpected = new Error("Cannot read properties of undefined (reading 'slug')");
    new ApiExceptionFilter(logger, errorReports, securityContext).catch(unexpected, host);
    // `reportServerError` is fired-and-forgotten (`void`); flush microtasks.
    await Promise.resolve();

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: "internal_server_error",
        correlationId: "correlation-1",
        message: "An unexpected error occurred.",
      },
    });
    expect(reportServerError).toHaveBeenCalledOnce();
    const captured = reportServerError.mock.calls[0]![0];
    expect(captured.correlationId).toBe("correlation-1");
    expect(captured.message).toBe(unexpected.message);
    expect(captured.identity).toStrictEqual({
      companyId: "company-1",
      identityId: "account-1",
      kind: "trader",
    });
  });

  it("does NOT capture an expected 400 validation error as a crash", async () => {
    const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const reportServerError = vi.fn().mockResolvedValue(undefined);
    const errorReports = { reportServerError } as unknown as ClientErrorReportService;
    const { host, status } = buildHost();

    new ApiExceptionFilter(logger, errorReports).catch(
      new BadRequestException("mobile must be a valid UAE number"),
      host,
    );
    await Promise.resolve();

    expect(status).toHaveBeenCalledWith(400);
    expect(reportServerError).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("resolves the correlation id from the x-correlation-id header when request.id is absent", async () => {
    const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const reportServerError = vi.fn().mockResolvedValue(undefined);
    const errorReports = { reportServerError } as unknown as ClientErrorReportService;
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { "x-correlation-id": "header-correlation-id" },
          id: undefined,
          method: "GET",
          path: "/orders",
        }),
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;

    new ApiExceptionFilter(logger, errorReports).catch(new Error("boom"), host);
    await Promise.resolve();

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ correlationId: "header-correlation-id" }) }),
    );
    expect(reportServerError.mock.calls[0]![0].correlationId).toBe("header-correlation-id");
  });

  it("never lets a capture failure break the error response (no recursive reporting)", () => {
    const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
    // A misbehaving capture implementation that rejects -- proves the filter
    // itself never awaits it and never tries to "report the reporting
    // failure" (§35). The real `ClientErrorReportService.reportServerError`
    // already swallows its own errors; this proves the FILTER doesn't need
    // to, and wouldn't break the caller's response even if it didn't.
    const reportServerError = vi.fn().mockRejectedValue(new Error("insert failed"));
    const errorReports = { reportServerError } as unknown as ClientErrorReportService;
    const { host, json, status } = buildHost();

    expect(() => {
      new ApiExceptionFilter(logger, errorReports).catch(new Error("original failure"), host);
    }).not.toThrow();

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledOnce();
  });

  it("still returns a safe response when no error-reporting service is wired at all", () => {
    const logger = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const { host, json, status } = buildHost();

    expect(() => {
      new ApiExceptionFilter(logger).catch(new Error("boom"), host);
    }).not.toThrow();

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledOnce();
  });
});
