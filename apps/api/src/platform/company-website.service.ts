import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { type Kysely, sql } from "kysely";
import { createHash } from "node:crypto";

import type { AppConfiguration } from "../configuration/environment.js";
import { FileStoragePort } from "../files/file-storage.port.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";
import {
  EMPTY_COMPANY_WEBSITE_SETTINGS,
  settingsForWebsiteAudience,
  validateCompanyWebsiteSettings,
  type CompanyWebsiteSettings,
} from "./company-website-settings.js";
import {
  hasUnpublishedTemplateChanges,
  isCompanyWebsiteTemplateKey,
  templateForWebsiteAudience,
  type CompanyWebsiteTemplateKey,
} from "./company-website-templates.js";
import type { PublicWebsiteDeliveryRequestDto } from "./company-website-public.dto.js";

export type CompanyWebsiteStatus = "draft" | "published" | "disabled";

export interface CompanyWebsiteView {
  readonly id: string;
  readonly companyId: string;
  readonly slug: string;
  readonly status: CompanyWebsiteStatus;
  readonly enabled: boolean;
  readonly published: boolean;
  readonly templateKey: CompanyWebsiteTemplateKey;
  readonly publishedTemplateKey: CompanyWebsiteTemplateKey | null;
  readonly hasUnpublishedChanges: boolean;
  readonly settings: CompanyWebsiteSettings;
  readonly publishedSettings: CompanyWebsiteSettings | null;
  readonly primaryLanguage: "en" | "ar";
  readonly defaultLocale: "en" | "ar";
  readonly websiteUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
  readonly disabledAt: string | null;
  readonly lastPublishedBy: string | null;
  readonly lastUpdatedBy: string | null;
  readonly version: number;
}

interface WebsiteRow {
  id: string;
  companyId: string;
  slug: string;
  status: CompanyWebsiteStatus;
  enabled: boolean;
  published: boolean;
  templateKey: CompanyWebsiteTemplateKey;
  publishedTemplateKey: CompanyWebsiteTemplateKey | null;
  settings: CompanyWebsiteSettings;
  publishedSettings: CompanyWebsiteSettings | null;
  primaryLanguage: "en" | "ar";
  defaultLocale: "en" | "ar";
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  disabledAt: string | null;
  lastPublishedBy: string | null;
  lastUpdatedBy: string | null;
  version: number;
}

interface PublicWebsiteRow {
  companyId: string;
  slug: string;
  status: CompanyWebsiteStatus;
  enabled: boolean;
  published: boolean;
  templateKey: CompanyWebsiteTemplateKey;
  publishedTemplateKey: CompanyWebsiteTemplateKey | null;
  settings: CompanyWebsiteSettings;
  publishedSettings: CompanyWebsiteSettings | null;
  defaultLocale: "en" | "ar";
  nameEn: string;
  nameAr: string | null;
  subtitleEn: string | null;
  subtitleAr: string | null;
  telephone: string | null;
  email: string | null;
  addressEn: string | null;
  addressAr: string | null;
  logoFileId: string | null;
  storageKey: string | null;
  mediaType: string | null;
}

const reservedWebsiteSlugs = new Set([
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "cdn",
  "dashboard",
  "help",
  "internal",
  "mail",
  "platform",
  "static",
  "status",
  "store",
  "support",
  "www",
]);

export function isValidCompanyWebsiteSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(slug) && !reservedWebsiteSlugs.has(slug);
}

export function isCompanyWebsiteTransitionAllowed(
  current: CompanyWebsiteStatus,
  action: "publish" | "disable" | "enable",
): boolean {
  return (
    (action === "publish" && (current === "draft" || current === "published")) ||
    (action === "disable" && current === "published") ||
    (action === "enable" && current === "disabled")
  );
}

export function assertCompanyWebsiteExpectedVersion(
  actualVersion: number | undefined,
  expectedVersion: number,
): void {
  if ((actualVersion ?? 0) !== expectedVersion) {
    throw new ApplicationException(
      "website_version_conflict",
      "This website was modified by another administrator. Reload the latest version before retrying.",
      HttpStatus.CONFLICT,
    );
  }
}

@Injectable()
export class CompanyWebsiteService {
  private readonly hostSuffix: string;

  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(CompanyHostResolver) private readonly hosts: CompanyHostResolver,
    @Inject(FileStoragePort) private readonly storage: FileStoragePort,
    @Inject(ConfigService) config: ConfigService<AppConfiguration, true>,
  ) {
    this.hostSuffix = config.get("tenancy.hostSuffix", { infer: true }) ?? "tawseelhub.com";
  }

  public async get(companyId: string): Promise<{ status: "not_configured" } | CompanyWebsiteView> {
    const row = await this.row(this.database, companyId);
    return row === undefined ? { status: "not_configured" } : this.view(row);
  }

  public async configure(
    companyId: string,
    input: {
      slug: string;
      primaryLanguage?: "en" | "ar";
      defaultLocale?: "en" | "ar";
      templateKey?: CompanyWebsiteTemplateKey;
      expectedVersion: number;
      settings?: CompanyWebsiteSettings;
    },
    actor: { accountId: string; correlationId: string },
  ): Promise<CompanyWebsiteView> {
    const slug = input.slug.trim().toLowerCase();
    this.validateSlug(slug);
    if (input.templateKey !== undefined && !isCompanyWebsiteTemplateKey(input.templateKey)) {
      throw new ApplicationException(
        "company_website_template_invalid",
        "Website template is invalid",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    try {
      return await this.transactions.execute(async (transaction) => {
        const before = await this.row(transaction, companyId, true);
        assertCompanyWebsiteExpectedVersion(before?.version, input.expectedVersion);
        const settings = validateCompanyWebsiteSettings(
          input.settings ?? before?.settings ?? EMPTY_COMPANY_WEBSITE_SETTINGS,
        );
        const result =
          before === undefined
            ? await sql<WebsiteRow>`
              insert into company_websites (company_id, slug, template_key, draft_settings, primary_language, default_locale, last_updated_by_account_id)
              values (${companyId}::uuid, ${slug}, ${input.templateKey ?? "corporate"}, ${JSON.stringify(settings)}::jsonb, ${input.primaryLanguage ?? settings.languages.defaultLocale}, ${input.defaultLocale ?? settings.languages.defaultLocale}, ${actor.accountId}::uuid)
              returning ${this.returningColumns()}
            `.execute(transaction)
            : await sql<WebsiteRow>`
              update company_websites set slug=${slug}, template_key=${input.templateKey ?? before.templateKey},
                draft_settings=${JSON.stringify(settings)}::jsonb,
                primary_language=${input.primaryLanguage ?? before.primaryLanguage}, default_locale=${input.defaultLocale ?? before.defaultLocale},
                last_updated_by_account_id=${actor.accountId}::uuid, updated_at=now(), version=version+1
              where company_id=${companyId}::uuid and version=${input.expectedVersion} returning ${this.returningColumns()}
            `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) throw this.versionConflict();
        await this.audit(transaction, {
          action:
            before === undefined
              ? "platform.company_website.configured"
              : before.templateKey !== row.templateKey
                ? "platform.company_website.template_changed"
                : before.slug === slug
                  ? "platform.company_website.updated"
                  : "platform.company_website.slug_changed",
          actorAccountId: actor.accountId,
          companyId,
          correlationId: actor.correlationId,
          before:
            before === undefined
              ? null
              : {
                  slug: before.slug,
                  templateKey: before.templateKey,
                  primaryLanguage: before.primaryLanguage,
                  defaultLocale: before.defaultLocale,
                  settings: before.settings,
                },
          after: {
            slug,
            templateKey: row.templateKey,
            primaryLanguage: row.primaryLanguage,
            defaultLocale: row.defaultLocale,
            settings: row.settings,
          },
          subjectId: row.id,
        });
        if (before === undefined) {
          await this.audit(transaction, {
            action: "platform.company_website.template_selected",
            actorAccountId: actor.accountId,
            companyId,
            correlationId: actor.correlationId,
            before: null,
            after: { templateKey: row.templateKey },
            subjectId: row.id,
          });
        }
        if (before !== undefined) {
          for (const action of settingsAuditActions(before.settings, row.settings)) {
            await this.audit(transaction, {
              action,
              actorAccountId: actor.accountId,
              companyId,
              correlationId: actor.correlationId,
              before: { version: before.version },
              after: { version: row.version },
              subjectId: row.id,
            });
          }
        }
        return this.view(row);
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : "";
      if (
        code === "23505" &&
        (error as { constraint?: string }).constraint === "company_websites_company_id_key"
      )
        throw this.versionConflict();
      if (code === "23505")
        throw new ApplicationException(
          "company_website_slug_taken",
          "Website slug is already in use",
          HttpStatus.CONFLICT,
        );
      if (code === "23514" || message.includes("company_website_slug"))
        throw new ApplicationException(
          "company_website_slug_invalid",
          "Website slug is reserved or conflicts with an application hostname",
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      throw error;
    }
  }

  public publish(
    companyId: string,
    expectedVersion: number,
    actor: { accountId: string; correlationId: string },
  ): Promise<CompanyWebsiteView> {
    return this.transition(companyId, "published", expectedVersion, actor);
  }
  public disable(
    companyId: string,
    expectedVersion: number,
    actor: { accountId: string; correlationId: string },
  ): Promise<CompanyWebsiteView> {
    return this.transition(companyId, "disabled", expectedVersion, actor);
  }
  public enable(
    companyId: string,
    expectedVersion: number,
    actor: { accountId: string; correlationId: string },
  ): Promise<CompanyWebsiteView> {
    return this.transition(companyId, "published", expectedVersion, actor, true);
  }

  public async preview(companyId: string, templateKey?: string): Promise<object> {
    if (templateKey !== undefined && !isCompanyWebsiteTemplateKey(templateKey)) {
      throw new ApplicationException(
        "company_website_template_invalid",
        "Website template is invalid",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const row = await this.publicRow("company", companyId);
    if (row === undefined) throw this.notFound();
    return this.publicPayload(
      row,
      true,
      templateForWebsiteAudience({
        draft: row.templateKey,
        published: row.publishedTemplateKey,
        ...(templateKey ? { previewTemplate: templateKey } : {}),
      }) ?? row.templateKey,
    );
  }

  public async resolvePublic(host: string | undefined): Promise<object> {
    const resolved = await this.resolveWebsiteHost(host);
    const row = resolved?.row;
    if (row === undefined || row.status === "draft") throw this.publicNotFound();
    if (!resolved) throw this.publicNotFound();
    if (row.status === "disabled" || !row.enabled) return { availability: "disabled" };
    if (row.publishedTemplateKey === null) throw this.publicNotFound();
    const payload = this.publicPayload(
      row,
      false,
      templateForWebsiteAudience({ draft: row.templateKey, published: row.publishedTemplateKey }) ??
        row.publishedTemplateKey,
      resolved.primaryHostname,
    );
    return resolved.fallback && resolved.primaryHostname !== resolved.requestedHostname
      ? { ...payload, redirectTo: `https://${resolved.primaryHostname}` }
      : payload;
  }

  public async trackPublic(host: string | undefined, token: string): Promise<object> {
    const row = await this.requirePublishedHost(host);
    if (row.publishedSettings?.functions.trackingEnabled === false) throw this.publicNotFound();
    return this.trackForCompany(row, token);
  }

  /** Authenticated Platform Preview: draft visibility, same tenant-safe tracking lookup. */
  public async trackPreview(companyId: string, token: string): Promise<object> {
    const row = await this.publicRow("company", companyId);
    if (!row || validateCompanyWebsiteSettings(row.settings).functions.trackingEnabled === false)
      throw this.trackingNotFound();
    return this.trackForCompany(row, token);
  }

  private async trackForCompany(row: PublicWebsiteRow, reference: string): Promise<object> {
    const normalizedReference = reference.trim();
    const secureToken = /^[A-Za-z0-9_-]{43}$/u.test(normalizedReference);
    const orderReference = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(normalizedReference);
    if (!secureToken && !orderReference) throw this.trackingNotFound();
    const tokenHash = secureToken
      ? createHash("sha256").update(normalizedReference, "utf8").digest("hex")
      : null;
    const tracking = secureToken
      ? (
          await sql<{
            orderId: string;
            orderNumber: string;
            deliveryStatus: string;
            deliveredAt: string | null;
            lastUpdatedAt: string;
          }>`select o.id as "orderId",o.order_number as "orderNumber",o.delivery_status as "deliveryStatus",
          o.delivered_at::text as "deliveredAt",greatest(o.updated_at,coalesce(max(h.occurred_at),o.updated_at))::text as "lastUpdatedAt"
        from tracking_tokens tt join orders o on o.id=tt.order_id and o.company_id=tt.company_id
        left join order_status_history h on h.order_id=o.id and h.company_id=o.company_id
        where tt.company_id=${row.companyId}::uuid and tt.token_hash=${tokenHash}
          and tt.revoked_at is null and (tt.expires_at is null or tt.expires_at>now())
        group by o.id limit 1`.execute(this.database)
        ).rows[0]
      : (
          await sql<{
            orderId: string;
            orderNumber: string;
            deliveryStatus: string;
            deliveredAt: string | null;
            lastUpdatedAt: string;
          }>`select o.id as "orderId",o.order_number as "orderNumber",o.delivery_status as "deliveryStatus",
          o.delivered_at::text as "deliveredAt",greatest(o.updated_at,coalesce(max(h.occurred_at),o.updated_at))::text as "lastUpdatedAt"
        from orders o
        left join order_status_history h on h.order_id=o.id and h.company_id=o.company_id
        where o.company_id=${row.companyId}::uuid and upper(o.order_number)=upper(${normalizedReference})
        group by o.id limit 1`.execute(this.database)
        ).rows[0];
    if (!tracking) throw this.trackingNotFound();
    const timeline = (
      await sql<{
        status: string;
        occurredAt: string;
      }>`select to_status as status,occurred_at::text as "occurredAt"
        from order_status_history
        where company_id=${row.companyId}::uuid and order_id=${tracking.orderId}::uuid
          and status_dimension='delivery'
          and to_status in ('new','preparing','assigned','out_for_delivery','delivered','returned','cancelled')
        order by occurred_at asc`.execute(this.database)
    ).rows.map((event) => ({
      status: this.publicStatus(event.status),
      occurredAt: event.occurredAt,
    }));
    return {
      reference: tracking.orderNumber,
      status: this.publicStatus(tracking.deliveryStatus),
      deliveredAt: tracking.deliveredAt,
      lastUpdatedAt: tracking.lastUpdatedAt,
      company: { nameEn: row.nameEn, nameAr: row.nameAr },
      timeline,
    };
  }
  public async publicSitemap(host: string | undefined): Promise<string> {
    const resolved = await this.resolveWebsiteHost(host);
    const row = resolved?.row;
    if (!resolved || !row || row.status !== "published" || !row.enabled || !row.publishedSettings)
      throw this.publicNotFound();
    const settings = validateCompanyWebsiteSettings(row.publishedSettings);
    const enabled = (key: string) =>
      settings.sections.find((section) => section.key === key)?.enabled !== false;
    const paths = [
      "/",
      ...(enabled("tracking") && settings.functions.trackingEnabled ? ["/track"] : []),
      ...(enabled("request_delivery") && settings.functions.requestDeliveryEnabled
        ? ["/request-delivery"]
        : []),
      ...(enabled("contact") ? ["/contact"] : []),
    ];
    return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((path) => `<url><loc>https://${resolved.primaryHostname}${path}</loc></url>`).join("")}</urlset>`;
  }

  public async createDeliveryRequest(
    host: string | undefined,
    input: PublicWebsiteDeliveryRequestDto,
  ): Promise<object> {
    const row = await this.requirePublishedHost(host);
    if (row.publishedSettings?.functions.requestDeliveryEnabled === false)
      throw this.publicNotFound();
    if (!input.codRequired && Number(input.codAmount ?? 0) !== 0)
      throw new ApplicationException(
        "delivery_request_invalid",
        "COD amount requires COD",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    try {
      return await this.transactions.execute(async (transaction) => {
        if (input.idempotencyKey) {
          const existing = (
            await sql<{
              publicReference: string;
            }>`select public_reference as "publicReference" from company_website_delivery_requests where company_website_id=(select id from company_websites where company_id=${row.companyId}::uuid) and idempotency_key=${input.idempotencyKey}`.execute(
              transaction,
            )
          ).rows[0];
          if (existing)
            return {
              reference: existing.publicReference,
              status: "received",
              pricing: "company_confirmation_required",
            };
        }
        const reference = `REQ-${String((await sql<{ n: string }>`select nextval('company_website_request_reference_seq')::text n`.execute(transaction)).rows[0]!.n).padStart(6, "0")}`;
        const created = (
          await sql<{
            id: string;
          }>`insert into company_website_delivery_requests(company_id,company_website_id,public_reference,contact_name,mobile,email,pickup_emirate,pickup_location,delivery_emirate,delivery_location,package_description,quantity,approximate_weight_kg,cod_required,cod_amount,requested_at,notes,idempotency_key,utm_source,utm_campaign,source_hostname)
          values(${row.companyId}::uuid,(select id from company_websites where company_id=${row.companyId}::uuid),${reference},${input.contactName},${input.mobile},${input.email ?? null},${input.pickupEmirate},${input.pickupLocation},${input.deliveryEmirate},${input.deliveryLocation},${input.packageDescription},${input.quantity},${input.approximateWeightKg},${input.codRequired},${input.codRequired ? (input.codAmount ?? 0) : 0},${input.requestedAt ?? null}::timestamptz,${input.notes ?? null},${input.idempotencyKey ?? null},${input.utmSource ?? null},${input.utmCampaign ?? null},${this.hostname(host)}) returning id`.execute(
            transaction,
          )
        ).rows[0]!;
        await sql`insert into audit_events(company_id,action,subject_type,subject_id,after_data,correlation_id,actor_role,source,result,source_application) values(${row.companyId}::uuid,'company_website.delivery_request_created','company_website_delivery_request',${created.id}::uuid,${JSON.stringify({ reference, sourceChannel: "company_public_website", websiteSlug: row.slug })}::jsonb,${reference},'public_visitor','public_website','success','web')`.execute(
          transaction,
        );
        return { reference, status: "received", pricing: "company_confirmation_required" };
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505" && input.idempotencyKey) {
        const existing = (
          await sql<{
            publicReference: string;
          }>`select r.public_reference as "publicReference" from company_website_delivery_requests r join company_websites w on w.id=r.company_website_id where w.company_id=${row.companyId}::uuid and r.idempotency_key=${input.idempotencyKey}`.execute(
            this.database,
          )
        ).rows[0];
        if (existing)
          return {
            reference: existing.publicReference,
            status: "received",
            pricing: "company_confirmation_required",
          };
      }
      throw error;
    }
  }

  public async discardDraft(
    companyId: string,
    expectedVersion: number,
    actor: { accountId: string; correlationId: string },
  ): Promise<CompanyWebsiteView> {
    return this.transactions.execute(async (transaction) => {
      const before = await this.row(transaction, companyId, true);
      if (before === undefined) throw this.notFound();
      assertCompanyWebsiteExpectedVersion(before.version, expectedVersion);
      if (before.publishedTemplateKey === null || before.publishedSettings === null) {
        throw new ApplicationException(
          "company_website_discard_unavailable",
          "There is no published website to restore",
          HttpStatus.CONFLICT,
        );
      }
      const result =
        await sql<WebsiteRow>`update company_websites set template_key=published_template_key,draft_settings=published_settings,updated_at=now(),last_updated_by_account_id=${actor.accountId}::uuid,version=version+1 where company_id=${companyId}::uuid and version=${expectedVersion} returning ${this.returningColumns()}`.execute(
          transaction,
        );
      const row = result.rows[0];
      if (!row) throw this.versionConflict();
      await this.audit(transaction, {
        action: "platform.company_website.draft_discarded",
        actorAccountId: actor.accountId,
        companyId,
        correlationId: actor.correlationId,
        before: { templateKey: before.templateKey, settings: before.settings },
        after: { templateKey: row.templateKey, settings: row.settings },
        subjectId: row.id,
      });
      return this.view(row);
    });
  }

  public async publicLogo(host: string | undefined): Promise<{ bytes: Buffer; mediaType: string }> {
    const row = (await this.resolveWebsiteHost(host))?.row;
    if (
      row === undefined ||
      row.status !== "published" ||
      !row.enabled ||
      row.storageKey === null ||
      row.mediaType === null
    )
      throw this.publicNotFound();
    return {
      bytes: Buffer.from(await this.storage.readPrivate(row.companyId, row.storageKey)),
      mediaType: row.mediaType,
    };
  }

  private async transition(
    companyId: string,
    target: "published" | "disabled",
    expectedVersion: number,
    actor: { accountId: string; correlationId: string },
    enabling = false,
  ): Promise<CompanyWebsiteView> {
    return this.transactions.execute(async (transaction) => {
      const before = await this.row(transaction, companyId, true);
      if (before === undefined) throw this.notFound();
      assertCompanyWebsiteExpectedVersion(before.version, expectedVersion);
      const action = target === "disabled" ? "disable" : enabling ? "enable" : "publish";
      const allowed = isCompanyWebsiteTransitionAllowed(before.status, action);
      if (!allowed)
        throw new ApplicationException(
          "company_website_transition_invalid",
          `Cannot move website from ${before.status} to ${target}`,
          HttpStatus.CONFLICT,
        );
      if (target === "published") {
        validateCompanyWebsiteSettings(before.settings);
        const company = (
          await sql<{
            name: string;
          }>`select btrim(name_en) as name from companies where id=${companyId}::uuid and status in ('active','draft')`.execute(
            transaction,
          )
        ).rows[0];
        if (!company?.name)
          throw new ApplicationException(
            "company_website_publish_invalid",
            "A public Company name is required before publishing",
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
      }
      const result = await sql<WebsiteRow>`
        update company_websites set status=${target}, enabled=${target === "published"}, published=true,
          published_template_key=${target === "published" ? sql`template_key` : sql`published_template_key`},
          published_settings=${target === "published" ? sql`draft_settings` : sql`published_settings`},
          published_at=${target === "published" ? sql`now()` : sql`published_at`}, disabled_at=${target === "disabled" ? sql`now()` : null},
          last_published_by_account_id=${actor.accountId}::uuid, last_updated_by_account_id=${actor.accountId}::uuid,
          updated_at=now(), version=version+1 where company_id=${companyId}::uuid and version=${expectedVersion} returning ${this.returningColumns()}
      `.execute(transaction);
      const row = result.rows[0];
      if (row === undefined) throw this.versionConflict();
      await this.audit(transaction, {
        action:
          target === "disabled"
            ? "platform.company_website.disabled"
            : enabling
              ? "platform.company_website.enabled"
              : "platform.company_website.published",
        actorAccountId: actor.accountId,
        companyId,
        correlationId: actor.correlationId,
        before: { status: before.status, templateKey: before.publishedTemplateKey },
        after: { status: row.status, templateKey: row.publishedTemplateKey },
        subjectId: row.id,
      });
      return this.view(row);
    });
  }

  private validateSlug(slug: string): void {
    if (!isValidCompanyWebsiteSlug(slug)) {
      throw new ApplicationException(
        "company_website_slug_invalid",
        "Website slug is invalid or reserved",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  private returningColumns() {
    return sql`id, company_id as "companyId", slug, status, enabled, published, template_key as "templateKey", published_template_key as "publishedTemplateKey", draft_settings as "settings", published_settings as "publishedSettings", primary_language as "primaryLanguage", default_locale as "defaultLocale", created_at as "createdAt", updated_at as "updatedAt", published_at as "publishedAt", disabled_at as "disabledAt", (select username from accounts where id=last_published_by_account_id) as "lastPublishedBy", (select username from accounts where id=last_updated_by_account_id) as "lastUpdatedBy", version`;
  }
  private async row(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    lock = false,
  ): Promise<WebsiteRow | undefined> {
    return (
      await sql<WebsiteRow>`select ${this.returningColumns()} from company_websites where company_id=${companyId}::uuid ${lock ? sql`for update` : sql``}`.execute(
        database,
      )
    ).rows[0];
  }
  private view(row: WebsiteRow): CompanyWebsiteView {
    return {
      ...row,
      hasUnpublishedChanges:
        hasUnpublishedTemplateChanges(row.templateKey, row.publishedTemplateKey) ||
        JSON.stringify(row.settings) !== JSON.stringify(row.publishedSettings),
      websiteUrl: `https://${row.slug}.${this.hostSuffix}`,
    };
  }
  private async publicRow(
    by: "slug" | "company",
    value: string,
  ): Promise<PublicWebsiteRow | undefined> {
    return (
      await sql<PublicWebsiteRow>`select w.company_id as "companyId",w.slug,w.status,w.enabled,w.published,w.template_key as "templateKey",w.published_template_key as "publishedTemplateKey",w.draft_settings as "settings",w.published_settings as "publishedSettings",w.default_locale as "defaultLocale",c.name_en as "nameEn",c.name_ar as "nameAr",c.subtitle_en as "subtitleEn",c.subtitle_ar as "subtitleAr",c.telephone,c.email,c.address_en as "addressEn",c.address_ar as "addressAr",c.logo_file_id as "logoFileId",f.storage_key as "storageKey",f.media_type as "mediaType" from company_websites w join companies c on c.id=w.company_id left join file_objects f on f.id=c.logo_file_id and f.company_id=c.id where ${by === "slug" ? sql`lower(w.slug)=lower(${value})` : sql`w.company_id=${value}::uuid`}`.execute(
        this.database,
      )
    ).rows[0];
  }
  private publicPayload(
    row: PublicWebsiteRow,
    preview: boolean,
    templateKey: CompanyWebsiteTemplateKey,
    canonicalHostname = `${row.slug}.${this.hostSuffix}`,
  ): object {
    const settings = settingsForWebsiteAudience(row.settings, row.publishedSettings, preview);
    if (settings === null) throw this.publicNotFound();
    return {
      availability: "published",
      preview,
      slug: row.slug,
      templateKey,
      settings,
      defaultLocale: row.defaultLocale,
      canonicalUrl: `https://${canonicalHostname}`,
      company: {
        nameEn: row.nameEn,
        nameAr: row.nameAr,
        subtitleEn: row.subtitleEn,
        subtitleAr: row.subtitleAr,
        telephone: preview ? row.telephone : null,
        email: preview ? row.email : null,
        addressEn: preview ? row.addressEn : null,
        addressAr: preview ? row.addressAr : null,
        hasLogo: row.logoFileId !== null,
      },
    };
  }
  private async requirePublishedHost(host: string | undefined): Promise<PublicWebsiteRow> {
    const row = (await this.resolveWebsiteHost(host))?.row;
    if (!row || row.status !== "published" || !row.enabled || !row.publishedSettings)
      throw this.publicNotFound();
    return row;
  }
  private hostname(host: string | undefined): string | undefined {
    if (!host) return undefined;
    return host.trim().toLowerCase().split(":")[0] || undefined;
  }
  private async resolveWebsiteHost(host: string | undefined): Promise<
    | {
        row: PublicWebsiteRow;
        requestedHostname: string;
        primaryHostname: string;
        fallback: boolean;
      }
    | undefined
  > {
    const requestedHostname = this.hostname(host);
    if (!requestedHostname) return undefined;
    const classified = this.hosts.classifyTawseelhubHost(requestedHostname);
    let row: PublicWebsiteRow | undefined;
    let fallback = false;
    if (classified.kind === "company_website") {
      row = await this.publicRow("slug", classified.slug);
      fallback = true;
    } else if (classified.kind === "company_app" || classified.kind === "reserved")
      return undefined;
    else
      row = (
        await sql<PublicWebsiteRow>`select w.company_id as "companyId",w.slug,w.status,w.enabled,w.published,w.template_key as "templateKey",w.published_template_key as "publishedTemplateKey",w.draft_settings as "settings",w.published_settings as "publishedSettings",w.default_locale as "defaultLocale",c.name_en as "nameEn",c.name_ar as "nameAr",c.subtitle_en as "subtitleEn",c.subtitle_ar as "subtitleAr",c.telephone,c.email,c.address_en as "addressEn",c.address_ar as "addressAr",c.logo_file_id as "logoFileId",f.storage_key as "storageKey",f.media_type as "mediaType" from company_website_domains d join company_websites w on w.id=d.company_website_id and w.company_id=d.company_id join companies c on c.id=d.company_id left join file_objects f on f.id=c.logo_file_id and f.company_id=c.id where lower(d.hostname)=lower(${requestedHostname}) and d.status='active' and d.verification_status='verified' and d.ssl_status='active' limit 1`.execute(
          this.database,
        )
      ).rows[0];
    if (!row) return undefined;
    const primary = (
      await sql<{
        hostname: string;
      }>`select hostname from company_website_domains where company_website_id=(select id from company_websites where company_id=${row.companyId}::uuid) and is_primary and status='active' and verification_status='verified' and ssl_status='active' limit 1`.execute(
        this.database,
      )
    ).rows[0]?.hostname;
    return {
      row,
      requestedHostname,
      primaryHostname: primary ?? `${row.slug}.${this.hostSuffix}`,
      fallback,
    };
  }
  private publicStatus(status: string): string {
    return (
      (
        {
          new: "order_received",
          preparing: "preparing",
          assigned: "assigned",
          out_for_delivery: "out_for_delivery",
          delivered: "delivered",
          returned: "returned",
          cancelled: "cancelled",
        } as Record<string, string>
      )[status] ?? "preparing"
    );
  }
  private trackingNotFound(): ApplicationException {
    return new ApplicationException(
      "tracking_not_found",
      "Tracking information was not found",
      HttpStatus.NOT_FOUND,
    );
  }
  private async audit(
    database: Kysely<DatabaseSchema>,
    input: {
      action: string;
      actorAccountId: string;
      companyId: string;
      correlationId: string;
      subjectId: string;
      before: object | null;
      after: object;
    },
  ): Promise<void> {
    await sql`insert into audit_events(company_id,actor_account_id,action,subject_type,subject_id,before_data,after_data,correlation_id,actor_role,source,result,source_application) values(${input.companyId}::uuid,${input.actorAccountId}::uuid,${input.action},'company_website',${input.subjectId}::uuid,${JSON.stringify(input.before)}::jsonb,${JSON.stringify(input.after)}::jsonb,${input.correlationId},'platform_administrator','platform_portal','success','platform-web')`.execute(
      database,
    );
  }
  private notFound(): ApplicationException {
    return new ApplicationException(
      "company_website_not_found",
      "Company website is not configured",
      HttpStatus.NOT_FOUND,
    );
  }
  private publicNotFound(): ApplicationException {
    return new ApplicationException(
      "company_website_not_available",
      "Website is not available",
      HttpStatus.NOT_FOUND,
    );
  }
  private versionConflict(): ApplicationException {
    return new ApplicationException(
      "website_version_conflict",
      "This website was modified by another administrator. Reload the latest version before retrying.",
      HttpStatus.CONFLICT,
    );
  }
}

function settingsAuditActions(
  before: CompanyWebsiteSettings,
  after: CompanyWebsiteSettings,
): string[] {
  const groups: Array<[keyof CompanyWebsiteSettings, string]> = [
    ["branding", "platform.company_website.branding_changed"],
    ["presentation", "platform.company_website.content_changed"],
    ["services", "platform.company_website.services_changed"],
    ["coverage", "platform.company_website.coverage_changed"],
    ["contact", "platform.company_website.contact_changed"],
    ["sections", "platform.company_website.sections_changed"],
    ["languages", "platform.company_website.languages_changed"],
    ["benefits", "platform.company_website.content_changed"],
    ["socialLinks", "platform.company_website.contact_changed"],
    ["knowledge", "platform.company_website.agent_knowledge_changed"],
    ["agent", "platform.company_website.agent_configuration_changed"],
  ];
  return [
    ...new Set(
      groups
        .filter(([key]) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
        .map(([, action]) => action),
    ),
  ];
}
