import { Module } from "@nestjs/common";

import { AuthenticationModule } from "../authentication/authentication.module.js";
import { CommerceCustomerAuthController } from "./commerce-customer-auth.controller.js";
import { CommerceCustomerAuthService } from "./commerce-customer-auth.service.js";
import { CommerceCustomerProfileController } from "./commerce-customer-profile.controller.js";
import { CommerceCustomerProfileService } from "./commerce-customer-profile.service.js";

/**
 * The marketplace Customer identity/authentication foundation (Shared
 * Commerce Foundation Prompt 3A). Imports `AuthenticationModule` to reuse
 * `AuthenticationService` (session/lockout/logout — see `loginCustomer`),
 * `PasswordHasher` and `SessionTokenService`, rather than duplicating any
 * of that security-critical machinery.
 */
@Module({
  controllers: [CommerceCustomerAuthController, CommerceCustomerProfileController],
  exports: [CommerceCustomerAuthService, CommerceCustomerProfileService],
  imports: [AuthenticationModule],
  providers: [CommerceCustomerAuthService, CommerceCustomerProfileService],
})
export class CommerceCustomerModule {}
