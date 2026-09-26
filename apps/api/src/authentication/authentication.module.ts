import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import {
  IDENTITY_CONTEXT_ACCESSOR,
  IdentityContextAccessor,
} from "../security/identity-context.js";
import {
  AsyncIdentityContextAccessor,
  AsyncTenantContextAccessor,
  RequestSecurityContextStore,
} from "../security/request-security-context.js";
import { RequestSecurityContextMiddleware } from "../security/request-security-context.middleware.js";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";
import { CompanyMobileCodeResolver } from "../tenancy/company-mobile-code-resolver.js";
import { TENANT_CONTEXT_ACCESSOR, TenantContextAccessor } from "../tenancy/tenant-context.js";
// Re-provided here rather than imported via `PushModule` — `PushModule`
// itself imports `AuthenticationModule` (for `IdentityContextAccessor`), so
// importing back would be a module cycle. This mirrors the existing
// `OperationsHistoryWriter`/`PaymentFundingAccountService` pattern in
// `operations.module.ts`: two feature modules that need each other's leaf
// service re-provide the class directly instead of importing one another.
import { DeviceRegistrationService } from "../push/device-registration.service.js";
import { AccountSetupController } from "./account-setup.controller.js";
import { AccountSetupService } from "./account-setup.service.js";
import { AuthenticationController } from "./authentication.controller.js";
import { AuthenticationGuard } from "./authentication.guard.js";
import { AuthenticationRepository } from "./authentication.repository.js";
import { AuthenticationService } from "./authentication.service.js";
import { PasswordHasher } from "./password-hasher.js";
import { SessionTokenService } from "./session-token.service.js";
import { TemporaryPasswordService } from "./temporary-password.service.js";

@Module({
  controllers: [AuthenticationController, AccountSetupController],
  exports: [
    IdentityContextAccessor,
    AuthenticationService,
    PasswordHasher,
    TemporaryPasswordService,
    TenantContextAccessor,
    AccountSetupService,
    // The Platform target-Company guard writes the resolved Company into the
    // request store. It is exported rather than re-provided so both modules
    // share the one AsyncLocalStorage instance — two instances would mean the
    // guard wrote a target the rest of the request could not see.
    RequestSecurityContextStore,
    CompanyHostResolver,
    // Exported for `CommerceCustomerAuthModule` (Shared Commerce Foundation
    // Prompt 3A): both are already fully generic over `account_kind` and
    // company-less accounts (session creation/lookup, lockout, token
    // hashing), so the Customer auth flow reuses them directly instead of
    // duplicating session/lockout logic in a parallel repository.
    AuthenticationRepository,
    SessionTokenService,
  ],
  providers: [
    AccountSetupService,
    AuthenticationRepository,
    CompanyHostResolver,
    CompanyMobileCodeResolver,
    AuthenticationService,
    DeviceRegistrationService,
    PasswordHasher,
    SessionTokenService,
    TemporaryPasswordService,
    RequestSecurityContextStore,
    RequestSecurityContextMiddleware,
    AsyncIdentityContextAccessor,
    AsyncTenantContextAccessor,
    { provide: IdentityContextAccessor, useExisting: AsyncIdentityContextAccessor },
    { provide: IDENTITY_CONTEXT_ACCESSOR, useExisting: AsyncIdentityContextAccessor },
    { provide: TenantContextAccessor, useExisting: AsyncTenantContextAccessor },
    { provide: TENANT_CONTEXT_ACCESSOR, useExisting: AsyncTenantContextAccessor },
    { provide: APP_GUARD, useClass: AuthenticationGuard },
  ],
})
export class AuthenticationModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestSecurityContextMiddleware).forRoutes("*");
  }
}
