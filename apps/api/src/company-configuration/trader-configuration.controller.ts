import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import {
  RequireAnyPermission,
  RequireIdentityKinds,
} from "../authentication/authentication.decorators.js";
import {
  TraderConfigurationService,
  type TraderPage,
  type TraderSummary,
} from "./trader-configuration.service.js";
// Runtime classes are required by Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ChangeTraderBankStatusDto,
  ChangeTraderStatusDto,
  CreateConfiguredTraderDto,
  CreateTraderPricingDto,
  SaveTraderBankAccountDto,
  UpdateConfiguredTraderDto,
  UpdateTraderPricingDto,
} from "./trader-configuration.dto.js";

@ApiTags("trader-configuration")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@RequireAnyPermission("users_roles.manage")
@Controller("configuration/traders")
export class TraderConfigurationController {
  public constructor(
    @Inject(TraderConfigurationService) private readonly traders: TraderConfigurationService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List Company Traders with server-side filtering" })
  public list(@Query() query: Record<string, string>): Promise<TraderPage<TraderSummary>> {
    return this.traders.traders(query);
  }

  @Post()
  public create(
    @Body() input: CreateConfiguredTraderDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.traders.create(input, this.correlationId(request));
  }

  @Get(":code")
  public detail(@Param("code") code: string): Promise<Record<string, unknown>> {
    return this.traders.trader(code);
  }

  @Patch(":traderId")
  public update(
    @Param("traderId", new ParseUUIDPipe()) traderId: string,
    @Body() input: UpdateConfiguredTraderDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.traders.update(traderId, input, this.correlationId(request));
  }

  @Patch(":traderId/status")
  public status(
    @Param("traderId", new ParseUUIDPipe()) traderId: string,
    @Body() input: ChangeTraderStatusDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.traders.changeStatus(traderId, input, this.correlationId(request));
  }

  @Post(":traderId/pricing")
  public pricing(
    @Param("traderId", new ParseUUIDPipe()) traderId: string,
    @Body() input: CreateTraderPricingDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.traders.createPricing(traderId, input, this.correlationId(request));
  }

  @Patch(":traderId/pricing/:priceId")
  public updatePricing(
    @Param("traderId", new ParseUUIDPipe()) traderId: string,
    @Param("priceId", new ParseUUIDPipe()) priceId: string,
    @Body() input: UpdateTraderPricingDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.traders.updatePricing(traderId, priceId, input, this.correlationId(request));
  }

  @Get(":traderId/orders")
  public orders(
    @Param("traderId", new ParseUUIDPipe()) traderId: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ): Promise<TraderPage<Record<string, unknown>>> {
    return this.traders.relatedOrders(traderId, Number(page), Number(pageSize));
  }

  @Get(":traderId/bank-accounts")
  public banks(
    @Param("traderId", new ParseUUIDPipe()) traderId: string,
  ): Promise<readonly Record<string, unknown>[]> {
    return this.traders.bankAccounts(traderId);
  }

  @Post(":traderId/bank-accounts")
  public createBank(
    @Param("traderId", new ParseUUIDPipe()) traderId: string,
    @Body() input: SaveTraderBankAccountDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.traders.createBank(traderId, input, this.correlationId(request));
  }

  @Patch(":traderId/bank-accounts/:bankId")
  public updateBank(
    @Param("traderId", new ParseUUIDPipe()) traderId: string,
    @Param("bankId", new ParseUUIDPipe()) bankId: string,
    @Body() input: SaveTraderBankAccountDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.traders.updateBank(traderId, bankId, input, this.correlationId(request));
  }

  @Patch(":traderId/bank-accounts/:bankId/status")
  public bankStatus(
    @Param("traderId", new ParseUUIDPipe()) traderId: string,
    @Param("bankId", new ParseUUIDPipe()) bankId: string,
    @Body() input: ChangeTraderBankStatusDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    return this.traders.changeBankStatus(traderId, bankId, input, this.correlationId(request));
  }

  private correlationId(request: Request): string {
    return String(request.id ?? request.headers["x-correlation-id"] ?? "unknown");
  }
}
