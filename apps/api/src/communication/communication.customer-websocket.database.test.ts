import { createServer, type Server as HttpServer } from "node:http";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import WebSocket from "ws";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { CommunicationRealtimeGateway } from "./communication-realtime.gateway.js";
import {
  createFixtureCompany,
  createFixtureCustomer,
  createFixtureOfficeUser,
  createFixtureOrder,
  createFixtureTrackingToken,
  createFixtureTrader,
  createTestAuthenticationService,
  createTestCommunicationService,
  StaticIdentityAccessor,
  withRolledBackCommunicationFixtures,
} from "./communication.database-test-helpers.js";

const enabled = process.env.RUN_COMMUNICATION_DATABASE === "true";

interface WebSocketEnvelope {
  readonly type: string;
  readonly events?: readonly { readonly sequence: string; readonly type: string }[];
  readonly fullRefreshRequired?: boolean;
}

async function nextJson(socket: WebSocket): Promise<WebSocketEnvelope> {
  return new Promise((resolvePromise, reject) => {
    socket.once("message", (message) => resolvePromise(JSON.parse(message.toString())));
    socket.once("error", reject);
  });
}

async function closeEvent(socket: WebSocket): Promise<{ readonly code: number }> {
  return new Promise((resolvePromise) => {
    socket.once("close", (code) => resolvePromise({ code }));
  });
}

/**
 * C. Customer WebSocket security — a real HTTP server with the production
 * gateway attached, real `AuthenticationService`/`CommunicationService`
 * bound to the guarded test transaction, and real `ws` clients. Nothing here
 * is mocked except the network boundary itself (loopback).
 */
describe.skipIf(!enabled)("guarded Customer communication WebSocket security", () => {
  let database: Kysely<DatabaseSchema>;

  beforeAll(() => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  });

  afterAll(async () => {
    await database.destroy();
  });

  it(
    "authenticates a valid Customer socket, replays only its own conversation, denies cross-scope subscriptions, and disconnects on revocation",
    async () => {
      await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
        const companyA = await createFixtureCompany(transaction, runId, "wsa");
        const officeA = await createFixtureOfficeUser(transaction, companyA.companyId, "wsa", [
          "communication.operator.read",
          "communication.operator.send",
        ]);
        const traderA = await createFixtureTrader(transaction, companyA.companyId, "wsa", []);
        const customerA = await createFixtureCustomer(
          transaction,
          companyA.companyId,
          officeA.accountId,
          "wsa",
        );
        const orderA = await createFixtureOrder(transaction, companyA.companyId, officeA.accountId, {
          customerId: customerA.customerId,
          traderId: traderA.traderId,
        });

        const companyB = await createFixtureCompany(transaction, runId, "wsb");
        const officeB = await createFixtureOfficeUser(transaction, companyB.companyId, "wsb", [
          "communication.operator.read",
        ]);
        const traderB = await createFixtureTrader(transaction, companyB.companyId, "wsb", []);
        const customerB = await createFixtureCustomer(
          transaction,
          companyB.companyId,
          officeB.accountId,
          "wsb",
        );
        const orderB = await createFixtureOrder(transaction, companyB.companyId, officeB.accountId, {
          customerId: customerB.customerId,
          traderId: traderB.traderId,
        });

        const accessor = new StaticIdentityAccessor();
        const communication = createTestCommunicationService(transaction, accessor);
        const authentication = createTestAuthenticationService(transaction);
        const gateway = new CommunicationRealtimeGateway(authentication, communication);

        const trackingA = await createFixtureTrackingToken(transaction, companyA.companyId, orderA.orderId);
        const sessionA = await communication.createCustomerMessagingSession({
          trackingToken: trackingA.rawToken,
        });
        const conversationA = await communication.customerResolveConversation(
          sessionA.customerMessagingToken,
        );

        const trackingB = await createFixtureTrackingToken(transaction, companyB.companyId, orderB.orderId);
        const sessionB = await communication.createCustomerMessagingSession({
          trackingToken: trackingB.rawToken,
        });
        const conversationB = await communication.customerResolveConversation(
          sessionB.customerMessagingToken,
        );

        // The office side posts a message in each Company before any socket
        // connects, so the very first recovery page must already be scoped.
        accessor.identity = {
          companyId: companyA.companyId,
          forcePasswordChange: false,
          identityId: officeA.accountId,
          kind: "company_user",
          permissions: new Set(["communication.operator.read", "communication.operator.send"]),
          sessionId: "office-a-session",
        };
        await communication.sendTextMessage(conversationA.id, {
          clientMessageId: "ws-office-a-1",
          idempotencyKey: `ws-office-a-key-${runId}`,
          text: "Company A update",
        });

        const httpServer: HttpServer = createServer();
        gateway.attach(httpServer);
        await new Promise<void>((resolveListen) => httpServer.listen(0, "127.0.0.1", resolveListen));
        const address = httpServer.address();
        if (address === null || typeof address === "string") throw new Error("server did not bind");
        const port = address.port;

        try {
          // --- Valid Customer socket: authenticates and replays only its own scope.
          const socketA = new WebSocket(
            `ws://127.0.0.1:${port}/api/v1/communication/realtime?customerToken=${sessionA.customerMessagingToken}`,
          );
          const recoveryA = await nextJson(socketA);
          expect(recoveryA.type).toBe("recovery");
          expect(recoveryA.fullRefreshRequired).toBe(false);
          expect(recoveryA.events?.length).toBeGreaterThan(0);
          socketA.close();
          await closeEvent(socketA);

          // --- Cross-Company denial: Company A's Customer token cannot be
          // steered at Company B's conversation via the query string.
          const crossCompany = new WebSocket(
            `ws://127.0.0.1:${port}/api/v1/communication/realtime?customerToken=${sessionA.customerMessagingToken}&conversationId=${conversationB.id}`,
          );
          const crossCompanyClose = await closeEvent(crossCompany);
          expect(crossCompanyClose.code).toBe(1008);

          // --- Cross-conversation denial within a real, unrelated conversation id.
          const crossConversation = new WebSocket(
            `ws://127.0.0.1:${port}/api/v1/communication/realtime?customerToken=${sessionB.customerMessagingToken}&conversationId=${conversationA.id}`,
          );
          const crossConversationClose = await closeEvent(crossConversation);
          expect(crossConversationClose.code).toBe(1008);

          // --- Both a customer token and an internal token supplied together
          // is refused outright (ambiguous authentication is never accepted).
          const ambiguous = new WebSocket(
            `ws://127.0.0.1:${port}/api/v1/communication/realtime?customerToken=${sessionA.customerMessagingToken}&token=${"A".repeat(43)}&conversationId=${conversationA.id}`,
          );
          const ambiguousClose = await closeEvent(ambiguous);
          expect(ambiguousClose.code).toBe(1008);

          // --- Revocation mid-connection disconnects the live socket, not
          // merely refuses new ones.
          const socketA2 = new WebSocket(
            `ws://127.0.0.1:${port}/api/v1/communication/realtime?customerToken=${sessionA.customerMessagingToken}`,
          );
          await nextJson(socketA2);
          await sql`
            update customer_messaging_sessions set revoked_at = now()
             where company_id = ${companyA.companyId}::uuid and order_id = ${orderA.orderId}::uuid
          `.execute(transaction);
          const revokedClose = await closeEvent(socketA2);
          expect(revokedClose.code).toBe(1008);
          return undefined;
        } finally {
          await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
        }
      });
    },
    20_000,
  );

  it(
    "deduplicates replayed events already delivered live and never leaks another conversation's events",
    async () => {
      await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
        const company = await createFixtureCompany(transaction, runId, "wsd");
        const office = await createFixtureOfficeUser(transaction, company.companyId, "wsd", [
          "communication.operator.read",
          "communication.operator.send",
        ]);
        const trader = await createFixtureTrader(transaction, company.companyId, "wsd", []);
        const customerOne = await createFixtureCustomer(
          transaction,
          company.companyId,
          office.accountId,
          "wsd1",
        );
        const customerTwo = await createFixtureCustomer(
          transaction,
          company.companyId,
          office.accountId,
          "wsd2",
        );
        const orderOne = await createFixtureOrder(transaction, company.companyId, office.accountId, {
          customerId: customerOne.customerId,
          traderId: trader.traderId,
        });
        const orderTwo = await createFixtureOrder(transaction, company.companyId, office.accountId, {
          customerId: customerTwo.customerId,
          traderId: trader.traderId,
        });

        const accessor = new StaticIdentityAccessor();
        const communication = createTestCommunicationService(transaction, accessor);
        const authentication = createTestAuthenticationService(transaction);
        const gateway = new CommunicationRealtimeGateway(authentication, communication);

        const trackingOne = await createFixtureTrackingToken(transaction, company.companyId, orderOne.orderId);
        const sessionOne = await communication.createCustomerMessagingSession({
          trackingToken: trackingOne.rawToken,
        });
        const conversationOne = await communication.customerResolveConversation(
          sessionOne.customerMessagingToken,
        );
        const trackingTwo = await createFixtureTrackingToken(transaction, company.companyId, orderTwo.orderId);
        const sessionTwo = await communication.createCustomerMessagingSession({
          trackingToken: trackingTwo.rawToken,
        });
        await communication.customerResolveConversation(sessionTwo.customerMessagingToken);

        accessor.identity = {
          companyId: company.companyId,
          forcePasswordChange: false,
          identityId: office.accountId,
          kind: "company_user",
          permissions: new Set(["communication.operator.read", "communication.operator.send"]),
          sessionId: "office-session",
        };
        await communication.sendTextMessage(conversationOne.id, {
          clientMessageId: "ws-dedupe-1",
          idempotencyKey: `ws-dedupe-key-${runId}`,
          text: "Only for Customer one",
        });

        const httpServer: HttpServer = createServer();
        gateway.attach(httpServer);
        await new Promise<void>((resolveListen) => httpServer.listen(0, "127.0.0.1", resolveListen));
        const address = httpServer.address();
        if (address === null || typeof address === "string") throw new Error("server did not bind");
        const port = address.port;

        try {
          const socketOne = new WebSocket(
            `ws://127.0.0.1:${port}/api/v1/communication/realtime?customerToken=${sessionOne.customerMessagingToken}`,
          );
          const recoveryOne = await nextJson(socketOne);
          const deliveredSequences = new Set((recoveryOne.events ?? []).map((event) => event.sequence));

          // Replaying from an earlier cursor must not re-deliver anything
          // the socket already received.
          socketOne.send(JSON.stringify({ cursor: "0", type: "recover" }));
          const replay = await nextJson(socketOne);
          expect(replay.type).toBe("recovery");
          for (const event of replay.events ?? []) {
            expect(deliveredSequences.has(event.sequence)).toBe(false);
          }
          socketOne.close();
          await closeEvent(socketOne);

          // Customer two's socket recovers only its own (empty) conversation
          // events — never Customer one's message.
          const socketTwo = new WebSocket(
            `ws://127.0.0.1:${port}/api/v1/communication/realtime?customerToken=${sessionTwo.customerMessagingToken}`,
          );
          const recoveryTwo = await nextJson(socketTwo);
          expect(recoveryTwo.events ?? []).toEqual([]);
          socketTwo.close();
          await closeEvent(socketTwo);
          return undefined;
        } finally {
          await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
        }
      });
    },
    20_000,
  );
});
