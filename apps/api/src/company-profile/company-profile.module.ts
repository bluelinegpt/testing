import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { FilesModule } from "../files/files.module.js";
import { AccountPreferencesController } from "./account-preferences.controller.js";
import { AccountPreferencesService } from "./account-preferences.service.js";
import { CompanyProfileController } from "./company-profile.controller.js";
import { CompanyProfileService } from "./company-profile.service.js";

@Module({
  imports: [AuthenticationModule, FilesModule],
  controllers: [CompanyProfileController, AccountPreferencesController],
  providers: [CompanyProfileService, AccountPreferencesService],
})
export class CompanyProfileModule {}
