import { IsOptional, IsUUID } from "class-validator";

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
