import { Inject, Injectable } from "@nestjs/common";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import { AuthenticationService } from "../authentication/authentication.service.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { IdentityContext } from "../security/identity-context.js";
import { CommunicationService, type CustomerMessagingPrincipal } from "./communication.service.js";

export interface CommunicationRealtimeSubscribeRequest {
  readonly accessToken: string;
  readonly conversationId: string;
  readonly lastEventCursor?: string;
}

export interface CommunicationRealtimeSubscription {
  readonly accountId: string;
  readonly companyId: string;
  readonly conversationId: string;
  readonly recoveryCursor: string | null;
}

interface RealtimeConnectionState {
  readonly conversationId: string;
  readonly delivered: Set<string>;
  readonly token: string;
  cursor: string | undefined;
  identity?: IdentityContext & { companyId: string };
  customer?: CustomerMessagingPrincipal & { conversationId: string };
  customerToken?: string;
}

@Injectable()
export class CommunicationRealtimeGateway {
  private server: WebSocketServer | undefined;
  private readonly connections = new Set<WebSocket>();

  public constructor(
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(CommunicationService) private readonly communication: CommunicationService,
  ) {}

  public attach(server: HttpServer): void {
    if (this.server !== undefined) return;
    this.server = new WebSocketServer({ noServer: true, path: "/api/v1/communication/realtime" });
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "", "http://localhost");
      if (url.pathname !== "/api/v1/communication/realtime") return;
      this.server?.handleUpgrade(request, socket, head, (socketClient) => {
        void this.accept(socketClient, url);
      });
    });
  }

  public async authenticateSubscription(
    request: CommunicationRealtimeSubscribeRequest,
  ): Promise<CommunicationRealtimeSubscription> {
    const identity = await this.authentication.authenticate(request.accessToken);
    if (identity.companyId === null) {
      throw new ApplicationException(
        "realtime_subscription_denied",
        "A Company-scoped session is required",
        403,
      );
    }
    return {
      accountId: identity.identityId,
      companyId: identity.companyId,
      conversationId: request.conversationId,
      recoveryCursor: request.lastEventCursor ?? null,
    };
  }

  private async accept(socket: WebSocket, url: URL): Promise<void> {
    try {
      const token = url.searchParams.get("token") ?? "";
      const customerToken = url.searchParams.get("customerToken") ?? "";
      let conversationId = url.searchParams.get("conversationId") ?? "";
      const cursor = url.searchParams.get("cursor") ?? undefined;
      if ((token === "" && customerToken === "") || (token !== "" && customerToken !== ""))
        throw this.denied("realtime_authentication_failed");
      let identity: (IdentityContext & { companyId: string }) | undefined;
      let customer: (CustomerMessagingPrincipal & { conversationId: string }) | undefined;
      if (customerToken !== "") {
        await this.communication.customerResolveConversation(customerToken);
        const principal = await this.communication.validateCustomerMessagingSession(customerToken);
        if (principal.conversationId === null) throw this.denied("realtime_subscription_denied");
        customer = principal as CustomerMessagingPrincipal & { conversationId: string };
        if (conversationId !== "" && conversationId !== customer.conversationId)
          throw this.denied("realtime_subscription_denied");
        conversationId = customer.conversationId;
      } else {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[0-9a-fA-F-]{36}$/.test(conversationId))
          throw this.denied("realtime_subscription_denied");
        identity = await this.companyIdentity(token);
        await this.communication.authorizeRealtimeConversation(identity, conversationId);
      }
      const state: RealtimeConnectionState = {
        conversationId,
        cursor,
        delivered: new Set<string>(),
        ...(identity === undefined ? {} : { identity }),
        ...(customer === undefined ? {} : { customer, customerToken }),
        token,
      };
      this.connections.add(socket);
      socket.on("close", () => this.connections.delete(socket));
      await this.sendRecovery(socket, state);
      const validationInterval = setInterval(() => {
        void this.revalidate(socket, state);
      }, 5_000);
      const liveInterval = setInterval(() => {
        void this.deliverLiveEvents(socket, state);
      }, 2_000);
      socket.on("close", () => {
        clearInterval(validationInterval);
        clearInterval(liveInterval);
      });
      socket.on("message", (raw) => {
        void this.handleMessage(socket, state, raw.toString());
      });
    } catch (error) {
      socket.close(
        1008,
        error instanceof ApplicationException ? "realtime_denied" : "realtime_denied",
      );
    }
  }

  private async handleMessage(
    socket: WebSocket,
    state: RealtimeConnectionState,
    raw: string,
  ): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      socket.close(1003, "invalid_json");
      return;
    }
    const payload = parsed as { type?: unknown; cursor?: unknown };
    if (payload.type !== "recover") return;
    await this.authorize(state);
    state.cursor = typeof payload.cursor === "string" ? payload.cursor : state.cursor;
    await this.sendRecovery(socket, state);
  }

  private async sendRecovery(socket: WebSocket, state: RealtimeConnectionState): Promise<void> {
    const recovery =
      state.customer === undefined
        ? await this.communication.recoverEventsForIdentity(state.identity!, {
            ...(state.cursor === undefined ? {} : { after: state.cursor }),
            limit: "50",
          })
        : await this.communication.customerRecoverEvents(state.customerToken!, {
            ...(state.cursor === undefined ? {} : { after: state.cursor }),
            limit: "50",
          });
    const events = this.filterAndDedupeEvents(recovery.events, state);
    socket.send(JSON.stringify({ type: "recovery", ...recovery, events }));
  }

  private async deliverLiveEvents(
    socket: WebSocket,
    state: RealtimeConnectionState,
  ): Promise<void> {
    if (socket.readyState !== socket.OPEN) return;
    try {
      await this.authorize(state);
      const recovery =
        state.customer === undefined
          ? await this.communication.recoverEventsForIdentity(state.identity!, {
              ...(state.cursor === undefined ? {} : { after: state.cursor }),
              limit: "50",
            })
          : await this.communication.customerRecoverEvents(state.customerToken!, {
              ...(state.cursor === undefined ? {} : { after: state.cursor }),
              limit: "50",
            });
      if (recovery.fullRefreshRequired) {
        socket.send(JSON.stringify({ type: "cursor_expired", fullRefreshRequired: true }));
        return;
      }
      for (const event of this.filterAndDedupeEvents(recovery.events, state)) {
        socket.send(JSON.stringify({ type: "event", event }));
      }
    } catch {
      socket.close(1008, "subscription_revoked");
    }
  }

  private async revalidate(socket: WebSocket, state: RealtimeConnectionState): Promise<void> {
    try {
      if (state.customer !== undefined) {
        const latest = await this.communication.validateCustomerMessagingSession(
          state.customerToken!,
        );
        if (latest.conversationId !== state.conversationId) throw this.denied("session_changed");
        state.customer = latest as CustomerMessagingPrincipal & { conversationId: string };
        return;
      }
      const latest = await this.companyIdentity(state.token);
      if (
        latest.identityId !== state.identity!.identityId ||
        latest.companyId !== state.identity!.companyId
      ) {
        socket.close(1008, "session_changed");
        return;
      }
      await this.communication.authorizeRealtimeConversation(latest, state.conversationId);
      state.identity = latest;
    } catch {
      socket.close(1008, "session_revoked");
    }
  }

  private async authorize(state: RealtimeConnectionState): Promise<void> {
    if (state.customer !== undefined) {
      const latest = await this.communication.validateCustomerMessagingSession(
        state.customerToken!,
      );
      if (latest.conversationId !== state.conversationId)
        throw this.denied("realtime_subscription_denied");
      state.customer = latest as CustomerMessagingPrincipal & { conversationId: string };
      return;
    }
    await this.communication.authorizeRealtimeConversation(state.identity!, state.conversationId);
  }

  private filterAndDedupeEvents(
    events: readonly unknown[],
    state: RealtimeConnectionState,
  ): readonly unknown[] {
    const accepted: unknown[] = [];
    for (const event of events) {
      const candidate = event as {
        readonly sequence?: string;
        readonly payload?: { readonly conversationId?: string };
      };
      if (candidate.sequence === undefined) continue;
      state.cursor = candidate.sequence;
      if (candidate.payload?.conversationId !== state.conversationId) continue;
      if (state.delivered.has(candidate.sequence)) continue;
      state.delivered.add(candidate.sequence);
      accepted.push(event);
    }
    return accepted;
  }

  private async companyIdentity(token: string): Promise<IdentityContext & { companyId: string }> {
    const identity = await this.authentication.authenticate(token);
    if (identity.companyId === null) throw this.denied("company_context_required");
    return identity as IdentityContext & { companyId: string };
  }

  private denied(code: string): ApplicationException {
    return new ApplicationException(code, "Realtime subscription is not allowed", 403);
  }
}
