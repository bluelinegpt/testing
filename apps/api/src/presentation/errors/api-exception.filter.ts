import { BadRequestException, Catch, HttpException, HttpStatus } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import type { Logger } from "nestjs-pino";

import { ApplicationException } from "./application.exception.js";
import type { ApiErrorResponse } from "../http/api-error.js";
import type { ClientErrorReportService } from "../../observability/client-error-report.service.js";
import type { RequestSecurityContextStore } from "../../security/request-security-context.js";

const statusCodes: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: "validation_error",
  [HttpStatus.UNAUTHORIZED]: "authentication_error",
  [HttpStatus.FORBIDDEN]: "authorization_error",
  [HttpStatus.NOT_FOUND]: "resource_not_found",
  [HttpStatus.CONFLICT]: "conflict",
  [HttpStatus.TOO_MANY_REQUESTS]: "rate_limit_exceeded",
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  /**
   * `errorReports`/`securityContext` are optional: this filter is
   * constructed manually in `bootstrap/create-application.ts`, outside
   * Nest's DI container, and `api-exception.filter.test.ts` constructs it
   * with just a logger. When present, every 500 is also captured into
   * `client_error_reports` for the Platform's Error Handler screen -- the
   * same durable record a frontend crash gets, so a backend crash no longer
   * lives only in Render's own log stream.
   */
  public constructor(
    private readonly logger: Logger,
    private readonly errorReports?: ClientErrorReportService,
    private readonly securityContext?: RequestSecurityContextStore,
  ) {}

  public catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const correlationId = String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");

    const databaseIntegrityError = this.isDatabaseIntegrityError(exception);
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : databaseIntegrityError
          ? HttpStatus.CONFLICT
          : 500;
    const safeMessage = databaseIntegrityError
      ? "The operation conflicts with current data integrity rules."
      : status >= 500
        ? "An unexpected error occurred."
        : this.message(exception);
    const details = this.validationDetails(exception);
    const code =
      exception instanceof ApplicationException
        ? exception.errorCode
        : databaseIntegrityError
          ? "database_integrity_conflict"
          : (statusCodes[status] ?? "internal_server_error");

    const payload: ApiErrorResponse = {
      error: {
        code,
        correlationId,
        message: safeMessage,
        ...(details === undefined ? {} : { details }),
      },
    };

    if (status >= 500) {
      this.logger.error({ correlationId, err: exception, path: request.path }, "Request failed");
      // Fire-and-forget: `reportServerError` already swallows its own
      // failures internally, and this response must reach the caller
      // whether or not the capture succeeds.
      void this.errorReports?.reportServerError({
        correlationId,
        identity: this.currentIdentity(),
        // Deliberately the REAL message, not `safeMessage` above -- that one
        // is sanitized for the client ("An unexpected error occurred.") and
        // would make every captured report identical and useless to triage.
        message: exception instanceof Error ? exception.message : String(exception),
        path: request.path,
        stack: exception instanceof Error ? (exception.stack ?? null) : null,
      });
    } else if (databaseIntegrityError) {
      /**
       * A database integrity error is logged with the constraint that fired.
       *
       * The CLIENT still gets only the generic message above — constraint and
       * table names describe the schema and must not leave the server. But
       * without them on the server side, "The operation conflicts with current
       * data integrity rules." is equally opaque to whoever has to diagnose it:
       * the correlation id in the user's screenshot leads to a log line that
       * repeats the same non-answer.
       *
       * These fields are the standard `pg` error shape. Nothing user-supplied
       * is logged — `detail` can quote the offending VALUES, so it is
       * deliberately excluded rather than risk writing personal data into logs.
       */
      const pgError = exception as {
        code?: string;
        constraint?: string;
        message?: string;
        table?: string;
      };
      this.logger.warn(
        {
          code,
          constraint: pgError.constraint,
          correlationId,
          path: request.path,
          pgCode: pgError.code,
          /**
           * The message is logged because for a DEFERRED constraint trigger it
           * is the only identifying field there is.
           *
           * Those fire at COMMIT rather than at the offending statement, so
           * PostgreSQL reports no `constraint` and no `table` — both come back
           * undefined. This repository leans on them heavily ("An Active Role
           * must have at least one Permission", "An Active User must have at
           * least one active Role"), so without the message a whole class of
           * rejection logs as a row of undefineds.
           *
           * Safe to log: these messages are fixed strings raised by the trigger
           * bodies and contain no user data. `detail`, which quotes the
           * offending VALUES, is still deliberately excluded.
           */
          reason: pgError.message,
          status,
          table: pgError.table,
        },
        "Request rejected by a database constraint",
      );
    } else {
      this.logger.warn({ code, correlationId, path: request.path, status }, "Request rejected");
    }
    response.status(status).json(payload);
  }

  /**
   * Best-effort read of the current identity, for the captured error report
   * only. `RequestSecurityContextStore.current()` throws when no identity is
   * attached -- entirely normal for a request that failed before
   * authentication ran -- so that case is just "no identity to attach",
   * never a reason to lose the capture.
   */
  private currentIdentity() {
    try {
      return this.securityContext?.current().identity;
    } catch {
      return undefined;
    }
  }

  private isDatabaseIntegrityError(exception: unknown): boolean {
    if (typeof exception !== "object" || exception === null || !("code" in exception)) {
      return false;
    }
    return ["23503", "23505", "23514", "23P01"].includes(String(exception.code));
  }

  private message(exception: unknown): string {
    if (exception instanceof ApplicationException || exception instanceof HttpException) {
      const response = exception.getResponse();
      if (typeof response === "string") {
        return response;
      }
      if (typeof response === "object" && response !== null && "message" in response) {
        const message = response.message;
        return Array.isArray(message) ? "Request validation failed." : String(message);
      }
      return exception.message;
    }
    return "An unexpected error occurred.";
  }

  private validationDetails(exception: unknown): readonly string[] | undefined {
    if (exception instanceof ApplicationException) {
      return exception.validationDetails;
    }
    if (exception instanceof BadRequestException) {
      const response = exception.getResponse();
      if (typeof response === "object" && response !== null && "message" in response) {
        const message = response.message;
        if (Array.isArray(message)) {
          return message.map(String);
        }
      }
    }
    return undefined;
  }
}
