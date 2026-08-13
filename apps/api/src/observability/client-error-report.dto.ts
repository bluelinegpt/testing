import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";

const sourceApps = ["web", "api", "platform-web", "store", "mobile"] as const;
const severities = ["high", "medium", "low"] as const;
const statuses = ["open", "resolved"] as const;

/**
 * What a frontend error boundary posts the moment it catches a crash.
 *
 * Deliberately small and forgiving: this fires from inside error-handling
 * code, at the worst possible moment for the client to also be doing careful
 * validation. `severity` defaults to `"high"` server-side rather than being
 * required here -- an app should never fail to REPORT a crash just because
 * it couldn't also classify it.
 */
export class ReportClientErrorDto {
  @IsIn(sourceApps)
  public readonly sourceApp!: (typeof sourceApps)[number];

  @IsString()
  @MaxLength(2000)
  public readonly message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  public readonly stack?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly path?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly correlationId?: string;

  // The __APP_VERSION__ the crashing build was running -- see VersionBadge
  // and the Deployment Registry. Ties a crash directly to "which commit was
  // this" without the Platform Administrator having to ask.
  @IsOptional()
  @IsString()
  @MaxLength(40)
  public readonly appCommit?: string;
}

/**
 * Filters for the Platform's error list.
 *
 * `whitelist` + `forbidNonWhitelisted` mean these are the only accepted
 * query parameters -- see the "type-only DTO import" bug this session
 * already found and fixed elsewhere in this codebase for why that matters:
 * every DTO used in a `@Query()`/`@Body()` here MUST be imported as a value,
 * not `import type`, or the whole endpoint 400s on every field.
 */
export class ListClientErrorReportsQueryDto {
  @IsOptional()
  @IsUUID()
  public readonly companyId?: string;

  @IsOptional()
  @IsIn(sourceApps)
  public readonly sourceApp?: (typeof sourceApps)[number];

  @IsOptional()
  @IsIn(severities)
  public readonly severity?: (typeof severities)[number];

  @IsOptional()
  @IsIn(statuses)
  public readonly status?: (typeof statuses)[number];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  public readonly search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public readonly page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  public readonly pageSize?: number;
}

/**
 * The triage fields a Platform Administrator can change after the fact.
 * Never the fields that describe what actually happened (message, stack,
 * correlationId, path, appCommit, occurredAt) -- see this migration's own
 * comment for why those stay immutable.
 */
export class UpdateClientErrorReportDto {
  @IsOptional()
  @IsIn(severities)
  public readonly severity?: (typeof severities)[number];

  @IsOptional()
  @IsIn(statuses)
  public readonly status?: (typeof statuses)[number];

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  public readonly explanation?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  public readonly resolutionNotes?: string;
}
