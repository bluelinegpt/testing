import { Body, Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { Public } from "../authentication/authentication.decorators.js";
import { CreateDemoRequestDto } from "./demo-request.dto.js";
// Runtime import is required for Nest constructor injection metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { DemoRequestService } from "./demo-request.service.js";

@Controller("public/demo-requests")
export class PublicDemoRequestController {
  public constructor(@Inject(DemoRequestService) private readonly leads: DemoRequestService) {}
  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @HttpCode(201) @Post()
  public create(@Body() input: CreateDemoRequestDto, @Req() request: Request): Promise<{id:string;referenceNumber:string}> { return this.leads.create(input,{ip:request.ip ?? null,userAgent:request.headers["user-agent"] ?? null}); }
}
