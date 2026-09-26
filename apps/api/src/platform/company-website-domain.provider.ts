import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppConfiguration } from "../configuration/environment.js";

export interface DomainProviderState {
  reference: string;
  hostnameStatus: string;
  sslStatus: string;
  records: Array<{ type: "TXT" | "CNAME"; name: string; value: string }>;
  error?: string;
}
export abstract class CompanyWebsiteDomainProvider {
  public abstract readonly name: string;
  public abstract create(hostname: string): Promise<DomainProviderState>;
  public abstract refresh(reference: string): Promise<DomainProviderState>;
  public abstract remove(reference: string): Promise<void>;
}

@Injectable()
export class CloudflareCompanyWebsiteDomainProvider extends CompanyWebsiteDomainProvider {
  public readonly name: string;
  private readonly token: string | undefined;
  private readonly zoneId: string | undefined;
  public constructor(@Inject(ConfigService) config: ConfigService<AppConfiguration, true>) {
    super();
    const domains = config.get("websiteDomains", { infer: true });
    this.name = domains.provider;
    this.token = domains.cloudflareApiToken;
    this.zoneId = domains.cloudflareZoneId;
  }
  public async create(hostname: string): Promise<DomainProviderState> {
    this.assertConfigured();
    try {
      return this.state(
        await this.call("POST", "", { hostname, ssl: { method: "txt", type: "dv" } }),
      );
    } catch (error) {
      const existing = await this.find(hostname).catch(() => undefined);
      if (existing) return existing;
      throw error;
    }
  }
  public async refresh(reference: string): Promise<DomainProviderState> {
    this.assertConfigured();
    return this.state(await this.call("GET", `/${encodeURIComponent(reference)}`));
  }
  public async remove(reference: string): Promise<void> {
    this.assertConfigured();
    await this.call("DELETE", `/${encodeURIComponent(reference)}`);
  }
  private assertConfigured(): void {
    if (this.name !== "cloudflare" || !this.token || !this.zoneId)
      throw new Error("custom_domain_provider_not_configured");
  }
  private async call(
    method: string,
    path: string,
    body?: object,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${this.zoneId}/custom_hostnames${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (method === "DELETE" && response.status === 404) return {};
    const payload = (await response.json()) as {
      success?: boolean;
      result?: Record<string, unknown>;
      errors?: Array<{ message?: string }>;
    };
    if (!response.ok || payload.success !== true || !payload.result)
      throw new Error(payload.errors?.[0]?.message ?? `domain_provider_http_${response.status}`);
    return payload.result;
  }
  private async find(hostname: string): Promise<DomainProviderState | undefined> {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${this.zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    const payload = (await response.json()) as {
      success?: boolean;
      result?: Array<Record<string, unknown>>;
    };
    if (!response.ok || payload.success !== true)
      throw new Error(`domain_provider_http_${response.status}`);
    return payload.result?.[0] ? this.state(payload.result[0]) : undefined;
  }
  private state(result: Record<string, unknown>): DomainProviderState {
    const ownership = result.ownership_verification as
      { type?: string; name?: string; value?: string } | undefined;
    const ssl = result.ssl as
      | { status?: string; validation_records?: Array<{ txt_name?: string; txt_value?: string }> }
      | undefined;
    const records: DomainProviderState["records"] = [];
    if (ownership?.name && ownership.value)
      records.push({
        type: ownership.type === "cname" ? "CNAME" : "TXT",
        name: ownership.name,
        value: ownership.value,
      });
    for (const record of ssl?.validation_records ?? [])
      if (record.txt_name && record.txt_value)
        records.push({ type: "TXT", name: record.txt_name, value: record.txt_value });
    return {
      reference: String(result.id),
      hostnameStatus: String(result.status ?? "pending"),
      sslStatus: String(ssl?.status ?? "pending"),
      records,
    };
  }
}
