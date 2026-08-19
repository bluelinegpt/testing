export type AgentChannel = "website" | "whatsapp" | "simulator" | "platform_staff" | "public_form" | "system";
export type AgentLanguage = "en" | "ar";
export type AgentIntent =
  | "greeting"
  | "small_talk"
  | "thanks"
  | "goodbye"
  | "customer_quote"
  | "trader"
  | "delivery_company_demo"
  | "general_question"
  | "product_feature_question"
  | "current_feature_status"
  | "clarification"
  | "handoff"
  | "unknown";

export type AgentProviderType = "openai" | "deterministic" | "unconfigured";

export interface AgentSlots {
  pickupEmirate?: string;
  pickupArea?: string;
  deliveryEmirate?: string;
  deliveryArea?: string;
  packageType?: string;
  description?: string;
  weightKg?: number;
  quantity?: number;
  requestedServiceType?: string;
  pickupDate?: string;
  codRequired?: boolean;
  codAmount?: number;
  requesterName?: string;
  requesterMobile?: string;
  requesterEmail?: string;
  pickupAddress?: string;
  deliveryAddress?: string;
  recipientName?: string;
  recipientMobile?: string;
  storeName?: string;
  contactPerson?: string;
  mobileNumber?: string;
  email?: string;
  primaryCategory?: string;
  pickupBusinessArea?: string;
  monthlyOrderRange?: string;
  deliveryEmirates?: string[];
  paymentMix?: string;
  hasExistingDeliveryCompany?: boolean;
  existingDeliveryCompanyName?: string;
  channels?: Array<{ type: string; url?: string; handle?: string }>;
  companyName?: string;
  emirate?: string;
  approximateDriverCount?: number;
  approximateMonthlyOrders?: number;
  approximateTraderCount?: number;
  currentSystem?: string;
  preferredContactMethod?: string;
  mainChallenges?: string;
  featuresOfInterest?: string[];
  contactName?: string;
  mobile?: string;
}

export interface AgentState {
  slots: AgentSlots;
  audience?: "delivery_company" | "trader" | "customer" | "unknown";
  discussedTopics?: string[];
  lastBusinessIntent?: AgentIntent;
  historicalContext?: {
    latestReference?: string;
    latestStatus?: string;
  };
  returningRequestDecision?: "pending";
  existingRequest?: {
    reference: string;
    status: string;
  };
  deliveryAddressSkipped?: boolean;
  pendingAction?: {
    type: "calculate_customer_quote" | "submit_trader_application" | "submit_demo_request" | "create_handoff";
    summary: Record<string, unknown>;
  };
  lastAskedSlot?: keyof AgentSlots;
  seenInboundMessageIds?: string[];
}

export interface AgentModelInput {
  text: string;
  language: AgentLanguage;
  previousIntent: AgentIntent;
  state: AgentState;
}

export interface AgentModelResult {
  intent: AgentIntent;
  language: AgentLanguage;
  extracted: AgentSlots;
  wantsConfirmation: boolean;
  wantsCorrection: boolean;
}

export interface AgentModelProvider {
  classifyAndExtract(input: AgentModelInput): Promise<AgentModelResult>;
}

export interface AgentProviderDiagnostics {
  providerType: AgentProviderType;
  configured: boolean;
  model: string;
}

export interface AgentKnowledgeContext {
  title: string;
  content: string;
  category: string;
  audience: "public" | "delivery_company" | "trader" | "customer" | "all";
  featureStatus: "live" | "planned" | "on_hold" | "future" | "internal_only" | "informational";
  visibility: "public_agent" | "internal_only";
}

export interface AgentReplyInput {
  text: string;
  language: AgentLanguage;
  intent: AgentIntent;
  audience: NonNullable<AgentState["audience"]>;
  previousIntent: AgentIntent;
  conversationSummary: string;
  knowledge: AgentKnowledgeContext[];
}
