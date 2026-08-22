import { BadRequestException, Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { CustomerQuoteService } from "../customer-quotes/customer-quote.service.js";
import { runQuoteEngine, type QuoteRule } from "../customer-quotes/quote-engine.js";
import { DemoRequestService } from "../demo-requests/demo-request.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { TraderApplicationService } from "../trader-applications/trader-application.service.js";
import type { AgentConversationReviewDto, AgentKnowledgeDto, AgentSettingsDto } from "./agent.dto.js";
import type { AgentChannel, AgentIntent, AgentKnowledgeContext, AgentLanguage, AgentModelResult, AgentSlots, AgentState } from "./agent.types.js";
import { AgentModelRouterProvider } from "./agent-model-router.provider.js";
import { agentIntentFromWorkflow, decideNextFrame, stateWithFrame } from "./conversation-frame.js";
import { agentQuickActions, agentQuickActionsArabic, arabicGreeting, englishGreeting } from "./agent-instructions.js";
import { RulesAgentModelProvider } from "./rules-agent-model.provider.js";
import { MetaWhatsAppCloudProvider, SandboxWhatsAppProvider, type WhatsAppProvider } from "./whatsapp-provider.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const reference = async (db: Kysely<DatabaseSchema>, sequence: string, prefix: string) => {
  const row = (await sql<{ n: string }>`select nextval(${sql.raw(`'${sequence}'`)})::text n`.execute(db)).rows[0];
  return `${prefix}-${String(row?.n ?? "0").padStart(6, "0")}`;
};
const asObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const mapRow = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_m, letter: string) => letter.toUpperCase()), value]));
const compact = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ""));
const socialIntents = new Set<AgentIntent>(["greeting", "small_talk", "thanks", "goodbye"]);
const businessInfoIntents = new Set<AgentIntent>(["general_question", "product_feature_question", "current_feature_status", "clarification", "unknown"]);
const workflowIntents = new Set<AgentIntent>(["customer_quote", "trader", "delivery_company_demo", "handoff"]);
const genericAnswerIntents = new Set<AgentIntent>(["general_question", "unknown"]);
const privateDirectoryOrCustomerInfo = /delivery companies|company directory|which traders|traders .*use|traders .*using|another customer|customer'?s information|customer'?s conversation|أسماء شركات التوصيل|شركات التوصيل المسجلة|أي تجار|معلومات عميل|محادثة عميل/i;
const quoteSlotOrder: Array<keyof AgentSlots> = ["requesterName", "requesterMobile", "pickupEmirate", "pickupArea", "deliveryEmirate", "deliveryArea", "packageType", "weightKg", "pickupDate", "deliveryAddress"];
const traderSlotOrder: Array<keyof AgentSlots> = ["storeName", "contactPerson", "mobileNumber", "email", "pickupEmirate", "pickupBusinessArea"];
const demoSlotOrder: Array<keyof AgentSlots> = ["companyName", "contactPerson", "mobileNumber", "email", "emirate"];
const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const previousRequestPattern = /\b(last|previous|old)\b.*\b(request|shipment|quote|package|order)\b|what happened.*\b(request|shipment|quote|package|order)\b|شو صار.*(طلب|شحنة)|آخر طلب|اخر طلب/i;
const referencePattern = /\b(QTE-\d{6}|AGT-\d{6})\b/i;
const cancelHumanRequestPattern = /\b(never mind|cancel|continue with yousef|back to yousef|return to yousef|resume yousef|no human|no need|stop waiting)\b|خلاص|إلغاء|الغاء|ارجع|رجع يوسف|كمل مع يوسف|بدون موظف/i;
const normalizeInternationalMobile = (value: string | undefined | null) => value?.replace(/[^\d]/g, "") || null;
const priceQuestionPattern = /\b(?:wha\s*tis|what\s+is|what'?s|what|how\s+much|cost|price|pricing|rate|charge|amount)\b.*\b(?:cost|price|pricing|rate|charge|amount)\b|\bhow\s+much\??$|\b(?:cost|price|pricing|rate|charge)\??$/i;
const arabicPriceQuestionPattern = /كم\s*(?:السعر|يكلف|التكلفة)|ما\s*(?:السعر|التكلفة)|السعر|تكلفة|بكم|كم\?/i;
const continueExistingPattern = /^(continue|continue previous|show my quote|show quote|old quote|previous quote|same quote|use existing|existing|تابع|كمل|اكمل|وريني السعر|اعرض السعر|الطلب السابق)$/i;
const newShipmentPattern = /^(new shipment|start new|start over|another package|new package|new quote|shipment new|شحنة جديدة|طلب جديد|ابدأ جديد|ابدا جديد|طرد جديد)$/i;
const skipPattern = /^(skip|no|not now|later|i don't have it|dont have it|لا|تخطي|بعدان|بعدين|ما عندي|ليس الآن)$/i;
export const arabicGeneralFallback = "Tawseelhub نظام تشغيل لشركات التوصيل في دولة الإمارات. يساعد في إدارة الطلبات والسائقين والتحصيل النقدي وتسويات التجار والتقارير وعلاقات التجار وطلبات الأسعار.";
const safeRulesClassifier = new RulesAgentModelProvider();
export const isCorruptedArabicText = (value: string) => /\?{3,}/.test(value) && !/[\u0600-\u06ff]/.test(value);
export const isAgentPriceQuestionText = (value: string) => priceQuestionPattern.test(value.trim()) || arabicPriceQuestionPattern.test(value.trim());
export const isAgentPlatformPricingQuestionText = (value: string) => /system price|price .*system|system .*price|platform price|price .*platform|platform .*price|software price|price .*software|software .*price|product pricing|your prices?|your pricing|how (?:is|are).*prices?|subscription|monthly plan|pricing page|سعر النظام|سعر استخدام النظام|سعر.*النظام|النظام.*سعر|اشتراك|باقة|باقات|رسوم النظام|تكلفة النظام/i.test(value.trim());
export const isAgentAnyPricingTopicText = (value: string) => {
  if (isAgentPlatformPricingQuestionText(value)) return true;
  const text = value.trim();
  const asksDeliveryQuote = /shipment|package|parcel|delivery price|delivery quote|send|pickup|drop(?:off)?|شحنة|طرد|سعر توصيل|عرض سعر توصيل|استلام|توصيل/i.test(text);
  return isAgentPriceQuestionText(text) && !asksDeliveryQuote;
};
export const isAgentAffirmativeText = (value: string) => /^(yes|y|ok|okay|sure|please|confirm|نعم|اي|إي|ايوه|أيوه|تمام|اوكي|أوكي|أكيد|اكيد)$/i.test(value.trim());
export const isAgentDeductionQuestionText = (value: string) => {
  const lower = value.toLowerCase().trim();
  const asksWhy = /\bwhy\b|\bwhat\s+for\b|ليش|ليه|لماذا|لشو|شو سبب|ما سبب/.test(lower);
  const feeWords = /deduct|deduction|charge|fee|fees|subscription|monthly|cost|خصم|تخصم|تخصمون|رسوم|اشتراك|تكلفة|تحاسب|تدفع/.test(lower);
  return asksWhy && feeWords;
};
export const isAgentConfusionText = (value: string) => /not clear|unclear|confusing|confused|i do not understand|i don't understand|what do you mean|الكلام غير مفهوم|غير مفهوم|مش فاهم|ما فهمت|شو تقصد/i.test(value.trim());
export const isAgentTraderUsageQuestionText = (value: string) => {
  const lower = value.toLowerCase().trim();
  const mentionsTrader = /trader|seller|merchant|store|تاجر|متجر/.test(lower);
  const asksHow = /\bhow\b|\bwhat\b|كيف|شلون|شو|ما/.test(lower);
  const usageWords = /use|work|benefit|system|platform|manage|يستخدم|يستفيد|يشتغل|النظام|المنصة|يدير/.test(lower);
  return mentionsTrader && asksHow && usageWords;
};
export const isAgentFeatureExplanationText = (value: string) => /driver management|manage drivers|drivers|cod|cash on delivery|collections|settlements|reports|payroll|إدارة السائقين|ادارة السائقين|السائقين|المندوبين|تحصيل|COD|التسويات|تسويات|التقارير|تقارير|الرواتب|رواتب/i.test(value.trim());
export const isAgentTraderExplanationChoiceText = (value: string) => /^(trader|traders|seller|sellers|merchant|merchants|store|stores|the trader|for traders|التاجر|التجار|للتاجر|للتجار|تاجر|تجار|المتجر|المتاجر)$/i.test(value.trim());
export const isAgentExplainOnlyText = (value: string) => /explain only|just explain|no request|no order|what request|اشرح فقط|فقط اشرح|اشرح النظام|انت فقط اشرح|أنت فقط اشرح|لا يوجد طلب|لايوجد طلب|ما في طلب|اي طلب|أي طلب|وانت مالك|وأنت مالك/i.test(value.trim());
const traderRegistrationChoicePattern = /trader registration|register as trader|تسجيل.*تاجر|التسجيل كتاجر|كتاجر|تاجر/i;
const emailAddressPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
export const publicAgentLabel = (value: unknown): string => String(value ?? "").replace(/_/g, " ").replace(/\s+/g, " ").trim().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
export const persistableAgentConversationIntent = (intent: AgentIntent): AgentIntent =>
  socialIntents.has(intent) ? "general_question" : intent;
export function privacyBoundaryResponse(language: AgentLanguage): string {
  return language === "ar"
    ? "لا أستطيع مشاركة بيانات خاصة أو داخلية، مثل أسماء شركات التوصيل أو التجار، معلومات عملاء آخرين، العمولات، الأرقام الداخلية، الملاحظات الداخلية أو أي أسرار. أقدر أشرح لك طريقة استخدام Tawseelhub أو أساعدك في طلبك الخاص فقط."
    : "I can’t share private or internal information such as Delivery Company or Trader names, other customers’ data, commissions, internal IDs, staff notes, credentials or secrets. I can explain how Tawseelhub works or help with your own request.";
}
export function generalKnowledgeContent(language: AgentLanguage, storedContent: string | undefined): string {
  if (language === "ar" && (storedContent === undefined || isCorruptedArabicText(storedContent))) return arabicGeneralFallback;
  return storedContent ?? "I do not have confirmed information for that yet.";
}
export function contextualGeneralFollowUpResponse(text: string, language: AgentLanguage, previousState: AgentState, currentState: AgentState): { content: string; intent: AgentIntent; status: string; structured: { suppressReturningAcknowledgement: true; state: AgentState } } | undefined {
  if (isAgentFeatureExplanationText(text) && !/(demo|عرض تجريبي|احجز|book|submit|send request|أرسل طلب|ارسل طلب)/i.test(text)) {
    const { pendingAction: _pendingAction, lastAskedSlot: _lastAskedSlot, pendingGeneralFollowUp: _pendingGeneralFollowUp, ...baseState } = currentState;
    const content = featureExplanationText(text, language);
    return { content, intent: "product_feature_question", status: "waiting_for_user", structured: { suppressReturningAcknowledgement: true, state: { ...baseState, lastBusinessIntent: "product_feature_question", pendingGeneralFollowUp: "feature_choice" } } };
  }
  if (previousState.lastAskedSlot && previousState.lastBusinessIntent && workflowIntents.has(previousState.lastBusinessIntent) && isAgentExplainOnlyText(text)) {
    const { pendingAction: _pendingAction, lastAskedSlot: _lastAskedSlot, pendingGeneralFollowUp: _pendingGeneralFollowUp, ...baseState } = currentState;
    const content = language === "ar"
      ? "تمام، أوقفت نموذج الطلب. Tawseelhub هو نظام يساعد شركات التوصيل والتجار على تنظيم الطلبات والتوصيل والتحصيل COD والتسويات والتقارير في مكان واحد. بالنسبة للتاجر، الفائدة أنه يستطيع ربط طلباته مع شركة التوصيل ومتابعة حالة الطلب والتحصيل والتسوية بشكل أوضح. هل تريد شرح جزء معيّن من النظام؟"
      : "Understood — I’ve stopped the request form. Tawseelhub helps Delivery Companies and Traders organize orders, delivery, COD collections, settlements and reports in one place. For a Trader, the value is connecting orders with a Delivery Company and following delivery status, COD and settlement more clearly. Which part of the system would you like explained?";
    return { content, intent: "general_question", status: "waiting_for_user", structured: { suppressReturningAcknowledgement: true, state: { ...baseState, lastBusinessIntent: "general_question", pendingGeneralFollowUp: "feature_choice" } } };
  }
  if ((previousState.pendingGeneralFollowUp === "public_explanation" || previousState.pendingGeneralFollowUp === "feature_choice") && isAgentTraderExplanationChoiceText(text)) {
    const { pendingAction: _pendingAction, lastAskedSlot: _lastAskedSlot, pendingGeneralFollowUp: _pendingGeneralFollowUp, ...baseState } = currentState;
    const content = language === "ar"
      ? "بالنسبة للتاجر، Tawseelhub يساعده على ربط متجره أو طلباته مع شركة توصيل، متابعة حالة الطلبات، معرفة ما تم تحصيله COD، ومتابعة التسويات حسب الاتفاق مع شركة التوصيل. هذا شرح للنظام فقط، وليس طلب تسجيل. هل تريد شرح التسجيل كتاجر أم متابعة الطلبات والتحصيل؟"
      : "For a Trader, Tawseelhub helps connect the store or orders with a Delivery Company, follow delivery status, track COD collected, and follow settlements based on the agreement with the Delivery Company. This is only an explanation, not a registration request. Would you like me to explain Trader registration or order/COD follow-up?";
    return { content, intent: "general_question", status: "waiting_for_user", structured: { suppressReturningAcknowledgement: true, state: { ...baseState, audience: "trader", lastBusinessIntent: "general_question", pendingGeneralFollowUp: "feature_choice" } } };
  }
  if (previousState.pendingAction && isAgentConfusionText(text)) {
    const { pendingAction: _pendingAction, lastAskedSlot: _lastAskedSlot, pendingGeneralFollowUp: _pendingGeneralFollowUp, ...baseState } = currentState;
    const content = language === "ar"
      ? "أعتذر، سأوضحها ببساطة. كنت أراجع تفاصيل طلب قبل الإرسال، لكن لن أرسله إلا إذا أكدت ذلك بوضوح. هل تريد شرح الخطوة، أم نبدأ من جديد؟"
      : "Sorry — let me make that clearer. I was reviewing details before submission, but I will not submit anything unless you clearly confirm. Would you like me to explain the step, or should we start again?";
    return { content, intent: "general_question", status: "waiting_for_user", structured: { suppressReturningAcknowledgement: true, state: baseState } };
  }
  if (isAgentDeductionQuestionText(text)) {
    const content = language === "ar"
      ? "Tawseelhub لا يخصم مبلغاً من العميل بشكل عشوائي. التكلفة تكون إما اشتراكاً شهرياً لشركة التوصيل حسب حجم الطلبات، أو سعر توصيل لكل شحنة حسب المسار والاتفاق. إذا تقصد خصماً في طلب أو فاتورة محددة، أرسل رقم المرجع لأتحقق منه."
      : "Tawseelhub does not randomly deduct money from customers. Costs are either a monthly subscription for the Delivery Company based on order volume, or a delivery charge for a shipment based on the route and agreement. If you mean a specific deduction on a request or invoice, send the reference number and I can check it.";
    const { pendingGeneralFollowUp: _pendingGeneralFollowUp, ...clearedState } = currentState;
    return { content, intent: "general_question", status: "waiting_for_user", structured: { suppressReturningAcknowledgement: true, state: clearedState } };
  }
  if (isAgentAnyPricingTopicText(text)) {
    const { pendingAction: _pendingAction, lastAskedSlot: _lastAskedSlot, pendingGeneralFollowUp: _pendingGeneralFollowUp, ...baseState } = currentState;
    return {
      content: platformPricingResponse(language),
      intent: "general_question",
      status: "waiting_for_user",
      structured: { suppressReturningAcknowledgement: true, state: { ...baseState, lastBusinessIntent: "general_question" } },
    };
  }
  if (previousState.pendingGeneralFollowUp === "feature_choice" && traderRegistrationChoicePattern.test(text) && !isAgentTraderExplanationChoiceText(text)) {
    const { pendingAction: _pendingAction, lastAskedSlot: _lastAskedSlot, pendingGeneralFollowUp: _pendingGeneralFollowUp, ...baseState } = currentState;
    const content = language === "ar"
      ? "التسجيل كتاجر يعني أن المتجر يترك بياناته في Tawseelhub حتى يستطيع فريق العمليات ربطه بخدمة التوصيل المناسبة ومتابعة الطلبات والتحصيل لاحقاً. إذا أردت التسجيل، سأبدأ معك من أول سؤال ولن أستخدم تفاصيل قديمة بدون تأكيد. هل تريد أن نبدأ طلب تسجيل تاجر الآن؟"
      : "Trader registration means the store leaves its details with Tawseelhub so the operations team can connect it to the right delivery service and later manage orders and COD follow-up. If you want to register, I’ll start from the first question and won’t reuse old details without confirmation. Should we start a Trader application now?";
    return { content, intent: "general_question", status: "waiting_for_user", structured: { suppressReturningAcknowledgement: true, state: { ...baseState, pendingGeneralFollowUp: "trader_registration_explained" } } };
  }
  if (previousState.pendingGeneralFollowUp === "trader_registration_explained" && isAgentAffirmativeText(text)) {
    const { pendingAction: _pendingAction, lastAskedSlot: _lastAskedSlot, pendingGeneralFollowUp: _pendingGeneralFollowUp, ...baseState } = currentState;
    const content = language === "ar"
      ? "تمام، لنبدأ طلب تسجيل التاجر. ما اسم المتجر؟"
      : "Great, let’s start the Trader application. What is the store name?";
    return { content, intent: "trader", status: "waiting_for_user", structured: { suppressReturningAcknowledgement: true, state: { ...baseState, slots: {}, lastBusinessIntent: "trader", lastAskedSlot: "storeName" } } };
  }
  if (previousState.pendingGeneralFollowUp && isAgentAffirmativeText(text)) {
    const content = language === "ar"
      ? "تمام. أي جزء تريدني أشرحه: التحصيل COD، إدارة السائقين، تسويات التجار، التقارير، الأسعار، أو التسجيل كتاجر؟"
      : "Sure. Which part should I explain: COD collections, driver management, Trader settlements, reports, pricing, or Trader registration?";
    return { content, intent: "general_question", status: "waiting_for_user", structured: { suppressReturningAcknowledgement: true, state: { ...currentState, pendingGeneralFollowUp: "feature_choice" } } };
  }
  return undefined;
}
function featureExplanationText(text: string, language: AgentLanguage): string {
  const lower = text.toLowerCase();
  if (/driver management|manage drivers|drivers|إدارة السائقين|ادارة السائقين|السائقين|المندوبين/.test(lower)) {
    return language === "ar"
      ? "إدارة السائقين في Tawseelhub تعني أن شركة التوصيل تستطيع تنظيم بيانات السائقين، متابعة الطلبات المسندة لكل سائق، مراقبة حالة التسليم، وربط عمل السائقين بالتحصيل COD والتقارير. هذا شرح للميزة فقط، وليس طلب عرض تجريبي. هل تريد شرح التحصيل مع السائقين أم تقارير أداء السائقين؟"
      : "Driver management in Tawseelhub helps a Delivery Company organize driver records, follow assigned orders, monitor delivery status, and connect driver activity to COD collections and reports. This is only a feature explanation, not a demo request. Would you like me to explain driver collections or driver performance reports?";
  }
  if (/cod|cash on delivery|collection|تحصيل/.test(lower)) {
    return language === "ar"
      ? "التحصيل COD في Tawseelhub يساعد على ربط مبلغ التحصيل بالطلب والسائق والتاجر، ثم متابعة ما تم تحصيله وما يحتاج تسوية أو مطابقة. هل تريد شرح تحصيل السائقين أم تسويات التجار؟"
      : "COD in Tawseelhub connects collected amounts to the order, driver and Trader, then tracks what was collected and what needs settlement or reconciliation. Would you like driver collection or Trader settlement explained?";
  }
  if (/settlement|التسويات|تسويات/.test(lower)) {
    return language === "ar"
      ? "التسويات تساعد على متابعة المبالغ المستحقة للتجار أو على السائقين بعد التسليم والتحصيل، حتى تكون الأرصدة والتقارير أوضح. هل تريد شرح تسويات التجار أم تقارير التحصيل؟"
      : "Settlements help track amounts payable to Traders or due from drivers after delivery and COD collection, so balances and reports stay clear. Would you like Trader settlements or collection reports explained?";
  }
  if (/report|reports|التقارير|تقارير/.test(lower)) {
    return language === "ar"
      ? "التقارير في Tawseelhub تعرض صورة تشغيلية عن الطلبات والسائقين والتحصيل والتسويات وأداء التوصيل، حسب إعدادات الشركة. هل تريد مثالاً على تقرير السائقين أم تقرير COD؟"
      : "Reports in Tawseelhub show operational visibility across orders, drivers, COD, settlements and delivery performance depending on company setup. Would you like an example of driver reports or COD reports?";
  }
  return language === "ar"
    ? "هذه ميزة داخل نظام Tawseelhub لإدارة عمليات التوصيل. أشرحها لك بدون بدء أي طلب. أي جزء تريد تفاصيل أكثر عنه؟"
    : "This is a Tawseelhub delivery operations feature. I can explain it without starting any request. Which part would you like more detail on?";
}
function platformPricingResponse(language: AgentLanguage): string {
  return language === "ar"
    ? "أسعار استخدام نظام Tawseelhub موجودة هنا: https://tawseelhub.com/pricing"
    : "Tawseelhub system pricing is available here: https://tawseelhub.com/pricing";
}
export function publicConversationIntroStep(text: string, language: AgentLanguage, state: AgentState): { content: string; intent: AgentIntent; status: string; structured: { state: AgentState } } | undefined {
  const slots = { ...state.slots };
  const answer = text.trim();
  const previousMissing = state.lastAskedSlot;
  const isQuestion = /[?؟]/.test(answer);
  const isNonAnswer = !answer || isQuestion || /^(hi|hello|hey|مرحبا|هلا|السلام عليكم|كيفك|كيف الحال)$/i.test(answer);
  const normalizedMobileAnswer = answer.replace(/\D/g, "");
  const isUaeMobileAnswer = /^05\d{8}$/.test(normalizedMobileAnswer) || /^5\d{8}$/.test(normalizedMobileAnswer) || /^9715\d{8}$/.test(normalizedMobileAnswer);

  if (previousMissing === "contactName" && !isNonAnswer && answer.length <= 80) {
    slots.contactName = answer;
    slots.requesterName = slots.requesterName ?? answer;
    slots.contactPerson = slots.contactPerson ?? answer;
  }
  if (previousMissing === "requesterMobile") {
    if (isUaeMobileAnswer) {
      slots.requesterMobile = answer;
      slots.mobileNumber = slots.mobileNumber ?? answer;
      slots.mobile = slots.mobile ?? answer;
    } else if (answer) {
      return {
        content: language === "ar" ? "رقم الهاتف غير واضح. اكتب رقم موبايل إماراتي مثل 0501234567." : "The mobile number is not clear. Please enter a UAE mobile like 0501234567.",
        intent: "general_question",
        status: "waiting_for_user",
        structured: { state: { ...state, slots, lastBusinessIntent: "general_question", lastAskedSlot: "requesterMobile" } },
      };
    }
  }
  if (previousMissing === "companyName" && !isNonAnswer && answer.length <= 120) {
    slots.companyName = answer;
    slots.storeName = slots.storeName ?? answer;
  }
  if (previousMissing === "email") {
    const email = emailAddressPattern.exec(answer)?.[0]?.toLowerCase();
    if (email) {
      slots.email = email;
      slots.requesterEmail = slots.requesterEmail ?? email;
    } else if (answer) {
      return {
        content: language === "ar" ? "البريد الإلكتروني غير واضح. اكتب الإيميل بصيغة مثل name@example.com." : "The email is not clear. Please enter it like name@example.com.",
        intent: "general_question",
        status: "waiting_for_user",
        structured: { state: { ...state, slots, lastBusinessIntent: "general_question", lastAskedSlot: "email" } },
      };
    }
  }

  const hasName = Boolean(slots.contactName ?? slots.requesterName ?? slots.contactPerson);
  const hasMobile = Boolean(slots.requesterMobile ?? slots.mobileNumber ?? slots.mobile);
  const hasBusinessName = Boolean(slots.companyName ?? slots.storeName);
  const hasEmail = Boolean(slots.email ?? slots.requesterEmail);
  if (!hasName) {
    return {
      content: language === "ar" ? "قبل أن أساعدك، ما اسمك؟" : "Before I help, what is your name?",
      intent: "general_question",
      status: "waiting_for_user",
      structured: { state: { ...state, slots, lastBusinessIntent: "general_question", lastAskedSlot: "contactName" } },
    };
  }
  if (!hasMobile) {
    return {
      content: language === "ar" ? "ما رقم الهاتف المتحرك في الإمارات؟" : "What UAE mobile number should we use?",
      intent: "general_question",
      status: "waiting_for_user",
      structured: { state: { ...state, slots, lastBusinessIntent: "general_question", lastAskedSlot: "requesterMobile" } },
    };
  }
  if (!hasBusinessName) {
    return {
      content: language === "ar" ? "ما اسم الشركة أو المتجر؟" : "What is the company or store name?",
      intent: "general_question",
      status: "waiting_for_user",
      structured: { state: { ...state, slots, lastBusinessIntent: "general_question", lastAskedSlot: "companyName" } },
    };
  }
  if (!hasEmail) {
    return {
      content: language === "ar" ? "ما البريد الإلكتروني للتواصل؟" : "What email should we use for contact?",
      intent: "general_question",
      status: "waiting_for_user",
      structured: { state: { ...state, slots, lastBusinessIntent: "general_question", lastAskedSlot: "email" } },
    };
  }
  if (previousMissing === "contactName" || previousMissing === "requesterMobile" || previousMissing === "companyName" || previousMissing === "email") {
    const { lastAskedSlot: _lastAskedSlot, ...nextState } = { ...state, slots, lastBusinessIntent: "general_question" as const };
    return {
      content: language === "ar" ? "شكراً، تم حفظ بيانات التواصل. كيف يمكنني مساعدتك الآن؟" : "Thanks, I saved the contact details. How can I help you now?",
      intent: "general_question",
      status: "waiting_for_user",
      structured: { state: nextState },
    };
  }
  return undefined;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  public constructor(
    @Inject(DATABASE) private readonly db: Kysely<DatabaseSchema>,
    @Inject(CustomerQuoteService) private readonly quotes: CustomerQuoteService,
    @Inject(TraderApplicationService) private readonly traders: TraderApplicationService,
    @Inject(DemoRequestService) private readonly demos: DemoRequestService,
    @Inject(AgentModelRouterProvider) private readonly model: AgentModelRouterProvider,
  ) {}

  private visitorIpHash(visitorIp?: string) {
    const normalized = visitorIp?.trim().toLowerCase();
    return normalized ? hash(`agent-ip:${normalized}`) : null;
  }

  public async createWebsiteConversation(language?: AgentLanguage, visitorId?: string, visitorIp?: string) {
    const sessionToken = token();
    const settings = await this.settings();
    if (!settings.agentEnabled || !settings.websiteChatEnabled) throw new BadRequestException("agent_disabled");
    const ref = await reference(this.db, "platform_agent_conversation_reference_seq", "AGT");
    const stableVisitorId = validUuid.test(visitorId ?? "") ? visitorId! : randomUUID();
    const visitorIpHash = this.visitorIpHash(visitorIp);
    await sql`insert into platform_agent_conversations(reference_number,public_session_token_hash,visitor_id,visitor_ip_hash,visitor_ip_seen_at,channel,language,current_intent,status,requester_type,audience,last_message_at,state) values(${ref},${hash(sessionToken)},${stableVisitorId}::uuid,${visitorIpHash},case when ${visitorIpHash}::text is not null then now() else null end,'website',${language ?? settings.defaultLanguage},'unknown','active','unknown','unknown',now(),${JSON.stringify({ slots: {}, audience: "unknown", discussedTopics: [], visitorId: stableVisitorId })}::jsonb)`.execute(this.db);
    const selectedLanguage = language ?? settings.defaultLanguage;
    const welcome = this.welcome(selectedLanguage);
    const quickActions = selectedLanguage === "ar" ? agentQuickActionsArabic : agentQuickActions;
    await this.appendMessageByReference(ref, "assistant", welcome, { quickActions });
    return { conversationToken: sessionToken, reference: ref, assistantName: settings.assistantDisplayName, language: selectedLanguage, message: welcome, quickActions };
  }

  public async websiteConversation(sessionToken: string) {
    const conversation = await this.findByToken(sessionToken);
    return this.publicConversation(conversation);
  }

  public async receiveWebsiteMessage(sessionToken: string, text: string, language?: AgentLanguage, visitorIp?: string) {
    const conversation = await this.findByToken(sessionToken);
    const visitorIpHash = this.visitorIpHash(visitorIp);
    if (visitorIpHash) {
      await sql`
        update platform_agent_conversations
        set visitor_ip_hash=coalesce(visitor_ip_hash, ${visitorIpHash}),
          visitor_ip_seen_at=now()
        where id=${conversation.id}::uuid
      `.execute(this.db);
      conversation.visitor_ip_hash = String(conversation.visitor_ip_hash ?? visitorIpHash);
      conversation.visitor_ip_seen_at = new Date().toISOString();
    }
    return this.handleInbound(conversation, { channel: "website", text, ...(language === undefined ? {} : { language }) });
  }

  public async simulateWhatsApp(input: { sender: string; message: string; inboundMessageId: string; language?: AgentLanguage }) {
    return this.receiveWhatsAppMessages("sandbox", [{
      eventId: input.inboundMessageId,
      from: input.sender,
      fromNormalized: normalizeInternationalMobile(input.sender) ?? input.sender,
      ...(input.language === undefined ? {} : { language: input.language }),
      messageId: input.inboundMessageId,
      text: input.message,
      timestamp: new Date(),
    }]);
  }

  public whatsappProvider(providerType?: string): WhatsAppProvider {
    if (providerType === "sandbox") return new SandboxWhatsAppProvider();
    return new MetaWhatsAppCloudProvider({
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN?.trim() || undefined,
      appSecret: process.env.WHATSAPP_APP_SECRET?.trim() || undefined,
      graphApiBaseUrl: process.env.WHATSAPP_GRAPH_API_BASE_URL?.trim() || "https://graph.facebook.com/v20.0",
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || undefined,
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN?.trim() || undefined,
    });
  }

  public async verifyWhatsAppWebhook(query: Record<string, unknown>) {
    const settings = await this.settings();
    const challenge = this.whatsappProvider(settings.whatsappProvider).verifyWebhook(query);
    if (!challenge) throw new UnauthorizedException("whatsapp_webhook_verification_failed");
    return challenge;
  }

  public async receiveWhatsAppWebhook(body: unknown, rawBody: Buffer | undefined, signature: string | undefined) {
    const settings = await this.settings();
    if (!settings.whatsappAgentEnabled || settings.whatsappProvider === "disabled") throw new BadRequestException("whatsapp_disabled");
    const provider = this.whatsappProvider(settings.whatsappProvider);
    if (settings.whatsappProvider !== "sandbox" && !provider.verifySignature(rawBody, signature)) {
      await this.recordWebhook("meta_cloud", `unauthorized-${randomUUID()}`, "message", "unauthorized", null, null, null, "signature_failed");
      throw new UnauthorizedException("whatsapp_signature_failed");
    }
    return this.receiveWhatsAppMessages(settings.whatsappProvider ?? "meta_cloud", provider.normalizeWebhook(body));
  }

  public async receiveWhatsAppMessages(providerName: string, messages: Array<{ eventId: string; messageId: string; from: string; fromNormalized: string; text: string; timestamp: Date; language?: AgentLanguage; mediaType?: string }>) {
    const settings = await this.settings();
    if (!settings.agentEnabled) throw new BadRequestException("agent_disabled");
    const results: unknown[] = [];
    for (const message of messages) {
      const existing = (await sql<{ id: string }>`select id from platform_agent_messages where provider=${providerName} and provider_message_id=${message.messageId} limit 1`.execute(this.db)).rows[0];
      if (existing) {
        await this.recordWebhook(providerName, message.eventId, "message", "duplicate", null, message.messageId, message.fromNormalized, null);
        results.push({ duplicate: true, providerMessageId: message.messageId });
        continue;
      }
      const conversation = await this.findOrCreateWhatsAppConversation(providerName, message.from, message.fromNormalized, message.language ?? settings.defaultLanguage);
      await this.recordWebhook(providerName, message.eventId, "message", "received", String(conversation.id), message.messageId, message.fromNormalized, null);
      const result = await this.handleInbound(conversation, { channel: "whatsapp", inboundMessageId: message.messageId, ...(message.language === undefined ? {} : { language: message.language }), provider: providerName, providerMessageId: message.messageId, text: message.text });
      await this.recordWebhook(providerName, message.eventId, "message", "processed", String(conversation.id), message.messageId, message.fromNormalized, null);
      results.push(result);
    }
    await sql`update platform_agent_settings set whatsapp_last_webhook_at=now(), whatsapp_last_error_code=null where id=true`.execute(this.db);
    return { processed: results.length, results };
  }

  private async findOrCreateWhatsAppConversation(providerName: string, mobile: string, normalizedMobile: string, language: AgentLanguage) {
    const subjectHash = hash(normalizedMobile);
    const existing = (await sql<Record<string, unknown>>`
      select * from platform_agent_conversations
      where mobile_number_normalized=${normalizedMobile}
        and status not in('closed','abandoned')
        and (last_message_at at time zone 'Asia/Dubai')::date = (now() at time zone 'Asia/Dubai')::date
      order by last_message_at desc nulls last, created_at desc
      limit 1
    `.execute(this.db)).rows[0];
    if (existing) return existing;
    const ref = await reference(this.db, "platform_agent_conversation_reference_seq", "AGT");
    await sql`
      insert into platform_agent_conversations(reference_number,public_session_token_hash,channel,channel_subject_hash,provider,provider_thread_id,language,current_intent,status,requester_type,audience,mobile_number,mobile_number_normalized,last_message_at,last_customer_message_at,last_channel,state,operational_classification,review_status)
      values(${ref},${hash(`whatsapp:${providerName}:${normalizedMobile}:${Date.now()}`)},'whatsapp',${subjectHash},${providerName},${normalizedMobile},${language},'unknown','active','unknown','unknown',${mobile},${normalizedMobile},now(),now(),'whatsapp',${JSON.stringify({ slots: { mobileNumber: mobile, requesterMobile: mobile }, audience: "unknown", discussedTopics: [], seenInboundMessageIds: [] })}::jsonb,'general_enquiry','new')
    `.execute(this.db);
    return (await sql<Record<string, unknown>>`select * from platform_agent_conversations where reference_number=${ref}`.execute(this.db)).rows[0]!;
  }

  private async handleInbound(conversation: Record<string, unknown>, input: { channel: AgentChannel; text: string; inboundMessageId?: string; language?: AgentLanguage; provider?: string; providerMessageId?: string }) {
    if (input.text.length > 1200) throw new BadRequestException("message_too_long");
    const state = this.state(conversation.state);
    if (input.inboundMessageId && state.seenInboundMessageIds?.includes(input.inboundMessageId)) return this.publicConversation(conversation);
    state.seenInboundMessageIds = [...(state.seenInboundMessageIds ?? []), ...(input.inboundMessageId ? [input.inboundMessageId] : [])].slice(-50);
    await this.appendMessage(String(conversation.id), "user", input.text, undefined, { channel: input.channel, direction: "inbound", ...(input.provider === undefined ? {} : { provider: input.provider }), ...(input.providerMessageId === undefined ? {} : { providerMessageId: input.providerMessageId }) });
    if (conversation.conversation_mode === "paused" && cancelHumanRequestPattern.test(input.text.trim())) {
      const language = input.language ?? conversation.language as AgentLanguage;
      const content = language === "ar" ? "تم، يوسف متاح مرة أخرى. كيف يمكنني مساعدتك الآن؟" : "Done — Yousef is available again. How can I help you now?";
      await sql`
        update platform_agent_conversations
        set conversation_mode='ai_resume', current_intent='general_question', status='active', state=${JSON.stringify(state)}::jsonb,
            review_status=case when review_status='new' then 'open' else review_status end,
            last_customer_message_at=now(), last_channel=${input.channel}, updated_at=now(), last_message_at=now()
        where id=${conversation.id}::uuid
      `.execute(this.db);
      await this.appendMessage(String(conversation.id), "assistant", content, { humanRequestCancelled: true }, { channel: input.channel, direction: "outbound", ...(input.provider === undefined ? {} : { provider: input.provider }) });
      const updated = (await sql<Record<string, unknown>>`select * from platform_agent_conversations where id=${conversation.id}::uuid`.execute(this.db)).rows[0]!;
      return { ...(await this.publicConversation(updated)), reply: content, intent: "general_question", language };
    }
    if (conversation.conversation_mode === "human_active" || conversation.conversation_mode === "paused") {
      await sql`
        update platform_agent_conversations
        set state=${JSON.stringify(state)}::jsonb, review_status='open', last_customer_message_at=now(), last_channel=${input.channel}, updated_at=now(), last_message_at=now()
        where id=${conversation.id}::uuid
      `.execute(this.db);
      const updated = (await sql<Record<string, unknown>>`select * from platform_agent_conversations where id=${conversation.id}::uuid`.execute(this.db)).rows[0]!;
      return { ...(await this.publicConversation(updated)), reply: null, intent: updated.current_intent, language: updated.language, automationSuppressed: true };
    }
    const settings = await this.settings();
    const frame = decideNextFrame({
      currentIntent: conversation.current_intent as AgentIntent,
      message: input.text,
      state,
    });
    this.logFrameDecision(String(conversation.id), frame);
    if (frame.decision === "privacy_blocked") {
      const language = input.language ?? conversation.language as AgentLanguage;
      const { pendingAction: _pendingAction, lastAskedSlot: _lastAskedSlot, ...privacyBaseState } = state;
      const framedState = stateWithFrame({
        ...privacyBaseState,
        lastBusinessIntent: "general_question",
      }, frame);
      const content = privacyBoundaryResponse(language);
      await this.appendMessage(String(conversation.id), "assistant", content, { conversationFrame: frame, state: framedState }, { channel: input.channel, direction: "outbound", ...(input.provider === undefined ? {} : { provider: input.provider }) });
      await sql`update platform_agent_conversations set language=${language},current_intent='general_question',status='waiting_for_user',audience=${framedState.audience ?? "unknown"},state=${JSON.stringify(framedState)}::jsonb,updated_at=now(),last_message_at=now() where id=${conversation.id}::uuid`.execute(this.db);
      const updated = (await sql<Record<string, unknown>>`select * from platform_agent_conversations where id=${conversation.id}::uuid`.execute(this.db)).rows[0]!;
      return { ...(await this.publicConversation(updated)), reply: content, intent: "general_question", language };
    }
    if (input.channel === "whatsapp" && (!settings.whatsappAgentEnabled || settings.whatsappProvider === "disabled")) {
      await sql`update platform_agent_conversations set state=${JSON.stringify(state)}::jsonb, review_status='open', last_customer_message_at=now(), last_channel='whatsapp', updated_at=now(), last_message_at=now() where id=${conversation.id}::uuid`.execute(this.db);
      const updated = (await sql<Record<string, unknown>>`select * from platform_agent_conversations where id=${conversation.id}::uuid`.execute(this.db)).rows[0]!;
      return { ...(await this.publicConversation(updated)), reply: null, intent: updated.current_intent, language: updated.language, automationSuppressed: true };
    }
    const intro = publicConversationIntroStep(input.text, input.language ?? conversation.language as AgentLanguage, state);
    if (intro) {
      const introState = intro.structured.state;
      const identity = this.identityFromState(introState);
      await this.appendMessage(String(conversation.id), "assistant", intro.content, intro.structured, { channel: input.channel, direction: "outbound", ...(input.provider === undefined ? {} : { provider: input.provider }) });
      await sql`update platform_agent_conversations set language=${input.language ?? conversation.language as AgentLanguage},current_intent='general_question',status=${intro.status},audience=${introState.audience ?? "unknown"},customer_name=${identity.name},mobile_number=${identity.mobileOriginal},mobile_number_normalized=${identity.mobileNormalized},email=${identity.email},state=${JSON.stringify(introState)}::jsonb,updated_at=now(),last_message_at=now() where id=${conversation.id}::uuid`.execute(this.db);
      const updated = (await sql<Record<string, unknown>>`select * from platform_agent_conversations where id=${conversation.id}::uuid`.execute(this.db)).rows[0]!;
      return { ...(await this.publicConversation(updated)), reply: intro.content, intent: "general_question", language: input.language ?? conversation.language as AgentLanguage };
    }
    if (state.lastAskedSlot && this.isClarification(input.text)) {
      const contextualClarification = contextualGeneralFollowUpResponse(input.text, input.language ?? conversation.language as AgentLanguage, state, state);
      if (contextualClarification) {
        await this.appendMessage(String(conversation.id), "assistant", contextualClarification.content, contextualClarification.structured, { channel: input.channel, direction: "outbound", ...(input.provider === undefined ? {} : { provider: input.provider }) });
        await sql`update platform_agent_conversations set language=${input.language ?? conversation.language as AgentLanguage},current_intent='general_question',status='waiting_for_user',state=${JSON.stringify(contextualClarification.structured.state)}::jsonb,updated_at=now(),last_message_at=now() where id=${conversation.id}::uuid`.execute(this.db);
        const updated = (await sql<Record<string, unknown>>`select * from platform_agent_conversations where id=${conversation.id}::uuid`.execute(this.db)).rows[0]!;
        return { ...(await this.publicConversation(updated)), reply: contextualClarification.content, intent: "general_question", language: input.language ?? conversation.language as AgentLanguage };
      }
      const language = input.language ?? conversation.language as AgentLanguage;
      const response = this.fieldClarification(state.lastAskedSlot, language, state, input.text);
      await this.appendMessage(String(conversation.id), "assistant", response.content, { clarificationFor: state.lastAskedSlot }, { channel: input.channel, direction: "outbound", ...(input.provider === undefined ? {} : { provider: input.provider }) });
      const updatedState = { ...state, seenInboundMessageIds: state.seenInboundMessageIds };
      await sql`update platform_agent_conversations set language=${language},current_intent='clarification',status='waiting_for_user',state=${JSON.stringify(updatedState)}::jsonb,updated_at=now(),last_message_at=now() where id=${conversation.id}::uuid`.execute(this.db);
      const updated = (await sql<Record<string, unknown>>`select * from platform_agent_conversations where id=${conversation.id}::uuid`.execute(this.db)).rows[0]!;
      return { ...(await this.publicConversation(updated)), reply: response.content, intent: "clarification", language };
    }
    let model: AgentModelResult;
    try {
      model = await this.model.classifyAndExtract({ text: input.text, language: input.language ?? conversation.language as AgentLanguage, previousIntent: this.previousIntentForClassification(conversation.current_intent as AgentIntent, state), state });
    } catch (error) {
      this.logger.warn({
        code: (error as { code?: string; message?: string }).code ?? (error as { message?: string }).message?.slice(0, 80) ?? "provider_failed",
        diagnostics: this.model.diagnostics(),
      }, "Tawseelhub Agent model provider failed");
      try {
        model = await safeRulesClassifier.classifyAndExtract({ text: input.text, language: input.language ?? conversation.language as AgentLanguage, previousIntent: this.previousIntentForClassification(conversation.current_intent as AgentIntent, state), state });
      } catch (rulesError) {
        this.logger.error({
          code: (rulesError as { code?: string; message?: string }).code ?? (rulesError as { message?: string }).message?.slice(0, 80) ?? "rules_failed",
        }, "Tawseelhub Agent rules fallback failed");
        const language = conversation.language as AgentLanguage;
        const offline = input.channel === "website" && !settings.humanHandoffEnabled;
        const safe = input.channel === "website" ? (offline ? this.humanUnavailableAskForContactMessage(language, state) : this.humanWaitingMessage(language)) : "I'm unable to complete that request right now. You can try again, or I can pass your request to the Tawseelhub team.";
        const fallbackState = offline ? this.humanUnavailableContactState(state) : state;
        await this.appendMessage(String(conversation.id), "assistant", safe, { providerError: true, rulesError: true, state: fallbackState }, { channel: input.channel, direction: "outbound", ...(input.provider === undefined ? {} : { provider: input.provider }) });
        if (input.channel === "website" && !offline) await this.markWebsiteHumanRequested(String(conversation.id), String(conversation.conversation_mode ?? "ai_active"), "Model provider and rules fallback failed");
        if (offline) await sql`update platform_agent_conversations set current_intent='handoff',status='waiting_for_user',requester_type='unknown',audience=${fallbackState.audience ?? "unknown"},state=${JSON.stringify(fallbackState)}::jsonb,review_status=case when review_status='new' then 'follow_up' else review_status end,last_customer_message_at=now(),last_channel=${input.channel},updated_at=now(),last_message_at=now() where id=${conversation.id}::uuid`.execute(this.db);
        const updated = (await sql<Record<string, unknown>>`select * from platform_agent_conversations where id=${conversation.id}::uuid`.execute(this.db)).rows[0]!;
        return { ...(await this.publicConversation(updated)), reply: safe, intent: "handoff", language };
      }
    }
    const frameIntent = this.intentFromConversationFrame(frame, model.intent);
    const turnIntent = (isAgentTraderUsageQuestionText(input.text) || isAgentFeatureExplanationText(input.text)) ? "product_feature_question" : this.resolveTurnIntent(input.text, frameIntent, state);
    const mergedSlots = this.mergeSlots(state.slots, model.extracted, model.wantsCorrection);
    const frameScopedState = this.stateScopedByConversationFrame(state, frame);
    let nextState = this.enrichState(input.text, turnIntent, { ...frameScopedState, slots: this.applySequentialWorkflowAnswer(input.text, turnIntent, frameScopedState, mergedSlots) });
    nextState = stateWithFrame(nextState, frame);
    if (state.lastAskedSlot === "deliveryAddress" && this.isSkipAnswer(input.text)) {
      const { deliveryAddress: _deliveryAddress, ...remainingSlots } = nextState.slots;
      nextState = { ...nextState, deliveryAddressSkipped: true, slots: remainingSlots };
    }
    if (state.pendingAction && !model.wantsConfirmation && businessInfoIntents.has(model.intent)) {
      const { pendingAction: _pendingAction, lastAskedSlot: _lastAskedSlot, ...rest } = nextState;
      nextState = rest;
    }
    let response: { content: string; structured?: Record<string, unknown>; status?: string; intent?: AgentIntent };
    const contextualGeneralFollowUp = contextualGeneralFollowUpResponse(input.text, model.language, state, nextState);
    const interruption = contextualGeneralFollowUp ? undefined : await this.workflowInterruptionResponse(String(conversation.id), input.text, model.language, state, nextState);
    if (contextualGeneralFollowUp) response = contextualGeneralFollowUp;
    else if (interruption) response = interruption;
    else if (state.pendingAction && model.wantsConfirmation) response = await this.executePending(String(conversation.id), state.pendingAction.type, nextState);
    else response = await this.previousRequestQuestionResponse(String(conversation.id), input.text, model.language, nextState)
      ?? await this.nextResponse(String(conversation.id), turnIntent, model.language, nextState, String(conversation.status ?? ""), input.channel, settings);
    const mergedState = response.structured?.state as AgentState | undefined ?? nextState;
    const identity = this.identityFromState(mergedState);
    const responseIntent = response.intent ?? model.intent;
    const persistedIntent = persistableAgentConversationIntent(responseIntent);
    const classification = this.classificationFor(responseIntent, mergedState);
    const acknowledged = response.structured?.suppressReturningAcknowledgement ? response.content : await this.returningCustomerAcknowledgement(String(conversation.id), model.language, state, mergedState, response.content);
    const isWebsiteHandoff = input.channel === "website" && response.structured?.websiteHumanRequested === true;
    const reviewStatusOverride = typeof response.structured?.reviewStatus === "string" ? response.structured.reviewStatus : null;
    await sql`update platform_agent_conversations set language=${model.language},current_intent=${persistedIntent},status=${response.status ?? "waiting_for_user"},requester_type=${this.requesterType(responseIntent)},audience=${mergedState.audience ?? "unknown"},customer_name=${identity.name},mobile_number=${identity.mobileOriginal},mobile_number_normalized=${identity.mobileNormalized},email=${identity.email},operational_classification=${classification},state=${JSON.stringify(mergedState)}::jsonb,conversation_mode=case when ${isWebsiteHandoff}::boolean then 'paused' else conversation_mode end,review_status=case when ${reviewStatusOverride}::text is not null then ${reviewStatusOverride}::text when ${isWebsiteHandoff}::boolean and review_status='new' then 'open' else review_status end,mode_changed_at=case when ${isWebsiteHandoff}::boolean then now() else mode_changed_at end,updated_at=now(),last_message_at=now() where id=${conversation.id}::uuid`.execute(this.db);
    if (isWebsiteHandoff) await this.recordModeHistory(String(conversation.id), String(conversation.conversation_mode ?? "ai_active"), "paused", null, "Human requested from website chat");
    const assistantMessageId = await this.appendMessage(String(conversation.id), "assistant", acknowledged, response.structured, { channel: input.channel, direction: "outbound", ...(input.provider === undefined ? {} : { provider: input.provider }) });
    if (input.channel === "whatsapp" && input.provider) {
      const provider = this.whatsappProvider(input.provider);
      const send = await provider.sendText(String(conversation.mobile_number_normalized ?? ""), acknowledged);
      await sql`
        update platform_agent_messages
        set provider_message_id=${send.providerMessageId}, delivery_status=${send.status}, failure_code=${send.failureCode ?? null}
        where id=${assistantMessageId}::uuid
      `.execute(this.db);
      await sql`update platform_agent_settings set whatsapp_last_outbound_at=case when ${send.status}<>'failed' then now() else whatsapp_last_outbound_at end, whatsapp_last_error_code=${send.failureCode ?? null} where id=true`.execute(this.db);
    }
    const updated = (await sql<Record<string, unknown>>`select * from platform_agent_conversations where id=${conversation.id}::uuid`.execute(this.db)).rows[0]!;
    return { ...(await this.publicConversation(updated)), reply: acknowledged, intent: responseIntent ?? turnIntent, language: model.language };
  }

  private async nextResponse(conversationId: string, intent: AgentIntent, language: AgentLanguage, state: AgentState, currentStatus = "", channel?: AgentChannel, settings?: { humanHandoffEnabled?: boolean }) {
    if (socialIntents.has(intent)) return this.socialResponse(intent, language);
    if (currentStatus === "completed" && state.lastBusinessIntent === "customer_quote" && !state.pendingAction) return this.completedQuoteFollowUp(language);
    if (intent === "handoff") return this.prepareHandoff(conversationId, state, language, "requested_by_user", channel, settings?.humanHandoffEnabled ?? true);
    if (intent === "customer_quote") return this.quoteStep(state, language);
    if (intent === "trader") return this.traderStep(state, language);
    if (intent === "delivery_company_demo") return this.demoStep(state, language);
    return this.answerGeneralQuestion(conversationId, state, language, intent);
  }

  private quoteStep(state: AgentState, language: AgentLanguage) {
    const slots = { quantity: 1, requestedServiceType: "standard", codRequired: false, codAmount: 0, ...state.slots };
    const required: Array<[keyof AgentSlots, string, string]> = [
      ["requesterName", "What name should we put on the quote request?", "ما الاسم المطلوب لطلب السعر؟"],
      ["requesterMobile", "What UAE mobile number should we use for the quote?", "ما رقم الهاتف المتحرك في الإمارات؟"],
      ["pickupEmirate", "Which emirate should we pick up from?", "من أي إمارة يكون الاستلام؟"],
      ["pickupArea", "What pickup area should I use?", "ما منطقة الاستلام؟"],
      ["deliveryEmirate", "Which emirate is the delivery going to?", "إلى أي إمارة يكون التوصيل؟"],
      ["deliveryArea", "What delivery area should I use?", "ما منطقة التوصيل؟"],
      ["packageType", "What are you sending?", "ما نوع الشحنة؟"],
      ["weightKg", "What is the approximate weight in kg?", "ما الوزن التقريبي بالكيلو؟"],
      ["pickupDate", "What pickup date should I use?", "ما تاريخ الاستلام؟"],
    ];
    const missing = required.find(([key]) => slots[key] === undefined || slots[key] === "");
    if (missing) return { content: language === "ar" ? missing[2] : missing[1], intent: "customer_quote" as const, status: "waiting_for_user", structured: { state: { ...state, slots, lastAskedSlot: missing[0] } } };
    if (!slots.deliveryAddress && !state.deliveryAddressSkipped) {
      const content = language === "ar"
        ? "هل لديك عنوان التوصيل الكامل أو معلم قريب؟ هذا اختياري لطلب السعر الأولي، ويمكنك كتابة “تخطي”."
        : "Do you have the exact delivery address or a nearby landmark? This is optional for the initial quote, and you can type “skip”.";
      return { content, intent: "customer_quote" as const, status: "waiting_for_user", structured: { state: { ...state, slots, lastAskedSlot: "deliveryAddress" as const } } };
    }
    const summary = this.quoteSummary(slots);
    const content = language === "ar" ? `لدي التفاصيل الأساسية. هل ترغب أن أطلب السعر الآن؟\n${this.lines(summary)}` : `I have the core details. Would you like me to request the quote now?\n${this.lines(summary)}`;
    return { content, intent: "customer_quote" as const, status: "action_pending", structured: { state: { ...state, slots, pendingAction: { type: "calculate_customer_quote", summary } } } };
  }

  private traderStep(state: AgentState, language: AgentLanguage) {
    const slots = { primaryCategory: "general_trading", monthlyOrderRange: "under_100", deliveryEmirates: ["dubai"], paymentMix: "not_sure", hasExistingDeliveryCompany: false, channels: [{ type: "none" }], ...state.slots };
    const required: Array<[keyof AgentSlots, string, string]> = [
      ["storeName", "What is the store name?", "ما اسم المتجر؟"],
      ["contactPerson", "Who is the contact person?", "من هو الشخص المسؤول للتواصل؟"],
      ["mobileNumber", "What UAE mobile number should we use?", "ما رقم الهاتف المتحرك في الإمارات؟"],
      ["email", "What email should we use?", "ما البريد الإلكتروني؟"],
      ["pickupEmirate", "Which emirate is the main pickup location in?", "في أي إمارة يكون موقع الاستلام الرئيسي؟"],
      ["pickupBusinessArea", "What pickup area should we list for the Trader application?", "ما منطقة الاستلام للتاجر؟"],
    ];
    const missing = required.find(([key]) => slots[key] === undefined || slots[key] === "");
    if (missing) return { content: language === "ar" ? missing[2] : missing[1], intent: "trader" as const, status: "waiting_for_user", structured: { state: { ...state, slots, lastAskedSlot: missing[0] } } };
    const summary = compact({ store: slots.storeName, contact: slots.contactPerson, mobile: slots.mobileNumber, email: slots.email, pickup: `${slots.pickupBusinessArea}, ${slots.pickupEmirate}`, existingDeliveryCompany: slots.hasExistingDeliveryCompany ? slots.existingDeliveryCompanyName ?? "Provided by Trader" : "Needs Delivery Company", channels: slots.channels?.map((c) => c.type).join(", ") });
    const content = language === "ar" ? `هل أرسل طلب تسجيل التاجر بهذه التفاصيل؟\n${this.lines(summary)}` : `Should I submit the Trader application with these details?\n${this.lines(summary)}`;
    return { content, intent: "trader" as const, status: "action_pending", structured: { state: { ...state, slots, pendingAction: { type: "submit_trader_application", summary } } } };
  }

  private demoStep(state: AgentState, language: AgentLanguage) {
    const slots = { preferredContactMethod: "whatsapp", featuresOfInterest: ["order_management", "driver_management", "cod_collections", "reports"], ...state.slots };
    const required: Array<[keyof AgentSlots, string, string]> = [
      ["companyName", "What is the Delivery Company name?", "ما اسم شركة التوصيل؟"],
      ["contactPerson", "Who should Tawseelhub contact?", "من الشخص المسؤول للتواصل؟"],
      ["mobileNumber", "What UAE mobile number should we use?", "ما رقم الهاتف المتحرك في الإمارات؟"],
      ["email", "What email should we use?", "ما البريد الإلكتروني؟"],
      ["emirate", "Which emirate is the company mainly based in?", "في أي إمارة تقع الشركة غالبا؟"],
    ];
    const missing = required.find(([key]) => slots[key] === undefined || slots[key] === "");
    if (missing) return { content: language === "ar" ? missing[2] : missing[1], intent: "delivery_company_demo" as const, status: "waiting_for_user", structured: { state: { ...state, slots, lastAskedSlot: missing[0] } } };
    const summary = compact({ company: slots.companyName, contact: slots.contactPerson, mobile: slots.mobileNumber, email: slots.email, emirate: slots.emirate, drivers: slots.approximateDriverCount });
    const content = language === "ar" ? `هل أرسل طلب العرض التجريبي بهذه التفاصيل؟\n${this.lines(summary)}` : `Should I submit the demo request with these details?\n${this.lines(summary)}`;
    return { content, intent: "delivery_company_demo" as const, status: "action_pending", structured: { state: { ...state, slots, pendingAction: { type: "submit_demo_request", summary } } } };
  }

  private async executePending(conversationId: string, type: NonNullable<AgentState["pendingAction"]>["type"], state: AgentState) {
    try {
      if (type === "calculate_customer_quote") return await this.createQuote(conversationId, state);
      if (type === "submit_trader_application") return await this.createTraderApplication(conversationId, state);
      if (type === "submit_demo_request") return await this.createDemoRequest(conversationId, state);
      return await this.createHandoff(conversationId, state, "confirmed_by_user");
    } catch (error) {
      await sql`insert into platform_agent_actions(conversation_id,action_type,status,request_snapshot,safe_error_code) values(${conversationId}::uuid,${type},'failed',${JSON.stringify(state.pendingAction?.summary ?? {})}::jsonb,${(error as { message?: string }).message?.slice(0, 80) ?? "action_failed"})`.execute(this.db);
      return { content: "I could not complete that request right now. You can try again or I can pass it to the Tawseelhub team.", intent: "handoff" as const, status: "waiting_for_user", structured: { state: this.completedWorkflowState(state) } };
    }
  }

  private async createQuote(conversationId: string, state: AgentState) {
    const slots = state.slots;
    const existing = (await sql<{ reference_number: string; status: string; offer_count: string }>`
      select q.reference_number,q.status,count(o.id)::text offer_count
      from platform_agent_conversations c
      join platform_customer_quote_requests q on q.id=c.linked_quote_request_id
      left join platform_customer_quote_offers o on o.quote_request_id=q.id
      where c.id=${conversationId}::uuid
      group by q.reference_number,q.status
    `.execute(this.db)).rows[0];
    if (existing) {
      const offerText = Number(existing.offer_count) > 0 ? "The available quote options are already saved with that request." : "This shipment requires a custom quotation.";
      return { content: `Your quote request has already been received. Reference: ${existing.reference_number}\n${offerText}\nDo you have another question, or how can I help you now?`, intent: "customer_quote" as const, status: "completed", structured: { state: this.completedWorkflowState(state) } };
    }
    const requesterMobile = this.formatPublicUaeMobile(String(slots.requesterMobile));
    const recipientMobile = this.formatPublicUaeMobile(String(slots.recipientMobile ?? slots.requesterMobile));
    const payload = {
      requesterName: String(slots.requesterName),
      requesterMobile,
      ...(slots.requesterEmail === undefined ? {} : { requesterEmail: slots.requesterEmail }),
      pickupEmirate: String(slots.pickupEmirate),
      pickupArea: String(slots.pickupArea),
      pickupAddress: String(slots.pickupAddress ?? `${slots.pickupArea}, ${slots.pickupEmirate}`),
      pickupContactName: String(slots.requesterName),
      pickupMobile: requesterMobile,
      deliveryEmirate: String(slots.deliveryEmirate),
      deliveryArea: String(slots.deliveryArea),
      deliveryAddress: String(slots.deliveryAddress ?? `${slots.deliveryArea}, ${slots.deliveryEmirate}`),
      recipientName: String(slots.recipientName ?? slots.requesterName),
      recipientMobile,
      packageType: this.normalizePackageType(String(slots.packageType)),
      description: String(slots.description ?? slots.packageType ?? "Package"),
      weightKg: Number(slots.weightKg),
      quantity: Number(slots.quantity ?? 1),
      requestedServiceType: String(slots.requestedServiceType ?? "standard"),
      pickupDate: String(slots.pickupDate),
      codRequired: Boolean(slots.codRequired),
      codAmount: Number(slots.codAmount ?? 0),
      specialHandlingFlags: [],
      goodsConfirmation: true,
      landingPage: "/agent",
    } as any;
    const result = await this.quotes.create(payload);
    await sql`insert into platform_agent_actions(conversation_id,action_type,status,request_snapshot,response_snapshot) values(${conversationId}::uuid,'calculate_customer_quote','completed',${JSON.stringify(this.redactSlots(slots))}::jsonb,${JSON.stringify({ quoteReference: result.quoteReference, quoteType: result.quoteType, status: result.status, offerCount: result.offers.length })}::jsonb)`.execute(this.db);
    const quote = (await sql<{ id: string }>`select id from platform_customer_quote_requests where reference_number=${result.quoteReference}`.execute(this.db)).rows[0];
    if (quote) await sql`update platform_agent_conversations set linked_quote_request_id=${quote.id}::uuid where id=${conversationId}::uuid`.execute(this.db);
    const offerText = result.offers.length ? result.offers.map((offer) => `${offer.serviceType}: AED ${offer.customerPrice}`).join("\n") : "This shipment requires a custom quotation.";
    return { content: `Your quote request has been received. Reference: ${result.quoteReference}\n${offerText}${result.expiresAt ? `\nValid until: ${this.formatDubaiDateTime(result.expiresAt)}` : ""}\nDo you have another question, or how can I help you now?`, intent: "customer_quote" as const, status: "completed", structured: { state: this.completedWorkflowState(state) } };
  }

  private async createTraderApplication(conversationId: string, state: AgentState) {
    const s = state.slots;
    const traderPayload = {
      storeName: String(s.storeName),
      contactPerson: String(s.contactPerson),
      mobileNumber: String(s.mobileNumber),
      email: String(s.email),
      primaryCategory: String(s.primaryCategory ?? "general_trading"),
      additionalCategories: [],
      pickupEmirate: String(s.pickupEmirate),
      pickupArea: String(s.pickupBusinessArea ?? s.pickupArea ?? "To be confirmed"),
      channels: s.channels?.length ? s.channels as any : [{ type: "none" }],
      monthlyOrderRange: String(s.monthlyOrderRange ?? "under_100"),
      deliveryEmirates: s.deliveryEmirates?.length ? s.deliveryEmirates : [String(s.pickupEmirate)],
      paymentMix: String(s.paymentMix ?? "not_sure"),
      fragileProducts: false,
      temperatureControlled: false,
      hasExistingDeliveryCompany: Boolean(s.hasExistingDeliveryCompany),
      existingDeliveryCompanyName: s.hasExistingDeliveryCompany ? s.existingDeliveryCompanyName ?? "Provided by Trader" : undefined,
      consent: true,
      landingPage: "/agent",
    } as any;
    const result = await this.traders.create(traderPayload, { ip: null, userAgent: null });
    await sql`insert into platform_agent_actions(conversation_id,action_type,status,request_snapshot,response_snapshot) values(${conversationId}::uuid,'submit_trader_application','completed',${JSON.stringify(this.redactSlots(s))}::jsonb,${JSON.stringify({ referenceNumber: result.referenceNumber, status: result.status })}::jsonb)`.execute(this.db);
    await sql`update platform_agent_conversations set linked_trader_application_id=${result.id}::uuid where id=${conversationId}::uuid`.execute(this.db);
    return { content: `Your Trader application has been received. Reference: ${result.referenceNumber}. Status: Pending Verification.\nDo you have another question, or how can I help you now?`, intent: "trader" as const, status: "completed", structured: { state: this.completedWorkflowState(state) } };
  }

  private async createDemoRequest(conversationId: string, state: AgentState) {
    const s = state.slots;
    const demoPayload = {
      companyName: String(s.companyName),
      contactPerson: String(s.contactPerson),
      mobileNumber: String(s.mobileNumber),
      email: String(s.email),
      country: "United Arab Emirates",
      emirate: String(s.emirate) as any,
      ...(s.approximateDriverCount === undefined ? {} : { approximateDriverCount: s.approximateDriverCount }),
      ...(s.approximateMonthlyOrders === undefined ? {} : { approximateMonthlyOrders: s.approximateMonthlyOrders }),
      ...(s.approximateTraderCount === undefined ? {} : { approximateTraderCount: s.approximateTraderCount }),
      ...(s.currentSystem === undefined ? {} : { currentSystem: s.currentSystem }),
      preferredContactMethod: String(s.preferredContactMethod ?? "whatsapp") as any,
      ...(s.mainChallenges === undefined ? {} : { mainChallenges: s.mainChallenges }),
      featuresOfInterest: s.featuresOfInterest?.length ? s.featuresOfInterest as any : ["order_management", "driver_management", "cod_collections"],
      consent: true,
      landingPage: "/agent",
    } as any;
    const result = await this.demos.create(demoPayload, { ip: null, userAgent: null });
    await sql`insert into platform_agent_actions(conversation_id,action_type,status,request_snapshot,response_snapshot) values(${conversationId}::uuid,'submit_demo_request','completed',${JSON.stringify(this.redactSlots(s))}::jsonb,${JSON.stringify({ referenceNumber: result.referenceNumber })}::jsonb)`.execute(this.db);
    await sql`update platform_agent_conversations set linked_demo_request_id=${result.id}::uuid where id=${conversationId}::uuid`.execute(this.db);
    return { content: `Your demo request has been received. Reference: ${result.referenceNumber}.\nDo you have another question, or how can I help you now?`, intent: "delivery_company_demo" as const, status: "completed", structured: { state: this.completedWorkflowState(state) } };
  }

  private async prepareHandoff(conversationId: string, state: AgentState, language: AgentLanguage, reason: string, channel?: AgentChannel, humanHandoffEnabled = true) {
    if (channel === "website") {
      if (!humanHandoffEnabled) return this.offlineHumanFollowUpStep(conversationId, state, language, reason);
      return { content: this.humanWaitingMessage(language), intent: "handoff" as const, status: "waiting_for_user", structured: { state: this.completedWorkflowState(state), websiteHumanRequested: true } };
    }
    const summary = compact({ reason, name: state.slots.contactName ?? state.slots.requesterName ?? state.slots.contactPerson, mobile: state.slots.mobile ?? state.slots.mobileNumber ?? state.slots.requesterMobile, email: state.slots.email ?? state.slots.requesterEmail });
    const visibleSummary = compact({ name: summary.name, mobile: summary.mobile, email: summary.email });
    const visibleLines = this.lines(visibleSummary);
    const content = language === "ar"
      ? `أستطيع تحويل ذلك إلى فريق Tawseelhub. ${visibleLines ? `هل تؤكد بيانات التواصل؟\n${visibleLines}` : "يرجى مشاركة الاسم ورقم الهاتف للتواصل."}`
      : `I can pass this to the Tawseelhub team. ${visibleLines ? `Please confirm the best contact details.\n${visibleLines}` : "Please share your name and mobile number for follow-up."}`;
    return { content, intent: "handoff" as const, status: "action_pending", structured: { state: { ...state, pendingAction: { type: "create_handoff", summary } } } };
  }

  private completedWorkflowState(state: AgentState): AgentState {
    const { pendingAction: _pendingAction, lastAskedSlot: _lastAskedSlot, ...rest } = state;
    return rest;
  }

  private async offlineHumanFollowUpStep(conversationId: string, state: AgentState, language: AgentLanguage, reason: string) {
    const slots = state.slots;
    const name = slots.contactName ?? slots.requesterName ?? slots.contactPerson;
    const mobile = slots.mobile ?? slots.mobileNumber ?? slots.requesterMobile;
    if (!name) return {
      content: this.humanUnavailableAskForContactMessage(language, state),
      intent: "handoff" as const,
      status: "waiting_for_user",
      structured: { state: { ...state, lastBusinessIntent: "handoff" as const, lastAskedSlot: "contactName" as const } },
    };
    if (!mobile) return {
      content: language === "ar" ? "لا يوجد موظف متاح الآن. ما رقم الهاتف المتحرك الذي يمكن لفريق العمليات التواصل معك عليه؟" : "No human agent is available right now. What mobile number should our operations team use to contact you?",
      intent: "handoff" as const,
      status: "waiting_for_user",
      structured: { state: { ...state, slots: { ...slots, contactName: name, requesterName: slots.requesterName ?? name }, lastBusinessIntent: "handoff" as const, lastAskedSlot: "mobile" as const } },
    };
    return this.createHandoff(conversationId, { ...state, slots: { ...slots, contactName: name, mobile, mobileNumber: slots.mobileNumber ?? mobile, requesterMobile: slots.requesterMobile ?? mobile } }, reason, {
      content: language === "ar"
        ? "شكراً لك. تم حفظ معلوماتك، وسيتواصل معك فريق العمليات قريباً. هل لديك سؤال آخر، أو كيف يمكنني مساعدتك الآن؟"
        : "Thank you. I saved your information, and our operations team will get back to you soon. Do you have another question, or how can I help you now?",
      reviewStatus: "follow_up",
    });
  }

  private async createHandoff(conversationId: string, state: AgentState, reason: string, options?: { content?: string; reviewStatus?: "open" | "follow_up" }) {
    const existing = (await sql<{ reference_number: string }>`
      select reference_number
      from platform_agent_handoffs
      where conversation_id=${conversationId}::uuid
        and status not in('resolved','closed')
      order by created_at desc
      limit 1
    `.execute(this.db)).rows[0];
    if (existing) {
      return {
        content: options?.content ?? `I already passed this to the Tawseelhub team. Reference: ${existing.reference_number}.\nDo you have another question, or how can I help you now?`,
        intent: "handoff" as const,
        status: "handed_off",
        structured: { state: this.completedWorkflowState(state), ...(options?.reviewStatus ? { reviewStatus: options.reviewStatus } : {}) },
      };
    }
    const ref = await reference(this.db, "platform_agent_handoff_reference_seq", "HAND");
    const s = state.slots;
    const inserted = await sql<{ id: string }>`insert into platform_agent_handoffs(reference_number,conversation_id,reason,contact_name,mobile,email,status) values(${ref},${conversationId}::uuid,${reason},${s.contactName ?? s.requesterName ?? s.contactPerson ?? null},${s.mobile ?? s.mobileNumber ?? s.requesterMobile ?? null},${s.email ?? s.requesterEmail ?? null},'new') returning id`.execute(this.db);
    await sql`insert into platform_agent_handoff_history(handoff_id,old_status,new_status,notes) values(${inserted.rows[0]!.id}::uuid,null,'new','Created by Tawseelhub Agent'); insert into platform_agent_actions(conversation_id,action_type,status,request_snapshot,response_snapshot) values(${conversationId}::uuid,'create_handoff','completed',${JSON.stringify(this.redactSlots(s))}::jsonb,${JSON.stringify({ referenceNumber: ref })}::jsonb)`.execute(this.db);
    return {
      content: options?.content ?? `I have passed this to the Tawseelhub team. Reference: ${ref}.\nDo you have another question, or how can I help you now?`,
      intent: "handoff" as const,
      status: "handed_off",
      structured: { state: this.completedWorkflowState(state), ...(options?.reviewStatus ? { reviewStatus: options.reviewStatus } : {}) },
    };
  }

  private async previousRequestQuestionResponse(conversationId: string, text: string, language: AgentLanguage, state: AgentState) {
    if (!previousRequestPattern.test(text) && !referencePattern.test(text)) return undefined;
    const identity = this.identityFromState(state);
    const referenceMatch = text.match(referencePattern)?.[1]?.toUpperCase();
    const normalizedMobile = identity.mobileNormalized ?? this.normalizeUaeMobile(String(state.slots.mobile ?? state.slots.mobileNumber ?? state.slots.requesterMobile ?? ""));
    if (!normalizedMobile && !referenceMatch) {
      const content = language === "ar"
        ? "حتى أتحقق بأمان، أرسل رقم الهاتف المتحرك المستخدم في الطلب أو رقم المرجع مثل QTE-000016."
        : "To check that safely, please send the mobile number used on the request or the reference number, for example QTE-000016.";
      return { content, intent: "general_question" as const, status: "waiting_for_user", structured: { state } };
    }
    const latest = await this.latestPermittedCustomerObject(conversationId, normalizedMobile, referenceMatch);
    if (!latest) {
      const content = language === "ar"
        ? "لم أتمكن من فتح تفاصيل هذا الطلب من المعلومات الحالية. أرسل رقم الهاتف المسجل على الطلب أو تواصل مع فريق Tawseelhub للتحقق."
        : "I can’t access details for that request from the current information. Please verify with the mobile number registered on the request, or the Tawseelhub team can check it for you.";
      return { content, intent: "general_question" as const, status: "waiting_for_user", structured: { state } };
    }
    const status = this.customerStatusLabel(String(latest.status), language);
    const content = language === "ar"
      ? `آخر طلب مرتبط بهذا الرقم هو ${latest.reference_number} وهو ${status}. هل ترغب بالمتابعة عليه، أو أساعدك بشيء جديد؟`
      : `Your most recent request is ${latest.reference_number} and it is ${status}. Would you like to continue with that request, or can I help with something new?`;
    return { content, intent: "general_question" as const, status: "waiting_for_user", structured: { state: { ...state, historicalContext: { latestReference: latest.reference_number, latestStatus: latest.status } } } };
  }

  private async workflowInterruptionResponse(conversationId: string, text: string, language: AgentLanguage, previous: AgentState, current: AgentState) {
    if (previous.returningRequestDecision === "pending" && previous.existingRequest) {
      if (this.isNewShipmentDecision(text)) {
        const nextSlots: AgentSlots = {};
        const requesterName = current.slots.requesterName ?? previous.slots.requesterName;
        const requesterMobile = current.slots.requesterMobile ?? previous.slots.requesterMobile;
        if (requesterName) nextSlots.requesterName = requesterName;
        if (requesterMobile) nextSlots.requesterMobile = requesterMobile;
        const { existingRequest: _existingRequest, historicalContext: _historicalContext, lastAskedSlot: _lastAskedSlot, pendingAction: _pendingAction, returningRequestDecision: _returningRequestDecision, ...baseState } = current;
        const nextState: AgentState = {
          ...baseState,
          slots: nextSlots,
        };
        return this.quoteStep(nextState, language);
      }
      if (this.isContinueExistingDecision(text) || this.isPriceQuestion(text)) {
        const quote = await this.quoteStatusForReference(conversationId, previous.existingRequest.reference, this.identityFromState(previous).mobileNormalized);
        const content = this.existingQuoteDecisionMessage(quote ?? previous.existingRequest, language, { answerPrice: this.isPriceQuestion(text), continueOnly: this.isContinueExistingDecision(text) && !this.isPriceQuestion(text) });
        const { lastAskedSlot: _lastAskedSlot, ...baseState } = { ...previous, ...current };
        return { content, intent: "customer_quote" as const, status: "waiting_for_user", structured: { suppressReturningAcknowledgement: true, state: { ...baseState, returningRequestDecision: "pending" as const, existingRequest: previous.existingRequest } } };
      }
      const content = language === "ar"
        ? `لديك طلب سعر نشط ${previous.existingRequest.reference}. هل ترغب بالمتابعة عليه أم بدء شحنة جديدة؟`
        : `You already have an active quote ${previous.existingRequest.reference}. Would you like to continue with that quote or start a new shipment?`;
      const { lastAskedSlot: _lastAskedSlot, ...baseState } = { ...previous, ...current };
      return { content, intent: "customer_quote" as const, status: "waiting_for_user", structured: { suppressReturningAcknowledgement: true, state: { ...baseState, returningRequestDecision: "pending" as const, existingRequest: previous.existingRequest } } };
    }

    if (this.isPriceQuestion(text)) {
      const active = await this.activeQuoteForState(conversationId, current);
      if (active) {
        const content = this.existingQuoteDecisionMessage(active, language, { answerPrice: true });
        const { lastAskedSlot: _lastAskedSlot, ...baseState } = current;
        return { content, intent: "customer_quote" as const, status: "waiting_for_user", structured: { suppressReturningAcknowledgement: true, state: { ...baseState, returningRequestDecision: "pending" as const, existingRequest: { reference: String(active.reference_number), status: String(active.status) } } } };
      }
      if (current.lastBusinessIntent === "customer_quote" || previous.lastBusinessIntent === "customer_quote" || previous.lastAskedSlot) {
        const content = await this.currentWorkflowPriceAnswer(current, language);
        return { content, intent: "customer_quote" as const, status: "waiting_for_user", structured: { suppressReturningAcknowledgement: true, state: current } };
      }
    }

    if (this.isThenQuestion(text) && current.pendingAction?.type === "calculate_customer_quote") {
      const content = language === "ar"
        ? "الخطوة التالية هي إرسال تفاصيل الشحنة حتى أتحقق من السعر المتاح. هل ترغب أن أطلب السعر الآن؟"
        : "The next step is to submit these shipment details so I can check the available price. Would you like me to request the quote now?";
      return { content, intent: "customer_quote" as const, status: "action_pending", structured: { suppressReturningAcknowledgement: true, state: current } };
    }

    const before = this.identityFromState(previous).mobileNormalized;
    const after = this.identityFromState(current).mobileNormalized;
    if (after && before !== after && current.lastBusinessIntent === "customer_quote") {
      const active = await this.activeQuoteForState(conversationId, current);
      if (active) {
        const { lastAskedSlot: _lastAskedSlot, ...baseState } = current;
        const state: AgentState = {
          ...baseState,
          existingRequest: { reference: String(active.reference_number), status: String(active.status) },
          returningRequestDecision: "pending",
        };
        const content = language === "ar"
          ? `أهلاً بعودتك. لديك طلب سعر نشط ${active.reference_number}. هل ترغب بالمتابعة عليه أم بدء شحنة جديدة؟`
          : `Welcome back. You already have an active quote ${active.reference_number} waiting for your next step. Would you like to continue with that quote or start a new shipment?`;
        return { content, intent: "customer_quote" as const, status: "waiting_for_user", structured: { suppressReturningAcknowledgement: true, state } };
      }
    }

    return undefined;
  }

  private async returningCustomerAcknowledgement(conversationId: string, language: AgentLanguage, previous: AgentState, current: AgentState, response: string) {
    if (previous.historicalContext || current.historicalContext) return response;
    const before = this.identityFromState(previous).mobileNormalized;
    const after = this.identityFromState(current).mobileNormalized;
    if (!after || before === after) return response;
    const latest = await this.latestPermittedCustomerObject(conversationId, after);
    if (!latest) return response;
    const terminal = this.isTerminalCustomerStatus(String(latest.status));
    const acknowledgement = language === "ar"
      ? terminal
        ? `أهلاً بعودتك. أرى أن طلبك السابق ${latest.reference_number} ${this.customerStatusLabel(String(latest.status), language)}.`
        : `أهلاً بعودتك. لديك طلب سابق ${latest.reference_number} ${this.customerStatusLabel(String(latest.status), language)}.`
      : terminal
        ? `Welcome back. I can see your previous request ${latest.reference_number} is ${this.customerStatusLabel(String(latest.status), language)}.`
        : `Welcome back. You have an active request ${latest.reference_number} that is ${this.customerStatusLabel(String(latest.status), language)}.`;
    return `${acknowledgement}\n${response}`;
  }

  private async activeQuoteForState(conversationId: string, state: AgentState) {
    const identity = this.identityFromState(state);
    const latest = await this.latestPermittedCustomerObject(conversationId, identity.mobileNormalized);
    if (!latest || this.isTerminalCustomerStatus(String(latest.status))) return undefined;
    return latest;
  }

  private async quoteStatusForReference(conversationId: string, referenceNumber: string, normalizedMobile?: string | null) {
    return this.latestPermittedCustomerObject(conversationId, normalizedMobile, referenceNumber);
  }

  private existingQuoteDecisionMessage(quote: Record<string, unknown>, language: AgentLanguage, options: { answerPrice?: boolean; continueOnly?: boolean } = {}) {
    const referenceNumber = String(quote.reference_number ?? quote.reference ?? "");
    const status = String(quote.status ?? "");
    const currency = String(quote.quote_currency ?? "AED");
    const minimumOffer = quote.minimum_offer === undefined || quote.minimum_offer === null ? null : Number(quote.minimum_offer);
    const offerCount = Number(quote.offer_count ?? 0);
    const statusText = this.customerStatusLabel(status, language);
    if (options.continueOnly && !options.answerPrice) {
      if (minimumOffer !== null) {
        return language === "ar"
          ? `طلبك ${referenceNumber} ${statusText}. السعر المتاح يبدأ من ${currency} ${minimumOffer.toFixed(2)}. هل ترغب بالمتابعة عليه أم بدء شحنة جديدة؟`
          : `Your quote ${referenceNumber} is ${statusText}. The available price starts from ${currency} ${minimumOffer.toFixed(2)}. Would you like to continue with it or start a new shipment?`;
      }
      return language === "ar"
        ? `طلبك ${referenceNumber} ${statusText}. لا يوجد سعر مؤكد بعد. هل ترغب بالمتابعة عليه أم بدء شحنة جديدة؟`
        : `Your quote ${referenceNumber} is ${statusText}. There is no confirmed price yet. Would you like to continue with it or start a new shipment?`;
    }
    if (minimumOffer !== null && offerCount > 0) {
      return language === "ar"
        ? `عرض السعر الحالي ${referenceNumber} هو ${currency} ${minimumOffer.toFixed(2)}. هل ترغب بالمتابعة عليه أم بدء شحنة جديدة؟`
        : `Your current quote ${referenceNumber} is ${currency} ${minimumOffer.toFixed(2)}. Would you like to continue with it or start a new shipment?`;
    }
    const manual = status === "custom_quote_required" || status === "submitted";
    return language === "ar"
      ? `${referenceNumber} ${manual ? "لا يزال بانتظار سعر يدوي، لذلك لا يوجد مبلغ مؤكد بعد." : `حالته ${statusText} ولا يوجد مبلغ مؤكد ظاهر الآن.`} هل ترغب بالمتابعة عليه أم بدء شحنة جديدة؟`
      : `${referenceNumber} ${manual ? "is still waiting for a manual price, so there is no confirmed amount yet." : `is ${statusText}, and I do not see a confirmed amount yet.`} Would you like to continue with it or start a new shipment?`;
  }

  private async currentWorkflowPriceAnswer(state: AgentState, language: AgentLanguage): Promise<string> {
    const missing = this.missingPriceFields(state.slots);
    const resume = state.lastAskedSlot ? this.askForSlot(state.lastAskedSlot, language) : "";
    if (missing.length) {
      const missingText = language === "ar" ? this.arabicMissingPriceFields(missing) : missing.map((field) => field.replace(/([A-Z])/g, " $1").toLowerCase()).join(", ");
      const base = language === "ar"
        ? `أستطيع حساب السعر بعد معرفة تفاصيل الاستلام والتوصيل والشحنة. المعلومات الناقصة حالياً: ${missingText}.`
        : `I can calculate the price once I have the pickup, delivery and package details. We are currently missing: ${missingText}.`;
      return resume ? `${base}\n${resume}` : base;
    }
    const estimate = await this.estimateCurrentQuotePrice(state.slots);
    if (estimate.minimumOffer !== null) {
      const base = language === "ar"
        ? `لهذه التفاصيل، السعر الحالي يبدأ من ${estimate.currency} ${estimate.minimumOffer.toFixed(2)}.`
        : `For these details, the current delivery price starts from ${estimate.currency} ${estimate.minimumOffer.toFixed(2)}.`;
      return state.pendingAction?.type === "calculate_customer_quote"
        ? `${base}\n${language === "ar" ? "هل ترغب أن أطلب السعر الآن؟" : "Would you like me to request the quote now?"}`
        : resume ? `${base}\n${resume}` : base;
    }
    const base = language === "ar"
      ? "هذا المسار يحتاج سعراً يدوياً، لذلك لا يوجد سعر مؤكد حتى الآن. أستطيع إرسال الطلب والحصول على رقم QTE."
      : "This route requires a manual quotation, so I do not have a confirmed price yet. I can submit it now and give you a QTE reference.";
    return state.pendingAction?.type === "calculate_customer_quote" ? `${base}\n${language === "ar" ? "هل ترغب أن أطلب السعر الآن؟" : "Would you like me to request the quote now?"}` : resume ? `${base}\n${resume}` : base;
  }

  private missingPriceFields(slots: AgentSlots): Array<keyof AgentSlots> {
    return (["pickupEmirate", "pickupArea", "deliveryEmirate", "deliveryArea", "packageType", "weightKg"] as Array<keyof AgentSlots>)
      .filter((field) => slots[field] === undefined || slots[field] === "");
  }

  private arabicMissingPriceFields(fields: Array<keyof AgentSlots>): string {
    const labels: Partial<Record<keyof AgentSlots, string>> = {
      deliveryArea: "منطقة التوصيل",
      deliveryEmirate: "إمارة التوصيل",
      packageType: "نوع الشحنة",
      pickupArea: "منطقة الاستلام",
      pickupEmirate: "إمارة الاستلام",
      weightKg: "الوزن",
    };
    return fields.map((field) => labels[field] ?? String(field)).join("، ");
  }

  private async estimateCurrentQuotePrice(slots: AgentSlots): Promise<{ currency: string; minimumOffer: number | null }> {
    const settings = (await sql<{ enabled: boolean; commission_rate: string }>`select enabled,commission_rate::text from platform_customer_marketplace_settings where id=true`.execute(this.db)).rows[0];
    if (!settings?.enabled) return { currency: "AED", minimumOffer: null };
    const rules = (await sql<QuoteRule>`select r.id,r.pricing_profile_id as "profileId",p.company_id as "companyId",cp.marketplace_priority as priority,p.service_type as "serviceType",r.pickup_emirate as "pickupEmirate",r.pickup_area as "pickupArea",r.delivery_emirate as "deliveryEmirate",r.delivery_area as "deliveryArea",r.base_price::text as "basePrice",r.included_weight_kg::text as "includedWeightKg",r.extra_weight_price::text as "extraWeightPrice",r.cod_surcharge::text as "codSurcharge",r.minimum_charge::text as "minimumCharge",r.maximum_standard_weight::text as "maximumStandardWeight",p.max_cod_amount::text as "maxCodAmount",p.max_weight_kg::text as "maxWeightKg",p.max_length_cm::text as "maxLengthCm",p.max_width_cm::text as "maxWidthCm",p.max_height_cm::text as "maxHeightCm",p.supported_package_types as "supportedPackageTypes"
      from company_customer_quote_pricing_rules r join company_customer_quote_pricing_profiles p on p.id=r.pricing_profile_id join company_customer_quote_participation cp on cp.company_id=p.company_id
      where cp.participates=true and cp.accepts_instant=true and p.status='active' and r.active=true and p.service_type=${String(slots.requestedServiceType ?? "standard")}`.execute(this.db)).rows;
    const result = runQuoteEngine({
      codAmount: Number(slots.codAmount ?? 0),
      codRequired: Boolean(slots.codRequired),
      deliveryArea: String(slots.deliveryArea),
      deliveryEmirate: String(slots.deliveryEmirate),
      packageType: this.normalizePackageType(String(slots.packageType)),
      pickupArea: String(slots.pickupArea),
      pickupEmirate: String(slots.pickupEmirate),
      quantity: Number(slots.quantity ?? 1),
      serviceType: String(slots.requestedServiceType ?? "standard"),
      specialHandlingFlags: [],
      weightKg: Number(slots.weightKg),
    }, rules, settings.commission_rate);
    const minimum = result.offers[0]?.gross;
    return { currency: "AED", minimumOffer: minimum === undefined ? null : Number(minimum) };
  }

  private isPriceQuestion(text: string): boolean {
    return isAgentPriceQuestionText(text);
  }

  private isContinueExistingDecision(text: string): boolean {
    return continueExistingPattern.test(text.trim());
  }

  private isNewShipmentDecision(text: string): boolean {
    return newShipmentPattern.test(text.trim());
  }

  private isThenQuestion(text: string): boolean {
    return /^(then|what next|next|now what|وبعدين|بعدين|ثم)\??$/i.test(text.trim());
  }

  private isSkipAnswer(text: string): boolean {
    return skipPattern.test(text.trim());
  }

  private async latestPermittedCustomerObject(conversationId: string, normalizedMobile?: string | null, requestedReference?: string) {
    const normalized = normalizedMobile?.replace(/\D/g, "") || null;
    if (requestedReference?.startsWith("AGT-")) {
      const row = (await sql<Record<string, unknown>>`
        select reference_number,'agent_conversation' object_type,coalesce(review_status,status) status,created_at
        from platform_agent_conversations
        where reference_number=${requestedReference}
          and (${normalized}::text is not null and mobile_number_normalized=${normalized})
        limit 1
      `.execute(this.db)).rows[0];
      return row;
    }
    const rows = await sql<Record<string, unknown>>`
      select q.reference_number,'customer_quote' object_type,q.status,q.quote_currency,q.created_at,
        count(o.id)::int offer_count,
        min(o.gross_customer_price)::text minimum_offer
      from platform_customer_quote_requests q
      left join platform_agent_conversations c on c.linked_quote_request_id=q.id
      left join platform_customer_quote_offers o on o.quote_request_id=q.id and o.status in('available','selected')
      where (${requestedReference ?? null}::text is null or q.reference_number=${requestedReference})
        and (
          (${normalized}::text is not null and regexp_replace(q.requester_mobile,'\\D','','g') in (${normalized}, ${normalized?.startsWith("971") ? `0${normalized.slice(3)}` : normalized ?? ""}))
          or c.id=${conversationId}::uuid
        )
      group by q.reference_number,q.status,q.quote_currency,q.created_at
      order by q.created_at desc
      limit 1
    `.execute(this.db);
    return rows.rows[0];
  }

  private isTerminalCustomerStatus(status: string): boolean {
    return ["booked", "closed", "cancelled", "expired", "completed", "delivered", "resolved"].includes(status);
  }

  private customerStatusLabel(status: string, language: AgentLanguage): string {
    const english: Record<string, string> = {
      submitted: "submitted and waiting for review",
      quoted: "priced with available quote options",
      custom_quote_required: "waiting for a custom quotation",
      customer_selected: "selected by the customer",
      booking_pending: "waiting for booking confirmation",
      booked: "booked/completed",
      expired: "expired",
      cancelled: "cancelled",
      closed: "completed",
      resolved: "completed",
    };
    const arabic: Record<string, string> = {
      submitted: "مُرسل وينتظر المراجعة",
      quoted: "تم تسعيره وتوجد خيارات سعر متاحة",
      custom_quote_required: "بانتظار سعر مخصص",
      customer_selected: "تم اختياره من العميل",
      booking_pending: "بانتظار تأكيد الحجز",
      booked: "مكتمل/محجوز",
      expired: "منتهي",
      cancelled: "ملغي",
      closed: "مكتمل",
      resolved: "مكتمل",
    };
    return (language === "ar" ? arabic : english)[status] ?? (language === "ar" ? "قيد المتابعة" : "currently being followed up");
  }

  private async answerGeneralQuestion(conversationId: string, state: AgentState, language: AgentLanguage, currentTurnIntent: AgentIntent) {
    const latest = await this.latestUserMessage(conversationId);
    const knowledge = await this.retrieveKnowledge(latest, language, state);
    const fallback = () => this.safeBusinessFallback(latest, language, state, knowledge);
    const generated = currentTurnIntent === "product_feature_question" || currentTurnIntent === "current_feature_status" || privateDirectoryOrCustomerInfo.test(latest) || isAgentAnyPricingTopicText(latest)
      ? fallback()
      : await this.model.generateReply({
        audience: state.audience ?? "unknown",
        conversationSummary: this.conversationSummary(state),
        intent: currentTurnIntent,
        knowledge,
        language,
        previousIntent: state.lastBusinessIntent ?? "unknown",
        text: latest,
      }, fallback);
    const content = this.enforceSingleQuestion(this.guardPublicReply(generated, language, fallback));
    const shouldRememberFollowUp = /[?؟]/.test(content) && (currentTurnIntent === "general_question" || currentTurnIntent === "product_feature_question" || currentTurnIntent === "current_feature_status");
    const { pendingGeneralFollowUp: _pendingGeneralFollowUp, ...baseState } = state;
    return { content, intent: currentTurnIntent, status: "waiting_for_user", structured: { state: shouldRememberFollowUp ? { ...baseState, pendingGeneralFollowUp: "public_explanation" } : baseState } };
  }

  public async adminConversations(query: Record<string, string | undefined> = {}) {
    const pageSize = Math.min(Math.max(Number(query.pageSize ?? 25) || 25, 1), 100);
    const page = Math.max(Number(query.page ?? 1) || 1, 1);
    const offset = (page - 1) * pageSize;
    const dateRange = this.inboxDateRange(query.datePreset, query.from, query.to);
    const filters = [sql`true`];
    if (dateRange.from) filters.push(sql`c.last_message_at >= ${dateRange.from}`);
    if (dateRange.to) filters.push(sql`c.last_message_at < ${dateRange.to}`);
    if (query.visibility === "hidden") filters.push(sql`c.hidden_at is not null and c.deleted_at is null`);
    else if (query.visibility === "deleted") filters.push(sql`c.deleted_at is not null`);
    else if (query.visibility !== "all") filters.push(sql`c.hidden_at is null and c.deleted_at is null`);
    if (query.status && query.status !== "all") filters.push(sql`c.review_status = any(${query.status.split(",")})`);
    if (query.channel && query.channel !== "all") filters.push(sql`c.channel=${query.channel}`);
    if (query.conversationMode && query.conversationMode !== "all") filters.push(sql`c.conversation_mode=${query.conversationMode}`);
    if (query.audience && query.audience !== "all") filters.push(sql`c.audience=${query.audience}`);
    if (query.classification && query.classification !== "all") filters.push(sql`c.operational_classification=${query.classification}`);
    if (query.assignedToAccountId === "unassigned") filters.push(sql`c.assigned_to_account_id is null`);
    else if (query.assignedToAccountId && query.assignedToAccountId !== "all") filters.push(sql`c.assigned_to_account_id=${query.assignedToAccountId}::uuid`);
    if (query.needsReply === "true") {
      filters.push(sql`c.conversation_mode='human_active'`);
      filters.push(sql`exists(
        select 1
        from platform_agent_messages customer_message
        where customer_message.conversation_id=c.id
          and customer_message.sender_type='user'
          and customer_message.created_at > coalesce(
            (select max(staff_message.created_at) from platform_agent_messages staff_message where staff_message.conversation_id=c.id and staff_message.sender_type='platform_staff' and staff_message.direction='outbound'),
            'epoch'::timestamptz
          )
      )`);
    }
    if (query.unread === "unread") filters.push(sql`exists(select 1 from platform_agent_messages um where um.conversation_id=c.id and um.sender_type='user' and um.created_at > coalesce(c.platform_last_read_at,'epoch'::timestamptz))`);
    if (query.unread === "read") filters.push(sql`not exists(select 1 from platform_agent_messages um where um.conversation_id=c.id and um.sender_type='user' and um.created_at > coalesce(c.platform_last_read_at,'epoch'::timestamptz))`);
    if (query.search?.trim()) {
      const search = `%${query.search.trim().toLowerCase()}%`;
      filters.push(sql`(lower(c.reference_number) like ${search} or lower(coalesce(c.customer_name,'')) like ${search} or coalesce(c.mobile_number_normalized,'') like ${search} or coalesce(c.mobile_number,'') like ${search} or lower(coalesce(q.reference_number,'')) like ${search} or lower(coalesce(t.reference_number,'')) like ${search} or lower(coalesce(d.reference_number,'')) like ${search})`);
    }
    const where = sql.join(filters, sql` and `);
    const rows = await sql<Record<string, unknown>>`
      with base as (
        select c.*,q.reference_number quote_reference,t.reference_number trader_reference,d.reference_number demo_reference,h.status handoff_status,
          (c.last_message_at at time zone 'Asia/Dubai')::date business_date,
          case
            when c.customer_id is not null then 'customer:' || c.customer_id::text
            when c.mobile_number_normalized is not null and c.mobile_number_normalized <> '' then 'mobile:' || c.mobile_number_normalized
            when c.visitor_ip_hash is not null and c.visitor_ip_hash <> '' then 'ip:' || c.visitor_ip_hash
            when c.visitor_id is not null then 'visitor:' || c.visitor_id::text
            else 'conversation:' || c.id::text
          end identity_key,
          case
            when c.customer_id is not null then 'customer'
            when c.mobile_number_normalized is not null and c.mobile_number_normalized <> '' then 'mobile'
            when c.visitor_ip_hash is not null and c.visitor_ip_hash <> '' then 'ip'
            when c.visitor_id is not null then 'visitor'
            else 'conversation'
          end identity_match_type,
          message_counts.message_count,
          unread_counts.unread_count,
          left(last_user.content,180) last_user_message,
          left(last_assistant.content,180) last_assistant_message,
          left(last_message.content,220) latest_message_preview,
          coalesce(waiting.waiting_customer_message_count,0)::int waiting_customer_message_count,
          case
            when c.conversation_mode='paused' then coalesce(waiting.waiting_since,c.mode_changed_at)
            when c.conversation_mode='human_active' and coalesce(waiting.waiting_customer_message_count,0) > 0 then waiting.waiting_since
            else null
          end waiting_since
        from platform_agent_conversations c
        left join platform_customer_quote_requests q on q.id=c.linked_quote_request_id
        left join platform_trader_applications t on t.id=c.linked_trader_application_id
        left join platform_demo_requests d on d.id=c.linked_demo_request_id
        left join platform_agent_handoffs h on h.conversation_id=c.id
        left join lateral (select count(*)::int message_count from platform_agent_messages where conversation_id=c.id) message_counts on true
        left join lateral (select count(*)::int unread_count from platform_agent_messages where conversation_id=c.id and sender_type='user' and created_at > coalesce(c.platform_last_read_at,'epoch'::timestamptz)) unread_counts on true
        left join lateral (select content from platform_agent_messages where conversation_id=c.id and sender_type='user' order by created_at desc limit 1) last_user on true
        left join lateral (select content from platform_agent_messages where conversation_id=c.id and sender_type='assistant' order by created_at desc limit 1) last_assistant on true
        left join lateral (select content from platform_agent_messages where conversation_id=c.id and direction in('inbound','outbound') order by created_at desc,id desc limit 1) last_message on true
        left join lateral (select max(created_at) last_platform_reply_at from platform_agent_messages where conversation_id=c.id and sender_type='platform_staff' and direction='outbound') last_staff_reply on true
        left join lateral (
          select count(*)::int waiting_customer_message_count,min(created_at) waiting_since
          from platform_agent_messages waiting_message
          where waiting_message.conversation_id=c.id
            and waiting_message.sender_type='user'
            and (
              (c.conversation_mode='human_active' and waiting_message.created_at > coalesce(last_staff_reply.last_platform_reply_at,'epoch'::timestamptz))
              or
              (c.conversation_mode='paused' and waiting_message.created_at >= coalesce(c.mode_changed_at,'epoch'::timestamptz))
            )
        ) waiting on true
        where ${where}
      )
      select (array_agg(b.id order by b.last_message_at desc))[1] id,
        (array_agg(b.reference_number order by b.last_message_at desc))[1] reference_number,
        string_agg(distinct b.reference_number, ', ' order by b.reference_number) conversation_references,
        b.business_date::text business_date,
        b.identity_key,
        min(b.created_at) created_at,
        max(b.last_message_at) last_message_at,
        max(b.updated_at) updated_at,
        (array_agg(b.channel order by b.last_message_at desc))[1] channel,
        (array_agg(b.current_intent order by b.last_message_at desc))[1] current_intent,
        (array_agg(b.language order by b.last_message_at desc))[1] language,
        (array_agg(b.status order by b.last_message_at desc))[1] status,
        (array_agg(b.conversation_mode order by b.last_message_at desc))[1] conversation_mode,
        (array_agg(b.review_status order by b.last_message_at desc))[1] review_status,
        (array_agg(b.review_comment order by b.last_message_at desc))[1] review_comment,
        (array_agg(b.review_action order by b.last_message_at desc))[1] review_action,
        (array_agg(b.operational_classification order by b.last_message_at desc))[1] operational_classification,
        (array_agg(b.customer_name order by b.last_message_at desc nulls last))[1] customer_name,
        (array_agg(b.mobile_number order by b.last_message_at desc nulls last))[1] mobile_number,
        (array_agg(b.mobile_number_normalized order by b.last_message_at desc nulls last))[1] mobile_number_normalized,
        (array_agg(b.email order by b.last_message_at desc nulls last))[1] email,
        (array_agg(b.audience order by b.last_message_at desc))[1] audience,
        (array_agg(b.identity_match_type order by b.last_message_at desc))[1] identity_match_type,
        bool_or(b.visitor_ip_hash is not null and b.visitor_ip_hash <> '') has_visitor_ip,
        (array_agg(b.assigned_to_account_id order by b.last_message_at desc))[1] assigned_to_account_id,
        (array_agg(assignee.username order by b.last_message_at desc))[1] assigned_to_username,
        count(*)::int conversation_count,
        coalesce(sum(b.message_count),0)::int message_count,
        coalesce(sum(b.unread_count),0)::int unread_count,
        bool_or(b.linked_quote_request_id is not null) has_quote,
        string_agg(distinct b.quote_reference, ', ' order by b.quote_reference) quote_reference,
        bool_or(b.linked_trader_application_id is not null) has_trader_application,
        string_agg(distinct b.trader_reference, ', ' order by b.trader_reference) trader_reference,
        bool_or(b.linked_demo_request_id is not null) has_demo_request,
        string_agg(distinct b.demo_reference, ', ' order by b.demo_reference) demo_reference,
        (array_agg(b.handoff_status order by b.last_message_at desc nulls last))[1] handoff_status,
        (array_agg(b.last_user_message order by b.last_message_at desc nulls last))[1] last_user_message,
        (array_agg(b.last_assistant_message order by b.last_message_at desc nulls last))[1] last_assistant_message,
        (array_agg(b.latest_message_preview order by b.last_message_at desc nulls last))[1] latest_message_preview,
        coalesce(sum(b.waiting_customer_message_count),0)::int waiting_customer_message_count,
        min(b.waiting_since) waiting_since
      from base b
      left join accounts assignee on assignee.id=b.assigned_to_account_id
      group by b.business_date,b.identity_key
      order by max(b.last_message_at) desc
      limit ${pageSize} offset ${offset}
    `.execute(this.db);
    const total = (await sql<{ count: string }>`
      with base as (
        select c.id,(c.last_message_at at time zone 'Asia/Dubai')::date business_date,
          case when c.customer_id is not null then 'customer:' || c.customer_id::text when c.mobile_number_normalized is not null and c.mobile_number_normalized <> '' then 'mobile:' || c.mobile_number_normalized when c.visitor_ip_hash is not null and c.visitor_ip_hash <> '' then 'ip:' || c.visitor_ip_hash when c.visitor_id is not null then 'visitor:' || c.visitor_id::text else 'conversation:' || c.id::text end identity_key
      from platform_agent_conversations c
      left join platform_customer_quote_requests q on q.id=c.linked_quote_request_id
      left join platform_trader_applications t on t.id=c.linked_trader_application_id
      left join platform_demo_requests d on d.id=c.linked_demo_request_id
      where ${where}
      )
      select count(*)::text count from (select 1 from base group by business_date,identity_key) grouped
    `.execute(this.db));
    const counters = (await sql<Record<string, unknown>>`
      select
        count(*) filter(where hidden_at is null and deleted_at is null and review_status='new')::int new,
        count(*) filter(where hidden_at is null and deleted_at is null and review_status in('open','in_progress'))::int open,
        count(*) filter(where hidden_at is null and deleted_at is null and review_status='waiting_for_customer')::int waiting_for_customer,
        count(*) filter(where hidden_at is null and deleted_at is null and review_status='follow_up')::int follow_up,
        count(*) filter(where hidden_at is null and deleted_at is null and review_status='resolved' and (updated_at at time zone 'Asia/Dubai')::date=(now() at time zone 'Asia/Dubai')::date)::int resolved_today,
        count(*) filter(where hidden_at is null and deleted_at is null and conversation_mode='paused')::int waiting_for_human,
        count(*) filter(where hidden_at is null and deleted_at is null and conversation_mode='human_active')::int human_active,
        count(*) filter(where hidden_at is null and deleted_at is null and conversation_mode='human_active' and exists(
          select 1 from platform_agent_messages customer_message
          where customer_message.conversation_id=platform_agent_conversations.id
            and customer_message.sender_type='user'
            and customer_message.created_at > coalesce(
              (select max(staff_message.created_at) from platform_agent_messages staff_message where staff_message.conversation_id=platform_agent_conversations.id and staff_message.sender_type='platform_staff' and staff_message.direction='outbound'),
              'epoch'::timestamptz
            )
        ))::int needs_reply,
        count(*) filter(where hidden_at is null and deleted_at is null and exists(select 1 from platform_agent_messages um where um.conversation_id=platform_agent_conversations.id and um.sender_type='user' and um.created_at > coalesce(platform_agent_conversations.platform_last_read_at,'epoch'::timestamptz)))::int unread,
        count(*) filter(where hidden_at is not null and deleted_at is null)::int hidden,
        count(*) filter(where deleted_at is not null)::int deleted
      from platform_agent_conversations
    `.execute(this.db)).rows[0] ?? {};
    return { counters: mapRow(counters), items: rows.rows.map(mapRow), page, pageSize, total: Number(total.rows[0]?.count ?? "0") };
  }

  public async adminConversation(id: string) {
    const ids = await this.dailyThreadConversationIds(id);
    await sql`update platform_agent_conversations set platform_last_read_at=now(),updated_at=now() where id = any(${ids}::uuid[])`.execute(this.db);
    const conversation = (await sql<Record<string, unknown>>`
      select c.*,assignee.username assigned_to_username
      from platform_agent_conversations c
      left join accounts assignee on assignee.id=c.assigned_to_account_id
      where c.id=${ids[0]}::uuid
    `.execute(this.db)).rows[0];
    if (!conversation) throw new NotFoundException();
    const messages = await sql<Record<string, unknown>>`select m.id,m.sender_type,m.content,m.structured_payload,m.channel,m.direction,m.delivery_status,m.provider,m.provider_message_id,m.media_type,m.failure_code,m.created_at,c.reference_number conversation_reference from platform_agent_messages m join platform_agent_conversations c on c.id=m.conversation_id where m.conversation_id = any(${ids}::uuid[]) order by m.created_at,m.id`.execute(this.db);
    const actions = await sql<Record<string, unknown>>`select a.action_type,a.status,a.request_snapshot,a.response_snapshot,a.safe_error_code,a.created_at,c.reference_number conversation_reference from platform_agent_actions a join platform_agent_conversations c on c.id=a.conversation_id where a.conversation_id = any(${ids}::uuid[]) order by a.created_at`.execute(this.db);
    const comments = await sql<Record<string, unknown>>`select cc.id,cc.comment,cc.created_at,cc.updated_at,a.username author_username,c.reference_number conversation_reference from platform_agent_conversation_comments cc left join accounts a on a.id=cc.author_account_id join platform_agent_conversations c on c.id=cc.conversation_id where cc.conversation_id = any(${ids}::uuid[]) order by cc.created_at`.execute(this.db);
    const history = await sql<Record<string, unknown>>`select h.*,actor.username actor_username,old_assignee.username old_assignee_username,new_assignee.username new_assignee_username,c.reference_number conversation_reference from platform_agent_conversation_status_history h left join accounts actor on actor.id=h.actor_account_id left join accounts old_assignee on old_assignee.id=h.old_assigned_to_account_id left join accounts new_assignee on new_assignee.id=h.new_assigned_to_account_id join platform_agent_conversations c on c.id=h.conversation_id where h.conversation_id = any(${ids}::uuid[]) order by h.created_at`.execute(this.db);
    const previousDays = await this.customerPreviousDays(ids[0]!);
    const waiting = (await sql<Record<string, unknown>>`
      with selected as (
        select c.*,staff_reply.last_platform_reply_at
        from platform_agent_conversations c
        left join lateral (select max(created_at) last_platform_reply_at from platform_agent_messages where conversation_id=c.id and sender_type='platform_staff' and direction='outbound') staff_reply on true
        where c.id = any(${ids}::uuid[])
      )
      select
        coalesce(count(waiting_message.id),0)::int waiting_customer_message_count,
        case
          when bool_or(selected.conversation_mode='paused') then coalesce(min(waiting_message.created_at),min(selected.mode_changed_at))
          when coalesce(count(waiting_message.id),0) > 0 then min(waiting_message.created_at)
          else null
        end waiting_since,
        max(selected.last_message_at) latest_activity_at
      from selected
      left join platform_agent_messages waiting_message
        on waiting_message.conversation_id=selected.id
       and waiting_message.sender_type='user'
       and (
          (selected.conversation_mode='human_active' and waiting_message.created_at > coalesce(selected.last_platform_reply_at,'epoch'::timestamptz))
          or
          (selected.conversation_mode='paused' and waiting_message.created_at >= coalesce(selected.mode_changed_at,'epoch'::timestamptz))
       )
    `.execute(this.db)).rows[0] ?? {};
    return { ...mapRow(conversation), ...mapRow(waiting), groupConversationIds: ids, conversationCount: ids.length, messages: messages.rows.map(mapRow), actions: actions.rows.map(mapRow), comments: comments.rows.map(mapRow), history: history.rows.map(mapRow), previousDays };
  }

  public async updateConversationReview(id: string, input: AgentConversationReviewDto, actorId: string) {
    const ids = await this.dailyThreadConversationIds(id);
    const before = await sql<Record<string, unknown>>`select id,review_status,assigned_to_account_id from platform_agent_conversations where id = any(${ids}::uuid[])`.execute(this.db);
    await sql`
      update platform_agent_conversations
      set review_status=${input.status},
          review_comment=${input.comment?.trim() || null},
          review_action=${input.action?.trim() || null},
          operational_classification=${this.normalizeClassification(input.classification)},
          assigned_to_account_id=${input.assignedToAccountId ? sql`${input.assignedToAccountId}::uuid` : null},
          assigned_by_account_id=${input.assignedToAccountId ? sql`${actorId}::uuid` : null},
          assigned_at=${input.assignedToAccountId ? sql`now()` : null},
          reviewed_by_account_id=${actorId}::uuid,
          reviewed_at=now(),
          updated_at=now()
      where id = any(${ids}::uuid[])
    `.execute(this.db);
    for (const row of before.rows) {
      await sql`insert into platform_agent_conversation_status_history(conversation_id,old_status,new_status,old_assigned_to_account_id,new_assigned_to_account_id,actor_account_id,comment) values(${row.id}::uuid,${String(row.review_status ?? "") || null},${input.status},${row.assigned_to_account_id ? sql`${String(row.assigned_to_account_id)}::uuid` : null},${input.assignedToAccountId ? sql`${input.assignedToAccountId}::uuid` : null},${actorId}::uuid,${input.comment?.trim() || null})`.execute(this.db);
    }
    return this.adminConversation(ids[0]!);
  }

  public async addConversationComment(id: string, comment: string, actorId: string) {
    const ids = await this.dailyThreadConversationIds(id);
    await sql`insert into platform_agent_conversation_comments(conversation_id,author_account_id,comment) values(${ids[0]}::uuid,${actorId}::uuid,${comment.trim()})`.execute(this.db);
    return this.adminConversation(ids[0]!);
  }

  public async replyToWhatsAppConversation(id: string, message: string, actorId: string) {
    const ids = await this.dailyThreadConversationIds(id);
    const conversation = (await sql<Record<string, unknown>>`select * from platform_agent_conversations where id=${ids[0]}::uuid`.execute(this.db)).rows[0];
    if (!conversation) throw new NotFoundException();
    if (!ids.length || !ids.some(Boolean)) throw new NotFoundException();
    const target = String(conversation.mobile_number_normalized ?? "");
    if (!target) throw new BadRequestException("conversation_has_no_whatsapp_mobile");
    const settings = await this.settings();
    if (!settings.whatsappAgentEnabled || settings.whatsappProvider === "disabled") throw new BadRequestException("whatsapp_disabled");
    const providerName = String(conversation.provider ?? settings.whatsappProvider ?? "meta_cloud");
    const messageId = await this.appendMessage(ids[0]!, "platform_staff", message.trim(), { sentBy: actorId }, { channel: "whatsapp", deliveryStatus: "queued", direction: "outbound", provider: providerName, senderAccountId: actorId });
    const send = await this.whatsappProvider(providerName).sendText(target, message.trim());
    await sql`update platform_agent_messages set provider_message_id=${send.providerMessageId},delivery_status=${send.status},failure_code=${send.failureCode ?? null} where id=${messageId}::uuid`.execute(this.db);
    await sql`update platform_agent_settings set whatsapp_last_outbound_at=case when ${send.status}<>'failed' then now() else whatsapp_last_outbound_at end, whatsapp_last_error_code=${send.failureCode ?? null} where id=true`.execute(this.db);
    await sql`insert into platform_agent_conversation_status_history(conversation_id,old_status,new_status,actor_account_id,comment) values(${ids[0]}::uuid,${String(conversation.review_status ?? "open")},${String(conversation.review_status ?? "open")},${actorId}::uuid,'Platform WhatsApp reply sent')`.execute(this.db);
    return this.adminConversation(ids[0]!);
  }

  public async replyToWebsiteConversation(id: string, message: string, actorId: string) {
    const ids = await this.dailyThreadConversationIds(id);
    const conversation = (await sql<Record<string, unknown>>`select * from platform_agent_conversations where id=${ids[0]}::uuid`.execute(this.db)).rows[0];
    if (!conversation) throw new NotFoundException();
    if (conversation.channel !== "website" && conversation.last_channel !== "website") throw new BadRequestException("conversation_is_not_website_chat");
    if (conversation.conversation_mode !== "human_active") throw new BadRequestException("human_takeover_required");
    const assignedTo = conversation.assigned_to_account_id === null || conversation.assigned_to_account_id === undefined ? null : String(conversation.assigned_to_account_id);
    if (assignedTo && assignedTo !== actorId) throw new BadRequestException("conversation_owned_by_another_agent");
    await this.appendMessage(ids[0]!, "platform_staff", message.trim(), { publicLabel: "Tawseelhub Team" }, { channel: "website", deliveryStatus: "recorded", direction: "outbound", senderAccountId: actorId });
    await sql`insert into platform_agent_conversation_status_history(conversation_id,old_status,new_status,actor_account_id,comment) values(${ids[0]}::uuid,${String(conversation.review_status ?? "open")},${String(conversation.review_status ?? "open")},${actorId}::uuid,'Platform website reply sent')`.execute(this.db);
    return this.adminConversation(ids[0]!);
  }

  public async setConversationMode(id: string, mode: "ai_active" | "human_active" | "paused" | "ai_resume", actorId: string, note?: string) {
    const ids = await this.dailyThreadConversationIds(id);
    const before = await sql<Record<string, unknown>>`select id,conversation_mode,review_status,assigned_to_account_id from platform_agent_conversations where id = any(${ids}::uuid[])`.execute(this.db);
    if (!before.rows.length) throw new NotFoundException();
    if (mode === "human_active" && before.rows.some((row) => row.assigned_to_account_id && String(row.assigned_to_account_id) !== actorId)) throw new BadRequestException("conversation_owned_by_another_agent");
    await sql`
      update platform_agent_conversations
      set conversation_mode=${mode},
          status=case when ${mode}='human_active' then 'handed_off' when ${mode}='paused' then 'waiting_for_user' when ${mode} in('ai_active','ai_resume') and status='handed_off' then 'active' else status end,
          mode_changed_by_account_id=${actorId}::uuid,
          mode_changed_at=now(),
          assigned_to_account_id=case when ${mode}='human_active' then ${actorId}::uuid when ${mode} in('ai_active','ai_resume') then null else assigned_to_account_id end,
          assigned_by_account_id=case when ${mode}='human_active' then ${actorId}::uuid when ${mode} in('ai_active','ai_resume') then null else assigned_by_account_id end,
          assigned_at=case when ${mode}='human_active' then now() when ${mode} in('ai_active','ai_resume') then null else assigned_at end,
          review_status=case when ${mode} in('human_active','paused') and review_status='new' then 'open' else review_status end,
          updated_at=now()
      where id = any(${ids}::uuid[])
    `.execute(this.db);
    for (const row of before.rows) {
      await this.recordModeHistory(String(row.id), String(row.conversation_mode ?? "ai_active"), mode, actorId, note ?? (mode === "human_active" ? "Take Over" : mode === "paused" ? "Human requested" : "Return to Yousef"));
    }
    return this.adminConversation(ids[0]!);
  }

  public async platformAssignees() {
    const rows = await sql<Record<string, unknown>>`select id,username,status from accounts where company_id is null and account_kind='platform_administrator' order by username`.execute(this.db);
    return rows.rows.map(mapRow);
  }

  public async hideConversation(id: string, actorId: string) {
    if (!validUuid.test(id)) throw new NotFoundException();
    const conversation = (await sql<Record<string, unknown>>`
      update platform_agent_conversations
      set hidden_at=now(),
        hidden_by_account_id=${actorId}::uuid,
        updated_at=now()
      where id=${id}::uuid
        and deleted_at is null
      returning id,review_status
    `.execute(this.db)).rows[0];
    if (!conversation) throw new NotFoundException();
    await sql`insert into platform_agent_conversation_status_history(conversation_id,old_status,new_status,actor_account_id,comment) values(${id}::uuid,${String(conversation.review_status ?? "open")},${String(conversation.review_status ?? "open")},${actorId}::uuid,'Conversation hidden from Agent inbox')`.execute(this.db);
    return { id, hidden: true };
  }

  public async unhideConversation(id: string, actorId: string) {
    if (!validUuid.test(id)) throw new NotFoundException();
    const conversation = (await sql<Record<string, unknown>>`
      update platform_agent_conversations
      set hidden_at=null,
        hidden_by_account_id=null,
        deleted_at=null,
        deleted_by_account_id=null,
        updated_at=now()
      where id=${id}::uuid
      returning id,review_status
    `.execute(this.db)).rows[0];
    if (!conversation) throw new NotFoundException();
    await sql`insert into platform_agent_conversation_status_history(conversation_id,old_status,new_status,actor_account_id,comment) values(${id}::uuid,${String(conversation.review_status ?? "open")},${String(conversation.review_status ?? "open")},${actorId}::uuid,'Conversation restored to Agent inbox')`.execute(this.db);
    return this.adminConversation(id);
  }

  public async deleteConversation(id: string, actorId: string) {
    if (!validUuid.test(id)) throw new NotFoundException();
    const ids = await this.dailyThreadConversationIds(id);
    let deletedCount = 0;
    await this.db.transaction().execute(async (trx) => {
      const handoffRows = (await sql<{ id: string }>`
        select id
        from platform_agent_handoffs
        where conversation_id = any(${ids}::uuid[])
      `.execute(trx)).rows;
      const handoffIds = handoffRows.map((row) => row.id);

      await sql`
        update platform_agent_whatsapp_webhooks
        set conversation_id=null
        where conversation_id = any(${ids}::uuid[])
      `.execute(trx);

      if (handoffIds.length > 0) {
        await sql`alter table platform_agent_handoff_history disable trigger agent_handoff_history_append_only`.execute(trx);
        await sql`
          delete from platform_agent_handoff_history
          where handoff_id = any(${handoffIds}::uuid[])
        `.execute(trx);
        await sql`alter table platform_agent_handoff_history enable trigger agent_handoff_history_append_only`.execute(trx);
        await sql`
          delete from platform_agent_handoffs
          where id = any(${handoffIds}::uuid[])
        `.execute(trx);
      }

      await sql`delete from platform_agent_conversation_status_history where conversation_id = any(${ids}::uuid[])`.execute(trx);
      await sql`delete from platform_agent_conversation_comments where conversation_id = any(${ids}::uuid[])`.execute(trx);
      await sql`delete from platform_agent_actions where conversation_id = any(${ids}::uuid[])`.execute(trx);
      await sql`delete from platform_agent_messages where conversation_id = any(${ids}::uuid[])`.execute(trx);
      const deleted = await sql<{ id: string }>`
        delete from platform_agent_conversations
        where id = any(${ids}::uuid[])
        returning id
      `.execute(trx);
      deletedCount = deleted.rows.length;
    });
    if (deletedCount === 0) throw new NotFoundException();
    return { id, deleted: true, deletedBy: actorId, deletedCount };
  }

  private async dailyThreadConversationIds(id: string): Promise<string[]> {
    if (!validUuid.test(id)) throw new NotFoundException();
    const anchor = (await sql<{ business_date: string; customer_id: string | null; mobile_number_normalized: string | null; visitor_id: string | null; visitor_ip_hash: string | null }>`
      select (last_message_at at time zone 'Asia/Dubai')::date::text business_date,
        customer_id::text,
        mobile_number_normalized,
        visitor_id::text,
        visitor_ip_hash
      from platform_agent_conversations
      where id=${id}::uuid
    `.execute(this.db)).rows[0];
    if (!anchor) throw new NotFoundException();
    const rows = await sql<{ id: string }>`
      select id
      from platform_agent_conversations
      where (last_message_at at time zone 'Asia/Dubai')::date::text=${anchor.business_date}
        and (
          id=${id}::uuid
          or
          (${anchor.customer_id}::text is not null and customer_id::text=${anchor.customer_id})
          or (${anchor.mobile_number_normalized}::text is not null and mobile_number_normalized=${anchor.mobile_number_normalized})
          or (${anchor.visitor_id}::text is not null and visitor_id::text=${anchor.visitor_id})
          or (${anchor.visitor_ip_hash}::text is not null and visitor_ip_hash=${anchor.visitor_ip_hash})
        )
      order by last_message_at desc, created_at desc
    `.execute(this.db);
    return rows.rows.map((row) => row.id);
  }

  private async customerPreviousDays(id: string) {
    const anchor = (await sql<{ business_date: string; customer_id: string | null; mobile_number_normalized: string | null; visitor_id: string | null; visitor_ip_hash: string | null }>`
      select (last_message_at at time zone 'Asia/Dubai')::date::text business_date,
        customer_id::text,
        mobile_number_normalized,
        visitor_id::text,
        visitor_ip_hash
      from platform_agent_conversations where id=${id}::uuid
    `.execute(this.db)).rows[0];
    if (!anchor) return [];
    const rows = await sql<Record<string, unknown>>`
      select (last_message_at at time zone 'Asia/Dubai')::date::text business_date,
        count(*)::int conversation_count,
        sum(message_counts.message_count)::int message_count,
        max(last_message_at) last_activity_at,
        array_remove(array[
          case when bool_or(${anchor.customer_id}::text is not null and c.customer_id::text=${anchor.customer_id}) then 'customer' end,
          case when bool_or(${anchor.mobile_number_normalized}::text is not null and c.mobile_number_normalized=${anchor.mobile_number_normalized}) then 'mobile' end,
          case when bool_or(${anchor.visitor_id}::text is not null and c.visitor_id::text=${anchor.visitor_id}) then 'visitor' end,
          case when bool_or(${anchor.visitor_ip_hash}::text is not null and c.visitor_ip_hash=${anchor.visitor_ip_hash}) then 'ip' end
        ], null) match_signals
      from platform_agent_conversations c
      left join lateral (select count(*)::int message_count from platform_agent_messages where conversation_id=c.id) message_counts on true
      where (last_message_at at time zone 'Asia/Dubai')::date::text <> ${anchor.business_date}
        and (
          (${anchor.customer_id}::text is not null and c.customer_id::text=${anchor.customer_id})
          or (${anchor.mobile_number_normalized}::text is not null and c.mobile_number_normalized=${anchor.mobile_number_normalized})
          or (${anchor.visitor_id}::text is not null and c.visitor_id::text=${anchor.visitor_id})
          or (${anchor.visitor_ip_hash}::text is not null and c.visitor_ip_hash=${anchor.visitor_ip_hash})
        )
      group by business_date
      order by business_date desc
      limit 12
    `.execute(this.db);
    return rows.rows.map(mapRow);
  }

  public async handoffs() {
    const rows = await sql<Record<string, unknown>>`select h.*,c.reference_number conversation_reference,c.channel from platform_agent_handoffs h join platform_agent_conversations c on c.id=h.conversation_id order by h.created_at desc limit 200`.execute(this.db);
    return rows.rows.map(mapRow);
  }

  public async updateHandoffStatus(id: string, status: string, notes: string | undefined, actorId: string) {
    const before = (await sql<{ status: string }>`select status from platform_agent_handoffs where id=${id}::uuid`.execute(this.db)).rows[0];
    if (!before) throw new NotFoundException();
    await sql`update platform_agent_handoffs set status=${status},updated_at=now() where id=${id}::uuid; insert into platform_agent_handoff_history(handoff_id,old_status,new_status,actor_account_id,notes) values(${id}::uuid,${before.status},${status},${actorId}::uuid,${notes ?? null})`.execute(this.db);
    return this.handoffs();
  }

  public async knowledge() {
    return (await sql<Record<string, unknown>>`select * from platform_agent_knowledge order by language,status,sort_order,title`.execute(this.db)).rows.map(mapRow);
  }

  public async saveKnowledge(input: AgentKnowledgeDto, actorId: string, id?: string) {
    if (/<\s*script/i.test(input.content)) throw new BadRequestException("unsafe_content");
    const audience = input.audience ?? "all";
    const featureStatus = input.featureStatus ?? "informational";
    const visibility = input.visibility ?? "public_agent";
    if (visibility === "internal_only" && featureStatus !== "internal_only") throw new BadRequestException("internal_visibility_requires_internal_status");
    if (id) await sql`update platform_agent_knowledge set language=${input.language},title=${input.title},content=${input.content},category=${input.category},audience=${audience},feature_status=${featureStatus},visibility=${visibility},status=${input.status},sort_order=${input.sortOrder ?? 100},updated_by_account_id=${actorId}::uuid,updated_at=now() where id=${id}::uuid`.execute(this.db);
    else await sql`insert into platform_agent_knowledge(language,title,content,category,audience,feature_status,visibility,status,sort_order,created_by_account_id,updated_by_account_id) values(${input.language},${input.title},${input.content},${input.category},${audience},${featureStatus},${visibility},${input.status},${input.sortOrder ?? 100},${actorId}::uuid,${actorId}::uuid)`.execute(this.db);
    return this.knowledge();
  }

  public async settings() {
    const row = (await sql<Record<string, unknown>>`select agent_enabled,website_chat_enabled,whatsapp_agent_enabled,assistant_display_name,default_language,human_handoff_enabled,general_fallback_message,model_provider,model_identifier,max_response_length,handoff_failure_threshold,supported_public_intents,whatsapp_provider,whatsapp_business_number,whatsapp_business_number_normalized,whatsapp_public_cta_enabled,whatsapp_last_webhook_at,whatsapp_last_outbound_at,whatsapp_last_error_code,whatsapp_configuration_note from platform_agent_settings where id=true`.execute(this.db)).rows[0]!;
    const mapped = mapRow(row) as Record<string, unknown>;
    return { ...mapped, diagnostics: this.model.diagnostics(), whatsappDiagnostics: this.whatsappProvider(String(mapped.whatsappProvider ?? "meta_cloud")).status() } as any;
  }

  public async publicWhatsAppSettings() {
    const row = (await sql<Record<string, unknown>>`
      select agent_enabled,whatsapp_agent_enabled,whatsapp_public_cta_enabled,whatsapp_business_number,whatsapp_business_number_normalized,whatsapp_provider
      from platform_agent_settings where id=true
    `.execute(this.db)).rows[0]!;
    const enabled = Boolean(row.whatsapp_public_cta_enabled) && row.whatsapp_provider !== "disabled";
    const number = String(row.whatsapp_business_number ?? "+971 50 689 8604");
    const normalized = normalizeInternationalMobile(String(row.whatsapp_business_number_normalized ?? number)) ?? "971506898604";
    return {
      enabled,
      label: "Chat on WhatsApp",
      number,
      url: enabled ? `https://wa.me/${normalized}` : null,
    };
  }

  public async publicAvailability() {
    const row = (await sql<Record<string, unknown>>`
      select agent_enabled, website_chat_enabled, human_handoff_enabled
      from platform_agent_settings where id=true
    `.execute(this.db)).rows[0]!;
    const assistantAvailable = Boolean(row.agent_enabled) && Boolean(row.website_chat_enabled);
    const humanAvailable = assistantAvailable && Boolean(row.human_handoff_enabled);
    return {
      assistantAvailable,
      humanAvailable,
      status: humanAvailable ? "available" : "unavailable",
    };
  }

  public async updateSettings(input: AgentSettingsDto, actorId: string) {
    await sql`update platform_agent_settings set agent_enabled=${input.agentEnabled},website_chat_enabled=${input.websiteChatEnabled},whatsapp_agent_enabled=${input.whatsappAgentEnabled},assistant_display_name=${input.assistantDisplayName},default_language=${input.defaultLanguage},human_handoff_enabled=${input.humanHandoffEnabled},general_fallback_message=${input.generalFallbackMessage},whatsapp_provider=${input.whatsappProvider ?? "meta_cloud"},whatsapp_business_number=${input.whatsappBusinessNumber ?? null},whatsapp_business_number_normalized=${normalizeInternationalMobile(input.whatsappBusinessNumber) ?? null},whatsapp_public_cta_enabled=${input.whatsappPublicCtaEnabled ?? true},updated_by_account_id=${actorId}::uuid,updated_at=now() where id=true`.execute(this.db);
    return this.settings();
  }

  private async recordWebhook(provider: string, eventId: string, eventType: string, status: string, conversationId: string | null, providerMessageId: string | null, senderMobileNormalized: string | null, safeErrorCode: string | null) {
    await sql`
      insert into platform_agent_whatsapp_webhooks(provider,provider_event_id,event_type,processing_status,conversation_id,provider_message_id,sender_mobile_normalized,safe_error_code,processed_at)
      values(${provider},${eventId},${eventType},${status},${conversationId ? sql`${conversationId}::uuid` : null},${providerMessageId},${senderMobileNormalized},${safeErrorCode},case when ${status} in('processed','duplicate','ignored','failed','unauthorized') then now() else null end)
      on conflict(provider,provider_event_id) do update set processing_status=excluded.processing_status,conversation_id=coalesce(excluded.conversation_id,platform_agent_whatsapp_webhooks.conversation_id),safe_error_code=excluded.safe_error_code,processed_at=excluded.processed_at
    `.execute(this.db);
  }

  private inboxDateRange(preset?: string, from?: string, to?: string): { from?: Date; to?: Date } {
    const now = new Date();
    const dubaiNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Dubai" }));
    const startOfDay = (date: Date) => new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - 4 * 60 * 60 * 1000);
    if (from || to) {
      return {
        ...(from ? { from: startOfDay(new Date(`${from}T00:00:00`)) } : {}),
        ...(to ? { to: new Date(startOfDay(new Date(`${to}T00:00:00`)).getTime() + 24 * 60 * 60 * 1000) } : {}),
      };
    }
    if (preset === "today") return { from: startOfDay(dubaiNow), to: new Date(startOfDay(dubaiNow).getTime() + 24 * 60 * 60 * 1000) };
    if (preset === "yesterday") return { from: new Date(startOfDay(dubaiNow).getTime() - 24 * 60 * 60 * 1000), to: startOfDay(dubaiNow) };
    if (preset === "this_week") {
      const day = dubaiNow.getDay();
      const mondayOffset = (day + 6) % 7;
      const start = new Date(startOfDay(dubaiNow).getTime() - mondayOffset * 24 * 60 * 60 * 1000);
      return { from: start, to: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000) };
    }
    if (preset === "this_month") {
      const start = startOfDay(new Date(dubaiNow.getFullYear(), dubaiNow.getMonth(), 1));
      const end = startOfDay(new Date(dubaiNow.getFullYear(), dubaiNow.getMonth() + 1, 1));
      return { from: start, to: end };
    }
    return {};
  }

  private normalizeUaeMobile(value?: string): string | null {
    if (!value) return null;
    const digits = value.replace(/\D/g, "");
    if (/^05\d{8}$/.test(digits)) return `971${digits.slice(1)}`;
    if (/^5\d{8}$/.test(digits)) return `971${digits}`;
    if (/^9715\d{8}$/.test(digits)) return digits;
    return digits || null;
  }

  private normalizeClassification(value?: string): string {
    const allowed = new Set(["shipment_quote", "trader_lead", "delivery_company_lead", "demo_request", "product_question", "storefront_commerce", "support", "general_enquiry", "pricing_enquiry", "partnership_enquiry"]);
    return allowed.has(value ?? "") ? value! : "general_enquiry";
  }

  private classificationFor(intent: AgentIntent, state: AgentState): string {
    if (intent === "customer_quote" || state.pendingAction?.type === "calculate_customer_quote") return "shipment_quote";
    if (intent === "trader" || state.pendingAction?.type === "submit_trader_application") return "trader_lead";
    if (state.pendingAction?.type === "submit_demo_request") return "demo_request";
    if (intent === "delivery_company_demo") return "delivery_company_lead";
    const topics = state.discussedTopics ?? [];
    if (topics.includes("storefront") || topics.includes("integrations")) return "storefront_commerce";
    if (topics.includes("customer_quotes")) return "pricing_enquiry";
    if (intent === "product_feature_question" || intent === "current_feature_status") return "product_question";
    if (state.audience === "delivery_company" && topics.includes("delivery_companies")) return "delivery_company_lead";
    return "general_enquiry";
  }

  private formatPublicUaeMobile(value: string): string {
    const normalized = this.normalizeUaeMobile(value);
    return normalized?.startsWith("971") ? `+${normalized}` : value;
  }

  private formatDubaiDateTime(value: string): string {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      month: "short",
      timeZone: "Asia/Dubai",
      timeZoneName: "short",
      year: "numeric",
    }).format(new Date(value));
  }

  private askForSlot(field: keyof AgentSlots, language: AgentLanguage): string {
    const en: Partial<Record<keyof AgentSlots, string>> = {
      deliveryAddress: "What delivery address or landmark should I use? You can type “skip” if you do not have it now.",
      deliveryArea: "What delivery area should I use?",
      deliveryEmirate: "Which emirate is the delivery going to?",
      packageType: "What are you sending?",
      pickupArea: "What pickup area should I use?",
      pickupDate: "What pickup date should I use?",
      pickupEmirate: "Which emirate should we pick up from?",
      requesterMobile: "What UAE mobile number should we use for the quote?",
      requesterName: "What name should we put on the quote request?",
      weightKg: "What is the approximate weight in kg?",
    };
    const ar: Partial<Record<keyof AgentSlots, string>> = {
      deliveryAddress: "ما عنوان التوصيل أو أقرب معلم؟ يمكنك كتابة “تخطي” إذا لم يكن متوفراً الآن.",
      deliveryArea: "ما منطقة التوصيل؟",
      deliveryEmirate: "إلى أي إمارة يكون التوصيل؟",
      packageType: "ما نوع الشحنة؟",
      pickupArea: "ما منطقة الاستلام؟",
      pickupDate: "ما تاريخ الاستلام؟",
      pickupEmirate: "من أي إمارة يكون الاستلام؟",
      requesterMobile: "ما رقم الهاتف المتحرك في الإمارات؟",
      requesterName: "ما الاسم المطلوب لطلب السعر؟",
      weightKg: "ما الوزن التقريبي بالكيلو؟",
    };
    return (language === "ar" ? ar[field] : en[field]) ?? (language === "ar" ? "ما المعلومة التي أستخدمها هنا؟" : "What should I use for that detail?");
  }

  private publicEmirateLabel(value: unknown, language: AgentLanguage): string {
    const key = String(value ?? "");
    if (language === "ar") {
      const ar: Record<string, string> = {
        abu_dhabi: "أبوظبي",
        ajman: "عجمان",
        dubai: "دبي",
        fujairah: "الفجيرة",
        ras_al_khaimah: "رأس الخيمة",
        sharjah: "الشارقة",
        umm_al_quwain: "أم القيوين",
      };
      return ar[key] ?? publicAgentLabel(key);
    }
    return publicAgentLabel(key);
  }

  private normalizePackageType(value: string): string {
    const lower = value.toLowerCase().replace(/[_-]/g, " ").trim();
    if (/document|paper|مستند/.test(lower)) return "document";
    if (/small|parcel|package|طرد|شحنة/.test(lower)) return "small_parcel";
    if (/medium/.test(lower)) return "medium_parcel";
    if (/large|big/.test(lower)) return "large_parcel";
    if (/box|carton|كرتون/.test(lower)) return "box";
    if (/fragile|breakable/.test(lower)) return "fragile_item";
    if (/food|meal|طعام|اكل/.test(lower)) return "food";
    if (/electronic|phone|laptop|mobile|إلكترون/.test(lower)) return "electronics";
    if (/clothes|clothing|dress|shirt/.test(lower)) return "clothing";
    return "other";
  }

  private identityFromState(state: AgentState) {
    const name = state.slots.requesterName ?? state.slots.contactPerson ?? state.slots.contactName ?? state.slots.storeName ?? state.slots.companyName ?? null;
    const mobileOriginal = state.slots.requesterMobile ?? state.slots.mobileNumber ?? state.slots.mobile ?? null;
    const email = state.slots.requesterEmail ?? state.slots.email ?? null;
    return {
      email,
      mobileNormalized: this.normalizeUaeMobile(mobileOriginal ?? undefined),
      mobileOriginal,
      name,
    };
  }

  private mergeSlots(current: AgentSlots, extracted: AgentSlots, correction: boolean): AgentSlots {
    const next = correction ? { ...current } : { ...current };
    for (const [key, value] of Object.entries(extracted)) if (value !== undefined && value !== "") (next as Record<string, unknown>)[key] = value;
    if (next.pickupBusinessArea === undefined && next.pickupArea) next.pickupBusinessArea = next.pickupArea;
    return next;
  }

  private applySequentialWorkflowAnswer(text: string, intent: AgentIntent, previousState: AgentState, slots: AgentSlots): AgentSlots {
    const answer = text.trim();
    if (!["customer_quote", "trader", "delivery_company_demo", "handoff"].includes(intent) || !previousState.lastAskedSlot || !answer || answer.length > 120 || /[?؟]/.test(answer)) return slots;
    const previousMissing = previousState.lastAskedSlot;
    if (!previousMissing || slots[previousMissing] !== undefined && slots[previousMissing] !== "") return slots;
    if (previousMissing === "pickupEmirate" || previousMissing === "deliveryEmirate" || previousMissing === "emirate") {
      if (!slots.emirate) return slots;
      const next = { ...slots };
      if (previousMissing === "pickupEmirate") next.pickupEmirate = slots.emirate;
      if (previousMissing === "emirate") next.emirate = slots.emirate;
      if (previousMissing === "deliveryEmirate") {
        next.deliveryEmirate = slots.emirate;
        if (previousState.slots.pickupEmirate) next.pickupEmirate = previousState.slots.pickupEmirate;
      }
      return next;
    }
    if (previousMissing === "weightKg") {
      const weight = /(\d+(?:\.\d+)?)/.exec(answer)?.[1];
      return weight ? { ...slots, weightKg: Number(weight) } : slots;
    }
    if (previousMissing === "pickupArea") return { ...slots, pickupArea: answer, pickupBusinessArea: slots.pickupBusinessArea ?? answer };
    if (previousMissing === "deliveryArea") return { ...slots, deliveryArea: answer };
    if (previousMissing === "packageType") return { ...slots, packageType: answer };
    if (previousMissing === "requesterName") return { ...slots, requesterName: answer };
    if (previousMissing === "requesterMobile") return { ...slots, requesterMobile: answer, mobileNumber: slots.mobileNumber ?? answer };
    if (previousMissing === "deliveryAddress") return this.isSkipAnswer(answer) ? slots : { ...slots, deliveryAddress: answer };
    if (previousMissing === "storeName") return { ...slots, storeName: answer };
    if (previousMissing === "companyName") return { ...slots, companyName: answer };
    if (previousMissing === "contactPerson") {
      if (/\b(i sell|we sell|need delivery|orders?|instagram|shopify|store|trader)\b/i.test(answer)) return slots;
      return { ...slots, contactPerson: answer, contactName: slots.contactName ?? answer };
    }
    if (previousMissing === "contactName") return { ...slots, contactName: answer, requesterName: slots.requesterName ?? answer };
    if (previousMissing === "mobile") return { ...slots, mobile: answer, mobileNumber: slots.mobileNumber ?? answer, requesterMobile: slots.requesterMobile ?? answer };
    if (previousMissing === "mobileNumber") return { ...slots, mobileNumber: answer, requesterMobile: slots.requesterMobile ?? answer };
    if (previousMissing === "email") return { ...slots, email: answer, requesterEmail: slots.requesterEmail ?? answer };
    if (previousMissing === "pickupBusinessArea") return { ...slots, pickupBusinessArea: answer, pickupArea: slots.pickupArea ?? answer };
    return slots;
  }

  private resolveTurnIntent(text: string, classifiedIntent: AgentIntent, state: AgentState): AgentIntent {
    if (!state.lastAskedSlot || !state.lastBusinessIntent || !workflowIntents.has(state.lastBusinessIntent)) return classifiedIntent;
    if (this.isPriceQuestion(text)) return classifiedIntent;
    if (classifiedIntent === "handoff" || classifiedIntent === "current_feature_status" || classifiedIntent === "product_feature_question") return classifiedIntent;
    if (this.isClarification(text) || this.isWorkflowCancellation(text) || this.looksLikeNewBusinessQuestion(text)) return classifiedIntent;
    const answer = text.trim();
    if (!answer || answer.length > 120 || /[?؟]/.test(answer)) return classifiedIntent;
    if (genericAnswerIntents.has(classifiedIntent) || socialIntents.has(classifiedIntent) || workflowIntents.has(classifiedIntent)) return state.lastBusinessIntent;
    return classifiedIntent;
  }

  private intentFromConversationFrame(frame: AgentState["conversationFrame"], classifiedIntent: AgentIntent): AgentIntent {
    if (!frame) return classifiedIntent;
    if (frame.decision === "explicit_workflow_start" || frame.decision === "workflow_continue" || frame.decision === "current_workflow_slot_response") {
      return agentIntentFromWorkflow(frame.workflow) ?? classifiedIntent;
    }
    if (frame.decision === "human_handoff") return "handoff";
    if (frame.decision === "privacy_blocked") return "general_question";
    if (frame.mode === "conversation" && frame.workflowState !== "active") {
      if (["drivers", "cod", "reconciliation", "settlement", "accounting", "payroll", "reports", "integrations", "stores", "mobile", "trader", "delivery_company"].includes(frame.topic)) return "product_feature_question";
      if (frame.topic === "pricing") return "general_question";
      return socialIntents.has(classifiedIntent) ? classifiedIntent : "general_question";
    }
    return classifiedIntent;
  }

  private stateScopedByConversationFrame(state: AgentState, frame: AgentState["conversationFrame"]): AgentState {
    if (!frame) return state;
    if (frame.decision === "bare_topic_information" || frame.decision === "workflow_paused_for_explanation" || frame.decision === "workflow_cancelled" || frame.decision === "informational_topic" || frame.decision === "privacy_blocked") {
      const { pendingAction: _pendingAction, lastAskedSlot: _lastAskedSlot, pendingGeneralFollowUp: _pendingGeneralFollowUp, ...baseState } = state;
      return {
        ...baseState,
        conversationFrame: frame,
        lastBusinessIntent: "general_question",
      };
    }
    return { ...state, conversationFrame: frame };
  }

  private logFrameDecision(conversationId: string, frame: NonNullable<AgentState["conversationFrame"]>): void {
    this.logger.debug({
      conversationId,
      decision: frame.decision,
      detectedAction: frame.lastExplicitUserAction,
      detectedTopic: frame.topic,
      mode: frame.mode,
      workflow: frame.workflow,
      workflowState: frame.workflowState,
      reason: frame.reason,
    }, "Tawseelhub Agent conversation frame decision");
  }

  private previousIntentForClassification(currentIntent: AgentIntent, state: AgentState): AgentIntent {
    if (state.lastAskedSlot && state.lastBusinessIntent && workflowIntents.has(state.lastBusinessIntent)) return state.lastBusinessIntent;
    return currentIntent;
  }

  private isWorkflowCancellation(text: string): boolean {
    return /^(cancel|stop|never mind|start over|reset|الغاء|إلغاء|وقف|خلاص|ابدأ من جديد)$/i.test(text.trim());
  }

  private looksLikeNewBusinessQuestion(text: string): boolean {
    const lower = text.toLowerCase().trim();
    if (/[?؟]/.test(lower)) return true;
    return /^(can|do|does|is|are|how|what|which|when|where|why|هل|كيف|شو|ما|متى|وين)\b/i.test(lower);
  }

  private isClarification(text: string): boolean {
    return /^(why|why\?|for what|what for|for pickup or delivery|pickup or delivery|is this pickup or delivery|what do you mean|is it required|why do you need this|why do you need .*address)\??$/i.test(text.trim()) || /^(ليش|لماذا|لشو|حق شو|شو تقصد|عنوان الاستلام ولا التوصيل|استلام ولا توصيل|للاستلام ولا للتوصيل|هل هو مطلوب|هل مطلوب)[؟?]?$/.test(text.trim()) || /ليش.*العنوان|ليش.*عنوان|لماذا.*العنوان|عنوان.*(?:استلام|توصيل)/i.test(text.trim());
  }

  private fieldClarification(field: keyof AgentSlots, language: AgentLanguage, state: AgentState, text: string) {
    if (field === "deliveryAddress") {
      const pickup = [state.slots.pickupArea, this.publicEmirateLabel(state.slots.pickupEmirate, language)].filter(Boolean).join(", ");
      const delivery = [state.slots.deliveryArea, this.publicEmirateLabel(state.slots.deliveryEmirate, language)].filter(Boolean).join(", ");
      const asksPickupOrDelivery = /pickup or delivery|(?:ال)?استلام ولا (?:ال)?توصيل|للاستلام ولا للتوصيل/i.test(text);
      const asksForWhat = /for what|what for|لشو|حق شو/i.test(text);
      if (language === "ar") {
        const context = pickup && delivery ? `الاستلام محفوظ عندي: ${pickup}. والتوصيل إلى ${delivery}.` : "";
        const explanation = asksPickupOrDelivery
          ? `للتوصيل — عنوان المستلم أو أقرب معلم في ${delivery || "منطقة التوصيل"}. ${context}`
          : asksForWhat
            ? `لموقع التوصيل. ${context} أطلب عنوان المستلم أو أقرب معلم فقط لتحسين دقة المسار.`
            : `عنوان التوصيل يساعد شركة التوصيل على تقدير المسار والسعر بشكل أدق. ${context}`;
        return { content: `${explanation}\nما عنوان التوصيل أو أقرب معلم؟ وإذا غير متوفر الآن اكتب “تخطي”.`, intent: "clarification" as const, status: "waiting_for_user" };
      }
      const context = pickup && delivery ? `I already have your pickup as ${pickup}, and delivery as ${delivery}.` : "";
      const explanation = asksPickupOrDelivery
        ? `Delivery — the receiver's address or closest landmark in ${delivery || "the delivery area"}. ${context}`
        : asksForWhat
          ? `For the delivery location. ${context} I’m asking for the receiver’s address or closest landmark.`
          : `The delivery address helps the Delivery Company estimate the route and quotation more accurately. ${context}`;
      return { content: `${explanation}\nWhat delivery address or landmark should I use? You can type “skip” if you do not have it now.`, intent: "clarification" as const, status: "waiting_for_user" };
    }
    const en: Partial<Record<keyof AgentSlots, string>> = {
      deliveryAddress: "The delivery address helps the Delivery Company estimate the route and quotation more accurately. If you do not have the exact address yet, you can give the closest area or landmark.",
      pickupArea: "The pickup area helps estimate the route and match the right delivery option. The Emirate alone is usually not enough for an accurate quotation.",
      deliveryArea: "The delivery area helps estimate distance and service availability. The Emirate alone is usually not enough for an accurate quotation.",
      requesterName: "We ask for the name so the Tawseelhub team can identify the quote request and follow up correctly.",
      requesterMobile: "We ask for a UAE mobile number so Tawseelhub can contact you with the quotation or any needed clarification.",
    };
    const ar: Partial<Record<keyof AgentSlots, string>> = {
      deliveryAddress: "العنوان يساعد شركة التوصيل على تقدير المسار والسعر بشكل أدق. إذا ما عندك العنوان الكامل الآن، ممكن تكتب أقرب منطقة أو معلم واضح.",
      pickupArea: "منطقة الاستلام تساعد في تقدير المسار واختيار عرض التوصيل المناسب. الإمارة وحدها غالباً لا تكفي لسعر دقيق.",
      deliveryArea: "منطقة التوصيل تساعد في تقدير المسافة وتوفر الخدمة. الإمارة وحدها غالباً لا تكفي لسعر دقيق.",
      requesterName: "نطلب الاسم حتى يتمكن فريق Tawseelhub من تمييز طلب السعر والمتابعة معك بشكل صحيح.",
      requesterMobile: "نطلب رقم هاتف إماراتي حتى يتواصل معك فريق Tawseelhub بعرض السعر أو أي توضيح مطلوب.",
    };
    return { content: (language === "ar" ? ar[field] : en[field]) ?? (language === "ar" ? "أحتاج هذه المعلومة حتى أتابع الطلب بشكل صحيح. إذا غير متوفرة الآن، أخبرني بما هو متاح." : "I need that detail to continue the request correctly. If you do not have it now, tell me what you do have."), intent: "clarification" as const, status: "waiting_for_user" };
  }

  private state(value: unknown): AgentState {
    const object = asObject(value);
    const state: AgentState = {
      audience: object.audience === "delivery_company" || object.audience === "trader" || object.audience === "customer" ? object.audience : "unknown",
      discussedTopics: Array.isArray(object.discussedTopics) ? object.discussedTopics.filter((item): item is string => typeof item === "string") : [],
      slots: asObject(object.slots) as AgentSlots,
      seenInboundMessageIds: Array.isArray(object.seenInboundMessageIds) ? object.seenInboundMessageIds as string[] : [],
    };
    if (typeof object.lastBusinessIntent === "string") state.lastBusinessIntent = object.lastBusinessIntent as AgentIntent;
    if (typeof object.lastAskedSlot === "string") state.lastAskedSlot = object.lastAskedSlot as keyof AgentSlots;
    if (object.returningRequestDecision === "pending") state.returningRequestDecision = "pending";
    if (object.existingRequest !== undefined) {
      const existing = asObject(object.existingRequest);
      if (typeof existing.reference === "string" && typeof existing.status === "string") state.existingRequest = { reference: existing.reference, status: existing.status };
    }
    if (object.deliveryAddressSkipped === true) state.deliveryAddressSkipped = true;
    if (object.pendingGeneralFollowUp === "public_explanation" || object.pendingGeneralFollowUp === "feature_choice" || object.pendingGeneralFollowUp === "trader_registration_explained") state.pendingGeneralFollowUp = object.pendingGeneralFollowUp;
    if (object.historicalContext !== undefined) state.historicalContext = asObject(object.historicalContext) as NonNullable<AgentState["historicalContext"]>;
    if (object.pendingAction !== undefined) {
      state.pendingAction = object.pendingAction as NonNullable<AgentState["pendingAction"]>;
    }
    if (object.conversationFrame !== undefined) state.conversationFrame = asObject(object.conversationFrame) as unknown as NonNullable<AgentState["conversationFrame"]>;
    return state;
  }

  private async findByToken(sessionToken: string) {
    const row = (await sql<Record<string, unknown>>`select * from platform_agent_conversations where public_session_token_hash=${hash(sessionToken)}`.execute(this.db)).rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  private async publicConversation(conversation: Record<string, unknown>) {
    const messages = await sql<Record<string, unknown>>`
      select id,sender_type,content,structured_payload,created_at
      from platform_agent_messages
      where conversation_id=${conversation.id}::uuid
        and direction in('inbound','outbound')
        and sender_type in('user','assistant','platform_staff')
      order by created_at,id
    `.execute(this.db);
    return {
      reference: conversation.reference_number,
      channel: conversation.channel,
      conversationMode: conversation.conversation_mode ?? "ai_active",
      humanState: conversation.conversation_mode === "human_active" ? "human_active" : conversation.conversation_mode === "paused" ? "waiting_for_human" : "ai_active",
      language: conversation.language,
      intent: conversation.current_intent,
      status: conversation.status,
      messages: messages.rows.map((row) => {
        const mapped = mapRow(row);
        return {
          ...mapped,
          displayName: row.sender_type === "platform_staff" ? "Tawseelhub Team" : row.sender_type === "assistant" ? "Yousef" : "You",
        };
      }),
    };
  }

  private humanWaitingMessage(language: AgentLanguage) {
    return language === "ar"
      ? "طلبت من فريق Tawseelhub الانضمام إلى هذه المحادثة. يمكنك الاستمرار في الكتابة هنا أثناء الانتظار."
      : "I’ve asked the Tawseelhub team to join this chat. You can continue typing here while you wait.";
  }

  private humanUnavailableAskForContactMessage(language: AgentLanguage, state: AgentState) {
    const slots = state.slots;
    const hasName = Boolean(slots.contactName ?? slots.requesterName ?? slots.contactPerson);
    return language === "ar"
      ? hasName
        ? "لا يوجد موظف متاح الآن. سأحفظ معلوماتك وسيتواصل معك فريق العمليات قريباً. ما رقم الهاتف المتحرك الذي يمكن التواصل معك عليه؟"
        : "لا يوجد موظف متاح الآن. سأحفظ معلوماتك وسيتواصل معك فريق العمليات قريباً. ما اسمك؟"
      : hasName
        ? "No human agent is available right now. I’ll save your information and our operations team will get back to you soon. What mobile number should we use?"
        : "No human agent is available right now. I’ll save your information and our operations team will get back to you soon. What is your name?";
  }

  private humanUnavailableContactState(state: AgentState): AgentState {
    const slots = state.slots;
    return {
      ...state,
      lastBusinessIntent: "handoff",
      lastAskedSlot: slots.contactName ?? slots.requesterName ?? slots.contactPerson ? "mobile" : "contactName",
    };
  }

  private async markWebsiteHumanRequested(conversationId: string, oldMode: string, comment: string) {
    await sql`
      update platform_agent_conversations
      set conversation_mode='paused', status='waiting_for_user', review_status=case when review_status='new' then 'open' else review_status end, mode_changed_at=now(), updated_at=now()
      where id=${conversationId}::uuid
    `.execute(this.db);
    await this.recordModeHistory(conversationId, oldMode, "paused", null, comment);
  }

  private async recordModeHistory(conversationId: string, oldMode: string, newMode: string, actorId: string | null, comment: string) {
    await sql`
      insert into platform_agent_conversation_status_history(conversation_id,old_status,new_status,actor_account_id,comment)
      values(${conversationId}::uuid,${oldMode},${newMode},${actorId ? sql`${actorId}::uuid` : null},${comment})
    `.execute(this.db);
  }

  private async appendMessage(conversationId: string, sender: string, content: string, payload?: unknown, meta: { channel?: string; provider?: string; providerMessageId?: string; direction?: "inbound" | "outbound" | "internal"; senderAccountId?: string; deliveryStatus?: string } = {}) {
    const inserted = await sql<{ id: string }>`
      insert into platform_agent_messages(conversation_id,sender_type,content,structured_payload,channel,provider,provider_message_id,direction,sender_account_id,delivery_status)
      values(${conversationId}::uuid,${sender},${content},${payload === undefined ? null : JSON.stringify(payload)}::jsonb,${meta.channel ?? null},${meta.provider ?? null},${meta.providerMessageId ?? null},${meta.direction ?? (sender === "user" ? "inbound" : sender === "system" ? "internal" : "outbound")},${meta.senderAccountId ? sql`${meta.senderAccountId}::uuid` : null},${meta.deliveryStatus ?? "recorded"})
      returning id
    `.execute(this.db);
    await sql`
      update platform_agent_conversations
      set last_message_at=now(),
          last_channel=coalesce(${meta.channel ?? null},last_channel,channel),
          last_customer_message_at=case when ${sender}='user' then now() else last_customer_message_at end,
          last_outbound_message_at=case when ${sender} in('assistant','platform_staff') then now() else last_outbound_message_at end,
          updated_at=now()
      where id=${conversationId}::uuid
    `.execute(this.db);
    return inserted.rows[0]!.id;
  }

  private async appendMessageByReference(ref: string, sender: string, content: string, payload?: unknown) {
    await sql`insert into platform_agent_messages(conversation_id,sender_type,content,structured_payload,channel,direction) select id,${sender},${content},${payload === undefined ? null : JSON.stringify(payload)}::jsonb,channel,case when ${sender}='user' then 'inbound' when ${sender}='system' then 'internal' else 'outbound' end from platform_agent_conversations where reference_number=${ref}`.execute(this.db);
    await sql`update platform_agent_conversations set last_message_at=now(),updated_at=now() where reference_number=${ref}`.execute(this.db);
  }

  private welcome(language: AgentLanguage) {
    return language === "ar" ? arabicGreeting() : englishGreeting();
  }

  private socialResponse(intent: AgentIntent, language: AgentLanguage) {
    const socialIntent = intent as "greeting" | "small_talk" | "thanks" | "goodbye";
    const content =
      language === "ar"
        ? {
            greeting: "مرحباً! كيف يمكنني مساعدتك اليوم؟ يمكنك السؤال عن Tawseelhub أو إرسال شحنة أو تسجيل تاجر أو طلب عرض لشركة توصيل.",
            small_talk: "أنا بخير، شكراً لك. كيف يمكنني مساعدتك اليوم؟",
            thanks: "على الرحب والسعة. إذا احتجت أي شيء آخر فأنا هنا للمساعدة.",
            goodbye: "شكراً لتواصلك مع Tawseelhub. أتمنى لك يوماً موفقاً.",
          }[socialIntent] ?? "كيف يمكنني مساعدتك؟"
        : {
            greeting: "Hi! How can I help you today? You can ask about Tawseelhub, send a package, register as a Trader, or request a Delivery Company demo.",
            small_talk: "I’m doing well, thank you. How can I help you today?",
            thanks: "You’re welcome. If you need anything else, I’m here to help.",
            goodbye: "Thanks for contacting Tawseelhub. Have a great day.",
          }[socialIntent] ?? "How can I help you?";
    return { content, intent, status: intent === "goodbye" ? "closed" : "waiting_for_user" };
  }

  private completedQuoteFollowUp(language: AgentLanguage) {
    const content =
      language === "ar"
        ? "تم استلام طلب السعر. إذا كان الطلب يحتاج سعراً مخصصاً، سيقوم فريق Tawseelhub بمراجعته والتواصل معك على رقم الهاتف الذي أدخلته عند توفر الرد. هل لديك سؤال آخر، أو كيف يمكنني مساعدتك الآن؟"
        : "Your quote request has already been received. If it requires a custom quotation, the Tawseelhub team will review it and contact you on the mobile number you provided when the response is ready. Do you have another question, or how can I help you now?";
    return { content, intent: "customer_quote" as const, status: "completed" };
  }

  private enrichState(text: string, intent: AgentIntent, state: AgentState): AgentState {
    const audience = this.detectAudience(text, state);
    const topics = new Set([...(state.discussedTopics ?? []), ...this.detectTopics(text, intent)]);
    return {
      ...state,
      audience,
      discussedTopics: [...topics].slice(-12),
      ...(businessInfoIntents.has(intent) || intent === "customer_quote" || intent === "trader" || intent === "delivery_company_demo" ? { lastBusinessIntent: intent } : {}),
    };
  }

  private detectAudience(text: string, state: AgentState): NonNullable<AgentState["audience"]> {
    const lower = text.toLowerCase();
    if (/delivery company|courier company|fleet|drivers|driver|شركة توصيل|سائق/.test(lower)) return "delivery_company";
    if (/trader|store|seller|shopify|salla|woocommerce|instagram|تاجر|متجر/.test(lower)) return "trader";
    if (/send|shipment|package|parcel|quote|pickup|deliver|delivery from|kg|box|personal package|customer|أرسل|ارسل|إرسال|ارسال|شحنة|طرد|سعر|طلب توصيل|أحتاج توصيل|احتاج توصيل/.test(lower)) return "customer";
    return state.audience ?? "unknown";
  }

  private detectTopics(text: string, intent: AgentIntent): string[] {
    const lower = text.toLowerCase();
    const topics: string[] = [];
    for (const [topic, pattern] of Object.entries({
      accounting: /accounting|journal|financial|محاسبة/,
      cod_collections: /cod|cash|collection|driver money|reconciliation|تحصيل/,
      payroll: /payroll|earning|salary|رواتب/,
      reports: /report|statement|تقارير|كشف/,
      integrations: /shopify|salla|woocommerce|integration|تكامل/,
      storefront: /storefront|build a store|create a store/,
      trader_registration: /trader|register|تاجر|تسجيل/,
      customer_quotes: /quote|price|send|package|سعر|شحنة/,
      delivery_companies: /delivery company|driver|fleet|شركة توصيل|سائق/,
    })) if (pattern.test(lower)) topics.push(topic);
    if (intent === "delivery_company_demo") topics.push("delivery_companies");
    if (intent === "trader") topics.push("trader_registration");
    if (intent === "customer_quote") topics.push("customer_quotes");
    return topics;
  }

  private async latestUserMessage(conversationId: string): Promise<string> {
    const row = (await sql<{ content: string }>`select content from platform_agent_messages where conversation_id=${conversationId}::uuid and sender_type='user' order by created_at desc limit 1`.execute(this.db)).rows[0];
    return row?.content ?? "";
  }

  private async retrieveKnowledge(text: string, language: AgentLanguage, state: AgentState): Promise<AgentKnowledgeContext[]> {
    const rows = await sql<Record<string, unknown>>`
      select title,content,category,audience,feature_status,visibility,language
      from platform_agent_knowledge
      where language in (${language}, 'en')
        and status='published'
        and visibility='public_agent'
      order by sort_order,title
      limit 80
    `.execute(this.db);
    const lower = text.toLowerCase();
    const topics = new Set([...this.detectTopics(text, state.lastBusinessIntent ?? "unknown"), ...(state.discussedTopics ?? [])]);
    const scored = rows.rows.map((row) => {
      const searchable = `${row.title} ${row.category} ${row.content}`.toLowerCase();
      let score = 0;
      for (const topic of topics) if (searchable.includes(topic.replace(/_/g, " ")) || searchable.includes(topic)) score += 4;
      for (const token of lower.split(/[^a-z0-9\u0600-\u06ff]+/).filter((item) => item.length > 2)) if (searchable.includes(token)) score += 1;
      if (row.language === language) score += 3;
      if ((row.audience === state.audience || row.audience === "all" || row.audience === "public") && state.audience !== "unknown") score += 2;
      if (row.category === "Tawseelhub Overview") score += 1;
      return { row, score };
    }).filter((item) => item.score > 0);
    const selected = (scored.length ? scored.sort((a, b) => b.score - a.score) : rows.rows.map((row) => ({ row, score: 0 }))).slice(0, 5);
    return selected.map(({ row }) => ({
      audience: String(row.audience ?? "all") as AgentKnowledgeContext["audience"],
      category: String(row.category ?? "general"),
      content: generalKnowledgeContent(language, String(row.content ?? "")),
      featureStatus: String(row.feature_status ?? "informational") as AgentKnowledgeContext["featureStatus"],
      title: String(row.title ?? ""),
      visibility: String(row.visibility ?? "public_agent") as AgentKnowledgeContext["visibility"],
    }));
  }

  private safeBusinessFallback(text: string, language: AgentLanguage, state: AgentState, knowledge: AgentKnowledgeContext[]): string {
    const lower = text.toLowerCase();
    if (privateDirectoryOrCustomerInfo.test(text)) {
      return language === "ar"
        ? "لا أستطيع مشاركة أسماء شركات التوصيل أو التجار أو معلومات أو محادثات عملاء آخرين. هذه معلومات خاصة داخل المنصة. إذا كنت تحتاج توصيلاً، أستطيع مساعدتك بطلب سعر أو تسجيل تاجر ليتم التعامل مع الطلب عبر المسار المناسب."
        : "I can’t share private Delivery Company names, Trader names, another customer’s information, or another customer’s conversation. That information is private inside the Platform. If you need delivery support, I can guide you through a package quote or Trader registration instead.";
    }
    if (isAgentAnyPricingTopicText(text)) return platformPricingResponse(language);
    if (/reconciliation|driver collections|driver money/.test(lower)) return language === "ar"
      ? "تتم مطابقة السائق من خلال Driver Collections: تراجع الشركة الطلبات المسلّمة للسائق، وتسجل المبلغ الذي تم تسليمه نقداً أو بوسيلة دفع، ويبقى ذلك مرتبطاً بالتقارير والتسويات بدون تكرار نفس الطلب."
      : "Driver reconciliation is handled through Driver Collections: the company reviews delivered orders for a driver, records the cash or payment handed over, and keeps the result traceable for reports and downstream settlement. It is designed to avoid repeating the same order in multiple collections.";
    if (/cod|cash on delivery|collection|driver money|reconciliation|تحصيل/.test(lower)) {
      if (state.audience === "trader") {
        return language === "ar"
          ? "بالنسبة للتاجر، COD يعني أن مبلغ الطلب يُحصّل عند التسليم ثم يظهر للتسوية مع التاجر حسب إجراءات شركة التوصيل وTawseelhub. الفكرة أن تكون مبالغ التحصيل وكشوفات التاجر واضحة وقابلة للمتابعة."
          : "For a Trader, COD means the order amount is collected at delivery and then tracked for Trader settlement. Tawseelhub helps keep COD amounts, delivery status and Trader statements clear so you can follow what should be paid to you.";
      }
      return language === "ar"
        ? "يساعد Tawseelhub شركات التوصيل في إدارة التحصيل النقدي من الطلبات وربطه بالطلبات والسائقين والتجار والتسويات والتقارير. الهدف أن ترى الشركة مبالغ COD، ما تم تحصيله، وما يحتاج مطابقة أو تسوية مع التجار. أي جزء من التحصيل تريد تحسينه أولاً؟"
        : "Tawseelhub helps Delivery Companies manage COD collections by connecting order amounts, driver collections, Trader balances, settlements, accounting and reports in one operating flow. The goal is to make collected cash traceable from delivery through reconciliation and Trader settlement. Which COD problem are you trying to solve first?";
    }
    if (language === "ar") {
      if (isAgentFeatureExplanationText(text)) return featureExplanationText(text, language);
      if (isAgentTraderUsageQuestionText(text)) return "يستخدم التاجر Tawseelhub لربط متجره أو طلباته مع عمليات التوصيل: تسجيل بيانات المتجر، تحديد موقع الاستلام، متابعة الطلبات، رؤية حالة التوصيل، ومتابعة التحصيل COD والتسويات حسب إعداد شركة التوصيل. التسجيل كتاجر هو الخطوة الأولى إذا كان يريد من فريق Tawseelhub مراجعة بياناته وربطه بخدمة توصيل مناسبة. هل تريد شرح التسجيل، أم متابعة الطلبات بعد التسجيل؟";
      if (/shopify|شوبيفاي/.test(lower)) return "تكامل Shopify مخطط وليس متاحاً حالياً. الهدف أن يحتفظ التاجر بمتجر Shopify بينما تنتقل طلبات التوصيل إلى Tawseelhub عند توفر التكامل.";
      if (/محاسبة|حسابات/.test(lower)) return "نعم، يوجد دعم محاسبي تشغيلي داخل Tawseelhub لمتابعة COD والتحصيل والتسويات والتقارير المالية المرتبطة بعمليات التوصيل.";
      if (/رواتب|راتب|Payroll/i.test(lower)) return "نعم، يوجد دعم للرواتب/مستحقات السائقين والموظفين حسب إعدادات الشركة، وليس كمنتج رواتب عام منفصل.";
      if (/تطبيق|موبايل|mobile/i.test(lower)) return "تدفقات تطبيقات الموبايل جزء من نموذج Tawseelhub للعمليات الميدانية وتجربة العملاء. حالة كل تطبيق أو وحدة تعتمد على إعدادات التشغيل المتاحة للشركة.";
      return knowledge.find((item) => /[\u0600-\u06ff]/.test(item.content))?.content ?? arabicGeneralFallback;
    }
    if (state.audience === "trader" && /receive.*money|paid|payment|settlement|my money/.test(lower)) return "You receive your money through Trader settlement: delivered orders and COD amounts are tracked, then the Delivery Company/Tawseelhub process records what is payable to you and follows it through statement and settlement status. Exact timing depends on the commercial arrangement.";
    if (isAgentFeatureExplanationText(text)) return featureExplanationText(text, language);
    if (isAgentTraderUsageQuestionText(text)) return "A Trader uses Tawseelhub to connect store/order details with delivery operations: store registration, pickup location, order follow-up, delivery status, COD tracking and settlement follow-up depending on the Delivery Company setup. Trader registration is the first step if they want Tawseelhub to review their details and connect them to a suitable delivery service. Would you like me to explain registration or order follow-up after registration?";
    if (/manage .*drivers|manage my drivers|drivers|driver management|fleet/.test(lower)) return "Yes. Tawseelhub supports Delivery Company driver operations such as keeping driver records, assigning orders, following delivery progress, and connecting driver activity to collections and reports. If you have 20 drivers, the main value is seeing orders, drivers and COD in one operating view.";
    if (/accounting|journal|financial/.test(lower)) return "Yes. Tawseelhub includes accounting-oriented records and reporting for delivery operations, so operational activity such as COD, collections and settlements can be followed more clearly. It is part of the operating system, not a separate public accounting product.";
    if (/payroll|salary|earning/.test(lower)) return "Yes. Payroll support is included for driver/employee compensation workflows in the delivery operating system. It should be used with the configured company rules rather than treated as a public standalone payroll app.";
    if (/manage traders|trader relationship|traders/.test(lower)) return "Yes. Delivery Companies can manage Trader relationships in Tawseelhub, including Trader profiles, orders, COD balances, statements and settlement follow-up. I won’t expose private Trader names publicly, but the platform can organize your own Trader base.";
    if (/report|reports|statement/.test(lower)) return "Tawseelhub provides operational reports around orders, drivers, COD collections, Trader statements, settlements and delivery performance. The exact report set depends on what your company has configured.";
    if (/mobile app|driver app|apps/.test(lower)) return "Mobile app workflows are part of the Tawseelhub operating model for field and customer-facing use. Core delivery operations are live in the platform; specific mobile app modules should be treated as app-enabled workflows unless your Tawseelhub configuration confirms that module is live.";
    if (/shopify/.test(lower)) return "Shopify integration is planned, not live yet. The goal is for Traders to keep Shopify while delivery orders flow into Tawseelhub and then to their Delivery Company. Are you asking as a Trader or a Delivery Company?";
    if (/salla/.test(lower)) return "Salla integration is planned, not live yet. The goal is for Traders to keep their Salla store while delivery orders flow into Tawseelhub. Do you already operate a Salla store?";
    if (/woocommerce/.test(lower)) return "WooCommerce integration is planned, not live yet. It is intended to connect store orders into Tawseelhub delivery workflows. Are you asking from the Trader side or Delivery Company side?";
    if (/storefront|build a store|create a store/.test(lower)) return "A Tawseelhub Storefront concept is part of the roadmap, but it is currently on hold while Tawseelhub focuses on the Delivery Operating System, customer quote service, Trader onboarding and planned commerce integrations. Do you already have an online store today?";
    if (/customers.*shop|shop on tawseelhub|sell products through tawseelhub/.test(lower)) return "Customer shopping through Tawseelhub is not live as a public marketplace. Trader commerce and Storefront capabilities exist as a foundation/roadmap area, while public customer shopping should not be described as live.";
    const base = knowledge[0]?.content ?? "I do not have confirmed information about that yet.";
    if (state.audience === "delivery_company") return `${base} Which part of your delivery operation are you trying to improve first?`;
    if (state.audience === "trader") return `${base} Are you already working with a Delivery Company, or are you looking for one?`;
    return `${base} Are you looking at Tawseelhub for a Delivery Company, as a Trader, or because you need to send a package?`;
  }

  private conversationSummary(state: AgentState): string {
    return JSON.stringify({
      audience: state.audience ?? "unknown",
      discussedTopics: state.discussedTopics ?? [],
      knownSlots: this.redactSlots(state.slots),
    });
  }

  private guardPublicReply(text: string, language: AgentLanguage, fallback: () => string): string {
    const unsafe = /(api[_ -]?key|company[_ -]?id|commission|company net|net amount|marketplace priority|internal pricing|delivery company directory|show.*delivery companies|15\s*%)/i;
    let trimmed = text.trim();
    if (!trimmed || trimmed.length > 1800 || unsafe.test(trimmed)) return fallback();
    if (language === "ar" && isCorruptedArabicText(trimmed)) return arabicGeneralFallback;
    if (language === "ar") {
      trimmed = trimmed
        .replace(/^(?:مرحباً|أهلاً|اهلاً|هلا|Hi|Hello)?\s*[—–-]?\s*أنا\s+(?:يوسف|يوسُف|Yousef)[،,\s-]*(?:مساعد\s+)?(?:Tawseelhub|توصيلهَب|توصيلهب)?(?:\s*(?:AI|بالذكاء الاصطناعي|الآلي|Assistant|مساعد))?[.،,\s-]*/i, "")
        .replace(/^(?:مرحباً|أهلاً|اهلاً|هلا|Hi|Hello)\s*[—–-]\s*(?:يوسف|Yousef)\s*(?:هنا|here)?[.،,\s-]*/i, "")
        .replace(/توصيلهَب|توصيلهب|توصيل هب/g, "Tawseelhub")
        .trim();
    } else {
      trimmed = trimmed
        .replace(/^(?:Hi|Hello|Hey)\s*[—–-]\s*Yousef\s+here[.!,\s-]*/i, "")
        .replace(/^I(?:'m| am)\s+Yousef[,\s-]*(?:Tawseelhub\s+)?(?:AI\s+)?Assistant\.?\s*/i, "")
        .trim();
    }
    return trimmed;
  }

  private enforceSingleQuestion(text: string): string {
    const firstQuestionIndex = text.search(/[?؟]/);
    if (firstQuestionIndex < 0) return text;
    const afterFirstQuestion = text.slice(firstQuestionIndex + 1);
    if (!/[?؟]/.test(afterFirstQuestion)) return text;
    return text.slice(0, firstQuestionIndex + 1).trim();
  }

  private requesterType(intent: AgentIntent) {
    if (intent === "customer_quote") return "customer";
    if (intent === "trader") return "trader";
    if (intent === "delivery_company_demo") return "delivery_company";
    return "unknown";
  }

  private quoteSummary(slots: AgentSlots) {
    return compact({
      Pickup: `${slots.pickupArea}, ${this.publicEmirateLabel(slots.pickupEmirate, "en")}`,
      Delivery: `${slots.deliveryArea}, ${this.publicEmirateLabel(slots.deliveryEmirate, "en")}`,
      Package: publicAgentLabel(this.normalizePackageType(String(slots.packageType ?? ""))),
      Weight: `${slots.weightKg} kg`,
      Service: publicAgentLabel(slots.requestedServiceType ?? "standard"),
      COD: slots.codRequired ? `Yes, AED ${slots.codAmount ?? 0}` : "No",
      "Pickup date": slots.pickupDate,
      ...(slots.deliveryAddress ? { "Delivery address": slots.deliveryAddress } : {}),
    });
  }

  private lines(input: Record<string, unknown>) {
    return Object.entries(input).map(([key, value]) => `${key}: ${String(value)}`).join("\n");
  }

  private redactSlots(slots: AgentSlots) {
    const { requesterMobile, recipientMobile, mobileNumber, mobile, email, requesterEmail, ...safe } = slots;
    return safe;
  }
}
