import { Transform, Type } from "class-transformer";
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";

/**
 * Company request contracts.
 *
 * ---------------------------------------------------------------------------
 * ONLY BUSINESS FIELDS CROSS THIS BOUNDARY
 * ---------------------------------------------------------------------------
 *
 * The global validation pipe runs with `whitelist` and `forbidNonWhitelisted`,
 * so a request carrying anything not declared here is REJECTED rather than
 * quietly stripped. That is what keeps `companyId`, `createdBy`, account
 * identifiers, lifecycle timestamps, template file paths and Chart-of-Accounts
 * content out of the request surface entirely — there is no field for them, so
 * sending one fails.
 *
 * Everything else is resolved server-side: identifiers, timestamps, the acting
 * administrator, and the template contents.
 */

const environments = ["development", "demo", "sandbox", "trial", "production"] as const;
const statuses = ["draft", "active", "suspended", "disabled", "closed"] as const;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

export class CompanyListQueryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  public search?: string;

  @IsOptional()
  @IsIn(statuses)
  public status?: (typeof statuses)[number];

  @IsOptional()
  @IsIn(environments)
  public environment?: (typeof environments)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // Capped so a caller cannot turn the list into a full-table export.
  @Max(100)
  public pageSize?: number;

  @IsOptional()
  @IsIn(["code", "name", "status", "environment", "createdAt"])
  public sort?: string;

  @IsOptional()
  @IsIn(["asc", "desc"])
  public direction?: "asc" | "desc";
}

export class CreateCompanyDto {
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  public name!: string;

  /**
   * Uppercased on the way in so `dev-acme` and `DEV-ACME` cannot both exist.
   * `companies_code_unique` indexes `lower(code)`, so the database would refuse
   * the second one anyway — normalising here turns a constraint violation into
   * a predictable value.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Length(2, 63)
  @Matches(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, {
    message: "subdomain must be a valid DNS label",
  })
  public subdomain?: string;

  @IsIn(environments)
  public environment!: (typeof environments)[number];

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z]{2}$/, { message: "countryCode must be a two-letter ISO code" })
  public countryCode?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  public timezone?: string;

  @IsOptional()
  @IsIn(["en", "ar"])
  public defaultLanguage?: "en" | "ar";

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  public contactName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  public telephone?: string;

  /**
   * Company-chosen business-day start. Optional: when omitted the approved
   * template's default applies, which is the whole point of a template default.
   */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "businessDayStart must be HH:MM" })
  public businessDayStart?: string;

  @IsOptional()
  @Transform(trim)
  @IsEmail()
  @Length(1, 320)
  public email?: string;

  /**
   * The template is chosen by CODE and VERSION from the server's approved
   * registry. There is deliberately no field for template content, a file path
   * or a URL.
   */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  public accountingTemplateCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public accountingTemplateVersion?: number;
}

/**
 * Profile edit.
 *
 * `code`, `subdomain` and `environment` are absent by design. Each is either a
 * reference used elsewhere or a safety property a future reset will depend on,
 * so none of them may be changed by a casual field edit. Environment in
 * particular is immutable after creation in this phase — a production Company
 * silently becoming non-production is precisely the failure a destructive
 * maintenance guard must never allow.
 */
export class UpdateCompanyProfileDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  public name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 200)
  public nameAr?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 120)
  public contactName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 40)
  public telephone?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 320)
  public email?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 500)
  public addressEn?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 100)
  public tradeLicenseNumber?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 100)
  public taxRegistrationNumber?: string;
}

/** A reason is required for the transitions a person will later have to explain. */
export class LifecycleActionDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(3, 500)
  public reason?: string;
}

export class SuspendCompanyDto {
  @Transform(trim)
  @IsString()
  @Length(3, 500)
  public reason!: string;
}

export class CloseCompanyDto extends SuspendCompanyDto {
  @Transform(trim)
  @IsString()
  @Length(7, 80)
  public confirmation!: string;
}

export class ResetCompanyDataDto {
  @Transform(trim)
  @IsString()
  @Length(7, 80)
  public confirmation!: string;
}

export class CreateCompanyDeletionBackupDto {
  @IsUUID()
  public operationId!: string;
}

export class PermanentDeleteCompanyDto {
  @IsUUID()
  public operationId!: string;

  @IsUUID()
  public previewId!: string;

  @Transform(trim)
  @IsString()
  @Length(8, 80)
  public confirmation!: string;

  @Transform(trim)
  @IsString()
  @Length(8, 200)
  public idempotencyKey!: string;
}
