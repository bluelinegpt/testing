import { describe, expect, it } from "vitest";
import { agentQuickActions, arabicAgentQuickActions, arabicGreeting, englishGreeting, greetingPeriod, tawseelhubAgentInstructions } from "./agent-instructions.js";

describe("Tawseelhub agent instructions", () => {
  it("keeps the public opening in Yousef's voice with all four quick actions", () => {
    expect(englishGreeting(new Date("2026-01-01T10:00:00.000Z"))).toBe("Good afternoon, I’m Yousef, Tawseelhub AI Assistant. How can I help you today?");
    expect(agentQuickActions).toEqual(["Send a Package", "Register as Trader", "Delivery Company Demo", "Learn About Tawseelhub"]);
    expect(arabicAgentQuickActions).toHaveLength(4);
  });

  it("uses UAE time for morning, afternoon, evening and overnight greetings", () => {
    expect(greetingPeriod(new Date("2026-01-01T04:00:00.000Z"))).toBe("morning");
    expect(greetingPeriod(new Date("2026-01-01T10:00:00.000Z"))).toBe("afternoon");
    expect(greetingPeriod(new Date("2026-01-01T15:00:00.000Z"))).toBe("evening");
    expect(greetingPeriod(new Date("2026-01-01T21:00:00.000Z"))).toBe("overnight");
    expect(arabicGreeting(new Date("2026-01-01T04:00:00.000Z"))).toContain("صباح الخير");
  });

  it("contains the required public safety boundaries", () => {
    const instructions = tawseelhubAgentInstructions();

    expect(instructions).toContain("Yousef");
    expect(instructions).toContain("Do not list delivery companies");
    expect(instructions).toContain("Do not invent prices");
    expect(instructions).toContain("Never reveal private company");
    expect(instructions).toContain("Output JSON only");
  });
});
