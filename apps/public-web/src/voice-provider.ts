export type VoiceLanguage = "en" | "ar";

export type SpeechRecognitionResult = {
  transcript: string;
  durationSeconds: number;
};

export interface SpeechToTextProvider {
  readonly id: "browser" | "openai" | "future_provider";
  isSupported(): boolean;
  listen(language: VoiceLanguage): Promise<SpeechRecognitionResult>;
  stop(): void;
  cancel(): void;
}

export interface TextToSpeechProvider {
  readonly id: "openai" | "heygen" | "elevenlabs" | "browser" | "future_provider";
  isSupported(): boolean;
  speak(text: string, language: VoiceLanguage): Promise<{ characterCount: number }>;
  stop(): void;
}

type BrowserRecognitionEvent = Event & {
  results: ArrayLike<{ 0?: { transcript?: string } }>;
};

type BrowserRecognitionErrorEvent = Event & { error?: string };

type BrowserRecognition = EventTarget & {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: BrowserRecognitionEvent) => void) | null;
  onerror: ((event: BrowserRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
};

type BrowserRecognitionConstructor = new () => BrowserRecognition;

declare global {
  interface Window {
    SpeechRecognition?: BrowserRecognitionConstructor;
    webkitSpeechRecognition?: BrowserRecognitionConstructor;
  }
}

export class BrowserSpeechToTextProvider implements SpeechToTextProvider {
  public readonly id = "browser" as const;
  private recognition: BrowserRecognition | null = null;
  private settled = false;
  private rejectPending: ((reason: Error) => void) | null = null;

  public isSupported() {
    return Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition);
  }

  public listen(language: VoiceLanguage): Promise<SpeechRecognitionResult> {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) return Promise.reject(new Error("speech_recognition_unsupported"));
    this.cancel();
    const recognition = new Recognition();
    this.recognition = recognition;
    this.settled = false;
    recognition.lang = language === "ar" ? "ar-AE" : "en-AE";
    recognition.continuous = false;
    recognition.interimResults = false;
    const startedAt = performance.now();

    return new Promise((resolve, reject) => {
      this.rejectPending = reject;
      const finish = (callback: () => void) => {
        if (this.settled) return;
        this.settled = true;
        this.recognition = null;
        this.rejectPending = null;
        callback();
      };
      recognition.onresult = (event) => {
        const transcript = Array.from(event.results)
          .map((result) => result[0]?.transcript ?? "")
          .join(" ")
          .trim();
        finish(() => transcript
          ? resolve({ transcript, durationSeconds: Math.max(0, (performance.now() - startedAt) / 1000) })
          : reject(new Error("speech_not_recognized")));
      };
      recognition.onerror = (event) => finish(() => reject(new Error(event.error || "speech_recognition_failed")));
      recognition.onend = () => finish(() => reject(new Error("speech_not_recognized")));
      try {
        recognition.start();
      } catch {
        finish(() => reject(new Error("speech_recognition_failed")));
      }
    });
  }

  public stop() {
    this.recognition?.stop();
  }

  public cancel() {
    const active = this.recognition;
    const reject = this.rejectPending;
    this.recognition = null;
    this.settled = true;
    this.rejectPending = null;
    active?.abort();
    reject?.(new Error("speech_recognition_cancelled"));
  }
}

export class BrowserTextToSpeechProvider implements TextToSpeechProvider {
  public readonly id = "browser" as const;

  public isSupported() {
    return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  }

  public speak(text: string, language: VoiceLanguage): Promise<{ characterCount: number }> {
    if (!this.isSupported()) return Promise.reject(new Error("speech_synthesis_unsupported"));
    this.stop();
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = language === "ar" ? "ar-AE" : "en-AE";
      const preferred = window.speechSynthesis.getVoices().find((voice) =>
        voice.lang.toLowerCase().startsWith(language),
      );
      if (preferred) utterance.voice = preferred;
      utterance.onend = () => resolve({ characterCount: text.length });
      utterance.onerror = () => reject(new Error("speech_synthesis_failed"));
      window.speechSynthesis.speak(utterance);
    });
  }

  public stop() {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }
}

export function createSpeechToTextProvider(provider: "browser" | "openai" | "future_provider" = "browser") {
  return provider === "browser" ? new BrowserSpeechToTextProvider() : null;
}

export function createTextToSpeechProvider(provider: "browser" | "openai" | "heygen" | "elevenlabs" | "future_provider" = "browser") {
  return provider === "browser" ? new BrowserTextToSpeechProvider() : null;
}
