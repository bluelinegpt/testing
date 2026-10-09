import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";

import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_SURFACES,
  ANNOUNCEMENT_TYPES,
  MAX_ANNOUNCEMENT_BODY_LENGTH,
  MAX_ANNOUNCEMENT_COMPANIES,
  MAX_ANNOUNCEMENT_TITLE_LENGTH,
} from "../announcements/announcements.js";

/**
 * Create or replace a Platform announcement. The service re-checks the whole
 * announcement (languages complete, dates in order, targets exist); these
 * decorators only keep malformed input out.
 */
export class SavePlatformAnnouncementDto {
  @ApiProperty({ enum: ANNOUNCEMENT_TYPES })
  @IsIn(ANNOUNCEMENT_TYPES)
  public readonly type!: string;

  @ApiPropertyOptional({ maxLength: MAX_ANNOUNCEMENT_TITLE_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ANNOUNCEMENT_TITLE_LENGTH)
  public readonly titleEn?: string | null;

  @ApiPropertyOptional({ maxLength: MAX_ANNOUNCEMENT_TITLE_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ANNOUNCEMENT_TITLE_LENGTH)
  public readonly titleAr?: string | null;

  @ApiPropertyOptional({ maxLength: MAX_ANNOUNCEMENT_BODY_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ANNOUNCEMENT_BODY_LENGTH)
  public readonly bodyEn?: string | null;

  @ApiPropertyOptional({ maxLength: MAX_ANNOUNCEMENT_BODY_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ANNOUNCEMENT_BODY_LENGTH)
  public readonly bodyAr?: string | null;

  @ApiProperty({ description: "ISO 8601 instant with an offset, e.g. 2026-10-14T01:00:00.000Z" })
  @IsISO8601({ strict: true })
  public readonly showFrom!: string;

  @ApiProperty({ description: "ISO 8601 instant with an offset" })
  @IsISO8601({ strict: true })
  public readonly showUntil!: string;

  @ApiProperty({ enum: ANNOUNCEMENT_SURFACES, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ANNOUNCEMENT_SURFACES.length)
  @IsIn(ANNOUNCEMENT_SURFACES, { each: true })
  public readonly surfaces!: string[];

  @ApiProperty({ enum: ANNOUNCEMENT_AUDIENCES })
  @IsIn(ANNOUNCEMENT_AUDIENCES)
  public readonly audience!: string;

  @ApiPropertyOptional({ type: [String], description: "Required for selected_companies" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ANNOUNCEMENT_COMPANIES)
  @IsUUID("all", { each: true })
  public readonly companyIds?: string[];
}
