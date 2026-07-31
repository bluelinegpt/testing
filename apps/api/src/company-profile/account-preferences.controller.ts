import { Body, Controller, Get, Inject, Patch, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { RequireIdentityKinds } from "../authentication/authentication.decorators.js";
import { type AccountPreferences, AccountPreferencesService } from "./account-preferences.service.js";
// Runtime class value is required for Nest validation metadata.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { UpdateTextLanguageDto, UpdateThemeDto } from "./company-profile.dto.js";

@ApiTags("account-preferences")
@ApiBearerAuth()
@RequireIdentityKinds("company_user")
@Controller("me/preferences")
export class AccountPreferencesController {
  public constructor(
    @Inject(AccountPreferencesService) private readonly preferences: AccountPreferencesService,
  ) {}

  @ApiOperation({ summary: "Read the signed-in user's preferences" })
  @Get()
  public myPreferences(): Promise<AccountPreferences> {
    return this.preferences.myPreferences();
  }

  @ApiOperation({ summary: "Update the signed-in user's Text Language" })
  @Patch("text-language")
  public updateTextLanguage(
    @Body() input: UpdateTextLanguageDto,
    @Req() request: Request,
  ): Promise<AccountPreferences> {
    return this.preferences.updateTextLanguage(
      input.textLanguage,
      String(request.id ?? request.headers["x-correlation-id"] ?? "unknown"),
    );
  }

  @ApiOperation({ summary: "Update the signed-in user's visual theme preference" })
  @Patch("theme")
  public updateTheme(
    @Body() input: UpdateThemeDto,
    @Req() request: Request,
  ): Promise<AccountPreferences> {
    return this.preferences.updateTheme(
      input.theme,
      String(request.id ?? request.headers["x-correlation-id"] ?? "unknown"),
    );
  }
}
