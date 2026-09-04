export type LiveAvatarLanguage = "en" | "ar";

export type LiveAvatarSessionToken = {
  provider: "heygen_live";
  token: string;
  sandbox: boolean;
  idleTimeoutSeconds: number;
};

export type LiveAvatarSessionOptions = {
  avatarId?: string;
  voiceId?: string;
  voiceAgentId?: string;
  idleTimeoutSeconds: number;
  maxSessionSeconds: number;
};

export interface LiveAvatarServerProvider {
  readonly id: "heygen_live" | "tavus_live" | "future_provider";
  configured(): boolean;
  createSessionToken(language: LiveAvatarLanguage, options: LiveAvatarSessionOptions): Promise<LiveAvatarSessionToken>;
}

const DEFAULT_SANDBOX_AVATAR_ID = "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a";
const DEFAULT_SANDBOX_VOICE_AGENT_ID = "fb88d7b4-0b66-48da-b3a4-c2a4edcf26e2";

export class HeyGenLiveAvatarProvider implements LiveAvatarServerProvider {
  public readonly id = "heygen_live" as const;

  public configured() {
    return Boolean(process.env.HEYGEN_LIVEAVATAR_API_KEY?.trim());
  }

  public async createSessionToken(language: LiveAvatarLanguage, options: LiveAvatarSessionOptions): Promise<LiveAvatarSessionToken> {
    const apiKey = process.env.HEYGEN_LIVEAVATAR_API_KEY?.trim();
    if (!apiKey) throw new Error("live_avatar_not_configured");
    const sandbox = process.env.HEYGEN_LIVEAVATAR_SANDBOX !== "false";
    const avatarId = options.avatarId?.trim() || process.env.HEYGEN_LIVEAVATAR_AVATAR_ID?.trim()
      || (sandbox ? DEFAULT_SANDBOX_AVATAR_ID : "");
    if (!avatarId) throw new Error("live_avatar_missing_avatar_id");
    const voiceAgentId = options.voiceAgentId?.trim() || process.env.HEYGEN_LIVEAVATAR_VOICE_AGENT_ID?.trim()
      || (sandbox ? DEFAULT_SANDBOX_VOICE_AGENT_ID : "");
    if (!voiceAgentId) throw new Error("live_avatar_missing_voice_agent_id");
    const response = await fetch("https://api.liveavatar.com/v1/sessions/token", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        avatar_id: avatarId,
        // HeyGen currently requires FULL plus a voice-agent identity for direct
        // text-to-avatar rendering. The browser never opens voice chat and the
        // client uses repeat(finalTawseelhubAnswer), never message(question), so
        // Tawseelhub remains the sole intelligence and knowledge layer.
        mode: "FULL",
        is_sandbox: sandbox,
        voice_agent: { id: voiceAgentId, language, ...(options.voiceId ? { voice_id: options.voiceId } : {}) },
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`live_avatar_token_failed_${response.status}`);
    const body = await response.json() as { data?: { session_token?: string }; session_token?: string };
    const token = body.data?.session_token ?? body.session_token;
    if (!token) throw new Error("live_avatar_token_missing");
    return { provider: this.id, token, sandbox, idleTimeoutSeconds: options.idleTimeoutSeconds };
  }
}

export function createLiveAvatarServerProvider(provider: string): LiveAvatarServerProvider | null {
  return provider === "heygen_live" ? new HeyGenLiveAvatarProvider() : null;
}
