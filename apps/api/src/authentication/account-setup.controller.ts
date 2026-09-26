import { Body, Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsString, Length } from "class-validator";
import type { Request } from "express";

import { AccountSetupService } from "./account-setup.service.js";
import { Public } from "./authentication.decorators.js";

/**
 * The Company-facing end of account activation and password recovery.
 *
 * Deliberately PUBLIC and deliberately not on the Platform API. A Platform
 * Administrator creates the account and issues the link; the Company user
 * establishes their own credential. Putting this behind a session would be
 * circular — the whole point is that the person has no way in yet.
 *
 * The token is the only authority these endpoints accept. There is no account
 * identifier, no Company identifier and no email in the request: supplying one
 * would let a caller aim a valid token at a different account, and asking for
 * an email would turn the endpoint into an account-existence oracle.
 */
export class AccountSetupTokenDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(32, 128)
  public token!: string;
}

export class CompleteAccountSetupDto extends AccountSetupTokenDto {
  /**
   * The same length rule the rest of the product applies
   * (`ChangePasswordDto`, `LoginDto`). Deliberately not a stricter,
   * Platform-only policy: a password that satisfies account setup but fails the
   * ordinary change-password screen would be a trap.
   */
  @IsString()
  @Length(8, 256)
  public password!: string;
}

@ApiTags("account setup")
@Controller("auth/account-setup")
export class AccountSetupController {
  public constructor(@Inject(AccountSetupService) private readonly setup: AccountSetupService) {}

  /**
   * Describes the link so the page can greet the right person.
   *
   * Returns the account's own display name, username and Company. That is
   * information the legitimate holder of the token already has; it is not
   * reachable without a valid, unexpired, unused token.
   */
  @Public()
  @ApiOperation({ summary: "Describe an account-setup link" })
  @HttpCode(200)
  @Post("describe")
  public describe(@Body() input: AccountSetupTokenDto): Promise<object> {
    return this.setup.describe(input.token);
  }

  @Public()
  @ApiOperation({ summary: "Set a password using an account-setup link" })
  @HttpCode(204)
  @Post("complete")
  public async complete(
    @Body() input: CompleteAccountSetupDto,
    @Req() request: Request,
  ): Promise<void> {
    await this.setup.complete(
      input.token,
      input.password,
      String(request.id ?? request.headers["x-correlation-id"] ?? "account-setup"),
    );
  }
}
