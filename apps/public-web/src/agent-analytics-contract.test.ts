// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { trackEventOnce } from "./analytics";

describe("Agent analytics lifecycle", () => {
  it("uses distinct names and dedupe keys for the Agent lifecycle", () => {
    expect(trackEventOnce("agent_opened", "open-1")?.event).toBe("agent_opened");
    expect(trackEventOnce("agent_conversation_started", "AGT-000001")?.event).toBe("agent_conversation_started");
    expect(trackEventOnce("agent_conversation_started", "AGT-000001")).toBeUndefined();
    expect(trackEventOnce("agent_contact_captured", "AGT-000001")?.event).toBe("agent_contact_captured");
    expect(trackEventOnce("agent_lead_created", "AGT-000001")?.event).toBe("agent_lead_created");
  });
});
