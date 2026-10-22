import { Body, Controller, Get, HttpStatus, Inject, Param, Put, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsBoolean, IsOptional, IsString, Length } from "class-validator";
import type { Request } from "express";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { correlationIdOf, PlatformAuditService } from "./platform-audit.service.js";
import {
  PLATFORM_COMPANIES_MANAGE,
  PLATFORM_COMPANIES_READ,
  RequirePlatformPermissions,
} from "./platform-authorization.js";
import { PlatformTargetCompanyGuard } from "./platform-target-company.guard.js";

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

/** Change one or both switches; `reason` is kept in the audit trail. */
export class ChangeCompanySettlementOptionsDto {
  @IsOptional()
  @IsBoolean()
  public oneScreen?: boolean;

  @IsOptional()
  @IsBoolean()
  public codShortfall?: boolean;

  @Transform(trim)
  @IsString()
  @Length(1, 500)
  public reason!: string;
}

export interface CompanySettlementOptions {
  /** COD below the fee on a "Pay by Customer" Order is charged to the Trader (new Orders). */
  readonly codShortfall: boolean;
  /** One-screen Trader Settlement: Draft -> Preview -> Post, no Money Received, collect from Trader. */
  readonly oneScreen: boolean;
  /** For the decision: Orders paid to the Trader whose Money Received was never confirmed. */
  readonly ordersWaitingReceipt: number;
  /** For the decision: open settlement drafts. */
  readonly openDrafts: number;
}

/**
 * Platform Administration -> Companies -> selected Company -> Trader
 * Settlement options (Aiman, 22 Oct 2026).
 *
 * The two per-Company switches behind the one-screen settlement work, so a
 * Company can be moved onto it -- and back again -- without a deploy or a
 * database change by hand. Only the switches change: no Order, settlement,
 * receivable or money is touched. Turning one off is a full rollback for new
 * work; what was posted while it was on stays valid (see each switch's notes in
 * the Platform screen). Every change is audited with its reason.
 */
@ApiTags("platform company settlement options")
@ApiBearerAuth()
@Controller("platform/companies/:companyId/settlement-options")
@UseGuards(PlatformTargetCompanyGuard)
export class PlatformCompanySettlementOptionsController {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(PlatformAuditService) private readonly audit: PlatformAuditService,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
  ) {}

  @ApiOperation({ summary: "Trader Settlement options of the selected Company" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_READ)
  @Get()
  public settlementOptions(@Param("companyId") companyId: string): Promise<CompanySettlementOptions> {
    return this.read(companyId);
  }

  @ApiOperation({ summary: "Turn the selected Company's Trader Settlement options on or off" })
  @RequirePlatformPermissions(PLATFORM_COMPANIES_MANAGE)
  @Put()
  public async updateSettlementOptions(
    @Param("companyId") companyId: string,
    @Body() input: ChangeCompanySettlementOptionsDto,
    @Req() request: Request,
  ): Promise<CompanySettlementOptions> {
    if (input.oneScreen === undefined && input.codShortfall === undefined) {
      throw new ApplicationException(
        "settlement_options_nothing_to_change",
        "Choose an option to change",
        HttpStatus.BAD_REQUEST,
      );
    }
    const before = await this.read(companyId);
    await sql`
      update companies
         set settlement_one_screen_enabled = ${input.oneScreen ?? before.oneScreen},
             trader_pays_cod_shortfall = ${input.codShortfall ?? before.codShortfall},
             updated_at = now()
       where id = ${companyId}::uuid
    `.execute(this.database);
    const after = await this.read(companyId);
    await this.audit.record({
      action: "platform.company.settlement_options_changed",
      actorAccountId: this.identities.current().identityId,
      after: { codShortfall: after.codShortfall, oneScreen: after.oneScreen },
      before: { codShortfall: before.codShortfall, oneScreen: before.oneScreen },
      companyId,
      correlationId: correlationIdOf(request),
      reason: input.reason,
      subjectId: companyId,
      subjectType: "company",
    });
    return after;
  }

  private async read(companyId: string): Promise<CompanySettlementOptions> {
    const row = (
      await sql<{ codShortfall: boolean | null; oneScreen: boolean | null; openDrafts: number; ordersWaitingReceipt: number }>`
        select (to_jsonb(c) ->> 'settlement_one_screen_enabled')::boolean as "oneScreen",
               (to_jsonb(c) ->> 'trader_pays_cod_shortfall')::boolean as "codShortfall",
               (select count(*)::int from trader_settlement_drafts d
                 where d.company_id = c.id and d.status = 'draft') as "openDrafts",
               (select count(*)::int from orders o
                 where o.company_id = c.id and o.delivery_status in ('delivered', 'closed')
                   and o.trader_settlement_status = 'money_sent_to_trader') as "ordersWaitingReceipt"
          from companies c
         where c.id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (row === undefined) {
      throw new ApplicationException("company_not_found", "Company not found", HttpStatus.NOT_FOUND);
    }
    return {
      codShortfall: row.codShortfall === true,
      oneScreen: row.oneScreen === true,
      openDrafts: row.openDrafts,
      ordersWaitingReceipt: row.ordersWaitingReceipt,
    };
  }
}
