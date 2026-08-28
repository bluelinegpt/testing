import { Module } from "@nestjs/common";
import { CustomerQuotesModule } from "../customer-quotes/customer-quotes.module.js";
import { DemoRequestsModule } from "../demo-requests/demo-requests.module.js";
import { OperationsModule } from "../operations/operations.module.js";
import { TraderApplicationsModule } from "../trader-applications/trader-applications.module.js";
import { PublicAgentController } from "./agent.controller.js";
import { AgentModelRouterProvider } from "./agent-model-router.provider.js";
import { AgentService } from "./agent.service.js";
import { OpenAIModelProvider } from "./openai-model.provider.js";
import { RulesAgentModelProvider } from "./rules-agent-model.provider.js";

@Module({
  controllers: [PublicAgentController],
  exports: [AgentService],
  // OperationsModule is imported so Yousef reuses the exact same
  // PublicTrackingService the central `/track` website flow calls -- never
  // a second tracking implementation inside the Agent (see
  // PublicTrackingService's own module-export comment).
  imports: [CustomerQuotesModule, DemoRequestsModule, TraderApplicationsModule, OperationsModule],
  providers: [AgentService, AgentModelRouterProvider, OpenAIModelProvider, RulesAgentModelProvider],
})
export class AgentModule {}
