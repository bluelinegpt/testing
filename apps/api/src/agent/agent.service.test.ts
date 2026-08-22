import { describe, expect, it } from "vitest";
import { arabicGeneralFallback, contextualGeneralFollowUpResponse, generalKnowledgeContent, isAgentAnyPricingTopicText, isAgentConfusionText, isAgentDeductionQuestionText, isAgentExplainOnlyText, isAgentFeatureExplanationText, isAgentPlatformPricingQuestionText, isAgentPriceQuestionText, isAgentTraderExplanationChoiceText, isAgentTraderUsageQuestionText, isCorruptedArabicText, persistableAgentConversationIntent, privacyBoundaryResponse, publicAgentLabel, publicConversationIntroStep } from "./agent.service.js";

describe("AgentService general knowledge content", () => {
  it("does not show corrupted question-mark Arabic seed data to visitors", () => {
    const corrupted = "????? ?? ???? ????? ?????? ??????? ?? ???? ????????";

    expect(isCorruptedArabicText(corrupted)).toBe(true);
    expect(generalKnowledgeContent("ar", corrupted)).toBe(arabicGeneralFallback);
    expect(generalKnowledgeContent("ar", corrupted)).toMatch(/[\u0600-\u06ff]/);
    expect(generalKnowledgeContent("ar", corrupted)).not.toContain("???");
  });

  it("keeps valid Arabic and English knowledge content unchanged", () => {
    const arabic = "Tawseelhub منصة لإدارة عمليات التوصيل.";
    const english = "Tawseelhub is a Delivery Operating System.";

    expect(generalKnowledgeContent("ar", arabic)).toBe(arabic);
    expect(generalKnowledgeContent("en", english)).toBe(english);
  });
});

describe("AgentService privacy boundary", () => {
  it("does not expose private company, trader, customer, internal, financial or secret information", () => {
    const response = privacyBoundaryResponse("ar");

    expect(response).toContain("لا أستطيع");
    expect(response).toContain("شركات التوصيل");
    expect(response).toContain("التجار");
    expect(response).toContain("العمولات");
    expect(response).toContain("أسرار");
    expect(response).not.toContain("???");
  });
});

describe("AgentService public conversation intro", () => {
  it("asks for the visitor name before answering business questions", () => {
    const response = publicConversationIntroStep("ما هو توصيل هب", "ar", { slots: {}, audience: "unknown" });

    expect(response?.content).toContain("ما اسمك");
    expect(response?.structured.state.lastAskedSlot).toBe("contactName");
  });

  it("collects name, UAE mobile, company or store name, and email before opening the conversation", () => {
    const afterName = publicConversationIntroStep("علي", "ar", { slots: {}, audience: "unknown", lastAskedSlot: "contactName" });
    expect(afterName?.content).toContain("الهاتف");

    const afterMobile = publicConversationIntroStep("0506468441", "ar", afterName!.structured.state);
    expect(afterMobile?.content).toContain("الشركة أو المتجر");

    const afterCompany = publicConversationIntroStep("متجر ايمن", "ar", afterMobile!.structured.state);
    expect(afterCompany?.content).toContain("البريد الإلكتروني");

    const afterEmail = publicConversationIntroStep("aothman@hotmail.com", "ar", afterCompany!.structured.state);
    expect(afterEmail?.content).toContain("كيف يمكنني مساعدتك");
    expect(afterEmail?.structured.state.lastAskedSlot).toBeUndefined();
    expect(afterEmail?.structured.state.slots.email).toBe("aothman@hotmail.com");
    expect(afterEmail?.structured.state.slots.requesterMobile).toBe("0506468441");
  });

  it("does not accept an invalid UAE mobile during the intro", () => {
    const response = publicConversationIntroStep("123", "ar", {
      slots: { contactName: "علي" },
      audience: "unknown",
      lastAskedSlot: "requesterMobile",
    });

    expect(response?.content).toContain("رقم الهاتف غير واضح");
    expect(response?.structured.state.lastAskedSlot).toBe("requesterMobile");
  });

  it("does not accept an invalid email during the intro", () => {
    const response = publicConversationIntroStep("ما في", "ar", {
      slots: { contactName: "علي", requesterMobile: "0506468441", companyName: "متجر ايمن" },
      audience: "unknown",
      lastAskedSlot: "email",
    });

    expect(response?.content).toContain("غير واضح");
    expect(response?.structured.state.lastAskedSlot).toBe("email");
  });
});

describe("AgentService quote workflow helpers", () => {
  it("recognizes price questions and common typos before slot filling", () => {
    expect(isAgentPriceQuestionText("what is cost")).toBe(true);
    expect(isAgentPriceQuestionText("wha tis the cost")).toBe(true);
    expect(isAgentPriceQuestionText("how much")).toBe(true);
    expect(isAgentPriceQuestionText("price?")).toBe(true);
    expect(isAgentPriceQuestionText("كم السعر؟")).toBe(true);
  });

  it("recognizes platform pricing questions and points to the pricing page", () => {
    expect(isAgentPlatformPricingQuestionText("سعر استخدام النظام نفسه")).toBe(true);
    expect(isAgentPlatformPricingQuestionText("price for the system")).toBe(true);
    expect(isAgentPlatformPricingQuestionText("how is your prices")).toBe(true);
    expect(isAgentAnyPricingTopicText("how is your prices")).toBe(true);
    expect(isAgentAnyPricingTopicText("price for the system")).toBe(true);
    expect(isAgentAnyPricingTopicText("delivery price for a package")).toBe(false);
    const response = contextualGeneralFollowUpResponse(
      "سعر استخدام النظام نفسه",
      "ar",
      { slots: {}, audience: "unknown" },
      { slots: {}, audience: "unknown" },
    );

    expect(response?.content).toContain("https://tawseelhub.com/pricing");
    expect(response?.content).toContain("Tawseelhub");
    expect(response?.content).toContain("أسعار استخدام نظام");
    expect(response?.content).not.toContain("توصيلهَب");
    expect(response?.content).not.toContain("رقم الاتصال");
    expect(response?.content).not.toContain("شحنة");
  });

  it("renders internal enum values as public labels", () => {
    expect(publicAgentLabel("small_parcel")).toBe("Small Parcel");
    expect(publicAgentLabel("same_day")).toBe("Same Day");
  });
});

describe("AgentService conversation persistence helpers", () => {
  it("stores social turns as a durable general question intent without changing visitor replies", () => {
    expect(persistableAgentConversationIntent("greeting")).toBe("general_question");
    expect(persistableAgentConversationIntent("small_talk")).toBe("general_question");
    expect(persistableAgentConversationIntent("thanks")).toBe("general_question");
    expect(persistableAgentConversationIntent("goodbye")).toBe("general_question");
    expect(persistableAgentConversationIntent("customer_quote")).toBe("customer_quote");
  });
});

describe("AgentService contextual Arabic follow-up helpers", () => {
  it("keeps a short Arabic yes answer connected to the previous follow-up question", () => {
    const response = contextualGeneralFollowUpResponse(
      "نعم",
      "ar",
      { slots: {}, audience: "unknown", pendingGeneralFollowUp: "public_explanation" },
      { slots: {}, audience: "unknown" },
    );

    expect(response?.content).toContain("أي جزء");
    expect(response?.content).not.toContain("كيف يمكنني مساعدتك");
    expect(response?.structured.state.pendingGeneralFollowUp).toBe("feature_choice");
  });

  it("answers Arabic deduction questions as fee questions instead of small talk", () => {
    expect(isAgentDeductionQuestionText("ليش بتخصم")).toBe(true);
    const response = contextualGeneralFollowUpResponse(
      "ليش بتخصم",
      "ar",
      { slots: {}, audience: "unknown", pendingGeneralFollowUp: "feature_choice" },
      { slots: {}, audience: "unknown" },
    );

    expect(response?.content).toContain("لا يخصم");
    expect(response?.content).toContain("اشتراك");
  });

  it("explains Trader registration when selected from a feature-choice answer instead of submitting stale details", () => {
    const response = contextualGeneralFollowUpResponse(
      "التسجيل كتاجر",
      "ar",
      { slots: { storeName: "ايمن", mobileNumber: "0506468441" }, audience: "unknown", pendingGeneralFollowUp: "feature_choice" },
      { slots: { storeName: "ايمن", mobileNumber: "0506468441" }, audience: "trader", lastBusinessIntent: "trader" },
    );

    expect(response?.content).toContain("يعني");
    expect(response?.content).toContain("لن أستخدم تفاصيل قديمة");
    expect(response?.content).not.toContain("هل أرسل طلب تسجيل التاجر");
    expect(response?.structured.state.pendingGeneralFollowUp).toBe("trader_registration_explained");
  });

  it("starts a fresh Trader registration after explicit confirmation", () => {
    const response = contextualGeneralFollowUpResponse(
      "نعم",
      "ar",
      { slots: { storeName: "قديم" }, audience: "trader", pendingGeneralFollowUp: "trader_registration_explained" },
      { slots: { storeName: "قديم" }, audience: "trader", lastBusinessIntent: "trader" },
    );

    expect(response?.content).toContain("ما اسم المتجر");
    expect(response?.intent).toBe("trader");
    expect(response?.structured.state.slots).toEqual({});
    expect(response?.structured.state.lastAskedSlot).toBe("storeName");
  });

  it("does not repeat a pending submission summary when the visitor says the Arabic reply is unclear", () => {
    expect(isAgentConfusionText("الكلام غير مفهوم")).toBe(true);
    const response = contextualGeneralFollowUpResponse(
      "الكلام غير مفهوم",
      "ar",
      { slots: {}, audience: "trader", pendingAction: { type: "submit_trader_application", summary: { store: "ايمن" } } },
      { slots: {}, audience: "trader", pendingAction: { type: "submit_trader_application", summary: { store: "ايمن" } } },
    );

    expect(response?.content).toContain("لن أرسله");
    expect(response?.content).not.toContain("store:");
    expect(response?.structured.state.pendingAction).toBeUndefined();
  });

  it("recognizes Arabic Trader usage questions as explanation requests", () => {
    expect(isAgentTraderUsageQuestionText("كيف للتاجر يستخدم النظام")).toBe(true);
  });

  it("treats plain Trader after an explanation prompt as an explanation choice, not a registration form", () => {
    expect(isAgentTraderExplanationChoiceText("التاجر")).toBe(true);
    const response = contextualGeneralFollowUpResponse(
      "التاجر",
      "ar",
      { slots: {}, audience: "unknown", pendingGeneralFollowUp: "public_explanation" },
      { slots: {}, audience: "trader", lastBusinessIntent: "trader" },
    );

    expect(response?.content).toContain("شرح للنظام فقط");
    expect(response?.content).not.toContain("ما اسم المتجر");
    expect(response?.structured.state.lastAskedSlot).toBeUndefined();
  });

  it("treats Arabic plural Traders as an explanation choice, not a phone collection step", () => {
    expect(isAgentTraderExplanationChoiceText("التجار")).toBe(true);
    const response = contextualGeneralFollowUpResponse(
      "التجار",
      "ar",
      { slots: { contactName: "ايمن", companyName: "فهد", email: "fahid@hotmail.com" }, audience: "unknown", pendingGeneralFollowUp: "public_explanation" },
      { slots: { contactName: "ايمن", companyName: "فهد", email: "fahid@hotmail.com" }, audience: "trader", lastBusinessIntent: "trader" },
    );

    expect(response?.content).toContain("بالنسبة للتاجر");
    expect(response?.content).not.toContain("ما رقم الهاتف");
    expect(response?.structured.state.lastAskedSlot).toBeUndefined();
  });

  it("exits a mistaken workflow when the visitor asks only for system explanation", () => {
    expect(isAgentExplainOnlyText("انت فقط اشرح النظام")).toBe(true);
    const response = contextualGeneralFollowUpResponse(
      "انت فقط اشرح النظام",
      "ar",
      { slots: { storeName: "ايمن" }, audience: "trader", lastBusinessIntent: "trader", lastAskedSlot: "pickupEmirate" },
      { slots: { storeName: "ايمن" }, audience: "trader", lastBusinessIntent: "trader", lastAskedSlot: "pickupEmirate" },
    );

    expect(response?.content).toContain("أوقفت نموذج الطلب");
    expect(response?.content).toContain("Tawseelhub");
    expect(response?.structured.state.lastAskedSlot).toBeUndefined();
    expect(response?.structured.state.lastBusinessIntent).toBe("general_question");
  });

  it("explains Arabic driver management as a feature instead of starting a demo request", () => {
    expect(isAgentFeatureExplanationText("اداره السائقين")).toBe(true);
    const response = contextualGeneralFollowUpResponse(
      "اداره السائقين",
      "ar",
      { slots: { contactName: "ايمن", companyName: "فهد", email: "fahid@hotmail.com" }, audience: "unknown", pendingGeneralFollowUp: "feature_choice" },
      { slots: { contactName: "ايمن", companyName: "فهد", email: "fahid@hotmail.com" }, audience: "delivery_company", lastBusinessIntent: "delivery_company_demo" },
    );

    expect(response?.intent).toBe("product_feature_question");
    expect(response?.content).toContain("إدارة السائقين");
    expect(response?.content).toContain("شرح للميزة فقط");
    expect(response?.content).not.toContain("ما رقم الهاتف");
    expect(response?.structured.state.lastAskedSlot).toBeUndefined();
  });
});
