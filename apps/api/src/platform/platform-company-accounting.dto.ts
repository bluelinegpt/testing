import { Transform } from "class-transformer";
import { IsString, Length, Matches, ValidateIf } from "class-validator";

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim() : value;

/**
 * Execute body for enabling or disabling a Company's GL Accounting.
 *
 * All three fields come from the preview the administrator just reviewed:
 * the typed confirmation it displayed, and the configuration version it was
 * computed against (null when the Company had no configuration row). The
 * service re-checks everything under lock; these only prove the request is a
 * confirmation of THAT preview.
 */
export class ChangeCompanyAccountingModeDto {
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  public reason!: string;

  @Transform(trim)
  @IsString()
  @Length(10, 120)
  public confirmation!: string;

  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @Matches(/^[1-9][0-9]{0,18}$/u)
  public expectedConfigurationVersion!: string | null;
}
