import { describe, expect, it } from "vitest";
import { arabicGeneralFallback, generalKnowledgeContent, isAgentPriceQuestionText, isCorruptedArabicText, publicAgentLabel } from "./agent.service.js";

describe("AgentService general knowledge content", () => {
  it("does not show corrupted question-mark Arabic seed data to visitors", () => {
    const corrupted = "????? ?? ???? ????? ?????? ??????? ?? ???? ????????";

    expect(isCorruptedArabicText(corrupted)).toBe(true);
    expect(generalKnowledgeContent("ar", corrupted)).toBe(arabicGeneralFallback);
    expect(generalKnowledgeContent("ar", corrupted)).toMatch(/[\u0600-\u06ff]/);
    expect(generalKnowledgeContent("ar", corrupted)).not.toContain("???");
  });

  it("keeps valid Arabic and English knowledge content unchanged", () => {
    const arabic = "توصيل هب منصة لإدارة عمليات التوصيل.";
    const english = "Tawseelhub is a Delivery Operating System.";

    expect(generalKnowledgeContent("ar", arabic)).toBe(arabic);
    expect(generalKnowledgeContent("en", english)).toBe(english);
  });
});

describe("AgentService quote workflow helpers", () => {
  it("recognizes price questions and common typos before slot filling", () => {
    expect(isAgentPriceQuestionText("what is cost")).toBe(true);
    expect(isAgentPriceQuestionText("wha tis the cost")).toBe(true);
    expect(isAgentPriceQuestionText("how much")).toBe(true);
    expect(isAgentPriceQuestionText("price?")).toBe(true);
    expect(isAgentPriceQuestionText("كم السعر؟")).toBe(true);
  });

  it("renders internal enum values as public labels", () => {
    expect(publicAgentLabel("small_parcel")).toBe("Small Parcel");
    expect(publicAgentLabel("same_day")).toBe("Same Day");
  });
});
