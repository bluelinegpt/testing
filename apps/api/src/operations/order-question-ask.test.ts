import { describe, expect, it } from "vitest";

import {
  matchReadyQuestion,
  ORDER_QUESTION_SYSTEM_PROMPT,
  OrderQuestionAskService,
  resolveOrderQuestionProvider,
  sanitizeInterpretation,
} from "./order-question-ask.js";

describe("Orders question box", () => {
  it("answers a ready question in words without the AI, in Arabic and English", () => {
    expect(matchReadyQuestion("Which orders are ready to close?")).toBe("ready_to_close");
    expect(matchReadyQuestion("أي الطلبات جاهزة للإغلاق؟")).toBe("ready_to_close");
    expect(matchReadyQuestion("أي الطلبات جاهزة للتحصيل من المندوب؟")).toBe("collect_from_driver");
    expect(matchReadyQuestion("جميع الطلبات الجاهزه للدفع")).toBe("pay_trader");
    expect(matchReadyQuestion("orders ready for payment")).toBe("pay_trader");
    expect(matchReadyQuestion("orders with no driver")).toBe("no_driver");
    expect(matchReadyQuestion("أي الطلبات بدون مندوب")).toBe("no_driver");
  });

  it("sends a ready question that carries more (a name, a date) to the AI instead", () => {
    expect(matchReadyQuestion("ready to collect from Ali")).toBeNull();
    expect(matchReadyQuestion("جاهزة للتحصيل من المندوب علي أمس")).toBeNull();
    expect(matchReadyQuestion("Ali's orders delivered yesterday")).toBeNull();
  });

  it("keeps only allow-listed values from whatever the AI returns", () => {
    const clean = sanitizeInterpretation({
      cashStatus: "pending",
      deliveredFrom: "2026-10-10",
      deliveredTo: "yesterday",
      deliveryStatuses: ["delivered", "drop table orders", "delivered"],
      driverName: "  علي  ",
      extra: "ignored",
      orderType: "rocket",
      question: "delete_everything",
      settlementStatus: "unsettled; --",
    });
    expect(clean).toMatchObject({
      aboutOrders: true,
      cashStatus: "pending",
      deliveredFrom: "2026-10-10",
      deliveredTo: null,
      deliveryStatuses: ["delivered"],
      driverName: "علي",
      orderType: null,
      question: null,
      settlementStatus: null,
    });
    expect(clean).not.toHaveProperty("extra");
    expect(sanitizeInterpretation("not json at all")).toMatchObject({ aboutOrders: true, driverName: null });
    expect(sanitizeInterpretation({ aboutOrders: false }).aboutOrders).toBe(false);
  });

  it("turns an interpretation into Orders filters and removable chips", async () => {
    const service = new OrderQuestionAskService(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const result = await service.resolve(
      "company",
      sanitizeInterpretation({
        cashStatus: "pending",
        deliveredFrom: "2026-10-10",
        deliveredTo: "2026-10-10",
        deliveryStatuses: ["delivered"],
      }),
    );
    expect(result.filters).toEqual({
      cashStatus: "pending",
      deliveredOnly: "true",
      deliveryDateFrom: "2026-10-10",
      deliveryDateTo: "2026-10-10",
      deliveryStatus: "delivered",
      quickView: "delivery",
    });
    expect(result.chips.map((chip) => [chip.field, chip.value])).toEqual([
      ["deliveryStatus", "delivered"],
      ["cashStatus", "pending"],
      ["deliveredDate", "2026-10-10"],
    ]);
    const outside = await service.resolve("company", sanitizeInterpretation({ aboutOrders: false }));
    expect(outside).toMatchObject({ filters: {}, unsupported: true });
  });

  it("tells the AI to output filters only, never answers or SQL", () => {
    expect(ORDER_QUESTION_SYSTEM_PROMPT).toContain("Reply with ONE JSON object only");
    expect(ORDER_QUESTION_SYSTEM_PROMPT).not.toMatch(/select\s+.*from/i);
  });
  it("uses OpenRouter first, then Moonshot, then OpenAI, and nothing without a key", () => {
    expect(resolveOrderQuestionProvider({})).toBeNull();
    expect(resolveOrderQuestionProvider({ OPENAI_API_KEY: "o" })?.name).toBe("openai");
    const moonshot = resolveOrderQuestionProvider({
      MOONSHOT_API_KEY: "m",
      MOONSHOT_MODEL: "kimi-test",
      OPENAI_API_KEY: "o",
    });
    expect(moonshot?.name).toBe("moonshot");
    expect(moonshot?.model).toBe("kimi-test");
    expect(moonshot?.baseURL).toBe("https://api.moonshot.ai/v1");
    expect(resolveOrderQuestionProvider({ MOONSHOT_API_KEY: "m", OPENROUTER_API_KEY: "r" })?.name).toBe(
      "openrouter",
    );
    expect(resolveOrderQuestionProvider({ OPENROUTER_API_KEY: "  " })).toBeNull();
    const claude = resolveOrderQuestionProvider({ ANTHROPIC_API_KEY: "a", ANTHROPIC_MODEL: "claude-x", MOONSHOT_API_KEY: "m" });
    expect(claude?.name).toBe("anthropic");
    expect(claude?.model).toBe("claude-x");
  });
});
