// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  stopListening: vi.fn(),
  cancelListening: vi.fn(),
  speak: vi.fn(),
  stopSpeaking: vi.fn(),
  send: vi.fn(),
  track: vi.fn(),
}));

vi.mock("./voice-provider", () => ({
  createSpeechToTextProvider: () => ({
    id: "browser",
    isSupported: () => true,
    listen: mocks.listen,
    stop: mocks.stopListening,
    cancel: mocks.cancelListening,
  }),
  createTextToSpeechProvider: () => ({
    id: "browser",
    isSupported: () => true,
    speak: mocks.speak,
    stop: mocks.stopSpeaking,
  }),
}));

vi.mock("./analytics", () => ({ trackEvent: mocks.track }));

vi.mock("./agent-client", () => ({
  buildWhatsAppMessageUrl: (url: string) => url,
  createAgentConversation: vi
    .fn()
    .mockResolvedValue({
      conversationToken: "token",
      messages: [{ senderType: "assistant", content: "Hello", createdAt: "2026-09-03" }],
    }),
  fallbackAvatarSettings: {
    enabled: true,
    displayName: "Yousef",
    titleEn: "Tawseelhub AI Advisor",
    titleAr: "مستشار توصيل هب الذكي",
    imageUrl: "/default-avatar.svg",
    introVideoUrlEn: "/intro-en.mp4",
    introVideoUrlAr: "/intro-ar.mp4",
    introImageUrlEn: "/intro-en.webp",
    introImageUrlAr: "/intro-ar.webp",
    introTranscriptEn: "English intro",
    introTranscriptAr: "مقدمة عربية",
    showOnHomepage: true,
    showOnPricing: true,
    showOnDeliveryCompany: true,
    showOnTrader: true,
    showOnSendPackage: true,
    autoOpen: false,
    provider: "prerecorded",
    status: "active",
  },
  fallbackWhatsAppSettings: { enabled: false, label: "WhatsApp", number: "", url: null },
  getAgentAvailability: vi
    .fn()
    .mockResolvedValue({
      assistantAvailable: true,
      humanAvailable: false,
      status: "assistant_only",
    }),
  getAvatarSettings: vi
    .fn()
    .mockResolvedValue({
      enabled: true,
      displayName: "Yousef",
      titleEn: "Tawseelhub AI Advisor",
      titleAr: "مستشار توصيل هب الذكي",
      imageUrl: "/default-avatar.svg",
      introVideoUrlEn: "/intro-en.mp4",
      introVideoUrlAr: "/intro-ar.mp4",
      introImageUrlEn: "/intro-en.webp",
      introImageUrlAr: "/intro-ar.webp",
      introTranscriptEn: "English intro",
      introTranscriptAr: "مقدمة عربية",
      showOnHomepage: true,
      showOnPricing: true,
      showOnDeliveryCompany: true,
      showOnTrader: true,
      showOnSendPackage: true,
      autoOpen: false,
      provider: "prerecorded",
      status: "active",
    }),
  getAgentConversation: vi.fn().mockResolvedValue(null),
  getWhatsAppSettings: vi.fn().mockResolvedValue({ enabled: false, url: null }),
  sendAgentMessage: mocks.send,
}));

async function openAvatar() {
  const { AgentChat } = await import("./AgentChat");
  render(<AgentChat />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 720));
  });
  await act(async () => {
    window.dispatchEvent(new CustomEvent("tawseelhub:open-agent"));
  });
  await screen.findByRole("region", { name: "Tawseelhub Assistant" });
}

function enableVoiceReplies() {
  fireEvent.click(screen.getByRole("switch", { name: "Enable voice replies" }));
}

describe("Agent voice conversation", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    HTMLMediaElement.prototype.pause = vi.fn();
    window.localStorage.clear();
    mocks.listen.mockReset();
    mocks.stopListening.mockReset();
    mocks.cancelListening.mockReset();
    mocks.speak.mockReset().mockResolvedValue({ characterCount: 34 });
    mocks.stopSpeaking.mockReset();
    mocks.track.mockReset();
    mocks.send.mockReset().mockResolvedValue({
      language: "en",
      intent: "general_question",
      messages: [
        { senderType: "user", content: "What is Tawseelhub?", createdAt: "1" },
        {
          senderType: "assistant",
          content: "Tawseelhub connects delivery operations.",
          createdAt: "2",
        },
      ],
    });
  });
  afterEach(() => cleanup());

  it("transcribes through the existing Agent, renders text, speaks the same answer, and emits no content analytics", async () => {
    mocks.listen.mockResolvedValue({ transcript: "What is Tawseelhub?", durationSeconds: 1.25 });
    await openAvatar();
    enableVoiceReplies();
    fireEvent.click(screen.getByRole("button", { name: "Ask Yousef by voice" }));
    expect(await screen.findByText("Tawseelhub connects delivery operations.")).toBeVisible();
    await waitFor(() =>
      expect(mocks.speak).toHaveBeenCalledWith("Tawseelhub connects delivery operations.", "en"),
    );
    expect(mocks.send).toHaveBeenCalledWith("token", "What is Tawseelhub?", "en");
    expect(JSON.stringify(mocks.track.mock.calls)).not.toMatch(
      /What is Tawseelhub|connects delivery operations/,
    );
    expect(mocks.track).toHaveBeenCalledWith(
      "speech_to_text_seconds",
      expect.objectContaining({ duration_seconds: 1.25 }),
    );
    expect(mocks.track).toHaveBeenCalledWith(
      "text_to_speech_characters",
      expect.objectContaining({ character_count: 40 }),
    );
    expect(mocks.track).toHaveBeenCalledWith("voice_response_completed", expect.any(Object));
    fireEvent.click(await screen.findByRole("button", { name: "Replay" }));
    await waitFor(() => expect(mocks.speak).toHaveBeenCalledTimes(2));
  });

  it("keeps text chat available when microphone permission is denied", async () => {
    mocks.listen.mockRejectedValue(new Error("not-allowed"));
    await openAvatar();
    fireEvent.click(screen.getByRole("button", { name: "Ask Yousef by voice" }));
    expect(
      await screen.findByText("Voice is unavailable right now. Try again or continue typing."),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Your message" })).not.toBeDisabled();
    expect(mocks.track).toHaveBeenCalledWith(
      "voice_error",
      expect.objectContaining({ error_code: "microphone_denied" }),
    );
  });

  it("uses Arabic recognition, Agent response, speech, and RTL presentation", async () => {
    mocks.listen.mockResolvedValue({ transcript: "ما هي توصيل هب؟", durationSeconds: 1.5 });
    mocks.send.mockResolvedValue({
      language: "ar",
      intent: "general_question",
      messages: [
        { senderType: "user", content: "ما هي توصيل هب؟", createdAt: "1" },
        { senderType: "assistant", content: "توصيل هب منصة تشغيل متكاملة.", createdAt: "2" },
      ],
    });
    await openAvatar();
    enableVoiceReplies();
    fireEvent.click(screen.getByRole("button", { name: "Change chat language to Arabic" }));
    const arabicInput = await screen.findByRole("textbox", { name: "رسالتك" });
    expect(arabicInput.closest(".agent-chat")).toHaveAttribute("dir", "rtl");
    fireEvent.click(screen.getByRole("button", { name: "اسأل يوسف بصوتك" }));
    expect(await screen.findByText("توصيل هب منصة تشغيل متكاملة.")).toBeVisible();
    await waitFor(() =>
      expect(mocks.speak).toHaveBeenCalledWith("توصيل هب منصة تشغيل متكاملة.", "ar"),
    );
    expect(mocks.send).toHaveBeenCalledWith("token", "ما هي توصيل هب؟", "ar");
  });

  it("preserves the visible Agent answer when speech synthesis fails", async () => {
    mocks.listen.mockResolvedValue({ transcript: "What is Tawseelhub?", durationSeconds: 1 });
    mocks.speak.mockRejectedValue(new Error("speech_synthesis_failed"));
    await openAvatar();
    enableVoiceReplies();
    fireEvent.click(screen.getByRole("button", { name: "Ask Yousef by voice" }));
    expect(await screen.findByText("Tawseelhub connects delivery operations.")).toBeVisible();
    expect(
      await screen.findByText("Voice is unavailable right now. Try again or continue typing."),
    ).toBeVisible();
  });

  it("allows the visitor to stop spoken audio while keeping the text answer", async () => {
    mocks.listen.mockResolvedValue({ transcript: "What is Tawseelhub?", durationSeconds: 1 });
    mocks.speak.mockImplementation(() => new Promise(() => undefined));
    await openAvatar();
    enableVoiceReplies();
    fireEvent.click(screen.getByRole("button", { name: "Ask Yousef by voice" }));
    expect(await screen.findByText("Tawseelhub connects delivery operations.")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Stop audio" }));
    expect(mocks.stopSpeaking).toHaveBeenCalled();
    expect(screen.getByText("Tawseelhub connects delivery operations.")).toBeVisible();
  });

  it("cancels microphone and speech when the avatar closes", async () => {
    mocks.listen.mockImplementation(() => new Promise(() => undefined));
    await openAvatar();
    fireEvent.click(screen.getByRole("button", { name: "Ask Yousef by voice" }));
    expect(await screen.findByText(/Listening/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close chat" }));
    expect(mocks.cancelListening).toHaveBeenCalled();
    expect(mocks.stopSpeaking).toHaveBeenCalled();
    fireEvent.click(await screen.findByText("Meet Yousef"));
    expect(await screen.findByRole("region", { name: "Tawseelhub Assistant" })).toBeVisible();
  });

  it("keeps voice replies off by default until the visitor enables them", async () => {
    await openAvatar();
    const voiceSwitch = screen.getByRole("switch", { name: "Enable voice replies" });
    expect(voiceSwitch).not.toBeChecked();

    fireEvent.change(screen.getByRole("textbox", { name: "Your message" }), {
      target: { value: "What is Tawseelhub?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Tawseelhub connects delivery operations.")).toBeVisible();
    expect(mocks.speak).not.toHaveBeenCalled();
  });

  it("keeps one shared avatar stage outside the scrollable conversation as messages grow", async () => {
    mocks.send.mockResolvedValue({
      language: "en",
      intent: "general_question",
      messages: Array.from({ length: 24 }, (_, index) => ({
        senderType: index % 2 ? "assistant" : "user",
        content: `Layout test message ${index + 1}`,
        createdAt: String(index),
      })),
    });
    await openAvatar();
    const stageBefore = document.querySelector(".agent-chat__avatar-stage");
    expect(stageBefore).toBeTruthy();
    expect(stageBefore?.querySelectorAll(".agent-chat__avatar-media")).toHaveLength(1);
    expect(stageBefore?.querySelectorAll("video")).toHaveLength(2);
    expect(stageBefore?.closest(".agent-chat__messages")).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Your message" }), {
      target: { value: "Grow the conversation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Layout test message 24")).toBeVisible();
    expect(document.querySelector(".agent-chat__avatar-stage")).toBe(stageBefore);
    expect(document.querySelectorAll(".agent-chat__avatar-stage")).toHaveLength(1);
    expect(document.querySelector(".agent-chat__messages")?.scrollHeight).toBeGreaterThanOrEqual(0);
  });

  it("falls back from a failed language video to its image and then the default illustration", async () => {
    await openAvatar();
    const stage = document.querySelector(".agent-chat__avatar-stage")!;
    const introVideo = stage.querySelector("video.agent-chat__intro-avatar")!;
    fireEvent.error(introVideo);
    await waitFor(() => expect(stage.querySelector('img[src="/intro-en.webp"]')).toBeTruthy());
    fireEvent.error(stage.querySelector('img[src="/intro-en.webp"]')!);
    await waitFor(() => expect(stage.querySelector('img[src="/default-avatar.svg"]')).toBeTruthy());
  });
});
