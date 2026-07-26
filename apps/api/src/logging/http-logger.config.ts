import { randomUUID } from "node:crypto";

import type { Options } from "pino-http";

const correlationIdPattern = /^[A-Za-z0-9._-]{8,128}$/;

export function createHttpLoggerOptions(): Options {
  return {
    autoLogging: {
      ignore: (request) => request.url === "/api/v1/health/live",
    },
    customProps: () => ({
      environment: process.env.NODE_ENV ?? "development",
      service: "blueline-api",
    }),
    genReqId(request, response) {
      const supplied = request.headers["x-correlation-id"];
      const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
      const correlationId =
        candidate !== undefined && correlationIdPattern.test(candidate) ? candidate : randomUUID();
      response.setHeader("x-correlation-id", correlationId);
      return correlationId;
    },
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      censor: "[REDACTED]",
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body.password",
        "req.body.token",
        "res.headers.set-cookie",
      ],
    },
  };
}
