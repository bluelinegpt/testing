import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationSource = readFileSync(
  resolve(
    process.cwd(),
    "../../database/migrations/20260972000000_agent_lead_capture_metadata.ts",
  ),
  "utf8",
);

describe("Agent lead capture metadata migration", () => {
  it("adds bounded source and explicit contact-request metadata", () => {
    expect(migrationSource).toContain("add column source_hostname text");
    expect(migrationSource).toContain("add column source_page text");
    expect(migrationSource).toContain("add column contact_requested_at timestamptz");
    expect(migrationSource).toContain("add column handoff_requested_at timestamptz");
    expect(migrationSource).toContain("add column conversation_started_at timestamptz");
    expect(migrationSource).toContain("add column contact_captured_at timestamptz");
    expect(migrationSource).toContain("add column qualified_lead_at timestamptz");
    expect(migrationSource).toContain("add column country_code char(2)");
    expect(migrationSource).toContain("add column lead_status text not null default 'not_lead'");
    expect(migrationSource).toContain("create table platform_agent_analytics_events");
    expect(migrationSource).toContain("unique(conversation_id,event_name,dedupe_key)");
    expect(migrationSource).toContain("'has_mobile',new.mobile_number is not null");
    expect(migrationSource).toContain("source_hostname ~ '^[A-Za-z0-9.-]+$'");
    expect(migrationSource).toContain("source_page ~ '^/[A-Za-z0-9/_?&=.%+-]*$'");
  });

  it("backfills only records with captured contact details or a handoff", () => {
    expect(migrationSource).toContain("where c.customer_name is not null");
    expect(migrationSource).toContain("or c.mobile_number is not null");
    expect(migrationSource).toContain("or c.email is not null");
    expect(migrationSource).toContain("from platform_agent_handoffs h");
    expect(migrationSource).toContain("where h.conversation_id = c.id");
    expect(migrationSource).toContain("where sender_type = 'user'");
  });
});
