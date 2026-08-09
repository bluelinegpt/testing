import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { IdentityContext } from "../security/identity-context.js";
import { CommunicationRealtimeGateway } from "./communication-realtime.gateway.js";
import type { CommunicationService } from "./communication.service.js";

const VALID_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const EXPIRED_TOKEN = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";

interface WebSocketEnvelope {
  readonly type: string;
  readonly events?: readonly RealtimeEventFixture[];
  readonly event?: RealtimeEventFixture;
  readonly fullRefreshRequired?: boolean;
}

interface RealtimeEventFixture {
  readonly sequence: string;
  readonly eventType: string;
  readonly payload: { readonly conversationId: string };
}

interface FakeAuthenticationService {
  authenticate(token: string): Promise<IdentityContext>;
}

interface FakeCommunicationService {
  authorizeRealtimeConversation(
    identity: IdentityContext & { companyId: string },
    conversationId: string,
  ): Promise<void>;
  recoverEventsForIdentity(
    identity: IdentityContext & { companyId: string },
    query: { readonly after?: string; readonly limit?: string },
  ): Promise<{
    readonly events: readonly RealtimeEventFixture[];
    readonly nextCursor: string | null;
    readonly fullRefreshRequired: boolean;
  }>;
}

describe("CommunicationRealtimeGateway", () => {
  let httpServer: HttpServer;
  let port: number;
  let revoked = false;
  const sentEvent: RealtimeEventFixture = {
    eventType: "message.created",
    payload: { conversationId: CONVERSATION_ID },
    sequence: "10",
  };
  const unrelatedEvent: RealtimeEventFixture = {
    eventType: "message.created",
    payload: { conversationId: OTHER_CONVERSATION_ID },
    sequence: "11",
  };

  const authentication: FakeAuthenticationService = {
    async authenticate(token: string): Promise<IdentityContext> {
      if (token === EXPIRED_TOKEN || revoked) {
        throw new ApplicationException("session_revoked", "Session is not active", 401);
      }
      if (token !== VALID_TOKEN) {
        throw new ApplicationException("session_invalid", "Session is invalid", 401);
      }
      return {
        companyId: COMPANY_ID,
        forcePasswordChange: false,
        identityId: ACCOUNT_ID,
        kind: "company_user",
        permissions: new Set(["communication.operator.read"]),
        sessionId: "session-1",
      };
    },
  };

  const communication: FakeCommunicationService = {
    async authorizeRealtimeConversation(
      _identity: IdentityContext & { companyId: string },
      conversationId: string,
    ): Promise<void> {
      if (conversationId !== CONVERSATION_ID || revoked) {
        throw new ApplicationException("conversation_denied", "Conversation is not allowed", 403);
      }
    },
    async recoverEventsForIdentity(
      _identity: IdentityContext & { companyId: string },
      query: { readonly after?: string; readonly limit?: string },
    ): Promise<{
      readonly events: readonly RealtimeEventFixture[];
      readonly nextCursor: string | null;
      readonly fullRefreshRequired: boolean;
    }> {
      if (query.after === "expired") {
        return { events: [], fullRefreshRequired: true, nextCursor: null };
      }
      return { events: [sentEvent, unrelatedEvent], fullRefreshRequired: false, nextCursor: "11" };
    },
  };

  beforeEach(async () => {
    revoked = false;
    vi.useRealTimers();
    httpServer = createServer();
    const gateway = new CommunicationRealtimeGateway(
      authentication as unknown as ConstructorParameters<typeof CommunicationRealtimeGateway>[0],
      communication as unknown as CommunicationService,
    );
    gateway.attach(httpServer);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (address === null || typeof address === "string")
      throw new Error("HTTP server did not bind");
    port = address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it("authenticates valid sockets and replays only authorized conversation events", async () => {
    const socket = connect(VALID_TOKEN, CONVERSATION_ID);
    const message = await nextJson(socket);

    expect(message.type).toBe("recovery");
    expect(message.events).toEqual([sentEvent]);

    socket.close();
  });

  it("rejects expired sessions before subscription", async () => {
    const socket = connect(EXPIRED_TOKEN, CONVERSATION_ID);
    const close = await closeEvent(socket);

    expect(close.code).toBe(1008);
  });

  it("denies cross-conversation subscriptions server-side", async () => {
    const socket = connect(VALID_TOKEN, OTHER_CONVERSATION_ID);
    const close = await closeEvent(socket);

    expect(close.code).toBe(1008);
  });

  it("deduplicates replayed events already delivered to the socket", async () => {
    const socket = connect(VALID_TOKEN, CONVERSATION_ID);
    await nextJson(socket);

    socket.send(JSON.stringify({ cursor: "9", type: "recover" }));
    const replay = await nextJson(socket);

    expect(replay.type).toBe("recovery");
    expect(replay.events).toEqual([]);

    socket.close();
  });

  it("reports expired cursors without replacing REST history recovery", async () => {
    const socket = connect(VALID_TOKEN, CONVERSATION_ID, "expired");
    const recovery = await nextJson(socket);
    const cursorExpired = await nextJson(socket);

    expect(recovery.fullRefreshRequired).toBe(true);
    expect(cursorExpired).toEqual({ fullRefreshRequired: true, type: "cursor_expired" });

    socket.close();
  });

  it("disconnects when a session is revoked after connection", async () => {
    const socket = connect(VALID_TOKEN, CONVERSATION_ID);
    await nextJson(socket);

    revoked = true;
    const close = await closeEvent(socket);

    expect(close.code).toBe(1008);
  }, 7_500);

  function connect(token: string, conversationId: string, cursor?: string): WebSocket {
    const url = new URL(`ws://127.0.0.1:${port}/api/v1/communication/realtime`);
    url.searchParams.set("token", token);
    url.searchParams.set("conversationId", conversationId);
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    return new WebSocket(url);
  }

  async function nextJson(socket: WebSocket): Promise<WebSocketEnvelope> {
    return new Promise<WebSocketEnvelope>((resolve, reject) => {
      socket.once("message", (message) => {
        resolve(JSON.parse(message.toString()) as WebSocketEnvelope);
      });
      socket.once("error", reject);
    });
  }

  async function closeEvent(socket: WebSocket): Promise<{ readonly code: number }> {
    return new Promise<{ readonly code: number }>((resolve) => {
      socket.once("close", (code) => resolve({ code }));
    });
  }
});
