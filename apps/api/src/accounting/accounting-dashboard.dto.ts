import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsUUID, Matches } from "class-validator";

import { paymentPositionPartyTypes } from "./payment-position.dto.js";
import type { PaymentPositionPartyType } from "./payment-position.service.js";

/**
 * Accounting Dashboard filters.
 *
 * Party types are imported from the Payment Position contract rather than
 * retyped: the dashboard's Money Position section is that service's answer, and
 * a second list of party types would eventually accept one the service cannot
 * resolve.
 */
export class AccountingDashboardQueryDto {
  @ApiPropertyOptional({ example: "2026-01-01" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "dateFrom must be YYYY-MM-DD" })
  public readonly dateFrom?: string;

  @ApiPropertyOptional({ example: "2026-01-31" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "dateTo must be YYYY-MM-DD" })
  public readonly dateTo?: string;

  /**
   * A Cash OR Bank account id. Which kind it is need not be stated: the
   * dashboard resolves it against both masters and reports the kind back.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  public readonly accountId?: string;

  @ApiPropertyOptional({ enum: paymentPositionPartyTypes })
  @IsOptional()
  @IsIn(paymentPositionPartyTypes)
  public readonly partyType?: PaymentPositionPartyType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  public readonly partyId?: string;
}
