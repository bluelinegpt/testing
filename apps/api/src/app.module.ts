import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";

import { AccountingModule } from "./accounting/accounting.module.js";
import { configuration, validateEnvironment } from "./configuration/environment.js";
import { AuthenticationModule } from "./authentication/authentication.module.js";
import { CommerceIntegrationModule } from "./commerce-integrations/commerce-integration.module.js";
import { CommerceCustomerModule } from "./commerce-customer/commerce-customer.module.js";
import { CompanyConfigurationModule } from "./company-configuration/company-configuration.module.js";
import { CompanyProfileModule } from "./company-profile/company-profile.module.js";
import { CommunicationModule } from "./communication/communication.module.js";
import { HealthModule } from "./health/health.module.js";
import { DatabaseModule } from "./infrastructure/database/database.module.js";
import { DemoRequestsModule } from "./demo-requests/demo-requests.module.js";
import { WebsiteCmsModule } from "./website-cms/website-cms.module.js";
import { TraderApplicationsModule } from "./trader-applications/trader-applications.module.js";
import { CustomerQuotesModule } from "./customer-quotes/customer-quotes.module.js";
import { BlogModule } from "./blog/blog.module.js";
import { AgentModule } from "./agent/agent.module.js";
import { createHttpLoggerOptions } from "./logging/http-logger.config.js";
import { ObservabilityModule } from "./observability/observability.module.js";
import { CommerceCheckoutModule } from "./commerce-checkout/commerce-checkout.module.js";
import { OperationsModule } from "./operations/operations.module.js";
import { PlatformModule } from "./platform/platform.module.js";
import { PushModule } from "./push/push.module.js";
import { RoleModule } from "./roles/role.module.js";
import { MarketplaceModule } from "./marketplace/marketplace.module.js";
import { StorefrontModule } from "./storefront/storefront.module.js";
import { StoreOrderModule } from "./store-order/store-order.module.js";
import { StoreOrderConversionModule } from "./store-order-conversion/store-order-conversion.module.js";
import { SupportModule } from "./support/support.module.js";
import { UserAdministrationModule } from "./users/user-administration.module.js";
import { WhatsAppModule } from "./whatsapp/whatsapp.module.js";

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
    DemoRequestsModule,
    WebsiteCmsModule,
    TraderApplicationsModule,
    CustomerQuotesModule,
    BlogModule,
    AgentModule,
    AuthenticationModule,
    CommerceIntegrationModule,
    CommerceCustomerModule,
    CommerceCheckoutModule,
    AccountingModule,
    CompanyConfigurationModule,
    CompanyProfileModule,
    CommunicationModule,
    ObservabilityModule,
    OperationsModule,
    PlatformModule,
    PushModule,
    RoleModule,
    StorefrontModule,
    StoreOrderModule,
    StoreOrderConversionModule,
    MarketplaceModule,
    SupportModule,
    UserAdministrationModule,
    WhatsAppModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
