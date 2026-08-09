import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";

import { AccountingModule } from "./accounting/accounting.module.js";
import { configuration, validateEnvironment } from "./configuration/environment.js";
import { AuthenticationModule } from "./authentication/authentication.module.js";
import { CompanyConfigurationModule } from "./company-configuration/company-configuration.module.js";
import { CompanyProfileModule } from "./company-profile/company-profile.module.js";
import { CommunicationModule } from "./communication/communication.module.js";
import { HealthModule } from "./health/health.module.js";
import { DatabaseModule } from "./infrastructure/database/database.module.js";
import { createHttpLoggerOptions } from "./logging/http-logger.config.js";
import { OperationsModule } from "./operations/operations.module.js";
import { PlatformModule } from "./platform/platform.module.js";
import { RoleModule } from "./roles/role.module.js";
import { MarketplaceModule } from "./marketplace/marketplace.module.js";
import { StorefrontModule } from "./storefront/storefront.module.js";
import { SupportModule } from "./support/support.module.js";
import { UserAdministrationModule } from "./users/user-administration.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      envFilePath: [".env", "../../.env"],
      isGlobal: true,
      load: [configuration],
      validate: validateEnvironment,
    }),
    LoggerModule.forRoot({ pinoHttp: createHttpLoggerOptions() }),
    ThrottlerModule.forRoot([
      {
        limit: Number.parseInt(process.env.RATE_LIMIT_MAX ?? "100", 10),
        ttl: Number.parseInt(process.env.RATE_LIMIT_TTL_MS ?? "60000", 10),
      },
    ]),
    DatabaseModule,
    AuthenticationModule,
    AccountingModule,
    CompanyConfigurationModule,
    CompanyProfileModule,
    CommunicationModule,
    OperationsModule,
    PlatformModule,
    RoleModule,
    StorefrontModule,
    MarketplaceModule,
    SupportModule,
    UserAdministrationModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
