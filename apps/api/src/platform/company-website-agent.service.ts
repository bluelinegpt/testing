import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";
import {
  CompanyWebsiteAgentProvider,
  type CompanyWebsiteAgentContext,
} from "./company-website-agent.provider.js";
import {
  validateCompanyWebsiteSettings,
  type CompanyWebsiteSettings,
} from "./company-website-settings.js";
import { CompanyWebsiteService } from "./company-website.service.js";

interface WebsiteAgentRow {
  websiteId: string;
  companyId: string;
  slug: string;
  status: string;
  enabled: boolean;
  nameEn: string;
  nameAr: string | null;
  timezone: string;
  settings: CompanyWebsiteSettings;
}
interface ConversationRow {
  id: string;
  companyId: string;
  websiteId: string;
  language: "en" | "ar";
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  messageCount: number;
  expiresAt: string;
  visitorContactNumber: string | null;
}

@Injectable()
export class CompanyWebsiteAgentService {
  private readonly logger = new Logger(CompanyWebsiteAgentService.name);
  public constructor(
    @Inject(DATABASE) private readonly db: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(CompanyHostResolver) private readonly hosts: CompanyHostResolver,
    @Inject(CompanyWebsiteAgentProvider) private readonly provider: CompanyWebsiteAgentProvider,
    @Inject(CompanyWebsiteService) private readonly websites: CompanyWebsiteService,
  ) {}
  public async start(
    host: string | undefined,
    language: "en" | "ar" | undefined,
    ip: string | null,
  ) {
    const row = await this.publicWebsite(host);
    const settings = validateCompanyWebsiteSettings(row.settings);
    this.assertEnabled(row, settings);
    const selected = this.language(settings, language);
    const token = randomBytes(32).toString("base64url");
    const agentName =
      settings.agent.displayName?.trim() ||
      `${selected === "ar" ? (row.nameAr ?? row.nameEn) : row.nameEn} Assistant`;
    await sql`insert into company_website_agent_conversations(company_id,company_website_id,public_token_hash,visitor_ip_hash,language,source_hostname) values(${row.companyId}::uuid,${row.websiteId}::uuid,${hash(token)},${ip ? hash(ip) : null},${selected},${hostnameOf(host)})`.execute(
      this.db,
    );
    return {
      conversationToken: token,
      assistantName: agentName,
      language: selected,
      message: welcome(row, settings, selected, agentName),
      suggestedActions: this.actions(settings),
    };
  }
  public async message(
    host: string | undefined,
    token: string,
    message: string,
    language: "en" | "ar" | undefined,
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw this.notFound();
    const started = Date.now();
    const row = await this.publicWebsite(host);
    const settings = validateCompanyWebsiteSettings(row.settings);
    this.assertEnabled(row, settings);
    const result = await this.transactions.execute(async (trx) => {
      const conversation = (
        await sql<ConversationRow>`select id,company_id as "companyId",company_website_id as "websiteId",language,messages,message_count as "messageCount",expires_at as "expiresAt",visitor_contact_number as "visitorContactNumber" from company_website_agent_conversations where public_token_hash=${hash(token)} and company_id=${row.companyId}::uuid and company_website_id=${row.websiteId}::uuid and expires_at>now() for update`.execute(
          trx,
        )
      ).rows[0];
      if (!conversation) throw this.notFound();
      if (conversation.messageCount >= 40)
        throw new ApplicationException(
          "company_website_agent_limit_reached",
          "This conversation has reached its message limit",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      const selected = this.language(settings, language ?? conversation.language);
      const agentName =
        settings.agent.displayName?.trim() ||
        `${selected === "ar" ? (row.nameAr ?? row.nameEn) : row.nameEn} Assistant`;
      const context: CompanyWebsiteAgentContext = {
        companyName: selected === "ar" ? (row.nameAr ?? row.nameEn) : row.nameEn,
        agentName,
        language: selected,
        timezone: row.timezone,
        settings,
        // The conversation is already bounded to 40 visitor turns. Supplying
        // the complete transcript prevents the Agent from forgetting details
        // collected early in a longer sales, booking or complaint flow.
        history: conversation.messages,
        visitorContactNumber: conversation.visitorContactNumber,
      };
      const trackingReference =
        settings.agent.capabilities.tracking && settings.functions.trackingEnabled
          ? trackingReferenceFrom(message)
          : undefined;
      const generated = trackingReference
        ? {
            reply: await this.trackingReply(host, trackingReference, selected),
            provider: "secure-tracking",
            model: "public-tracking-v1",
          }
        : await this.provider.reply(context, message);
      const messages = [
        ...conversation.messages,
        { role: "user" as const, content: message },
        { role: "assistant" as const, content: generated.reply },
      ];
      await sql`update company_website_agent_conversations set language=${selected},messages=${JSON.stringify(messages)}::jsonb,message_count=message_count+1,updated_at=now() where id=${conversation.id}::uuid and company_id=${row.companyId}::uuid`.execute(
        trx,
      );
      return {
        reply: generated.reply,
        language: selected,
        assistantName: agentName,
        suggestedActions: this.actions(settings),
        provider: generated.provider,
        model: generated.model,
      };
    });
    this.logger.log(
      {
        companyId: row.companyId,
        websiteId: row.websiteId,
        latencyMs: Date.now() - started,
        provider: result.provider,
        model: result.model,
        success: true,
      },
      "Company website agent request",
    );
    return { ...result, provider: undefined, model: undefined };
  }
  public async saveContact(host: string | undefined, token: string, contactNumber: string) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw this.notFound();
    const row = await this.publicWebsite(host);
    const settings = validateCompanyWebsiteSettings(row.settings);
    this.assertEnabled(row, settings);
    const normalized = contactNumber.trim().replace(/[ ()-]/gu, "");
    if (!/^\+?[0-9]{5,31}$/u.test(normalized)) {
      throw new ApplicationException(
        "company_website_agent_contact_invalid",
        "Enter a valid contact number",
        HttpStatus.BAD_REQUEST,
      );
    }
    const result = await sql`
      update company_website_agent_conversations
      set visitor_contact_number=${normalized}, updated_at=now()
      where public_token_hash=${hash(token)}
        and company_id=${row.companyId}::uuid
        and company_website_id=${row.websiteId}::uuid
        and expires_at>now()
      returning id
    `.execute(this.db);
    if (result.rows.length === 0) throw this.notFound();
    return { saved: true };
  }
  public async preview(companyId: string, message: string, language: "en" | "ar" | undefined) {
    const row = (
      await sql<WebsiteAgentRow>`select w.id as "websiteId",w.company_id as "companyId",w.slug,w.status,w.enabled,c.name_en as "nameEn",c.name_ar as "nameAr",coalesce(cs.timezone,'Asia/Dubai') as timezone,w.draft_settings as settings from company_websites w join companies c on c.id=w.company_id left join company_settings cs on cs.company_id=w.company_id where w.company_id=${companyId}::uuid`.execute(
        this.db,
      )
    ).rows[0];
    if (!row) throw this.notFound();
    const settings = validateCompanyWebsiteSettings(row.settings);
    const selected = this.language(settings, language);
    const agentName =
      settings.agent.displayName?.trim() ||
      `${selected === "ar" ? (row.nameAr ?? row.nameEn) : row.nameEn} Assistant`;
    const trackingReference =
      settings.agent.capabilities.tracking && settings.functions.trackingEnabled
        ? trackingReferenceFrom(message)
        : undefined;
    const generated = trackingReference
      ? {
          reply: await this.previewTrackingReply(companyId, trackingReference, selected),
          provider: "secure-tracking-preview",
          model: "public-tracking-v1",
        }
      : await this.provider.reply(
          {
            companyName: selected === "ar" ? (row.nameAr ?? row.nameEn) : row.nameEn,
            agentName,
            language: selected,
            timezone: row.timezone,
            settings,
            history: [],
          },
          message,
        );
    return {
      preview: true,
      noindex: true,
      reply: generated.reply,
      assistantName: agentName,
      language: selected,
      suggestedActions: this.actions(settings),
    };
  }
  private async publicWebsite(host: string | undefined) {
    const classified = this.hosts.classifyTawseelhubHost(host);
    if (classified.kind === "company_app" || classified.kind === "reserved") throw this.notFound();
    const hostname = hostnameOf(host);
    if (!hostname) throw this.notFound();
    const row =
      classified.kind === "company_website"
        ? (
            await sql<WebsiteAgentRow>`select w.id as "websiteId",w.company_id as "companyId",w.slug,w.status,w.enabled,c.name_en as "nameEn",c.name_ar as "nameAr",coalesce(cs.timezone,'Asia/Dubai') as timezone,w.published_settings as settings from company_websites w join companies c on c.id=w.company_id left join company_settings cs on cs.company_id=w.company_id where lower(w.slug)=lower(${classified.slug})`.execute(
              this.db,
            )
          ).rows[0]
        : (
            await sql<WebsiteAgentRow>`select w.id as "websiteId",w.company_id as "companyId",w.slug,w.status,w.enabled,c.name_en as "nameEn",c.name_ar as "nameAr",coalesce(cs.timezone,'Asia/Dubai') as timezone,w.published_settings as settings from company_website_domains d join company_websites w on w.id=d.company_website_id and w.company_id=d.company_id join companies c on c.id=d.company_id left join company_settings cs on cs.company_id=w.company_id where lower(d.hostname)=lower(${hostname}) and d.status='active' and d.verification_status='verified' and d.ssl_status='active' limit 1`.execute(
              this.db,
            )
          ).rows[0];
    if (!row || row.status !== "published" || !row.enabled || !row.settings) throw this.notFound();
    return row;
  }
  private assertEnabled(row: WebsiteAgentRow, settings: CompanyWebsiteSettings) {
    if (row.status !== "published" || !row.enabled || !settings.agent.enabled)
      throw this.notFound();
  }
  private language(
    settings: CompanyWebsiteSettings,
    requested: "en" | "ar" | undefined,
  ): "en" | "ar" {
    if (requested && settings.languages[requested]) return requested;
    return settings.languages.defaultLocale;
  }
  private actions(settings: CompanyWebsiteSettings) {
    return settings.agent.suggestedActions
      .filter(
        (action) =>
          action !== "whatsapp" ||
          (settings.contact.whatsappEnabled && settings.contact.showWhatsapp),
      )
      .filter((action) => action !== "track" || (settings.functions?.trackingEnabled ?? true))
      .filter(
        (action) =>
          action !== "request_delivery" || (settings.functions?.requestDeliveryEnabled ?? true),
      );
  }
  private async trackingReply(
    host: string | undefined,
    reference: string,
    language: "en" | "ar",
  ): Promise<string> {
    try {
      const result = (await this.websites.trackPublic(host, reference)) as {
        reference: string;
        status: string;
        timeline: Array<{ status: string; occurredAt: string }>;
      };
      return this.formatTrackingReply(result, language);
    } catch {
      return trackingNotFound(language);
    }
  }
  private async previewTrackingReply(
    companyId: string,
    reference: string,
    language: "en" | "ar",
  ): Promise<string> {
    try {
      return this.formatTrackingReply(
        (await this.websites.trackPreview(companyId, reference)) as {
          reference: string;
          status: string;
          timeline: Array<{ status: string; occurredAt: string }>;
        },
        language,
      );
    } catch {
      return trackingNotFound(language);
    }
  }
  private formatTrackingReply(
    result: {
      reference: string;
      status: string;
      timeline: Array<{ status: string; occurredAt: string }>;
    },
    language: "en" | "ar",
  ): string {
    const labels = trackingStatusLabels;
    const timeline = result.timeline
      .map(
        (event) =>
          `${labels[event.status]?.[language] ?? labels.preparing![language]} — ${new Date(event.occurredAt).toLocaleString(language === "ar" ? "ar-AE" : "en-AE")}`,
      )
      .join("\n");
    return language === "ar"
      ? `الشحنة ${result.reference}: ${labels[result.status]?.ar ?? labels.preparing!.ar}.${timeline ? `\n${timeline}` : ""}`
      : `Shipment ${result.reference} is currently ${labels[result.status]?.en ?? labels.preparing!.en}.${timeline ? `\n${timeline}` : ""}`;
  }
  private notFound() {
    return new ApplicationException(
      "company_website_agent_not_available",
      "Website assistant is not available",
      HttpStatus.NOT_FOUND,
    );
  }
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
const trackingStatusLabels: Record<string, { en: string; ar: string }> = {
  order_received: { en: "Order Received", ar: "تم استلام الطلب" },
  preparing: { en: "Preparing for Delivery", ar: "قيد التجهيز للتسليم" },
  assigned: { en: "Assigned for Delivery", ar: "تم تعيين مندوب للتسليم" },
  out_for_delivery: { en: "Out for Delivery", ar: "خرج للتسليم" },
  delivered: { en: "Delivered", ar: "تم التسليم" },
  returned: { en: "Returned", ar: "مرتجع" },
  cancelled: { en: "Cancelled", ar: "ملغي" },
};
function trackingReferenceFrom(message: string): string | undefined {
  return (
    message.match(/(?:^|\s)([A-Za-z0-9_-]{43})(?=\s|$)/u)?.[1] ??
    message.match(/(?:^|\s)([A-Z]{3}[0-9]{7,})(?=\s|$)/iu)?.[1]?.toUpperCase() ??
    message.match(/(?:^|\s)(ORD-[0-9]{6,})(?=\s|$)/iu)?.[1]?.toUpperCase()
  );
}
function trackingNotFound(language: "en" | "ar"): string {
  return language === "ar"
    ? "لم نتمكن من العثور على شحنة تطابق هذا المرجع."
    : "We couldn't find a shipment matching that reference.";
}
function hostnameOf(host: string | undefined) {
  return host?.trim().toLowerCase().split(":")[0] || undefined;
}
function welcome(
  row: WebsiteAgentRow,
  settings: CompanyWebsiteSettings,
  language: "en" | "ar",
  agentName: string,
) {
  return (
    settings.agent.welcomeMessage?.[language] ??
    settings.agent.welcomeMessage?.en ??
    (language === "ar"
      ? `مرحباً، أنا ${agentName}. كيف يمكنني مساعدتك في التوصيل؟`
      : `Hi, I'm ${agentName}. How can I help with your delivery?`)
  );
}
