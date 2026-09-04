// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSpeechToTextProvider, BrowserTextToSpeechProvider, createSpeechToTextProvider, createTextToSpeechProvider } from "./voice-provider";

class RecognitionMock {
  static latest: RecognitionMock;
  lang = "";
  continuous = true;
  interimResults = true;
  onresult: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  constructor() { RecognitionMock.latest = this; }
}

describe("provider-independent browser voice adapters", () => {
  beforeEach(() => {
    window.SpeechRecognition = RecognitionMock as any;
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: { speak: vi.fn(), cancel: vi.fn(), getVoices: vi.fn(() => [{ lang: "ar-AE" }, { lang: "en-US" }]) } });
    window.SpeechSynthesisUtterance = class { lang = ""; voice: unknown; onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(public text: string) {} } as any;
  });

  it("transcribes English and Arabic without retaining raw audio", async () => {
    const provider = new BrowserSpeechToTextProvider();
    const english = provider.listen("en");
    expect(RecognitionMock.latest.lang).toBe("en-AE");
    RecognitionMock.latest.onresult?.({ results: [{ 0: { transcript: "What is Tawseelhub?" } }] });
    await expect(english).resolves.toMatchObject({ transcript: "What is Tawseelhub?" });

    const arabic = provider.listen("ar");
    expect(RecognitionMock.latest.lang).toBe("ar-AE");
    RecognitionMock.latest.onresult?.({ results: [{ 0: { transcript: "ما هي توصيل هب؟" } }] });
    await expect(arabic).resolves.toMatchObject({ transcript: "ما هي توصيل هب؟" });
    expect(provider).not.toHaveProperty("audio");
  });

  it("supports stop, permission errors, cancellation, and unsupported providers", async () => {
    const provider = new BrowserSpeechToTextProvider();
    const denied = provider.listen("en");
    provider.stop();
    expect(RecognitionMock.latest.stop).toHaveBeenCalledOnce();
    RecognitionMock.latest.onerror?.({ error: "not-allowed" });
    await expect(denied).rejects.toThrow("not-allowed");
    const cancelled = provider.listen("en");
    provider.cancel();
    await expect(cancelled).rejects.toThrow("speech_recognition_cancelled");
    expect(RecognitionMock.latest.abort).toHaveBeenCalledOnce();
    expect(createSpeechToTextProvider("openai")).toBeNull();
  });

  it("speaks the same supplied text, selects language, and can stop", async () => {
    const provider = new BrowserTextToSpeechProvider();
    const pending = provider.speak("مرحباً", "ar");
    const utterance = (window.speechSynthesis.speak as any).mock.calls[0][0];
    expect(utterance.lang).toBe("ar-AE");
    utterance.onend();
    await expect(pending).resolves.toEqual({ characterCount: 6 });
    provider.stop();
    expect(window.speechSynthesis.cancel).toHaveBeenCalled();
    expect(createTextToSpeechProvider("heygen")).toBeNull();
  });
});
