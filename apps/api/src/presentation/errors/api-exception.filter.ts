import { BadRequestException, Catch, HttpException, HttpStatus } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import type { Logger } from "nestjs-pino";

import { ApplicationException } from "./application.exception.js";
import type { ApiErrorResponse } from "../http/api-error.js";

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
  public constructor(private readonly logger: Logger) {}

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
    } else {
      this.logger.warn({ code, correlationId, path: request.path, status }, "Request rejected");
    }
    response.status(status).json(payload);
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
