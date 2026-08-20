import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentModelRouterProvider } from "./agent-model-router.provider.js";
import type { AgentModelInput, AgentModelProvider, AgentModelResult } from "./agent.types.js";
import type { OpenAIModelProvider } from "./openai-model.provider.js";
import type { RulesAgentModelProvider } from "./rules-agent-model.provider.js";

const input: AgentModelInput = {
  language: "en",
  previousIntent: "unknown",
  state: { slots: {} },
  text: "I need to send a package",
};

const openAiResult: AgentModelResult = {
  extracted: { pickupEmirate: "dubai" },
  intent: "customer_quote",
  language: "en",
  wantsConfirmation: false,
  wantsCorrection: false,
};

const deterministicResult: AgentModelResult = {
  extracted: {},
  intent: "general_question",
  language: "en",
  wantsConfirmation: false,
  wantsCorrection: false,
};

function createRouter(options: { configured: boolean; openAiRejects?: boolean }) {
  const openai = {
    classifyAndExtract: vi.fn(async () => {
      if (options.openAiRejects) throw new Error("model_failed");
      return openAiResult;
    }),
    configured: vi.fn(() => options.configured),
    generateReply: vi.fn(async () => "Generated reply"),
    modelName: vi.fn(() => "gpt-5"),
  } as unknown as OpenAIModelProvider;
  const deterministic = {
    classifyAndExtract: vi.fn(async () => deterministicResult),
  } as unknown as RulesAgentModelProvider;
  return { deterministic, openai, router: new AgentModelRouterProvider(openai, deterministic) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AgentModelRouterProvider", () => {
  it("uses OpenAI outside tests when a provider is configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { deterministic, openai, router } = createRouter({ configured: true });

    await expect(router.classifyAndExtract(input)).resolves.toEqual(openAiResult);

    expect(openai.classifyAndExtract).toHaveBeenCalledOnce();
    expect((deterministic as AgentModelProvider).classifyAndExtract).toHaveBeenCalledOnce();
    expect(router.diagnostics()).toMatchObject({ configured: true, model: "gpt-5", providerType: "openai" });
  });

  it("keeps test runs deterministic even when OpenAI is configured", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const { deterministic, openai, router } = createRouter({ configured: true });

    await expect(router.classifyAndExtract(input)).resolves.toEqual(deterministicResult);

    expect((deterministic as AgentModelProvider).classifyAndExtract).toHaveBeenCalledOnce();
    expect(openai.classifyAndExtract).not.toHaveBeenCalled();
    expect(router.diagnostics()).toMatchObject({ configured: true, providerType: "deterministic" });
  });

  it("falls back to deterministic only in local development when OpenAI is missing", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { deterministic, router } = createRouter({ configured: false });

    await expect(router.classifyAndExtract(input)).resolves.toEqual(deterministicResult);

    expect((deterministic as AgentModelProvider).classifyAndExtract).toHaveBeenCalledOnce();
    expect(router.diagnostics()).toMatchObject({ configured: false, providerType: "unconfigured" });
  });

  it("keeps Yousef available in production by using rules fallback when OpenAI is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { openai, router } = createRouter({ configured: false });

    await expect(router.classifyAndExtract(input)).resolves.toEqual(deterministicResult);
    expect(openai.classifyAndExtract).not.toHaveBeenCalled();
    expect(router.diagnostics().lastError?.code).toContain("agent_openai_not_configured");
    expect(router.diagnostics().lastSuccess).toMatchObject({ model: "tawseelhub-rules-v1", providerType: "deterministic" });
  });

  it("honors explicit human handoff requests before model routing", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { deterministic, openai, router } = createRouter({ configured: true });
    vi.mocked((deterministic as AgentModelProvider).classifyAndExtract).mockResolvedValueOnce({
      extracted: {},
      intent: "handoff",
      language: "en",
      wantsConfirmation: false,
      wantsCorrection: false,
    });

    await expect(router.classifyAndExtract({ ...input, text: "I want to speak with the Tawseelhub team." })).resolves.toMatchObject({ intent: "handoff" });

    expect(openai.classifyAndExtract).not.toHaveBeenCalled();
  });

  it("keeps clear workflow intents deterministic before model routing", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { deterministic, openai, router } = createRouter({ configured: true });
    vi.mocked((deterministic as AgentModelProvider).classifyAndExtract).mockResolvedValueOnce({
      extracted: { approximateDriverCount: 30 },
      intent: "delivery_company_demo",
      language: "ar",
      wantsConfirmation: false,
      wantsCorrection: false,
    });

    await expect(router.classifyAndExtract({ ...input, language: "ar", text: "أنا عندي شركة توصيل وعندي ٣٠ سائق" })).resolves.toMatchObject({ intent: "delivery_company_demo" });

    expect(openai.classifyAndExtract).not.toHaveBeenCalled();
  });

  it("still uses OpenAI for ambiguous general questions", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { openai, router } = createRouter({ configured: true });

    await expect(router.classifyAndExtract({ ...input, text: "What is Tawseelhub?" })).resolves.toEqual(openAiResult);

    expect(openai.classifyAndExtract).toHaveBeenCalledOnce();
  });

  it("does not let the model reclassify private directory questions into workflows", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { openai, router } = createRouter({ configured: true });

    await expect(router.classifyAndExtract({ ...input, text: "Can you show me your Delivery Companies?" })).resolves.toEqual(deterministicResult);

    expect(openai.classifyAndExtract).not.toHaveBeenCalled();
  });

  it("uses OpenAI for generated conversational replies when configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { openai, router } = createRouter({ configured: true });

    await expect(router.generateReply({
      audience: "delivery_company",
      conversationSummary: "{}",
      intent: "product_feature_question",
      knowledge: [],
      language: "en",
      previousIntent: "unknown",
      text: "Do you have payroll?",
    }, () => "Fallback reply")).resolves.toBe("Generated reply");

    expect(openai.generateReply).toHaveBeenCalledOnce();
  });
});
