/**
 * Voice messaging for the Office Communication Center (Prompt 14, Office Web
 * piece only): a mic-driven composer control (record → preview → send) and a
 * compact playback control reused for both the local preview and delivered
 * timeline messages. Kept in its own file, as `CommunicationCenter.tsx` is
 * already a large single-feature component.
 */
import { Loader2, Mic, Pause, Play, Send, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { ApiError } from "../../api/api-client.js";
import type { CommunicationApi, CommunicationMessage } from "./communication-api.js";

const VOICE_MAX_DURATION_SECONDS = 300;
const VOICE_MAX_SIZE_BYTES = 10 * 1024 * 1024;

function requestErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.details === undefined || error.details.length === 0
      ? error.message
      : `${error.message}\n${error.details.join("\n")}`;
  }
  return error instanceof Error ? error.message : fallback;
}

/** Maps the backend's voice-message rejection codes to friendly, translated
 *  text; anything else falls back to the server/network error message. */
function voiceSendErrorMessage(error: unknown, t: TFunction): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "voice_message_empty":
        return t("communication.voice.errors.empty");
      case "voice_message_too_large":
        return t("communication.voice.errors.tooLarge");
      case "voice_message_unsupported_type":
        return t("communication.voice.errors.unsupportedType");
      case "voice_message_duration_invalid":
        return t("communication.voice.errors.durationInvalid");
      default:
        break;
    }
  }
  return requestErrorMessage(error, t("communication.voice.sendFailed"));
}

function formatDuration(totalSeconds: number): string {
  const safeSeconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = Math.floor(safeSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function isRecorderSupported(): boolean {
  return (
    typeof globalThis.MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

/** Prefers `audio/webm` (Chrome/Firefox/Edge default), falls back to
 *  `audio/ogg`; `undefined` means this browser can't produce a type the
 *  backend accepts. */
function pickRecordingMimeType(): string | undefined {
  if (typeof globalThis.MediaRecorder === "undefined") return undefined;
  if (typeof globalThis.MediaRecorder.isTypeSupported !== "function") return "audio/webm";
  if (globalThis.MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
  if (globalThis.MediaRecorder.isTypeSupported("audio/ogg")) return "audio/ogg";
  return undefined;
}

// --- Shared playback coordination: starting one player pauses any other. ---
type PlaybackListener = (playingId: string) => void;

class VoicePlaybackCoordinator {
  private readonly listeners = new Set<PlaybackListener>();

  public notifyPlaying(id: string): void {
    for (const listener of this.listeners) listener(id);
  }

  public subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const voicePlaybackCoordinator = new VoicePlaybackCoordinator();

type PlaybackStatus = "idle" | "loading" | "ready" | "error";

/**
 * Compact, business-style inline audio control: Play/Pause, elapsed/total
 * duration, a slim progress bar. The audio Blob is fetched lazily via
 * `loadBlob` on the first Play press only (never eagerly).
 */
function AudioPlaybackControl({
  id,
  initialDurationSeconds,
  loadBlob,
}: {
  readonly id: string;
  readonly initialDurationSeconds: number;
  readonly loadBlob: () => Promise<Blob>;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PlaybackStatus>("idle");
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(initialDurationSeconds);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | undefined>(undefined);
  const loadedRef = useRef(false);

  useEffect(
    () =>
      voicePlaybackCoordinator.subscribe((playingId) => {
        if (playingId === id) return;
        const audio = audioRef.current;
        if (audio !== null) {
          try {
            audio.pause();
          } catch {
            // best-effort — some test/runtime environments don't implement it
          }
        }
        setIsPlaying(false);
      }),
    [id],
  );

  // Release the object URL and stop audio on unmount (component removed, or
  // the owning conversation/message list changed and this instance is gone).
  useEffect(
    () => () => {
      if (objectUrlRef.current !== undefined) URL.revokeObjectURL(objectUrlRef.current);
      const audio = audioRef.current;
      if (audio !== null) {
        try {
          audio.pause();
        } catch {
          // ignore
        }
      }
    },
    [],
  );

  const playLoadedAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    try {
      const result: unknown = audio.play();
      if (
        result !== undefined &&
        result !== null &&
        typeof (result as Promise<void>).catch === "function"
      ) {
        void (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Unsupported in some environments (e.g. jsdom) — state is already
      // tracked optimistically via `isPlaying`.
    }
  }, []);

  const togglePlay = useCallback(async () => {
    if (status === "loading") return;
    if (loadedRef.current) {
      const audio = audioRef.current;
      if (isPlaying) {
        if (audio !== null) {
          try {
            audio.pause();
          } catch {
            // ignore
          }
        }
        setIsPlaying(false);
        return;
      }
      voicePlaybackCoordinator.notifyPlaying(id);
      setIsPlaying(true);
      playLoadedAudio();
      return;
    }
    setStatus("loading");
    try {
      const blob = await loadBlob();
      objectUrlRef.current = URL.createObjectURL(blob);
      loadedRef.current = true;
      setStatus("ready");
      voicePlaybackCoordinator.notifyPlaying(id);
      setIsPlaying(true);
    } catch {
      setStatus("error");
    }
  }, [id, isPlaying, loadBlob, playLoadedAudio, status]);

  // The audio element only receives its `src` once `status` becomes "ready"
  // (next render); start playback once that src is actually attached.
  useEffect(() => {
    if (status === "ready" && isPlaying) playLoadedAudio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const progressPercent = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;

  return (
    <div className="communication-voice-player">
      <button
        aria-label={isPlaying ? t("communication.voice.pause") : t("communication.voice.play")}
        className="communication-voice-play-button"
        disabled={status === "loading"}
        onClick={() => void togglePlay()}
        type="button"
      >
        {status === "loading" ? (
          <Loader2 aria-hidden="true" className="spin" />
        ) : isPlaying ? (
          <Pause aria-hidden="true" />
        ) : (
          <Play aria-hidden="true" />
        )}
      </button>
      <div className="communication-voice-progress">
        <span className="communication-voice-progress-bar">
          <span
            className="communication-voice-progress-fill"
            style={{ width: `${progressPercent}%` }}
          />
        </span>
        <small className="communication-voice-duration">
          {formatDuration(elapsed)} / {formatDuration(duration)}
        </small>
      </div>
      {status === "error" && (
        <span className="communication-voice-player-error" role="alert">
          {t("communication.voice.playbackUnavailable")}
          <button
            className="button button-secondary button-compact"
            onClick={() => void togglePlay()}
            type="button"
          >
            {t("communication.voice.retry")}
          </button>
        </span>
      )}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- machine-generated voice notes have no captions to attach */}
      <audio
        hidden
        onEnded={() => setIsPlaying(false)}
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value)) setDuration(value);
        }}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime)}
        ref={audioRef}
        src={objectUrlRef.current}
      />
    </div>
  );
}

/** Timeline rendering for a delivered `messageType === "voice"` message. */
export function VoiceMessagePlayer({
  client,
  message,
}: {
  readonly client: CommunicationApi;
  readonly message: CommunicationMessage;
}) {
  const loadBlob = useCallback(() => client.messageMedia(message.id), [client, message.id]);
  return (
    <AudioPlaybackControl
      id={message.id}
      initialDurationSeconds={message.mediaDurationSeconds ?? 0}
      loadBlob={loadBlob}
    />
  );
}

// --- Composer: record → preview → send -------------------------------------

interface RecordingKeys {
  readonly clientMessageId: string;
  readonly idempotencyKey: string;
}

type RecorderPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "permissionDenied" }
  | { readonly kind: "recording"; readonly elapsedSeconds: number }
  | {
      readonly kind: "invalid";
      readonly blob: Blob;
      readonly durationSeconds: number;
      readonly message: string;
    }
  | {
      readonly kind: "preview";
      readonly blob: Blob;
      readonly durationSeconds: number;
      readonly hitDurationLimit: boolean;
    }
  | { readonly kind: "sending"; readonly blob: Blob; readonly durationSeconds: number }
  | {
      readonly kind: "error";
      readonly blob: Blob;
      readonly durationSeconds: number;
      readonly message: string;
    };

export function VoiceRecorderControl({
  client,
  conversationId,
  disabled,
  onSent,
}: {
  readonly client: CommunicationApi;
  readonly conversationId: string;
  readonly disabled: boolean;
  readonly onSent: (message: CommunicationMessage) => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<RecorderPhase>(() =>
    isRecorderSupported() ? { kind: "idle" } : { kind: "unsupported" },
  );

  const mediaRecorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof globalThis.setInterval> | undefined>(undefined);
  const elapsedRef = useRef(0);
  const hitLimitRef = useRef(false);
  const discardOnStopRef = useRef(false);
  const sendKeysRef = useRef<RecordingKeys | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (timerRef.current !== undefined) globalThis.clearInterval(timerRef.current);
      const recorder = mediaRecorderRef.current;
      if (recorder !== undefined && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // ignore — we still stop the underlying tracks below
        }
      }
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    },
    [],
  );

  const stopStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = undefined;
  }, []);

  const finishRecording = useCallback(() => {
    if (timerRef.current !== undefined) {
      globalThis.clearInterval(timerRef.current);
      timerRef.current = undefined;
    }
    stopStream();
    if (!mountedRef.current) return;
    if (discardOnStopRef.current) {
      setPhase({ kind: "idle" });
      return;
    }
    // The backend requires at least 1 second; a Stop pressed inside the first
    // tick of the elapsed-time interval would otherwise report 0.
    const durationSeconds = Math.max(1, elapsedRef.current);
    const mimeType = mediaRecorderRef.current?.mimeType ?? "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mimeType });
    sendKeysRef.current = undefined;
    if (blob.size === 0) {
      setPhase({
        kind: "invalid",
        blob,
        durationSeconds,
        message: t("communication.voice.errors.empty"),
      });
    } else if (blob.size > VOICE_MAX_SIZE_BYTES) {
      setPhase({
        kind: "invalid",
        blob,
        durationSeconds,
        message: t("communication.voice.errors.tooLarge"),
      });
    } else {
      setPhase({ kind: "preview", blob, durationSeconds, hitDurationLimit: hitLimitRef.current });
    }
  }, [stopStream, t]);

  const stopRecording = useCallback(() => {
    discardOnStopRef.current = false;
    mediaRecorderRef.current?.stop();
  }, []);

  const cancelRecording = useCallback(() => {
    discardOnStopRef.current = true;
    mediaRecorderRef.current?.stop();
  }, []);

  const startRecording = useCallback(async () => {
    if (disabled) return;
    const mimeType = pickRecordingMimeType();
    if (mimeType === undefined) {
      setPhase({ kind: "unsupported" });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (mountedRef.current) setPhase({ kind: "permissionDenied" });
      return;
    }
    if (!mountedRef.current) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const recorder = new MediaRecorder(stream, { mimeType });
    chunksRef.current = [];
    discardOnStopRef.current = false;
    elapsedRef.current = 0;
    hitLimitRef.current = false;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    });
    recorder.addEventListener("stop", finishRecording);
    mediaRecorderRef.current = recorder;
    streamRef.current = stream;
    recorder.start();
    setPhase({ kind: "recording", elapsedSeconds: 0 });
    timerRef.current = globalThis.setInterval(() => {
      elapsedRef.current += 1;
      if (mountedRef.current) {
        setPhase((previous) =>
          previous.kind === "recording"
            ? { kind: "recording", elapsedSeconds: elapsedRef.current }
            : previous,
        );
      }
      if (elapsedRef.current >= VOICE_MAX_DURATION_SECONDS) {
        hitLimitRef.current = true;
        stopRecording();
      }
    }, 1000);
  }, [disabled, finishRecording, stopRecording]);

  const discardPreview = useCallback(() => {
    sendKeysRef.current = undefined;
    setPhase({ kind: "idle" });
  }, []);

  const sendOrRetry = useCallback(async () => {
    if (phase.kind !== "preview" && phase.kind !== "error") return;
    const { blob, durationSeconds } = phase;
    sendKeysRef.current ??= {
      clientMessageId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
    };
    const keys = sendKeysRef.current;
    setPhase({ kind: "sending", blob, durationSeconds });
    try {
      const sent = await client.sendVoice({
        clientMessageId: keys.clientMessageId,
        conversationId,
        durationSeconds,
        file: blob,
        idempotencyKey: keys.idempotencyKey,
        originalClientTime: new Date().toISOString(),
      });
      sendKeysRef.current = undefined;
      if (mountedRef.current) setPhase({ kind: "idle" });
      onSent(sent);
    } catch (error) {
      if (mountedRef.current) {
        setPhase({
          kind: "error",
          blob,
          durationSeconds,
          message: voiceSendErrorMessage(error, t),
        });
      }
    }
  }, [client, conversationId, onSent, phase, t]);

  if (phase.kind === "idle") {
    return (
      <div className="communication-voice-composer">
        <button
          aria-label={t("communication.voice.record")}
          className="icon-button communication-voice-mic-button"
          disabled={disabled}
          onClick={() => void startRecording()}
          title={t("communication.voice.recordTooltip")}
          type="button"
        >
          <Mic aria-hidden="true" />
        </button>
      </div>
    );
  }

  if (phase.kind === "unsupported") {
    return (
      <div className="communication-voice-composer">
        <p className="communication-notice">{t("communication.voice.unsupportedBrowser")}</p>
      </div>
    );
  }

  if (phase.kind === "permissionDenied") {
    return (
      <div className="communication-voice-composer">
        <div className="communication-voice-recording-row">
          <p className="communication-error" role="alert">
            {t("communication.voice.permissionDenied")}
          </p>
          <button
            aria-label={t("communication.voice.record")}
            className="icon-button communication-voice-mic-button"
            disabled={disabled}
            onClick={() => void startRecording()}
            title={t("communication.voice.recordTooltip")}
            type="button"
          >
            <Mic aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === "recording") {
    return (
      <div className="communication-voice-composer">
        <div className="communication-voice-recording-row" role="status">
          <span className="communication-voice-recording-indicator">
            <span aria-hidden="true" className="communication-voice-recording-dot" />
            {t("communication.voice.recording")} · {formatDuration(phase.elapsedSeconds)}
          </span>
          <button
            className="button button-secondary button-compact"
            onClick={stopRecording}
            type="button"
          >
            <Square aria-hidden="true" />
            {t("communication.voice.stop")}
          </button>
          <button
            className="button button-secondary button-compact"
            onClick={cancelRecording}
            type="button"
          >
            <Trash2 aria-hidden="true" />
            {t("communication.voice.discard")}
          </button>
        </div>
      </div>
    );
  }

  if (phase.kind === "invalid") {
    return (
      <div className="communication-voice-composer">
        <div className="communication-voice-preview-row">
          <p className="communication-error" role="alert">
            {phase.message}
          </p>
          <button
            className="button button-secondary button-compact"
            onClick={discardPreview}
            type="button"
          >
            <Trash2 aria-hidden="true" />
            {t("communication.voice.discard")}
          </button>
        </div>
      </div>
    );
  }

  const sending = phase.kind === "sending";
  return (
    <div className="communication-voice-composer">
      <div className="communication-voice-preview-row">
        <AudioPlaybackControl
          id="voice-preview"
          initialDurationSeconds={phase.durationSeconds}
          loadBlob={() => Promise.resolve(phase.blob)}
        />
        {phase.kind === "preview" && phase.hitDurationLimit && (
          <p className="communication-notice">
            {t("communication.voice.errors.durationLimitReached")}
          </p>
        )}
        {phase.kind === "error" && (
          <p className="communication-error" role="alert">
            {phase.message}
          </p>
        )}
        <div className="communication-voice-preview-actions">
          <button
            className="button button-secondary button-compact"
            disabled={sending}
            onClick={discardPreview}
            type="button"
          >
            <Trash2 aria-hidden="true" />
            {t("communication.voice.discard")}
          </button>
          <button
            className="button button-primary button-compact"
            disabled={sending}
            onClick={() => void sendOrRetry()}
            type="button"
          >
            {sending ? (
              <Loader2 aria-hidden="true" className="spin" />
            ) : (
              <Send aria-hidden="true" />
            )}
            {phase.kind === "error"
              ? t("communication.voice.retry")
              : t("communication.voice.send")}
          </button>
        </div>
      </div>
    </div>
  );
}
