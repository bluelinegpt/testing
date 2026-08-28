import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Company website agent tenant isolation certification", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/platform/company-website-agent.service.ts"),
    "utf8",
  );
  it("derives the public tenant from the hostname and uses published settings only", () => {
    expect(source).toContain('classified.kind === "company_app" || classified.kind === "reserved"');
    expect(source).toContain(
      "d.status='active' and d.verification_status='verified' and d.ssl_status='active'",
    );
    expect(source).toContain("w.published_settings as settings");
    const publicResolver = source.slice(
      source.indexOf("private async publicWebsite"),
      source.indexOf("private assertEnabled"),
    );
    expect(publicResolver).not.toContain("draft_settings");
  });
  it("binds conversation lookup to token, Company and website", () => {
    expect(source).toContain(
      "public_token_hash=${hash(token)} and company_id=${row.companyId}::uuid and company_website_id=${row.websiteId}::uuid",
    );
  });
  it("keeps draft preview private and separate from persisted public conversations", () => {
    expect(source).toContain("w.draft_settings as settings");
    const previewBody = source.slice(
      source.indexOf("public async preview"),
      source.indexOf("private async publicWebsite"),
    );
    expect(previewBody).not.toContain("company_website_agent_conversations");
  });
  it("routes opaque tracking references through the existing public-safe Company flow", () => {
    expect(source).toContain("this.websites.trackPublic(host, token)");
    const trackingReply = source.slice(
      source.indexOf("private async trackingReply"),
      source.indexOf("private notFound"),
    );
    expect(trackingReply).not.toMatch(
      /customer|mobile|email|address|driver|trader|settlement|accounting/iu,
    );
  });
});
