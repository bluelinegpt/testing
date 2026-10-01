import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { PDFDocument } from "pdf-lib";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
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
  type TraderReceivableDetail,
  type TraderReceivableEligibleRow,
  type TraderReceivableLedgerRow,
  type TraderReceivableSummary,
  type TraderWithBalance,
} from "./trader-receivable.service.js";
import { TraderSettlementService } from "./trader-settlement.service.js";

/**
 * Trader Receivable / Collect Money from Trader — the reverse money-flow
 * direction from Trader Settlement (Trader -> Company). A distinct
 * controller under its own `operations/trader-receivables` prefix, never
 * `operations/settlements/*`, so no route here can ever be confused with or
 * shadow a Trader Settlement, Money Sent/Received, or Driver Collection
 * route. The Trader Payment Receipt PDF is its own report, never merged with
 * the Trader Settlement Statement, Driver Collection Report, or Driver
 * Shipment Manifest.
 */
@ApiTags("operations")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("operations/trader-receivables")
export class TraderReceivableController {
  public constructor(
    @Inject(TraderReceivableService) private readonly traderReceivables: TraderReceivableService,
    @Inject(TraderSettlementService) private readonly traderSettlements: TraderSettlementService,
  ) {}

  @RequireAnyPermission("trader_receivables.create", "settlements.create", "reports.export", "users_roles.manage")
  @ApiOperation({ summary: "Merge existing Trader collection and settlement PDFs for selected Orders" })
  @Post("bulk-report/pdf")
  public async bulkReportPdf(
    @Body() input: { orderIds: string[] },
    @Query("language") language: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const ids = [...new Set(input.orderIds)].slice(0, 100);
    const documents: Buffer[] = [];
    const settlementIds = new Set<string>();
    const collectionIds = new Set<string>();
    for (const orderId of ids) {
      const settlement = await this.traderSettlements.settlementForOrder(orderId);
      if (settlement !== null && !settlementIds.has(settlement.settlementId)) {
        const report = await this.traderSettlements.settlementPdf(
          settlement.settlementId,
          language === "ar" ? "ar" : "en",
          String(request.id ?? request.headers["x-correlation-id"] ?? "unknown"),
        );
        documents.push(report.bytes);
        settlementIds.add(settlement.settlementId);
      }
      const collection = await this.traderReceivables.collectionForOrder(orderId);
      if (collection !== undefined && !collectionIds.has(collection.collectionId)) {
        const report = await this.traderReceivables.collectionPdf(
          collection.collectionId,
          language === "ar" ? "ar" : "en",
          String(request.id ?? request.headers["x-correlation-id"] ?? "unknown"),
        );
        documents.push(report.bytes);
        collectionIds.add(collection.collectionId);
      }
    }
    if (documents.length === 0) {
      response.status(HttpStatus.NO_CONTENT).send();
      return;
    }
    const merged = await PDFDocument.create();
    for (const bytes of documents) {
      const source = await PDFDocument.load(bytes);
      const pages = await merged.copyPages(source, source.getPageIndices());
      pages.forEach((page) => merged.addPage(page));
    }
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", 'inline; filename="Trader-Reports.pdf"');
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.send(Buffer.from(await merged.save()));
  }

  @RequireAnyPermission("trader_receivables.create", "users_roles.manage")
  @ApiOperation({
    summary: "Server-authoritative summary cards for Trader receivables/collections",
  })
  @Get("summary")
  public summary(
    @Query() query: TraderCollectionSummaryQueryDto,
  ): Promise<TraderReceivableSummary> {
    return this.traderReceivables.summary(query);
  }

  @RequireAnyPermission("trader_receivables.create", "users_roles.manage")
  @ApiOperation({ summary: "Traders currently owing the Company money, highest balance first" })
  @Get("traders-with-balance")
  public tradersWithBalance(): Promise<readonly TraderWithBalance[]> {
    return this.traderReceivables.tradersWithBalance();
  }

  @RequireAnyPermission("trader_receivables.create", "settlements.create", "users_roles.manage")
  @ApiOperation({
    summary: "Eligible Trader receivables for a Collection or settlement, paginated",
  })
  @Get("eligible")
  public eligible(
    @Query() query: TraderReceivableEligibleQueryDto,
  ): Promise<Page<TraderReceivableEligibleRow>> {
    return this.traderReceivables.eligibleReceivables(query);
  }

  /**
   * Distinct from `eligible` above, which only ever returns the two statuses a
   * Collection may draw from. This one returns every Receivable and names the
   * Settlement or Collection that cleared it -- without it, a Receivable
   * cleared by settlement netting is reachable from no screen in the product.
   */
  @RequireAnyPermission("trader_receivables.create", "users_roles.manage")
  @ApiOperation({
    summary: "Every Trader receivable regardless of status, with how it was cleared",
  })
  @Get("receivables")
  public receivablesLedger(
    @Query() query: TraderReceivableEligibleQueryDto,
  ): Promise<Page<TraderReceivableLedgerRow>> {
    return this.traderReceivables.receivablesLedger(query);
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
    return this.traderReceivables.createReceivable(
      input,
      this.correlationId(request),
      idempotencyKey,
    );
  }

  @RequireAnyPermission("trader_receivables.create", "users_roles.manage")
  @ApiOperation({ summary: "Show one Trader receivable in full detail" })
  @Get("receivables/:receivableId")
  public receivableDetail(
    @Param("receivableId", new ParseUUIDPipe()) receivableId: string,
  ): Promise<TraderReceivableDetail> {
    return this.traderReceivables.receivableDetail(receivableId);
  }

  @RequireAnyPermission("trader_receivables.create", "users_roles.manage")
  @ApiOperation({ summary: "Cancel a Trader receivable before anything has been collected" })
  @Post("receivables/:receivableId/cancel")
  public cancelReceivable(
    @Param("receivableId", new ParseUUIDPipe()) receivableId: string,
    @Body() input: CancelTraderReceivableDto,
    @Req() request: Request,
  ): Promise<{ readonly receivableId: string; readonly status: string }> {
    return this.traderReceivables.cancelReceivable(
      receivableId,
      input,
      this.correlationId(request),
    );
  }

  @RequireAnyPermission("trader_receivables.create", "users_roles.manage")
  @ApiOperation({ summary: "Confirm a full or partial Trader collection with explicit allocation" })
  @Post("collections")
  public createCollection(
    @Body() input: CreateTraderCollectionDto,
    @Headers("x-idempotency-key") idempotencyKey: string | undefined,
    @Req() request: Request,
  ): Promise<CreateTraderCollectionResult> {
    return this.traderReceivables.confirmCollection(
      input,
      this.correlationId(request),
      idempotencyKey,
    );
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
  @ApiOperation({ summary: "Resolve the confirmed Trader collection linked to one Order" })
  @Get("collections-for-order/:orderId")
  public collectionForOrder(
    @Param("orderId", new ParseUUIDPipe()) orderId: string,
  ): Promise<{ collectionId: string; collectionNumber: string } | undefined> {
    return this.traderReceivables.collectionForOrder(orderId);
  }

  @RequireAnyPermission("trader_receivables.create", "reports.export", "users_roles.manage")
  @ApiOperation({ summary: "Server-authoritative report data for the Trader Payment Receipt" })
  @Get("collections/:collectionId/report-data")
  public collectionReportData(
    @Param("collectionId", new ParseUUIDPipe()) collectionId: string,
  ): Promise<TraderCollectionReportData> {
    return this.traderReceivables.reportData(collectionId);
  }

  @RequireAnyPermission("trader_receivables.create", "reports.export", "users_roles.manage")
  @ApiOperation({ summary: "True downloadable PDF file for the Trader Payment Receipt" })
  @Get("collections/:collectionId/pdf")
  public async collectionPdf(
    @Param("collectionId", new ParseUUIDPipe()) collectionId: string,
    @Query("language") language: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const resolvedLanguage = language === "ar" ? "ar" : "en";
    const { bytes, filename } = await this.traderReceivables.collectionPdf(
      collectionId,
      resolvedLanguage,
      this.correlationId(request),
    );
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    response.send(bytes);
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
