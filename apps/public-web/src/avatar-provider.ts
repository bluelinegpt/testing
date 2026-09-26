export type AvatarState =
  | "idle"
  | "intro_playing"
  | "intro_finished"
  | "listening"
  | "thinking"
  | "speaking"
  | "error"
  | "offline";

export type AvatarOperationResult =
  | { status: "ok" }
  | { status: "not_supported" }
  | { status: "error"; reason: string };

export interface AvatarProvider {
  initializeSession(): Promise<AvatarOperationResult>;
  playIntro(): Promise<AvatarOperationResult>;
  startListening(): Promise<AvatarOperationResult>;
  stopListening(): Promise<AvatarOperationResult>;
  speakResponse(text: string): Promise<AvatarOperationResult>;
  endSession(): Promise<AvatarOperationResult>;
}

export type LiveAvatarProviderMetrics = {
  sessionDurationSeconds: number;
  responseCount: number;
  initializationMs: number;
  responseFirstFrameMs?: number;
  endReason?: string;
};

export type LiveAvatarProviderOptions = {
  video: HTMLVideoElement;
  createToken: () => Promise<{ token: string; idleTimeoutSeconds: number; maxSessionSeconds?: number; usageId?: string }>;
  onSessionStarted?: (metrics: LiveAvatarProviderMetrics) => void;
  onResponseStarted?: (metrics: LiveAvatarProviderMetrics) => void;
  onResponseCompleted?: (metrics: LiveAvatarProviderMetrics) => void;
  onSessionEnded?: (metrics: LiveAvatarProviderMetrics) => void;
  onError?: (code: string) => void;
};

export class HeyGenLiveAvatarProvider implements AvatarProvider {
  private session: import("@heygen/liveavatar-web-sdk").LiveAvatarSession | null = null;
  private sessionStartedAt = 0;
  private responseRequestedAt = 0;
  private initializationMs = 0;
  private responseCount = 0;
  private idleTimer: number | null = null;
  private maxTimer: number | null = null;
  private idleTimeoutSeconds = 60;

  public constructor(private readonly options: LiveAvatarProviderOptions) {}

  private metrics(): LiveAvatarProviderMetrics {
    return {
      sessionDurationSeconds: this.sessionStartedAt ? (performance.now() - this.sessionStartedAt) / 1000 : 0,
      responseCount: this.responseCount,
      initializationMs: this.initializationMs,
    };
  }

  private resetIdleTimer() {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => void this.endSession("idle_timeout"), this.idleTimeoutSeconds * 1000);
  }

  public async initializeSession(): Promise<AvatarOperationResult> {
    if (this.session) {
      this.resetIdleTimer();
      return ok();
    }
    const started = performance.now();
    try {
      const [{ LiveAvatarSession, SessionEvent, AgentEventsEnum }, token] = await Promise.all([
        import("@heygen/liveavatar-web-sdk"),
        this.options.createToken(),
      ]);
      this.idleTimeoutSeconds = token.idleTimeoutSeconds;
      const session = new LiveAvatarSession(token.token, { voiceChat: false });
      session.on(SessionEvent.SESSION_STREAM_READY, () => session.attach(this.options.video));
      session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
        this.options.onResponseStarted?.({ ...this.metrics(), responseFirstFrameMs: performance.now() - this.responseRequestedAt });
      });
      session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
        this.responseCount += 1;
        this.options.onResponseCompleted?.(this.metrics());
        this.resetIdleTimer();
      });
      session.on(SessionEvent.SESSION_DISCONNECTED, () => {
        if (this.session === session) {
          this.session = null;
          if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
          this.idleTimer = null;
          if (this.maxTimer !== null) window.clearTimeout(this.maxTimer);
          this.maxTimer = null;
          this.options.onSessionEnded?.({ ...this.metrics(), endReason: "provider_disconnected" });
        }
      });
      await session.start();
      this.session = session;
      this.sessionStartedAt = performance.now();
      this.initializationMs = this.sessionStartedAt - started;
      this.options.onSessionStarted?.(this.metrics());
      const maximum = "maxSessionSeconds" in token ? Number(token.maxSessionSeconds) : 300;
      this.maxTimer = window.setTimeout(() => void this.endSession("max_duration"), maximum * 1000);
      this.resetIdleTimer();
      return ok();
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error.message : "live_avatar_init_failed");
      this.options.onSessionEnded?.({ ...this.metrics(), endReason: "initialization_failed" });
      return { status: "error", reason: "live_avatar_init_failed" };
    }
  }

  public async playIntro() { return notSupported(); }
  public async startListening() { return notSupported(); }
  public async stopListening() { return notSupported(); }
  public async speakResponse(text: string): Promise<AvatarOperationResult> {
    const initialized = await this.initializeSession();
    if (initialized.status !== "ok" || !this.session) return initialized;
    try {
      this.responseRequestedAt = performance.now();
      this.session.repeat(text);
      this.resetIdleTimer();
      return ok();
    } catch {
      this.options.onError?.("live_avatar_repeat_failed");
      return { status: "error", reason: "live_avatar_repeat_failed" };
    }
  }
  public interrupt() { this.session?.interrupt(); }
  public async endSession(reason = "client_ended"): Promise<AvatarOperationResult> {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.maxTimer !== null) window.clearTimeout(this.maxTimer);
    this.maxTimer = null;
    const session = this.session;
    this.session = null;
    if (!session) return ok();
    try {
      await session.stop();
      this.options.onSessionEnded?.({ ...this.metrics(), endReason: reason });
      return ok();
    } catch {
      this.options.onError?.("live_avatar_stop_failed");
      return { status: "error", reason: "live_avatar_stop_failed" };
    }
  }
}

const ok = (): AvatarOperationResult => ({ status: "ok" });
const notSupported = (): AvatarOperationResult => ({ status: "not_supported" });

class PrerecordedAvatarProvider implements AvatarProvider {
  public constructor(private readonly video: HTMLVideoElement | null) {}
  public async initializeSession() { return ok(); }
  public async playIntro(): Promise<AvatarOperationResult> {
    if (!this.video) return { status: "error", reason: "video_unavailable" };
    try {
      await this.video.play();
      return ok();
    } catch {
      return { status: "error", reason: "playback_failed" };
    }
  }
  public async startListening() { return notSupported(); }
  public async stopListening() { return notSupported(); }
  public async speakResponse() { return notSupported(); }
  public async endSession() {
    this.video?.pause();
    return ok();
  }
}

class UnsupportedAvatarProvider implements AvatarProvider {
  public async initializeSession() { return notSupported(); }
  public async playIntro() { return notSupported(); }
  public async startListening() { return notSupported(); }
  public async stopListening() { return notSupported(); }
  public async speakResponse() { return notSupported(); }
  public async endSession() { return notSupported(); }
}

export function createAvatarProvider(provider: string, video: HTMLVideoElement | null): AvatarProvider {
  return provider === "prerecorded"
    ? new PrerecordedAvatarProvider(video)
    : new UnsupportedAvatarProvider();
}

export function transcriptTrackUrl(transcript: string): string {
  const cue = transcript.replace(/-->/g, "→").replace(/\r?\n/g, " ");
  return `data:text/vtt;charset=utf-8,${encodeURIComponent(`WEBVTT\n\n00:00.000 --> 59:59.000\n${cue}`)}`;
}
