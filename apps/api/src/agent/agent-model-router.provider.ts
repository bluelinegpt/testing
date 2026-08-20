import { Inject, Injectable } from "@nestjs/common";
import type { AgentModelInput, AgentModelProvider, AgentModelResult, AgentProviderDiagnostics, AgentReplyInput } from "./agent.types.js";
import { OpenAIModelProvider } from "./openai-model.provider.js";
import { RulesAgentModelProvider } from "./rules-agent-model.provider.js";

interface ProviderEventSummary {
  at: string;
  providerType: string;
}

interface ProviderSuccessSummary extends ProviderEventSummary {
  latencyMs: number;
  model: string;
}

interface ProviderErrorSummary extends ProviderEventSummary {
  code: string;
}

export interface AgentRuntimeDiagnostics extends AgentProviderDiagnostics {
  lastSuccess: ProviderSuccessSummary | null;
  lastError: ProviderErrorSummary | null;
}

const deterministicIntents = new Set([
  "greeting",
  "small_talk",
  "thanks",
  "goodbye",
  "handoff",
  "customer_quote",
  "trader",
  "delivery_company_demo",
  "current_feature_status",
  "product_feature_question",
]);
const safetyLockedGeneralQuestions = /show me .*delivery companies|names? of delivery companies|delivery companies registered|registered .*delivery companies|delivery compan(?:y|ies) directory|company directory|which traders|traders .*using|another customer|customer.?s information|أسماء شركات التوصيل|شركات التوصيل المسجلة|أي تجار|معلومات عميل|محادثة عميل|commissions|commission|company net|net amount|marketplace priority|internal pricing/i;

@Injectable()
export class AgentModelRouterProvider implements AgentModelProvider {
  private lastSuccess: ProviderSuccessSummary | null = null;
  private lastError: ProviderErrorSummary | null = null;

  public constructor(
    @Inject(OpenAIModelProvider) private readonly openai: OpenAIModelProvider,
    @Inject(RulesAgentModelProvider) private readonly deterministic: RulesAgentModelProvider,
  ) {}

  public diagnostics(): AgentRuntimeDiagnostics {
    const forced = process.env.AGENT_MODEL_PROVIDER?.trim().toLowerCase();
    if (forced === "deterministic" || process.env.NODE_ENV === "test") {
      return { configured: true, lastError: this.lastError, lastSuccess: this.lastSuccess, model: "tawseelhub-rules-v1", providerType: "deterministic" };
    }
    if (this.openai.configured()) {
      return { configured: true, lastError: this.lastError, lastSuccess: this.lastSuccess, model: this.openai.modelName(), providerType: "openai" };
    }
    return { configured: false, lastError: this.lastError, lastSuccess: this.lastSuccess, model: this.openai.modelName(), providerType: "unconfigured" };
  }

  public async classifyAndExtract(input: AgentModelInput): Promise<AgentModelResult> {
    const deterministicResult = await this.deterministic.classifyAndExtract(input);
    if (deterministicIntents.has(deterministicResult.intent)) return deterministicResult;
    if (deterministicResult.intent === "general_question" && safetyLockedGeneralQuestions.test(input.text)) return deterministicResult;

    const diagnostics = this.diagnostics();
    if (diagnostics.providerType === "unconfigured" && process.env.NODE_ENV === "production") {
      this.lastError = {
        at: new Date().toISOString(),
        code: "agent_openai_not_configured",
        providerType: diagnostics.providerType,
      };
      this.lastSuccess = {
        at: new Date().toISOString(),
        latencyMs: 0,
        model: "tawseelhub-rules-v1",
        providerType: "deterministic",
      };
      return deterministicResult;
    }
    const started = Date.now();
    try {
      const result =
        diagnostics.providerType === "deterministic"
          ? deterministicResult
          : diagnostics.providerType === "openai"
            ? await this.openai.classifyAndExtract(input)
            : deterministicResult;
      this.lastSuccess = {
        at: new Date().toISOString(),
        latencyMs: Date.now() - started,
        model: diagnostics.providerType === "unconfigured" ? "tawseelhub-rules-v1" : diagnostics.model,
        providerType: diagnostics.providerType === "unconfigured" ? "deterministic" : diagnostics.providerType,
      };
      return result;
    } catch (error) {
      this.lastError = {
        at: new Date().toISOString(),
        code: (error as { code?: string; message?: string }).code ?? (error as { message?: string }).message?.slice(0, 80) ?? "provider_failed",
        providerType: diagnostics.providerType,
      };
      this.lastSuccess = {
        at: new Date().toISOString(),
        latencyMs: Date.now() - started,
        model: "tawseelhub-rules-v1",
        providerType: "deterministic",
      };
      return deterministicResult;
    }
  }

  public async generateReply(input: AgentReplyInput, fallback: () => string): Promise<string> {
    const diagnostics = this.diagnostics();
    const started = Date.now();
    try {
      const reply =
        diagnostics.providerType === "openai"
          ? await this.openai.generateReply(input)
          : fallback();
      this.lastSuccess = {
        at: new Date().toISOString(),
        latencyMs: Date.now() - started,
        model: diagnostics.providerType === "openai" ? diagnostics.model : "tawseelhub-rules-v1",
        providerType: diagnostics.providerType === "openai" ? "openai" : "deterministic",
      };
      return reply;
    } catch (error) {
      this.lastError = {
        at: new Date().toISOString(),
        code: (error as { code?: string; message?: string }).code ?? (error as { message?: string }).message?.slice(0, 80) ?? "provider_failed",
        providerType: diagnostics.providerType,
      };
      return fallback();
    }
  }
}
