import { Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

/** Platform Administration per-Company WhatsApp controls (enable/disable,
 *  template overrides, message history). Validation mirrors the database
 *  constraints so a bad request fails as a 400, never as an SQL error. */

export class SetCompanyWhatsAppEnabledDto {
  @IsBoolean()
  public enabled!: boolean;

  /** Optional operator note shown to the Company while disabled. Only
   *  meaningful when disabling — ignored (and cleared) on enable. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public reason?: string;
}

export class UpdateCompanyWhatsAppTemplateDto {
  @IsString()
  @Length(1, 2000)
  public bodyAr!: string;

  @IsString()
  @Length(1, 2000)
  public bodyEn!: string;
}

export class ListCompanyWhatsAppMessagesQueryDto {
  /** Inclusive start date (YYYY-MM-DD, Dubai business dates). */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public from?: string;

  /** Inclusive end date (YYYY-MM-DD). */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  public to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  public pageSize?: number;
}
