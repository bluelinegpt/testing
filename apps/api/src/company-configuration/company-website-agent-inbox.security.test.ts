import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Company website agent inbox tenant isolation", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/company-configuration/company-website-agent-inbox.service.ts"),
    "utf8",
  );

  it("derives Company scope from the authenticated identity for list and detail", () => {
    expect(source).toContain("this.identities.current().companyId");
    expect(source.match(/where company_id=\$\{companyId\}::uuid/gu)).toHaveLength(1);
    expect(source).toContain("where id=${id}::uuid and company_id=${companyId}::uuid");
  });

  it("does not select token or visitor IP hashes into the Company DTO", () => {
    expect(source).not.toContain("public_token_hash as");
    expect(source).not.toContain("visitor_ip_hash as");
  });
});
