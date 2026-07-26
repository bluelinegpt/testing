import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

import { RequestSecurityContextStore } from "./request-security-context.js";

@Injectable()
export class RequestSecurityContextMiddleware implements NestMiddleware {
  public constructor(
    @Inject(RequestSecurityContextStore) private readonly store: RequestSecurityContextStore,
  ) {}

  public use(_request: Request, _response: Response, next: NextFunction): void {
    this.store.runRequest(next);
  }
}
