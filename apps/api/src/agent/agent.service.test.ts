import { describe, expect, it, vi } from "vitest";
import {
  AgentService,
  arabicGeneralFallback,
  contextualGeneralFollowUpResponse,
  generalKnowledgeContent,
  isAgentAnyPricingTopicText,
  isAgentConfusionText,
  isAgentDeductionQuestionText,
  isAgentExplainOnlyText,
  isAgentFeatureExplanationText,
  isAgentPlatformPricingQuestionText,
  isAgentPriceQuestionText,
  isAgentTraderExplanationChoiceText,
  isAgentTraderUsageQuestionText,
  isCorruptedArabicText,
  isMenuRequestText,
  persistableAgentConversationIntent,
  privacyBoundaryResponse,
  publicAgentLabel,
  publicConversationIntroStep,
} from "./agent.service.js";

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
    const response = publicConversationIntroStep("ما هو توصيل هب", "ar", {
      slots: {},
      audience: "unknown",
    });

    expect(response?.content).toContain("ما اسمك");
    expect(response?.structured.state.lastAskedSlot).toBe("contactName");
  });

  it("collects only name and UAE mobile -- never company/store name or email, regardless of context", () => {
    const afterName = publicConversationIntroStep("علي", "ar", {
      slots: {},
      audience: "unknown",
      lastAskedSlot: "contactName",
    });
    expect(afterName?.content).toContain("الهاتف");

    const afterMobile = publicConversationIntroStep(
      "0506468441",
      "ar",
      afterName!.structured.state,
    );
    // No pending workflow -- generic acknowledgement, not a company/email ask.
    expect(afterMobile?.content).toContain("كيف يمكنني مساعدتك");
    expect(afterMobile?.content).not.toContain("الشركة أو المتجر");
    expect(afterMobile?.structured.state.lastAskedSlot).toBeUndefined();
    expect(afterMobile?.structured.state.slots.requesterMobile).toBe("0506468441");
    expect(afterMobile?.structured.state.slots.companyName).toBeUndefined();
    expect(afterMobile?.structured.state.slots.email).toBeUndefined();
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
});

describe("AgentService public conversation intro -- resuming a pending workflow", () => {
  // Once name + mobile are collected, a pending workflow (tracking, trader
  // registration, demo request, a package quote...) is resumed via
  // `resumeIntent` -- the caller then calls that workflow's OWN next-question
  // logic directly, so this only has to prove the correct workflow is named
  // and the slots survive the handoff, not duplicate each workflow's copy.
  it.each([
    ["shipment_tracking", "shipment_tracking"],
    ["trader", "trader"],
    ["delivery_company_demo", "delivery_company_demo"],
    ["customer_quote", "customer_quote"],
  ] as const)(
    "hands off to a pending %s workflow instead of asking for a company or email",
    (pendingWorkflowIntent, expectedResumeIntent) => {
      const afterName = publicConversationIntroStep(
        "Ahmed",
        "en",
        { slots: {}, audience: "unknown", lastAskedSlot: "contactName" },
        pendingWorkflowIntent,
      );
      expect(afterName?.content).toContain("mobile");
      expect(afterName?.resumeIntent).toBeUndefined();

      const afterMobile = publicConversationIntroStep(
        "0501234567",
        "en",
        afterName!.structured.state,
        pendingWorkflowIntent,
      );
      expect(afterMobile?.resumeIntent).toBe(expectedResumeIntent);
      expect(afterMobile?.structured.state.lastBusinessIntent).toBe(expectedResumeIntent);
      expect(afterMobile?.structured.state.lastAskedSlot).toBeUndefined();
      expect(afterMobile?.structured.state.slots.requesterMobile).toBe("0501234567");
      expect(afterMobile?.structured.state.slots.contactPerson).toBe("Ahmed");
      expect(afterMobile?.structured.state.slots.mobileNumber).toBe("0501234567");
      // Never collected here -- whichever workflow actually needs a company/
      // store name or email (trader, demo) asks for it itself once resumed.
      expect(afterMobile?.structured.state.slots.companyName).toBeUndefined();
      expect(afterMobile?.structured.state.slots.storeName).toBeUndefined();
      expect(afterMobile?.structured.state.slots.email).toBeUndefined();
    },
  );

  it("does the same in Arabic", () => {
    const afterName = publicConversationIntroStep(
      "أحمد",
      "ar",
      { slots: {}, audience: "unknown", lastAskedSlot: "contactName" },
      "shipment_tracking",
    );
    expect(afterName?.content).toContain("الهاتف");

    const afterMobile = publicConversationIntroStep(
      "0501234567",
      "ar",
      afterName!.structured.state,
      "shipment_tracking",
    );
    expect(afterMobile?.resumeIntent).toBe("shipment_tracking");
  });

  it("gives the generic acknowledgement, not a resume, when no workflow is pending", () => {
    const afterMobile = publicConversationIntroStep("0501234567", "en", {
      slots: { contactName: "Ahmed" },
      audience: "unknown",
      lastAskedSlot: "requesterMobile",
    });
    expect(afterMobile?.resumeIntent).toBeUndefined();
    expect(afterMobile?.content).toContain("Thanks, I saved the contact details");
  });
});

describe("AgentService menu request detection", () => {
  it("recognizes 'menu' and its variants as a request to start over, in EN and AR", () => {
    expect(isMenuRequestText("menu")).toBe(true);
    expect(isMenuRequestText("Menu")).toBe(true);
    expect(isMenuRequestText(" menu ")).toBe(true);
    expect(isMenuRequestText("main menu")).toBe(true);
    expect(isMenuRequestText("show menu")).toBe(true);
    expect(isMenuRequestText("options")).toBe(true);
    expect(isMenuRequestText("القائمة")).toBe(true);
    expect(isMenuRequestText("قائمة")).toBe(true);
  });

  it("does not misfire on ordinary answers that merely mention the word", () => {
    expect(isMenuRequestText("I saw your menu online")).toBe(false);
    expect(isMenuRequestText("Ahmed")).toBe(false);
    expect(isMenuRequestText("0501234567")).toBe(false);
  });
});

describe("AgentService tracking mobile auto-verification", () => {
  function trackingOnlyService(verifyAmbiguousShipment: ReturnType<typeof vi.fn>) {
    // trackingStep never touches db/quotes/traders/demos/model -- only
    // `this.tracking` -- so these can stay undefined for this test.
    return new AgentService(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { verifyAmbiguousShipment } as never,
    );
  }

  it("tries the mobile the customer already gave as their contact number, automatically -- never asks them to repeat it", async () => {
    const verifyAmbiguousShipment = vi.fn().mockResolvedValue({
      result: "verified",
      tracking: {
        airwayBill: "ORD-000200",
        status: "delivered",
        statusLabel: "Delivered",
        lastUpdated: "2026-08-28T08:00:00.000Z",
        deliveredAt: null,
        timeline: [],
      },
    });
    const service = trackingOnlyService(verifyAmbiguousShipment);
    const state = {
      slots: { contactName: "Aiman", requesterMobile: "0506468441", trackingAirwayBill: "12" },
      tracking: { verificationToken: "tok-123", startedAt: new Date().toISOString() },
    };

    const response = await (
      service as unknown as {
        trackingStep: (s: unknown, l: string) => Promise<{ content: string }>;
      }
    ).trackingStep(state, "en");

    expect(verifyAmbiguousShipment).toHaveBeenCalledWith("tok-123", "0506468441", "en");
    expect(response.content).not.toContain("Additional verification required");
    expect(response.content).toContain("Delivered");
    expect(response.content).toContain("28 Aug 2026, 12:00 PM");
    expect(response.content).not.toContain("GST");
  });

  it("does not count the automatic attempt against the failed-attempt limit, and asks for a different number instead of looping on the same one", async () => {
    const verifyAmbiguousShipment = vi.fn().mockResolvedValue({ result: "not_verified" });
    const service = trackingOnlyService(verifyAmbiguousShipment);
    const state = {
      slots: { contactName: "Aiman", requesterMobile: "0506468441", trackingAirwayBill: "12" },
      tracking: { verificationToken: "tok-123", startedAt: new Date().toISOString() },
    };

    const response = await (
      service as unknown as {
        trackingStep: (
          s: unknown,
          l: string,
        ) => Promise<{
          content: string;
          structured: {
            state: { tracking?: { failedMobileAttempts?: number; autoMobileAttempted?: boolean } };
          };
        }>;
      }
    ).trackingStep(state, "en");

    expect(response.content).toContain("enter the customer mobile number");
    expect(response.structured.state.tracking?.failedMobileAttempts ?? 0).toBe(0);
    expect(response.structured.state.tracking?.autoMobileAttempted).toBe(true);
  });

  it("does not retry the auto-tried mobile a second time -- it asks for an explicit answer next", async () => {
    const verifyAmbiguousShipment = vi.fn().mockResolvedValue({ result: "not_verified" });
    const service = trackingOnlyService(verifyAmbiguousShipment);
    const state = {
      slots: { contactName: "Aiman", requesterMobile: "0506468441", trackingAirwayBill: "12" },
      // autoMobileAttempted already true from a prior turn -- no known
      // mobile should be auto-tried again.
      tracking: {
        verificationToken: "tok-123",
        startedAt: new Date().toISOString(),
        autoMobileAttempted: true,
      },
    };

    const response = await (
      service as unknown as {
        trackingStep: (s: unknown, l: string) => Promise<{ content: string }>;
      }
    ).trackingStep(state, "en");

    expect(verifyAmbiguousShipment).not.toHaveBeenCalled();
    expect(response.content).toContain("Additional verification required");
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
    // Aligned with the published FAQ cost answer: free up to 100 orders/month.
    expect(response?.content).toContain("مجاناً حتى 100 طلب");
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
      {
        slots: { storeName: "ايمن", mobileNumber: "0506468441" },
        audience: "unknown",
        pendingGeneralFollowUp: "feature_choice",
      },
      {
        slots: { storeName: "ايمن", mobileNumber: "0506468441" },
        audience: "trader",
        lastBusinessIntent: "trader",
      },
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
      {
        slots: { storeName: "قديم" },
        audience: "trader",
        pendingGeneralFollowUp: "trader_registration_explained",
      },
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
      {
        slots: {},
        audience: "trader",
        pendingAction: { type: "submit_trader_application", summary: { store: "ايمن" } },
      },
      {
        slots: {},
        audience: "trader",
        pendingAction: { type: "submit_trader_application", summary: { store: "ايمن" } },
      },
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
      {
        slots: { contactName: "ايمن", companyName: "فهد", email: "fahid@hotmail.com" },
        audience: "unknown",
        pendingGeneralFollowUp: "public_explanation",
      },
      {
        slots: { contactName: "ايمن", companyName: "فهد", email: "fahid@hotmail.com" },
        audience: "trader",
        lastBusinessIntent: "trader",
      },
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
      {
        slots: { storeName: "ايمن" },
        audience: "trader",
        lastBusinessIntent: "trader",
        lastAskedSlot: "pickupEmirate",
      },
      {
        slots: { storeName: "ايمن" },
        audience: "trader",
        lastBusinessIntent: "trader",
        lastAskedSlot: "pickupEmirate",
      },
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
      {
        slots: { contactName: "ايمن", companyName: "فهد", email: "fahid@hotmail.com" },
        audience: "unknown",
        pendingGeneralFollowUp: "feature_choice",
      },
      {
        slots: { contactName: "ايمن", companyName: "فهد", email: "fahid@hotmail.com" },
        audience: "delivery_company",
        lastBusinessIntent: "delivery_company_demo",
      },
    );

    expect(response?.intent).toBe("product_feature_question");
    expect(response?.content).toContain("إدارة السائقين");
    expect(response?.content).toContain("شرح للميزة فقط");
    expect(response?.content).not.toContain("ما رقم الهاتف");
    expect(response?.structured.state.lastAskedSlot).toBeUndefined();
  });
});
