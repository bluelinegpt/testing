import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { type App, cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";

import type { AppConfiguration } from "../configuration/environment.js";
import { type PushMessage, PushProvider, type PushSendResult } from "./push-provider.port.js";

/**
 * The real Firebase Cloud Messaging adapter, bound to `PushProvider` in
 * `PushModule`. Credentials come ONLY from `AppConfiguration.push` (itself
 * sourced from `FIREBASE_SERVICE_ACCOUNT_JSON`) — nothing is ever read from a
 * committed file. When that env var is absent (true today: no live Firebase
 * project exists yet — see Prompt 15's `COMPLETE_WITH_EXTERNAL_FIREBASE_DEPENDENCY`
 * allowance), the Admin SDK is never initialized and every `send()` call
 * returns a `transient_failure` — the API still boots and runs normally, and
 * `PushDispatcher` will simply keep the outbox row retrying with backoff
 * (bounded — see Section K) until real credentials are supplied, rather than
 * crashing or silently dropping the notification.
 */
@Injectable()
export class FirebasePushProvider extends PushProvider {
  private readonly logger = new Logger(FirebasePushProvider.name);
  private readonly app: App | undefined;
  private warnedUnconfigured = false;

  public constructor(@Inject(ConfigService) config: ConfigService<AppConfiguration, true>) {
    super();
    const credentialJson = config.get("push.firebaseServiceAccountJson", { infer: true });
    this.app = credentialJson === undefined ? undefined : this.initialize(credentialJson);
  }

  private initialize(credentialJson: string): App | undefined {
    try {
      const serviceAccount = JSON.parse(credentialJson) as Record<string, unknown>;
      const existing = getApps().find((app) => app.name === "blueline-push");
      return (
        existing ??
        initializeApp({ credential: cert(serviceAccount) }, "blueline-push")
      );
    } catch {
      // Never log the credential itself — only that it failed to parse/apply.
      this.logger.error("firebase_service_account_invalid");
      return undefined;
    }
  }

  private messaging(): Messaging | undefined {
    return this.app === undefined ? undefined : getMessaging(this.app);
  }

  public async send(message: PushMessage): Promise<PushSendResult> {
    const messaging = this.messaging();
    if (messaging === undefined) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true;
        this.logger.warn("firebase_not_configured — FIREBASE_SERVICE_ACCOUNT_JSON is unset");
      }
      return { outcome: "transient_failure", reason: "provider_not_configured" };
    }
    try {
      await messaging.send({
        token: message.token,
        notification: message.body === undefined
          ? { title: message.title }
          : { title: message.title, body: message.body },
        data: message.data,
      });
      return { outcome: "sent" };
    } catch (error) {
      return this.classify(error);
    }
  }

  private classify(error: unknown): PushSendResult {
    const code = this.errorCode(error);
    // https://firebase.google.com/docs/cloud-messaging/send-message#admin-sdk-error-reference
    if (
      code === "messaging/registration-token-not-registered" ||
      code === "messaging/invalid-registration-token" ||
      code === "messaging/invalid-argument"
    ) {
      return { outcome: "invalid_token" };
    }
    if (
      code === "messaging/server-unavailable" ||
      code === "messaging/internal-error" ||
      code === "messaging/quota-exceeded" ||
      code === "messaging/message-rate-exceeded" ||
      code === "messaging/device-message-rate-exceeded"
    ) {
      return { outcome: "transient_failure", reason: code };
    }
    return { outcome: "permanent_failure", reason: code ?? "unknown_error" };
  }

  private errorCode(error: unknown): string | undefined {
    if (typeof error !== "object" || error === null) return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
}
