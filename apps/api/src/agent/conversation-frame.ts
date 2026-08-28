import type { AgentIntent, AgentState, ConversationFrame, ConversationTopic } from "./agent.types.js";

const workflowIntentToFrame: Partial<Record<AgentIntent, ConversationFrame["workflow"]>> = {
  customer_quote: "shipment_quote",
  delivery_company_demo: "demo_request",
  handoff: "human_handoff",
  shipment_tracking: "shipment_tracking",
  trader: "trader_registration",
};

const workflowToIntent: Partial<Record<ConversationFrame["workflow"], AgentIntent>> = {
  demo_request: "delivery_company_demo",
  human_handoff: "handoff",
  shipment_quote: "customer_quote",
  shipment_tracking: "shipment_tracking",
  trader_registration: "trader",
};

const topicPatterns: Array<{ topic: ConversationTopic; pattern: RegExp }> = [
  { topic: "pricing", pattern: /price|pricing|cost|rate|charge|fee|fees|كم السعر|السعر|الأسعار|تكلفة|بكم|رسوم|اشتراك/i },
  { topic: "drivers", pattern: /driver|drivers|fleet|إدارة السائقين|ادارة السائقين|السائقين|المندوبين|سائق/i },
  { topic: "cod", pattern: /cod|cash on delivery|collection|collections|تحصيل|الدفع عند الاستلام/i },
  { topic: "settlement", pattern: /settlement|settlements|تسوية|تسويات|مستحقات/i },
  { topic: "reconciliation", pattern: /reconciliation|مطابقة|عهدة/i },
  { topic: "accounting", pattern: /accounting|journal|financial|محاسبة|حسابات/i },
  { topic: "payroll", pattern: /payroll|salary|earnings|رواتب|راتب/i },
  { topic: "reports", pattern: /reports?|statement|dashboard|تقارير|تقرير|كشف/i },
  { topic: "integrations", pattern: /integration|integrations|salla|shopify|woocommerce|تكامل|سلة|شوبيفاي|ووكومرس/i },
  { topic: "stores", pattern: /storefront|marketplace|create a store|build a store|متجر|متاجر/i },
  { topic: "mobile", pattern: /mobile app|driver app|app|تطبيق|موبايل/i },
  { topic: "tracking", pattern: /\btrack(?:ing)?\b|where(?:'s| is) my (?:shipment|order|package|parcel)|shipment status|tracking number|تتبع|تعقب|رقم التتبع|حالة الشحنة|حالة شحنتي|أين شحنتي|وين شحنتي/i },
  { topic: "trader", pattern: /\btraders?\b|\bmerchant\b|\bseller\b|التاجر|التجار|تاجر|تجار/i },
  { topic: "delivery_company", pattern: /delivery company|delivery companies|courier company|شركة توصيل|شركات التوصيل/i },
  { topic: "send_package", pattern: /shipment|package|parcel|send a package|send shipment|شحنة|طرد|إرسال شحنة|ارسال شحنة/i },
  { topic: "support", pattern: /support|help|human|agent|call me|موظف|دعم|اتصل/i },
];

const bareTopicPattern = /^(?:traders?|merchants?|sellers?|delivery compan(?:y|ies)|drivers?|driver management|pricing|price|accounting|payroll|shipment|package|mobile app|salla|shopify|woocommerce|tracking|track|التجار|التاجر|السائقين|إدارة السائقين|ادارة السائقين|السعر|الأسعار|المحاسبة|الرواتب|شركة توصيل|شركات التوصيل|الشحن|الشحنة|المتجر|المتاجر|سلة|شوبيفاي|ووكومرس|تتبع|تعقب)$/i;
const humanPattern = /human|person|agent|support team|customer support|call me|speak|complaint|dispute|موظف|انسان|إنسان|اتصل|دعم بشري/i;
const cancelPattern = /^(?:cancel|stop|never mind|start over|reset|no request|no order|just explain|explain only|الغاء|إلغاء|وقف|خلاص|ابدأ من جديد|ابدا من جديد|لا يوجد طلب|لايوجد طلب|ما في طلب|اشرح فقط|فقط اشرح|انت فقط اشرح|أنت فقط اشرح)$/i;
const pauseForExplanationPattern = /(?:actually|instead|just|only).*(?:explain|tell me|how|what)|(?:اشرح|وضح|فهمني|بس اشرح|فقط اشرح|كيف|ما هو|شو هو|ماهي|ما هي)/i;
const clarificationPattern = /^(?:why|why\?|for what|what for|what do you mean|is it required|for pickup or delivery|pickup or delivery|ليش|لماذا|لشو|شو تقصد|هل هو مطلوب|استلام ولا توصيل)[؟?]?$/i;
const explicitShipmentStartPattern = /(?:i want|need|start|create|get|request|send).*(?:package|parcel|shipment|quote|delivery quote)|(?:أريد|اريد|بدي|أحتاج|احتاج|ابدأ|ابدا|اعمل).*(?:إرسال شحنة|ارسال شحنة|شحنة|طرد|عرض سعر|سعر توصيل)/i;
// Deliberately distinct verbs from `explicitShipmentStartPattern` ("track"/"check"/"where is",
// not "send"/"get a quote") so a customer who already has an Airway Bill and a Trader
// requesting a NEW delivery quote can never be confused for one another.
const explicitTrackingStartPattern = /(?:track|check|find)\s+(?:my\s+)?(?:shipment|order|package|parcel)|where(?:'s| is)\s+my\s+(?:shipment|order|package|parcel)|track(?:ing)?\s+(?:my\s+)?(?:number|status)|(?:تتبع|تعقب|أعرف|اعرف).*(?:شحنتي|شحنة|طردي|طلبي)/i;
const explicitTraderStartPattern = /(?:register|start|submit|apply).*(?:trader|store|merchant)|(?:أريد|اريد|سجل|سجّل|ابدأ|ابدا).*(?:التسجيل كتاجر|تسجيل تاجر|تسجيل متجري|متجري)/i;
const explicitDemoStartPattern = /(?:book|request|schedule|start).*(?:demo|demonstration)|(?:أريد|اريد|احجز|اطلب).*(?:ديمو|عرض تجريبي)/i;
const explicitContinuePattern = /^(?:continue|resume|go on|same request|continue my shipment|continue registration|تابع|كمل|اكمل|نفس الطلب)$/i;
const privateInformationPattern = /delivery compan(?:y|ies) (?:names?|directory|list)|names? of delivery companies|which traders|traders .*using|another customer|customer'?s (?:information|conversation|mobile|phone|number|address|name)|receiver'?s (?:mobile|phone|number|address|name)|driver'?s (?:mobile|phone|number)|internal id|internal order|order id|commission|company net|staff notes|secret|password|api key|cod amount|service fee|أسماء شركات التوصيل|قائمة شركات التوصيل|شركات التوصيل المسجلة|أي تجار|معلومات عميل|محادثة عميل|رقم (?:هاتف|جوال|موبايل) (?:العميل|الزبون|المستلم|السائق)|عنوان العميل|اسم العميل|عمولة|صافي الشركة|ملاحظات داخلية|كلمة السر|مفتاح/i;

export interface ConversationFrameInput {
  message: string;
  currentIntent?: AgentIntent;
  state: AgentState;
}

export function agentIntentFromWorkflow(workflow: ConversationFrame["workflow"]): AgentIntent | undefined {
  return workflowToIntent[workflow];
}

export function topicForMessage(message: string): ConversationTopic {
  const text = message.trim();
  for (const item of topicPatterns) if (item.pattern.test(text)) return item.topic;
  return text ? "general" : "other";
}

export function isPrivateInformationRequest(message: string): boolean {
  return privateInformationPattern.test(message);
}

export function isBareInformationalTopic(message: string): boolean {
  return bareTopicPattern.test(message.trim());
}

export function isExplicitWorkflowStart(message: string): ConversationFrame["workflow"] | undefined {
  if (explicitTraderStartPattern.test(message)) return "trader_registration";
  if (explicitDemoStartPattern.test(message)) return "demo_request";
  if (explicitTrackingStartPattern.test(message)) return "shipment_tracking";
  if (explicitShipmentStartPattern.test(message)) return "shipment_quote";
  return undefined;
}

export function decideNextFrame(input: ConversationFrameInput): ConversationFrame {
  const message = input.message.trim();
  const currentFrame = input.state.conversationFrame;
  const currentWorkflow = currentFrame?.workflow && currentFrame.workflow !== "none"
    ? currentFrame.workflow
    : workflowIntentToFrame[input.state.lastBusinessIntent ?? "unknown"] ?? "none";
  const topic = topicForMessage(message);

  if (humanPattern.test(message)) {
    return {
      decision: "human_handoff",
      lastExplicitUserAction: "handoff",
      mode: "human_handoff",
      reason: "User explicitly asked for a human or support.",
      topic: "support",
      workflow: "human_handoff",
      workflowState: "active",
    };
  }

  if (isPrivateInformationRequest(message)) {
    return {
      decision: "privacy_blocked",
      lastExplicitUserAction: "explain",
      mode: "conversation",
      reason: "User asked for private company, trader, customer, financial or secret information.",
      topic: "privacy",
      workflow: "none",
      workflowState: "inactive",
    };
  }

  if (cancelPattern.test(message)) {
    return {
      decision: "workflow_cancelled",
      lastExplicitUserAction: "cancel",
      mode: "conversation",
      reason: "User explicitly cancelled or asked to only explain.",
      topic,
      workflow: currentWorkflow,
      workflowState: "cancelled",
    };
  }

  const explicitWorkflow = isExplicitWorkflowStart(message);
  if (explicitWorkflow) {
    return {
      decision: "explicit_workflow_start",
      lastExplicitUserAction: "start",
      mode: explicitWorkflow === "human_handoff" ? "human_handoff" : "workflow",
      reason: "User used an explicit action signal to start a business workflow.",
      topic,
      workflow: explicitWorkflow,
      workflowState: "active",
    };
  }

  if (explicitContinuePattern.test(message) && currentWorkflow !== "none") {
    return {
      decision: "workflow_continue",
      lastExplicitUserAction: "continue",
      mode: "workflow",
      reason: "User explicitly asked to continue the active or paused workflow.",
      topic,
      workflow: currentWorkflow,
      workflowState: "active",
    };
  }

  if (clarificationPattern.test(message)) {
    return {
      decision: "clarification_preserve_slot",
      lastExplicitUserAction: "clarify",
      mode: input.state.lastAskedSlot ? "workflow" : "conversation",
      reason: "User asked a clarification question; preserve current slot if one exists.",
      topic,
      workflow: currentWorkflow,
      workflowState: input.state.lastAskedSlot ? "active" : "inactive",
    };
  }

  if ((input.state.lastAskedSlot || currentWorkflow !== "none") && pauseForExplanationPattern.test(message) && /[?؟]|explain|اشرح|وضح|كيف|ما|شو/i.test(message)) {
    return {
      decision: "workflow_paused_for_explanation",
      lastExplicitUserAction: "pause",
      mode: "conversation",
      reason: "User asked for explanation while a workflow had active state.",
      topic,
      workflow: currentWorkflow,
      workflowState: "paused",
    };
  }

  if (isBareInformationalTopic(message)) {
    return {
      decision: "bare_topic_information",
      lastExplicitUserAction: "explain",
      mode: "conversation",
      reason: "Bare topic words are informational and must not start workflows.",
      topic,
      workflow: "none",
      workflowState: "inactive",
    };
  }

  if (input.state.lastAskedSlot && currentWorkflow !== "none") {
    return {
      decision: "current_workflow_slot_response",
      lastExplicitUserAction: "continue",
      mode: "workflow",
      reason: "The user appears to be answering the current workflow slot.",
      topic,
      workflow: currentWorkflow,
      workflowState: "active",
    };
  }

  return {
    decision: "informational_topic",
    lastExplicitUserAction: "explain",
    mode: "conversation",
    reason: "No explicit workflow signal was detected.",
    topic,
    workflow: "none",
    workflowState: "inactive",
  };
}

export function stateWithFrame(state: AgentState, frame: ConversationFrame): AgentState {
  return { ...state, conversationFrame: frame };
}
