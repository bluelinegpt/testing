import { Transform } from "class-transformer";
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Length, Max, Min } from "class-validator";

/**
 * Optional Company scope for the integrity check run. Omitted means "every
 * Company" -- the Platform's own vantage point, matching how the Errors and
 * Deployment Registry screens work.
 */
export class RunIntegrityChecksQueryDto {
  @IsOptional()
  @IsUUID()
  public readonly companyId?: string;
}

export class VerifyIntegrityQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  public readonly includeAccepted = false;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(3650)
  public readonly thresholdDays = 7;
}

export class IntegrityCompanyParamsDto {
  @IsUUID()
  public readonly companyId!: string;
}

export class IntegrityCheckParamsDto extends IntegrityCompanyParamsDto {
  @IsString()
  @IsIn(["F1", "F2", "F3", "F4", "F8", "F11", "F12", "O1", "O2", "O3", "O4", "O5"])
  public readonly code!: string;
}

export class IntegrityAcceptanceParamsDto extends IntegrityCompanyParamsDto {
  @IsUUID()
  public readonly id!: string;
}

export class AcceptIntegrityDto {
  @IsString()
  @IsIn(["F1", "F2", "F3", "F4", "F8", "F11", "F12", "O1", "O2", "O3", "O4", "O5"])
  public readonly check_code!: string;
  @IsString()
  @IsNotEmpty()
  public readonly subject_type!: string;
  @IsUUID()
  public readonly subject_id!: string;
  @IsString()
  @Length(64, 64)
  public readonly fingerprint!: string;
  @IsString()
  @Length(1, 1000)
  public readonly note!: string;
}
