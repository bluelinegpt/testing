import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { isIP } from "node:net";
import { type Kysely, sql } from "kysely";
import type { AppConfiguration } from "../configuration/environment.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { assertCompanyWebsiteExpectedVersion } from "./company-website.service.js";
import {
  CompanyWebsiteDomainProvider,
  type DomainProviderState,
} from "./company-website-domain.provider.js";

export type CustomDomainStatus =
  "pending_verification" | "verified" | "pending_ssl" | "active" | "failed" | "disabled";
export interface DomainRow {
  id: string;
  companyId: string;
  websiteId: string;
  hostname: string;
  status: CustomDomainStatus;
  verificationStatus: "pending" | "verified" | "failed";
  sslStatus: "pending" | "active" | "failed";
  isPrimary: boolean;
  verificationMethod: string;
  verificationRecords: Array<{ type: string; name: string; value: string }>;
  provider: string;
  providerReference: string | null;
  lastError: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
  activatedAt: string | null;
  disabledAt: string | null;
}

export function normalizeCustomDomainHostname(input: string, tawseelhubSuffix: string): string {
  const value = input.trim().toLowerCase().replace(/\.$/u, "");
  if (
    !value ||
    value.length > 253 ||
    value.includes("://") ||
    /[/?#*\s]/u.test(value) ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 33 || code > 126;
    }) ||
    value.includes("xn--") ||
    isIP(value) !== 0
  )
    invalidDomain();
  const labels = value.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
    !/^[a-z]{2,63}$/u.test(labels.at(-1)!)
  )
    invalidDomain();
  if (
    value === tawseelhubSuffix ||
    value.endsWith(`.${tawseelhubSuffix}`) ||
    ["localhost", "example.com", "example.net", "example.org"].includes(value)
  )
    invalidDomain();
  return value;
}
function invalidDomain(): never {
  throw new ApplicationException(
    "company_website_domain_invalid",
    "Enter a valid ASCII hostname without a protocol, path, wildcard, or Tawseelhub hostname",
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

@Injectable()
export class CompanyWebsiteDomainService {
  private readonly suffix: string;
  private readonly cnameTarget?: string;
  public constructor(
    @Inject(DATABASE) private readonly db: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(CompanyWebsiteDomainProvider) private readonly provider: CompanyWebsiteDomainProvider,
    @Inject(ConfigService) config: ConfigService<AppConfiguration, true>,
  ) {
    this.suffix = config.get("tenancy.hostSuffix", { infer: true }) ?? "tawseelhub.com";
    this.cnameTarget = config.get("websiteDomains.cnameTarget", { infer: true });
  }
  public async list(companyId: string) {
    const website = (
      await sql<{
        id: string;
        slug: string;
        version: number;
      }>`select id,slug,version from company_websites where company_id=${companyId}::uuid`.execute(
        this.db,
      )
    ).rows[0];
    if (!website) throw this.notFound();
    return {
      fallbackHostname: `${website.slug}.${this.suffix}`,
      websiteVersion: website.version,
      cnameTarget: this.cnameTarget ?? null,
      domains: (
        await sql<DomainRow>`select id,company_id "companyId",company_website_id "websiteId",hostname,status,verification_status "verificationStatus",ssl_status "sslStatus",is_primary "isPrimary",verification_method "verificationMethod",verification_records "verificationRecords",provider,provider_reference "providerReference",last_error "lastError",version,created_at "createdAt",updated_at "updatedAt",verified_at "verifiedAt",activated_at "activatedAt",disabled_at "disabledAt" from company_website_domains where company_id=${companyId}::uuid order by is_primary desc,created_at`.execute(
          this.db,
        )
      ).rows,
    };
  }
  public async add(
    companyId: string,
    hostnameInput: string,
    actor: { accountId: string; correlationId: string },
  ) {
    const hostname = normalizeCustomDomainHostname(hostnameInput, this.suffix);
    const website = (
      await sql<{
        id: string;
      }>`select id from company_websites where company_id=${companyId}::uuid`.execute(this.db)
    ).rows[0];
    if (!website) throw this.notFound();
    let state: DomainProviderState;
    try {
      state = await this.provider.create(hostname);
    } catch (error) {
      throw this.providerFailure(error);
    }
    try {
      return await this.transactions.execute(async (trx) => {
        const row = (
          await sql<DomainRow>`insert into company_website_domains(company_website_id,company_id,hostname,verification_records,provider,provider_reference,last_updated_by_account_id) values(${website.id}::uuid,${companyId}::uuid,${hostname},${JSON.stringify(state.records)}::jsonb,${this.provider.name},${state.reference},${actor.accountId}::uuid) returning id,company_id "companyId",company_website_id "websiteId",hostname,status,verification_status "verificationStatus",ssl_status "sslStatus",is_primary "isPrimary",verification_method "verificationMethod",verification_records "verificationRecords",provider,provider_reference "providerReference",last_error "lastError",version,created_at "createdAt",updated_at "updatedAt",verified_at "verifiedAt",activated_at "activatedAt",disabled_at "disabledAt"`.execute(
            trx,
          )
        ).rows[0]!;
        await this.audit(trx, companyId, actor, "custom_domain_added", row.id, null, {
          hostname,
          provider: this.provider.name,
        });
        return row;
      });
    } catch (error) {
      void this.provider.remove(state.reference).catch(() => undefined);
      if ((error as { code?: string }).code === "23505")
        throw new ApplicationException(
          "company_website_domain_taken",
          "This domain is already connected to Tawseelhub",
          HttpStatus.CONFLICT,
        );
      throw error;
    }
  }
  public async refresh(
    companyId: string,
    id: string,
    expectedVersion: number,
    actor: { accountId: string; correlationId: string },
  ) {
    const before = await this.domain(companyId, id);
    if (before.version !== expectedVersion) throw this.conflict();
    if (!before.providerReference)
      throw this.providerFailure(new Error("provider_reference_missing"));
    let state: DomainProviderState;
    try {
      state = await this.provider.refresh(before.providerReference);
    } catch (error) {
      await sql`update company_website_domains set status='failed',last_error=${safeError(error)},updated_at=now(),version=version+1,last_updated_by_account_id=${actor.accountId}::uuid where id=${id}::uuid and company_id=${companyId}::uuid and version=${expectedVersion}`.execute(
        this.db,
      );
      throw this.providerFailure(error);
    }
    const mapped = mapState(state);
    return this.transactions.execute(async (trx) => {
      const row = (
        await sql<DomainRow>`update company_website_domains set status=${mapped.status},verification_status=${mapped.verification},ssl_status=${mapped.ssl},verification_records=${JSON.stringify(state.records)}::jsonb,last_error=${state.error ?? null},verified_at=case when ${mapped.verification}='verified' then coalesce(verified_at,now()) else verified_at end,activated_at=case when ${mapped.status}='active' then coalesce(activated_at,now()) else activated_at end,updated_at=now(),version=version+1,last_updated_by_account_id=${actor.accountId}::uuid where id=${id}::uuid and company_id=${companyId}::uuid and version=${expectedVersion} returning id,company_id "companyId",company_website_id "websiteId",hostname,status,verification_status "verificationStatus",ssl_status "sslStatus",is_primary "isPrimary",verification_method "verificationMethod",verification_records "verificationRecords",provider,provider_reference "providerReference",last_error "lastError",version,created_at "createdAt",updated_at "updatedAt",verified_at "verifiedAt",activated_at "activatedAt",disabled_at "disabledAt"`.execute(
          trx,
        )
      ).rows[0];
      if (!row) throw this.conflict();
      const action =
        row.status === "active" && before.status !== "active"
          ? "custom_domain_activated"
          : row.verificationStatus === "verified" && before.verificationStatus !== "verified"
            ? "custom_domain_verified"
            : row.status === "failed"
              ? "custom_domain_verification_failed"
              : "custom_domain_status_refreshed";
      await this.audit(
        trx,
        companyId,
        actor,
        action,
        id,
        { status: before.status, sslStatus: before.sslStatus },
        { status: row.status, sslStatus: row.sslStatus },
      );
      return row;
    });
  }
  public async makePrimary(
    companyId: string,
    id: string,
    domainVersion: number,
    websiteVersion: number,
    actor: { accountId: string; correlationId: string },
  ) {
    await this.transactions.execute(async (trx) => {
      const website = (
        await sql<{
          id: string;
          version: number;
        }>`select id,version from company_websites where company_id=${companyId}::uuid for update`.execute(
          trx,
        )
      ).rows[0];
      if (!website) throw this.notFound();
      assertCompanyWebsiteExpectedVersion(website.version, websiteVersion);
      const domain = (
        await sql<DomainRow>`select id,company_id "companyId",company_website_id "websiteId",hostname,status,verification_status "verificationStatus",ssl_status "sslStatus",is_primary "isPrimary",verification_method "verificationMethod",verification_records "verificationRecords",provider,provider_reference "providerReference",last_error "lastError",version,created_at "createdAt",updated_at "updatedAt",verified_at "verifiedAt",activated_at "activatedAt",disabled_at "disabledAt" from company_website_domains where id=${id}::uuid and company_id=${companyId}::uuid for update`.execute(
          trx,
        )
      ).rows[0];
      if (!domain) throw this.notFound();
      if (domain.version !== domainVersion) throw this.conflict();
      if (
        domain.status !== "active" ||
        domain.sslStatus !== "active" ||
        domain.verificationStatus !== "verified"
      )
        throw new ApplicationException(
          "company_website_domain_not_active",
          "Only a verified domain with active SSL can become primary",
          HttpStatus.CONFLICT,
        );
      await sql`update company_website_domains set is_primary=false,updated_at=now(),version=version+1,last_updated_by_account_id=${actor.accountId}::uuid where company_website_id=${website.id}::uuid and is_primary;update company_website_domains set is_primary=true,updated_at=now(),version=version+1,last_updated_by_account_id=${actor.accountId}::uuid where id=${id}::uuid;update company_websites set version=version+1,updated_at=now(),last_updated_by_account_id=${actor.accountId}::uuid where id=${website.id}::uuid and version=${websiteVersion}`.execute(
        trx,
      );
      await this.audit(trx, companyId, actor, "custom_domain_made_primary", id, null, {
        hostname: domain.hostname,
      });
    });
    return this.list(companyId);
  }
  public async disable(
    companyId: string,
    id: string,
    expectedVersion: number,
    actor: { accountId: string; correlationId: string },
  ) {
    const before = await this.domain(companyId, id);
    if (before.version !== expectedVersion) throw this.conflict();
    const row = (
      await sql<DomainRow>`update company_website_domains set status='disabled',is_primary=false,disabled_at=now(),updated_at=now(),version=version+1,last_updated_by_account_id=${actor.accountId}::uuid where id=${id}::uuid and company_id=${companyId}::uuid and version=${expectedVersion} returning *`.execute(
        this.db,
      )
    ).rows[0];
    if (!row) throw this.conflict();
    await this.audit(
      this.db,
      companyId,
      actor,
      "custom_domain_disabled",
      id,
      { status: before.status },
      { status: "disabled" },
    );
    return this.list(companyId);
  }
  public async remove(
    companyId: string,
    id: string,
    expectedVersion: number,
    actor: { accountId: string; correlationId: string },
  ) {
    const before = await this.domain(companyId, id);
    if (before.version !== expectedVersion) throw this.conflict();
    if (before.providerReference)
      try {
        await this.provider.remove(before.providerReference);
      } catch (error) {
        throw this.providerFailure(error);
      }
    await this.transactions.execute(async (trx) => {
      const deleted =
        await sql`delete from company_website_domains where id=${id}::uuid and company_id=${companyId}::uuid and version=${expectedVersion}`.execute(
          trx,
        );
      if (Number(deleted.numAffectedRows) !== 1) throw this.conflict();
      await this.audit(
        trx,
        companyId,
        actor,
        "custom_domain_removed",
        id,
        { hostname: before.hostname },
        {},
      );
    });
    return this.list(companyId);
  }
  private async domain(companyId: string, id: string) {
    const row = (
      await sql<DomainRow>`select id,company_id "companyId",company_website_id "websiteId",hostname,status,verification_status "verificationStatus",ssl_status "sslStatus",is_primary "isPrimary",verification_method "verificationMethod",verification_records "verificationRecords",provider,provider_reference "providerReference",last_error "lastError",version,created_at "createdAt",updated_at "updatedAt",verified_at "verifiedAt",activated_at "activatedAt",disabled_at "disabledAt" from company_website_domains where id=${id}::uuid and company_id=${companyId}::uuid`.execute(
        this.db,
      )
    ).rows[0];
    if (!row) throw this.notFound();
    return row;
  }
  private async audit(
    db: Kysely<DatabaseSchema>,
    companyId: string,
    actor: { accountId: string; correlationId: string },
    action: string,
    subjectId: string,
    before: object | null,
    after: object,
  ) {
    await sql`insert into audit_events(company_id,actor_account_id,action,subject_type,subject_id,before_data,after_data,correlation_id,actor_role,source,result,source_application) values(${companyId}::uuid,${actor.accountId}::uuid,${`platform.company_website.${action}`},'company_website_domain',${subjectId}::uuid,${JSON.stringify(before)}::jsonb,${JSON.stringify(after)}::jsonb,${actor.correlationId},'platform_administrator','platform_portal','success','platform-web')`.execute(
      db,
    );
  }
  private conflict() {
    return new ApplicationException(
      "company_website_domain_version_conflict",
      "This domain changed. Reload before retrying.",
      HttpStatus.CONFLICT,
    );
  }
  private notFound() {
    return new ApplicationException(
      "company_website_domain_not_found",
      "Custom domain was not found",
      HttpStatus.NOT_FOUND,
    );
  }
  private providerFailure(error: unknown) {
    return new ApplicationException(
      "company_website_domain_provider_error",
      safeError(error),
      HttpStatus.BAD_GATEWAY,
    );
  }
}
function mapState(state: DomainProviderState) {
  const verified = state.hostnameStatus === "active",
    sslActive = state.sslStatus === "active";
  return {
    verification: verified
      ? ("verified" as const)
      : state.hostnameStatus.includes("fail")
        ? ("failed" as const)
        : ("pending" as const),
    ssl: sslActive
      ? ("active" as const)
      : state.sslStatus.includes("fail")
        ? ("failed" as const)
        : ("pending" as const),
    status: (verified && sslActive
      ? "active"
      : verified
        ? "pending_ssl"
        : state.hostnameStatus.includes("fail") || state.sslStatus.includes("fail")
          ? "failed"
          : "pending_verification") as CustomDomainStatus,
  };
}
function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Domain provider request failed";
  return message.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").slice(0, 500);
}
