import { Injectable } from "@nestjs/common";
import type { AgentIntent, AgentLanguage, AgentModelInput, AgentModelProvider, AgentModelResult, AgentSlots } from "./agent.types.js";

const emirateAliases: Record<string, string> = {
  "abu dhabi": "abu_dhabi",
  abudhabi: "abu_dhabi",
  "أبو ظبي": "abu_dhabi",
  "أبوظبي": "abu_dhabi",
  "ابو ظبي": "abu_dhabi",
  "ابوظبي": "abu_dhabi",
  dubai: "dubai",
  "دبي": "dubai",
  sharjah: "sharjah",
  "الشارقة": "sharjah",
  "شارقة": "sharjah",
  ajman: "ajman",
  "عجمان": "ajman",
  "umm al quwain": "umm_al_quwain",
  ummalquwain: "umm_al_quwain",
  "أم القيوين": "umm_al_quwain",
  "ام القيوين": "umm_al_quwain",
  rak: "ras_al_khaimah",
  "ras al khaimah": "ras_al_khaimah",
  "رأس الخيمة": "ras_al_khaimah",
  "راس الخيمة": "ras_al_khaimah",
  fujairah: "fujairah",
  "الفجيرة": "fujairah",
  "فجيرة": "fujairah",
};

const integrationChannels = ["salla", "shopify", "woocommerce", "instagram", "facebook", "tiktok", "whatsapp"] as const;

function normalizeDate(text: string): string | undefined {
  const lower = text.toLowerCase();
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Dubai",
    year: "numeric",
  }).formatToParts(new Date());
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  const date = new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
  if (/\btomorrow\b|غدا|بكرة/.test(lower)) date.setUTCDate(date.getUTCDate() + 1);
  else if (/\btoday\b|اليوم/.test(lower)) date.setUTCDate(date.getUTCDate());
  else return undefined;
  return date.toISOString().slice(0, 10);
}

function detectLanguage(text: string, fallback: AgentLanguage): AgentLanguage {
  return /[\u0600-\u06ff]/.test(text) ? "ar" : fallback;
}

function detectIntent(text: string, previous: AgentIntent): AgentIntent {
  const lower = text.toLowerCase();
  const isShortContinuation = text.trim().length <= 40 && !/[?؟]/.test(text);
  const continuableIntents = new Set<AgentIntent>(["customer_quote", "trader", "delivery_company_demo", "handoff"]);
  if (/^(hi|hello|hey|good morning|good afternoon|good evening|مرحبا|هلا|السلام عليكم)\W*$/i.test(lower)) return "greeting";
  if (/^(how are you|how is everything|كيف الحال|شلونك|كيفك)\W*$/i.test(lower)) return "small_talk";
  if (/^(thank you|thanks|thx|nice|great|okay|ok|شكرا|مشكور|تمام)\W*$/i.test(lower)) return "thanks";
  if (/^(bye|goodbye|see you|مع السلامة|باي)\W*$/i.test(lower)) return "goodbye";
  if (/show me .*delivery companies|names? of delivery companies|delivery companies registered|registered .*delivery companies|delivery compan(?:y|ies) directory|company directory|which traders|traders .*using|another customer|customer.?s information|أسماء شركات التوصيل|شركات التوصيل المسجلة|أي تجار|معلومات عميل|محادثة عميل|commissions|commission/i.test(lower)) return "general_question";
  if (/human|person|agent|support team|customer support|call me|speak|complaint|dispute|موظف|انسان|اتصل/.test(lower)) return "handoff";
  if (/is .* live|currently live|available now|status|planned|on hold|roadmap|support .*shopify|support .*salla|support .*woocommerce|create a store|build a store|storefront|هل .*متاح|هل .*مباشر|هل .*شغال|شغال حال|جاهز/.test(lower)) return "current_feature_status";
  if (/request .*demo|book .*demo|delivery company demo|demo request|عرض تجريبي/.test(lower)) return "delivery_company_demo";
  if (/manage traders|trader relationships|trader management|إدارة التجار/.test(lower)) return "product_feature_question";
  if (/trader|store|seller|merchant|shopify|salla|woocommerce|instagram|online store|تاجر|متجر/.test(lower)) return "trader";
  if (/send .*package|send .*parcel|\bshipment\b|\bpackage\b|\bparcel\b|\bquote\b|\bpickup\b|\b\d+(?:\.\d+)?\s*kg\b|\bbox\b|أرسل|ارسل|إرسال|ارسال|شحنة|طرد|سعر|طلب توصيل|أحتاج توصيل|احتاج توصيل/.test(lower)) return "customer_quote";
  if (/payroll|accounting|journal|cod|collection|reconciliation|settlement|report|driver money|driver collections|manage .*drivers|manage my drivers|manage traders|mobile app|driver app|storefront|courier|feature|how can .*help|كيف ممكن تساعد|ميزة|رواتب|محاسبة|تحصيل|تسوية|تقارير/.test(lower)) return "product_feature_question";
  if (/driver|drivers|delivery company|courier company|demo|fleet|مندوب|سائق|شركة توصيل/.test(lower)) return "delivery_company_demo";
  if (isShortContinuation && continuableIntents.has(previous)) return previous;
  return "general_question";
}

function extractEmirates(text: string, slots: AgentSlots): AgentSlots {
  const lower = text.toLowerCase().replace(/[,-]/g, " ");
  const result: AgentSlots = {};
  const names = Object.keys(emirateAliases).sort((a, b) => b.length - a.length);
  const ordered = names
    .map((name) => ({ name, index: lower.indexOf(name) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index);
  const fromMatch = ordered[0]?.name;
  const toMatch = ordered.find((item) => item.name !== fromMatch)?.name;
  if (fromMatch) result.pickupEmirate = emirateAliases[fromMatch]!;
  if (toMatch) result.deliveryEmirate = emirateAliases[toMatch]!;
  const all = names.filter((name) => lower.includes(name)).map((name) => emirateAliases[name]);
  if (!result.pickupEmirate && all[0] && !slots.pickupEmirate) result.pickupEmirate = all[0];
  if (!result.deliveryEmirate && all[1] && !slots.deliveryEmirate) result.deliveryEmirate = all[1];
  if (!result.emirate && all[0]) result.emirate = all[0];
  return result;
}

function extractAreaAfter(text: string, marker: string): string | undefined {
  const expression = new RegExp(`${marker}\\s+([a-z0-9\\s]+?)(?:\\s+to\\s+|\\s+from\\s+|\\s+tomorrow\\b|\\s+today\\b|,|$)`, "i");
  const match = expression.exec(text);
  const area = match?.[1]?.trim();
  if (!area) return undefined;
  if (/^(send|deliver|delivery|ship|create|request|get|use|manage)\b/i.test(area)) return undefined;
  if (/\b(package|shipment|parcel|quote|order|orders|delivery company|trader)\b/i.test(area)) return undefined;
  return area;
}

@Injectable()
export class RulesAgentModelProvider implements AgentModelProvider {
  public async classifyAndExtract(input: AgentModelInput): Promise<AgentModelResult> {
    const text = input.text.trim();
    const lower = text.toLowerCase();
    const language = input.language === "ar" ? "ar" : detectLanguage(text, input.language);
    const intent = detectIntent(text, input.previousIntent);
    const extracted: AgentSlots = { ...extractEmirates(text, input.state.slots) };

    const weight = /(\d+(?:\.\d+)?)\s*(?:kg|kilo|kilogram|كيلو)/i.exec(text)?.[1];
    if (weight) extracted.weightKg = Number(weight);
    const quantity = /(\d+)\s*(?:boxes|box|parcels|packages|طرود|كرتون)/i.exec(text)?.[1];
    if (quantity) extracted.quantity = Number(quantity);
    if (/small\s+(?:package|parcel)|small\s+shipment|طرد صغير|شحنة صغيرة/i.test(text)) extracted.packageType = "small_parcel";
    else if (/box|carton|كرتون/i.test(text)) extracted.packageType = "box";
    else if (/document|paper|مستند/i.test(text)) extracted.packageType = "document";
    else if (/food|طعام|اكل/i.test(text)) extracted.packageType = "food";
    else if (/electronic|phone|laptop|إلكترون/i.test(text)) extracted.packageType = "electronics";
    if (/\bno cod\b|without cod|cod no|بدون تحصيل/i.test(text)) extracted.codRequired = false;
    if (/\bcod\b|cash on delivery|تحصيل/i.test(text)) extracted.codRequired = extracted.codRequired ?? true;
    const codAmount = /cod(?:\s+amount)?\s*(?:aed)?\s*(\d+(?:\.\d+)?)/i.exec(text)?.[1];
    if (codAmount) {
      extracted.codRequired = true;
      extracted.codAmount = Number(codAmount);
    }
    if (/same day|same-day|نفس اليوم/i.test(text)) extracted.requestedServiceType = "same_day";
    else if (/express|urgent|سريع/i.test(text)) extracted.requestedServiceType = "express";
    else if (/standard|next day|عادي/i.test(text)) extracted.requestedServiceType = "standard";
    const date = normalizeDate(text);
    if (date) extracted.pickupDate = date;
    const fromArea = extractAreaAfter(text, "from");
    const toArea = extractAreaAfter(text, "to");
    if (fromArea && !Object.keys(emirateAliases).includes(fromArea.toLowerCase())) extracted.pickupArea = fromArea;
    if (toArea && !Object.keys(emirateAliases).includes(toArea.toLowerCase())) extracted.deliveryArea = toArea;

    const mobile = /(?:\+971|971|0)?5\d[\d\s-]{7,12}/.exec(text)?.[0]?.replace(/[^\d+]/g, "");
    if (mobile) {
      extracted.mobileNumber = mobile;
      extracted.requesterMobile = mobile;
      extracted.recipientMobile = mobile;
      extracted.mobile = mobile;
    }
    const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(text)?.[0]?.toLowerCase();
    if (email) {
      extracted.email = email;
      extracted.requesterEmail = email;
    }
    const name = /(?:my name is|i am|i'm|contact person is)\s+([a-z][a-z\s]{1,80})/i.exec(text)?.[1]?.trim();
    if (name) {
      const looksLikeAudienceStatement = /\b(trader|store|seller|merchant|delivery company|courier company|shipment|package|parcel|orders?|drivers?)\b/i.test(name);
      if (!looksLikeAudienceStatement) {
        extracted.requesterName = name;
        extracted.contactPerson = name;
        extracted.recipientName = name;
        extracted.contactName = name;
      }
    }
    const storeName = /(?:store is|store name is|my store is)\s+([^,.]{2,120})/i.exec(text)?.[1]?.trim();
    if (storeName) extracted.storeName = storeName;
    const companyName = /(?:company is|company name is|we are|we run)\s+([^,.]{2,160})/i.exec(text)?.[1]?.trim();
    if (companyName) extracted.companyName = companyName;
    const drivers = /(\d+)\s*(?:drivers|driver|سائق)/i.exec(text)?.[1];
    if (drivers) extracted.approximateDriverCount = Number(drivers);
    const orders = /(\d+)\s*(?:orders|order|طلب)/i.exec(text)?.[1];
    if (orders) extracted.approximateMonthlyOrders = Number(orders);
    for (const channel of integrationChannels) {
      if (lower.includes(channel)) extracted.channels = [...(extracted.channels ?? []), { type: channel }];
    }
    if (/need a delivery company|need delivery|looking for delivery|find.*delivery/i.test(text)) extracted.hasExistingDeliveryCompany = false;
    const existing = /already (?:use|with|have)\s+([^,.]{2,120})/i.exec(text)?.[1]?.trim();
    if (existing) {
      extracted.hasExistingDeliveryCompany = true;
      extracted.existingDeliveryCompanyName = existing;
    }

    return {
      extracted,
      intent,
      language,
      wantsConfirmation: /^(yes|y|confirm|submit|go ahead|ok|okay|نعم|أكد)/i.test(lower),
      wantsCorrection: /\b(no|not|instead|change|correct|actually)\b|لا/i.test(lower),
    };
  }
}
