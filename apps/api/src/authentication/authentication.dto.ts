import { Transform } from "class-transformer";
import { IsString, Length } from "class-validator";

export class LoginDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 320)
  public identifier!: string;

  @IsString()
  @Length(8, 256)
  public password!: string;
}

/**
 * Company sign-in carries no Company identifier. The tenant is resolved from
 * the request host by CompanyHostResolver, so a caller cannot aim a login at a
 * Company it was not served by.
 */
export class CompanyLoginDto extends LoginDto {}

export class ChangePasswordDto {
  @IsString()
  @Length(8, 256)
  public currentPassword!: string;

  @IsString()
  @Length(8, 256)
  public newPassword!: string;
}
