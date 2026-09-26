import { describe, expect, it } from "vitest";
import { agentFaqAnswer } from "./agent-faq.js";

describe("Agent FAQ knowledge", () => {
  it.each([
    ["What is Tawseelhub?", "delivery operating system built for UAE delivery companies"],
    ["Who is Tawseelhub designed for?", "delivery and courier companies"],
    ["Can Tawseelhub handle COD management?", "tracks COD collections from drivers"],
    ["Does Tawseelhub support driver management?", "assign orders, track driver performance"],
    ["What is trader settlement?", "reconciling and paying merchants or traders"],
    ["Does Tawseelhub include accounting features?", "integrates accounting functions"],
    ["Can I manage driver payroll through Tawseelhub?", "payroll management is built into"],
    ["Is Tawseelhub only for large delivery companies?", "small and large delivery operations"],
    ["Does Tawseelhub offer real-time order tracking?", "track order status from dispatch"],
    ["Is Tawseelhub cloud-based?", "cloud-based platform"],
    ["Can Tawseelhub integrate with existing e-commerce systems?", "Salla, Shopify and WooCommerce"],
    ["What UAE cities does Tawseelhub support?", "Dubai, Abu Dhabi, Sharjah and Ajman"],
    ["How does Tawseelhub help reduce delivery errors?", "centralizing order assignment"],
    ["Is there a free trial or demo available?", "Free plan gives free access"],
    ["How much does Tawseelhub cost?", "starts free for up to 100 orders"],
  ])("answers %j in English", (question, answerFragment) => {
    expect(agentFaqAnswer(question, "en")).toContain(answerFragment);
  });

  it.each([
    ["ما هو توصيل هب؟", "نظام تشغيل توصيل"],
    ["لمن صمم النظام؟", "شركات التوصيل والشحن"],
    ["هل يدعم إدارة الدفع عند الاستلام؟", "تحصيلات الدفع عند الاستلام"],
    ["هل يدعم النظام إدارة السائقين؟", "إسناد الطلبات"],
    ["ما هي تسوية التجار؟", "مطابقة ودفع مستحقات التجار"],
    ["هل يتضمن ميزات محاسبية؟", "وظائف المحاسبة"],
    ["هل يمكن إدارة رواتب السائقين؟", "إدارة الرواتب مدمجة"],
    ["هل هو فقط للشركات الكبيرة؟", "الصغيرة والكبيرة"],
    ["هل يوفر تتبع مباشر للطلبات؟", "تتبع حالة الطلب"],
    ["هل يعمل على السحابة؟", "منصة سحابية"],
    ["هل يوجد تكامل مع سلة وشوبيفاي؟", "سلة وشوبيفاي وووكومرس"],
    ["ما هي المدن التي يدعمها؟", "دبي وأبوظبي والشارقة وعجمان"],
    ["كيف يساعد على تقليل الأخطاء؟", "مركزية إسناد الطلبات"],
    ["هل تتوفر تجربة مجانية؟", "الخطة المجانية"],
    ["كم تكلفة الاشتراك؟", "tawseelhub.com/pricing"],
  ])("answers %j in Arabic", (question, answerFragment) => {
    expect(agentFaqAnswer(question, "ar")).toContain(answerFragment);
  });

  it("answers in the requested language regardless of the question's language", () => {
    expect(agentFaqAnswer("Is Tawseelhub cloud-based?", "ar")).toMatch(/سحابية/u);
    expect(agentFaqAnswer("هل يعمل على السحابة؟", "en")).toContain("cloud-based");
  });

  it("never swallows workflow starts, slot answers or ordinary chat", () => {
    // These must reach their real workflows/paths untouched -- an FAQ match
    // here would hijack tracking, registration and contact-capture turns.
    for (const text of [
      "Track my shipment",
      "ORD-000116",
      "0501234567",
      "Ahmed",
      "I want to register as a trader",
      "Book a demo for my delivery company",
      "أريد تتبع شحنتي",
      "hello",
      "thanks",
      "menu",
    ]) {
      expect(agentFaqAnswer(text, "en")).toBeUndefined();
    }
  });
});
