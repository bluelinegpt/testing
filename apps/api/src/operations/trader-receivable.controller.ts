import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { RequireAnyPermission, RequireIdentityKinds } from "../authentication/authentication.decorators.js";
// Runtime class values are required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  CancelTraderReceivableDto,
  CreateTraderCollectionDto,
  CreateTraderReceivableDto,
  ProposeTraderReceivableAllocationDto,
  ReverseTraderCollectionDto,
  TraderCollectionListQueryDto,
  TraderCollectionSummaryQueryDto,
  TraderReceivableEligibleQueryDto,
} from "./operations.dto.js";
import {
  type CreateTraderCollectionResult,
  type CreateTraderReceivableResult,
  type Page,
  type ReverseTraderCollectionResult,
  type TraderAllocationProposal,
  type TraderCollectionDetail,
  type TraderCollectionListRow,
  type TraderCollectionReportData,
  TraderReceivableService,
  type TraderReceivableEligibleRow,
  type TraderReceivableSummary,
} from "./trader-receivable.service.js";

/**
 * Trader Receivable / Collect Money from Trader — the reverse money-flow
 * direction from Trader Settlement (Trader -> Company). A distinct
 * controller under its own `operations/trader-receivables` prefix, never
 * `operations/settlements/*`, so no route here can ever be confused with or
 * shadow a Trader Settlement, Money Sent/Received, or Driver Collection
 * route. No PDF endpoint exists yet — `report-data` returns JSON only.
 */
@ApiTags("operations")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("operations/trader-receivables")
export class TraderReceivableController {
  public constructor(
    @Inject(TraderReceivableService) private readonly traderReceivables: TraderReceivableService,
  ) {}

  @RequireAnyPermission("trader_receivables.create", "users_roles.manage")
  @ApiOperation({ summary: "Server-authoritative summary cards for Trader receivables/collections" })
  @Get("summary")
  public summary(
    @Query() query: TraderCollectionSummaryQueryDto,
  ): Promise<TraderReceivableSummary> {
    return this.traderReceivables.summary(query);
  }

  @RequireAnyPermission("trader_receivables.create", "users_roles.manage")
  @ApiOperation({ summary: "Eligible Trader receivables for a Collection, paginated" })
  @Get("eligible")
  public eligible(
    @Query() query: TraderReceivableEligibleQueryDto,
  ): Promise<Page<TraderReceivableEligibleRow>> {
    return this.traderReceivables.eligibleReceivables(query);
  }

  @RequireAnyPermission("trader_receivables.create", "users_roles.manage")
  @ApiOperation({ summary: "List Trader collections, paginated" })
  @Get("collections")
  public collections(
    @Query() query: TraderCollectionListQueryDto,
  ): Promise<Page<TraderCollectionListRow>> {
    return this.traderReceivables.list(query);
  }

  @RequireAnyPermission("trader_receivables.create", "users_roles.manage")
  @ApiOperation({ summary: "Oldest-first default allocation proposal for a Trader collection" })
  @Post("allocation-proposal")
  public allocationProposal(
    @Body() input: ProposeTraderReceivableAllocationDto,
  ): Promise<TraderAllocationProposal> {
    return this.traderReceivables.proposeAllocation(input);
  }

  @RequireAnyPermission("trader_receivables.create", "users_roles.manage")
  @ApiOperation({ summary: "Create a Trader receivable" })
  @Post("receivables")
  public createReceivable(
    @Body() input: CreateTraderReceivableDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ): Promise<CreateTraderReceivableResult> {
    return this.traderReceivables.createReceivable(input, this.correlationId(request), idempotencyKey);
  }

  @RequireAnyPermission("trader_receivables.create", "users_roles.manage")
  @ApiOperation({ summary: "Cancel a Trader receivable before anything has been collected" })
  @Post("receivables/:receivableId/cancel")
  public cancelReceivable(
    @Param("receivableId", new ParseUUIDPipe()) receivableId: string,
    @Body() input: CancelTraderReceivableDto,
    @Req() request: Request,
  ): Promise<{ readonly receivableId: string; readonly status: string }> {
    return this.traderReceivables.cancelReceivable(receivableId, input, this.correlationId(request));
  }

  @RequireAnyPermission("trader_receivables.create", "users_roles.manage")
  @ApiOperation({ summary: "Confirm a full or partial Trader collection with explicit allocation" })
  @Post("collections")
  public createCollection(
    @Body() input: CreateTraderCollectionDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ): Promise<CreateTraderCollectionResult> {
    return this.traderReceivables.confirmCollection(input, this.correlationId(request), idempotencyKey);
  }

  @RequireAnyPermission("trader_receivables.create", "users_roles.manage")
  @ApiOperation({ summary: "Show one Trader collection in full detail" })
  @Get("collections/:collectionId")
  public collectionDetail(
    @Param("collectionId", new ParseUUIDPipe()) collectionId: string,
  ): Promise<TraderCollectionDetail> {
    return this.traderReceivables.detail(collectionId);
  }

  @RequireAnyPermission("trader_receivables.create", "reports.export", "users_roles.manage")
  @ApiOperation({ summary: "Server-authoritative report data for the Trader Payment Receipt" })
  @Get("collections/:collectionId/report-data")
  public collectionReportData(
    @Param("collectionId", new ParseUUIDPipe()) collectionId: string,
  ): Promise<TraderCollectionReportData> {
    return this.traderReceivables.reportData(collectionId);
  }

  @RequireAnyPermission("trader_receivables.reverse", "users_roles.manage")
  @ApiOperation({ summary: "Reverse a confirmed Trader collection with a reason" })
  @Post("collections/:collectionId/reverse")
  public reverseCollection(
    @Param("collectionId", new ParseUUIDPipe()) collectionId: string,
    @Body() input: ReverseTraderCollectionDto,
    @Req() request: Request,
  ): Promise<ReverseTraderCollectionResult> {
    return this.traderReceivables.reverseCollection(
      collectionId,
      input.reason,
      this.correlationId(request),
    );
  }

  private correlationId(request: Request): string {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}
