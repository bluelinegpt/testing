export type AgentChannel =
  "website" | "whatsapp" | "simulator" | "platform_staff" | "public_form" | "system";
export type AgentLanguage = "en" | "ar";
export type AgentIntent =
  | "greeting"
  | "small_talk"
  | "thanks"
  | "goodbye"
  | "customer_quote"
  | "trader"
  | "delivery_company_demo"
  | "shipment_tracking"
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
  trackingAirwayBill?: string;
  trackingMobileNumber?: string;
}

export interface AgentState {
  slots: AgentSlots;
  audience?: "delivery_company" | "trader" | "customer" | "unknown";
  discussedTopics?: string[];
  lastBusinessIntent?: AgentIntent;
  conversationFrame?: ConversationFrame;
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
  pendingGeneralFollowUp?:
    "public_explanation" | "feature_choice" | "trader_registration_explained";
  pendingAction?: {
    type:
      | "calculate_customer_quote"
      | "submit_trader_application"
      | "submit_demo_request"
      | "create_handoff";
    summary: Record<string, unknown>;
  };
  lastAskedSlot?: keyof AgentSlots;
  seenInboundMessageIds?: string[];
  /**
   * Temporary, self-expiring context for the shipment-tracking workflow
   * only. Never persisted beyond the tracking flow itself: cleared on
   * success, on a wrong-mobile failure, on timeout (see
   * `TRACKING_CONTEXT_TTL_MS` in `agent.service.ts`), or when a different
   * workflow starts. `verificationToken` is the same short-lived, opaque,
   * HMAC-signed token `PublicTrackingService` issues -- not customer data,
   * safe to hold in conversation state.
   */
  tracking?: {
    verificationToken?: string;
    result?: {
      airwayBill: string;
      status: string;
      statusLabel: string;
      lastUpdated: string;
      deliveredAt: string | null;
    };
    failedMobileAttempts?: number;
    startedAt?: string;
    /**
     * Set once we've auto-tried the mobile number the customer already gave
     * earlier in this same conversation (their own contact mobile) against
     * an ambiguous shipment match, so we never ask them to repeat a number
     * they already told us -- only if that attempt fails do we ask them to
     * confirm or provide a different one.
     */
    autoMobileAttempted?: boolean;
  };
}

export type ConversationMode = "conversation" | "workflow" | "human_handoff";
export type WorkflowState = "inactive" | "active" | "paused" | "cancelled" | "completed";
export type UserAction =
  | "explain"
  | "start"
  | "continue"
  | "cancel"
  | "pause"
  | "switch_topic"
  | "clarify"
  | "handoff"
  | "unknown";
export type ConversationTopic =
  | "general"
  | "delivery_company"
  | "trader"
  | "send_package"
  | "pricing"
  | "drivers"
  | "cod"
  | "reconciliation"
  | "settlement"
  | "accounting"
  | "payroll"
  | "reports"
  | "integrations"
  | "stores"
  | "mobile"
  | "tracking"
  | "support"
  | "privacy"
  | "other";

export interface ConversationFrame {
  mode: ConversationMode;
  topic: ConversationTopic;
  workflow:
    | "none"
    | "shipment_quote"
    | "trader_registration"
    | "demo_request"
    | "shipment_tracking"
    | "human_handoff"
    | string;
  workflowState: WorkflowState;
  lastExplicitUserAction: UserAction;
  decision: string;
  reason: string;
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
