import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from "class-validator";

export const accountingReportKinds = [
  "trial-balance",
  "general-ledger",
  "account-statement",
  "profit-and-loss",
  "balance-sheet",
  "cash-movement",
  "general-expenses",
  "vat",
] as const;
export type AccountingReportKind = (typeof accountingReportKinds)[number];

export class AccountingReportQueryDto {
  @IsOptional() @IsDateString()
  public readonly dateFrom?: string;

  @IsOptional() @IsDateString()
  public readonly dateTo?: string;

  @IsOptional() @IsDateString()
  public readonly asOfDate?: string;

  @IsOptional() @IsUUID()
  public readonly accountId?: string;

  @IsOptional() @IsUUID()
  public readonly categoryId?: string;

  @IsOptional() @IsIn(["en", "ar"])
  public readonly language?: "en" | "ar";

  @IsOptional() @Transform(({ value }) => value === true || value === "true") @IsBoolean()
  public readonly includeZero?: boolean;

  @IsOptional() @Transform(({ value }) => value === true || value === "true") @IsBoolean()
  public readonly comparative?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  public readonly page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  public readonly pageSize?: number;
}

export class AccountingReportExportQueryDto extends AccountingReportQueryDto {
  @IsIn(["csv", "xlsx"])
  public readonly format!: "csv" | "xlsx";
}

export class AccountingDocumentQueryDto {
  @IsOptional() @IsIn(["en", "ar"])
  public readonly language?: "en" | "ar";

  @IsOptional() @IsString()
  public readonly disposition?: string;
}
