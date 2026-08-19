import { Injectable } from "@nestjs/common";
import OpenAI from "openai";
import { tawseelhubAgentInstructions } from "./agent-instructions.js";
import type { AgentModelInput, AgentModelProvider, AgentModelResult, AgentReplyInput, AgentSlots } from "./agent.types.js";

const defaultModel = "gpt-5-mini";
const allowedIntents = ["greeting", "small_talk", "thanks", "goodbye", "customer_quote", "trader", "delivery_company_demo", "general_question", "product_feature_question", "current_feature_status", "clarification", "handoff", "unknown"] as const;
const allowedLanguages = ["en", "ar"] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sanitizeSlots(value: unknown): AgentSlots {
  const input = asRecord(value);
  const slots: AgentSlots = {};
  for (const key of [
    "pickupEmirate","pickupArea","deliveryEmirate","deliveryArea","packageType","description","requestedServiceType","pickupDate","requesterName","requesterMobile","requesterEmail","pickupAddress","deliveryAddress","recipientName","recipientMobile","storeName","contactPerson","mobileNumber","email","primaryCategory","pickupBusinessArea","monthlyOrderRange","paymentMix","existingDeliveryCompanyName","companyName","emirate","currentSystem","preferredContactMethod","mainChallenges","contactName","mobile",
  ] as const) {
    if (typeof input[key] === "string" && input[key].trim().length > 0) slots[key] = input[key].trim();
  }
  for (const key of ["weightKg","quantity","codAmount","approximateDriverCount","approximateMonthlyOrders","approximateTraderCount"] as const) {
    if (typeof input[key] === "number" && Number.isFinite(input[key])) slots[key] = input[key];
  }
  if (typeof input.codRequired === "boolean") slots.codRequired = input.codRequired;
  if (typeof input.hasExistingDeliveryCompany === "boolean") slots.hasExistingDeliveryCompany = input.hasExistingDeliveryCompany;
  if (Array.isArray(input.deliveryEmirates)) slots.deliveryEmirates = input.deliveryEmirates.filter((item): item is string => typeof item === "string");
  if (Array.isArray(input.featuresOfInterest)) slots.featuresOfInterest = input.featuresOfInterest.filter((item): item is string => typeof item === "string");
  if (Array.isArray(input.channels)) {
    slots.channels = input.channels.flatMap((item) => {
      const record = asRecord(item);
      return typeof record.type === "string" ? [{ type: record.type, ...(typeof record.url === "string" ? { url: record.url } : {}), ...(typeof record.handle === "string" ? { handle: record.handle } : {}) }] : [];
    });
  }
  return slots;
}

@Injectable()
export class OpenAIModelProvider implements AgentModelProvider {
  private readonly apiKey = process.env.OPENAI_API_KEY?.trim();
  private readonly model = process.env.OPENAI_AGENT_MODEL?.trim() || defaultModel;
  private readonly client = this.apiKey ? new OpenAI({ apiKey: this.apiKey }) : null;

  public configured(): boolean {
    return this.client !== null;
  }

  public modelName(): string {
    return this.model;
  }

  public async classifyAndExtract(input: AgentModelInput): Promise<AgentModelResult> {
    if (!this.client) throw new Error("openai_not_configured");
    const response = await this.client.responses.create({
      instructions: tawseelhubAgentInstructions(),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                task: "Classify Tawseelhub visitor intent and extract only explicitly supplied structured fields.",
                userMessage: input.text,
                language: input.language,
                previousIntent: input.previousIntent,
                audience: input.state.audience ?? "unknown",
                discussedTopics: input.state.discussedTopics ?? [],
                knownSlots: input.state.slots,
                pendingActionType: input.state.pendingAction?.type ?? null,
              }),
            },
          ],
        },
      ],
      max_output_tokens: 1500,
      model: this.model,
      reasoning: { effort: "minimal" },
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "tawseelhub_agent_extraction",
          strict: true,
          schema: {
            additionalProperties: false,
            properties: {
              intent: { enum: allowedIntents, type: "string" },
              language: { enum: allowedLanguages, type: "string" },
              extracted: {
                additionalProperties: false,
                properties: {
                  pickupEmirate: { type: ["string", "null"] },
                  pickupArea: { type: ["string", "null"] },
                  deliveryEmirate: { type: ["string", "null"] },
                  deliveryArea: { type: ["string", "null"] },
                  packageType: { type: ["string", "null"] },
                  description: { type: ["string", "null"] },
                  weightKg: { type: ["number", "null"] },
                  quantity: { type: ["number", "null"] },
                  requestedServiceType: { type: ["string", "null"] },
                  pickupDate: { type: ["string", "null"] },
                  codRequired: { type: ["boolean", "null"] },
                  codAmount: { type: ["number", "null"] },
                  requesterName: { type: ["string", "null"] },
                  requesterMobile: { type: ["string", "null"] },
                  requesterEmail: { type: ["string", "null"] },
                  pickupAddress: { type: ["string", "null"] },
                  deliveryAddress: { type: ["string", "null"] },
                  recipientName: { type: ["string", "null"] },
                  recipientMobile: { type: ["string", "null"] },
                  storeName: { type: ["string", "null"] },
                  contactPerson: { type: ["string", "null"] },
                  mobileNumber: { type: ["string", "null"] },
                  email: { type: ["string", "null"] },
                  primaryCategory: { type: ["string", "null"] },
                  pickupBusinessArea: { type: ["string", "null"] },
                  monthlyOrderRange: { type: ["string", "null"] },
                  deliveryEmirates: { items: { type: "string" }, type: ["array", "null"] },
                  paymentMix: { type: ["string", "null"] },
                  hasExistingDeliveryCompany: { type: ["boolean", "null"] },
                  existingDeliveryCompanyName: { type: ["string", "null"] },
                  channels: {
                    items: {
                      additionalProperties: false,
                      properties: { type: { type: "string" }, url: { type: ["string", "null"] }, handle: { type: ["string", "null"] } },
                      required: ["type", "url", "handle"],
                      type: "object",
                    },
                    type: ["array", "null"],
                  },
                  companyName: { type: ["string", "null"] },
                  emirate: { type: ["string", "null"] },
                  approximateDriverCount: { type: ["number", "null"] },
                  approximateMonthlyOrders: { type: ["number", "null"] },
                  approximateTraderCount: { type: ["number", "null"] },
                  currentSystem: { type: ["string", "null"] },
                  preferredContactMethod: { type: ["string", "null"] },
                  mainChallenges: { type: ["string", "null"] },
                  featuresOfInterest: { items: { type: "string" }, type: ["array", "null"] },
                  contactName: { type: ["string", "null"] },
                  mobile: { type: ["string", "null"] },
                },
                required: [
                  "pickupEmirate","pickupArea","deliveryEmirate","deliveryArea","packageType","description","weightKg","quantity","requestedServiceType","pickupDate","codRequired","codAmount","requesterName","requesterMobile","requesterEmail","pickupAddress","deliveryAddress","recipientName","recipientMobile","storeName","contactPerson","mobileNumber","email","primaryCategory","pickupBusinessArea","monthlyOrderRange","deliveryEmirates","paymentMix","hasExistingDeliveryCompany","existingDeliveryCompanyName","channels","companyName","emirate","approximateDriverCount","approximateMonthlyOrders","approximateTraderCount","currentSystem","preferredContactMethod","mainChallenges","featuresOfInterest","contactName","mobile",
                ],
                type: "object",
              },
              wantsConfirmation: { type: "boolean" },
              wantsCorrection: { type: "boolean" },
            },
            required: ["intent", "language", "extracted", "wantsConfirmation", "wantsCorrection"],
            type: "object",
          },
        },
      },
    } as any);
    const text = response.output_text?.trim();
    if (!text) {
      const error = new Error("openai_empty_output");
      (error as { code?: string }).code = "openai_empty_output";
      throw error;
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const intent = allowedIntents.includes(parsed.intent as any) ? parsed.intent as AgentModelResult["intent"] : "unknown";
    const language = allowedLanguages.includes(parsed.language as any) ? parsed.language as AgentModelResult["language"] : input.language;
    return {
      extracted: sanitizeSlots(parsed.extracted),
      intent,
      language,
      wantsConfirmation: parsed.wantsConfirmation === true,
      wantsCorrection: parsed.wantsCorrection === true,
    };
  }

  public async generateReply(input: AgentReplyInput): Promise<string> {
    if (!this.client) throw new Error("openai_not_configured");
    const response = await this.client.responses.create({
      instructions: [
        tawseelhubAgentInstructions().replace("Output JSON only. Return only the requested structured JSON. Do not include markdown or additional prose outside the JSON object.", ""),
        "You are writing the customer-visible chat reply as Yousef.",
        "Answer naturally and concisely. Do not use markdown tables. Do not mention internal implementation details.",
        "It is enough to identify yourself as Yousef or Tawseelhub AI Assistant briefly. Avoid repeating a heavy 'not human employee' disclaimer unless asked.",
        "Use only the supplied approved knowledge. If the knowledge does not support the answer, say you do not have confirmed information.",
        "Do not disclose internal-only commercial information, delivery company lists, commissions, company net amounts, company IDs, internal pricing, marketplace priority, API keys, or private admin data.",
        "For greetings, thanks and goodbyes, respond socially and do not force a sales question.",
        "Do not offer a human handoff unless the visitor explicitly asks to speak with Tawseelhub, support, the team, or a human.",
        "For meaningful business answers, ask at most one follow-up question. Never give a list of questions for the visitor to answer.",
      ].join("\n"),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                task: "Write the next Tawseelhub website-chat reply.",
                language: input.language,
                visitorMessage: input.text,
                intent: input.intent,
                audience: input.audience,
                previousIntent: input.previousIntent,
                conversationSummary: input.conversationSummary,
                approvedKnowledge: input.knowledge,
              }),
            },
          ],
        },
      ],
      max_output_tokens: 700,
      model: this.model,
      reasoning: { effort: "minimal" },
      store: false,
    } as any);
    const text = response.output_text?.trim();
    if (!text) {
      const error = new Error("openai_empty_reply");
      (error as { code?: string }).code = "openai_empty_reply";
      throw error;
    }
    return text;
  }
}

export const OPENAI_AGENT_DEFAULT_MODEL = defaultModel;
