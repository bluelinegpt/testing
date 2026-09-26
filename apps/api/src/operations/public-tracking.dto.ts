import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, Length } from "class-validator";

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

/**
 * Step 1 of central public tracking: accepts EITHER the customer's Company
 * Airway Bill / Serial Number as read off their label, OR the canonical
 * Tawseelhub Order Number (`ORD-000116`) -- `PublicTrackingService` detects
 * which one this is. Matched by exact value only -- never a partial/prefix
 * search, so this can never be used to enumerate Orders. Field name kept as
 * `airwayBill` (internal API shape); the public-facing label is "Airway
 * Bill or Tawseelhub Order Number".
 */
export class LookupTrackingDto {
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  public airwayBill!: string;

  /** Only affects which language the public status label is returned in. */
  @IsOptional()
  @IsIn(["en", "ar"])
  public language?: "en" | "ar";
}

/**
 * Step 2, only reached when Step 1 found more than one eligible match. The
 * `verificationToken` is the short-lived, single-purpose, non-guessable
 * token returned by Step 1 -- it represents the ambiguous-match context, so
 * the candidate set never has to be (and never is) sent to the browser.
 */
export class VerifyTrackingDto {
  @Transform(trim)
  @IsString()
  @Length(1, 512)
  public verificationToken!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 32)
  public mobile!: string;

  /** Only affects which language the public status label is returned in. */
  @IsOptional()
  @IsIn(["en", "ar"])
  public language?: "en" | "ar";
}
