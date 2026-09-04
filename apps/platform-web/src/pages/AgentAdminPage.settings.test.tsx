// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const defaults = {
  agentEnabled: true,
  websiteChatEnabled: true,
  whatsappAgentEnabled: true,
  whatsappPublicCtaEnabled: true,
  whatsappProvider: "meta_cloud",
  whatsappBusinessNumber: "+971506898604",
  humanHandoffEnabled: true,
  assistantDisplayName: "Yousef",
  defaultLanguage: "en",
  generalFallbackMessage: "Please try again or contact Tawseelhub support.",
  avatarEnabled: false,
  avatarDisplayName: "Yousef",
  avatarTitleEn: "Tawseelhub AI Advisor",
  avatarTitleAr: "مستشار توصيل هب الذكي",
  avatarImageUrl: "/yousef-ai-advisor.svg",
  avatarIntroVideoUrlEn: null,
  avatarIntroVideoUrlAr: null,
  avatarIntroImageUrlEn: null,
  avatarIntroImageUrlAr: null,
  avatarHomeOperationsImageUrlEn: null,
  avatarHomeOperationsImageUrlAr: null,
  avatarIntroTranscriptEn: "Hi, I’m Yousef, Tawseelhub’s AI advisor.",
  avatarIntroTranscriptAr: "مرحباً، أنا يوسف، المستشار الذكي لمنصة توصيل هب.",
  avatarShowHomepage: true,
  avatarShowPricing: true,
  avatarShowDeliveryCompany: true,
  avatarShowTrader: true,
  avatarShowSendPackage: true,
  avatarAutoOpen: false,
  avatarProvider: "prerecorded",
  avatarStatus: "active",
  avatarLiveEnabled: false,
  avatarLiveProvider: "heygen_live",
  avatarLiveAvatarId: "final-yousef-id",
  avatarLiveVoiceIdEn: "voice-en",
  avatarLiveVoiceIdAr: "voice-ar",
  avatarLiveVoiceAgentIdEn: "agent-en",
  avatarLiveVoiceAgentIdAr: "agent-ar",
  avatarLiveMaxSessionSeconds: 300,
  avatarLiveIdleTimeoutSeconds: 60,
  avatarLiveMaxConcurrentSessions: 2,
  avatarLiveStartRateLimitPerMinute: 3,
  avatarLiveDailyMinuteCap: 120,
  avatarLiveCostPerMinute: 0.25,
  avatarLiveUsage: { todaySessions: 4, todayMinutes: 7.5, activeSessions: 1, responseCount: 8, fallbackCount: 2, providerErrorCount: 1, estimatedCost: 1.88 },
};

const { api } = vi.hoisted(() => ({
  api: {
    agentAssignees: vi.fn().mockResolvedValue([]),
    agentConversations: vi.fn().mockResolvedValue({ counters: {}, items: [], page: 1, pageSize: 25, total: 0 }),
    agentHandoffs: vi.fn().mockResolvedValue([]),
    agentKnowledge: vi.fn().mockResolvedValue([]),
    agentSettings: vi.fn(),
    websiteCms: vi.fn().mockResolvedValue({ media: [] }),
    uploadWebsiteMedia: vi.fn(),
    updateAgentAvatarSettings: vi.fn(),
    updateAgentSettings: vi.fn(),
  },
}));

vi.mock("../api/platform-client.js", () => ({ platformApi: api }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderSettings() {
  const { AgentAdminPage } = await import("./AgentAdminPage.js");
  render(<MemoryRouter><AgentAdminPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: /settings/i }));
}

describe("Agent Administration settings", () => {
  it("renders existing and Website AI Avatar settings with bilingual defaults", async () => {
    api.agentSettings.mockResolvedValueOnce(defaults);
    await renderSettings();
    expect(await screen.findByRole("heading", { name: "Agent Settings" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Website AI Avatar" })).toBeVisible();
    expect(screen.getByDisplayValue("Tawseelhub AI Advisor")).toBeVisible();
    expect(screen.getByDisplayValue("مستشار توصيل هب الذكي")).toHaveAttribute("dir", "rtl");
    expect(screen.getByLabelText(/Auto-open panel/)).not.toBeChecked();
    expect(screen.getByLabelText("Provider")).toHaveValue("prerecorded");
    expect(screen.getByDisplayValue("final-yousef-id")).toBeVisible();
    expect(screen.getByText("7.5")).toBeVisible();
    expect(screen.getByLabelText(/Enable real-time avatar/)).not.toBeChecked();
  });

  it("shows an actionable error instead of a blank tab when the API fails", async () => {
    api.agentSettings.mockRejectedValueOnce(new Error("column missing"));
    await renderSettings();
    expect(await screen.findByRole("alert")).toHaveTextContent("Agent Settings unavailable");
    expect(screen.getByRole("button", { name: "Retry settings" })).toBeVisible();
  });

  it("saves the enabled state through the dedicated avatar endpoint", async () => {
    api.agentSettings.mockResolvedValue(defaults);
    await renderSettings();
    const enabled = await screen.findByLabelText("Avatar enabled");
    fireEvent.click(enabled);
    fireEvent.click(screen.getByRole("button", { name: "Save avatar settings" }));
    await waitFor(() => expect(api.updateAgentAvatarSettings).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      displayName: "Yousef",
      provider: "prerecorded",
      liveAvatarId: "final-yousef-id",
      liveMaxSessionSeconds: 300,
      liveDailyMinuteCap: 120,
      liveCostPerMinute: 0.25,
    })));
  });

  it("keeps English and Arabic intro media references independent", async () => {
    api.agentSettings.mockResolvedValue(defaults);
    await renderSettings();
    const references = await screen.findAllByLabelText("Current media URL/reference");
    fireEvent.change(references[0]!, { target: { value: "https://example.com/english.mp4" } });
    fireEvent.change(references[3]!, { target: { value: "https://example.com/arabic.webp" } });
    fireEvent.click(screen.getByRole("button", { name: "Save avatar settings" }));
    await waitFor(() => expect(api.updateAgentAvatarSettings).toHaveBeenCalledWith(expect.objectContaining({
      introVideoUrlEn: "https://example.com/english.mp4",
      introVideoUrlAr: undefined,
      introImageUrlEn: undefined,
      introImageUrlAr: "https://example.com/arabic.webp",
      liveAvatarId: "final-yousef-id",
      liveVoiceIdEn: "voice-en",
      liveVoiceIdAr: "voice-ar",
    })));
  });

  it("keeps homepage Delivery OS images independent from avatar media and LiveAvatar", async () => {
    api.agentSettings.mockResolvedValue(defaults);
    await renderSettings();
    const references = await screen.findAllByLabelText("Current media URL/reference");
    fireEvent.change(references[4]!, { target: { value: "https://example.com/operations-en.webp" } });
    fireEvent.change(references[5]!, { target: { value: "https://example.com/operations-ar.webp" } });
    fireEvent.click(screen.getByRole("button", { name: "Save avatar settings" }));
    await waitFor(() => expect(api.updateAgentAvatarSettings).toHaveBeenCalledWith(expect.objectContaining({
      homeOperationsImageUrlEn: "https://example.com/operations-en.webp",
      homeOperationsImageUrlAr: "https://example.com/operations-ar.webp",
      introVideoUrlEn: undefined,
      introVideoUrlAr: undefined,
      liveEnabled: false,
      liveAvatarId: "final-yousef-id",
    })));
  });
});
