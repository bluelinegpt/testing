import type { ArgumentsHost } from "@nestjs/common";
import type { Logger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";

import { ApiExceptionFilter } from "./api-exception.filter.js";

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
});
