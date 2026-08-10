import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { IdentityContext } from "../security/identity-context.js";
import {
  createFixtureCompany,
  createFixtureCustomer,
  createFixtureOfficeUser,
  createFixtureOrder,
  createFixtureTrackingToken,
  createFixtureTrader,
  createFixtureDriver,
  createTestCommunicationService,
  StaticIdentityAccessor,
  withRolledBackCommunicationFixtures,
} from "./communication.database-test-helpers.js";

const enabled = process.env.RUN_COMMUNICATION_DATABASE === "true";

function officeIdentity(
  companyId: string,
  accountId: string,
  permissions: readonly string[] = ["communication.operator.read", "communication.operator.send"],
): IdentityContext & { companyId: string } {
  return {
    companyId,
    forcePasswordChange: false,
    identityId: accountId,
    kind: "company_user",
    permissions: new Set(permissions),
    sessionId: `office-${accountId}`,
  };
}

function traderIdentity(
  companyId: string,
  accountId: string,
  traderId: string,
): IdentityContext & { companyId: string } {
  return {
    companyId,
    forcePasswordChange: false,
    identityId: accountId,
    kind: "trader",
    permissions: new Set(["communication.trader.read", "communication.trader.send"]),
    profileId: traderId,
    sessionId: `trader-${accountId}`,
  };
}

function driverIdentity(
  companyId: string,
  accountId: string,
  driverId: string,
): IdentityContext & { companyId: string } {
  return {
    companyId,
    forcePasswordChange: false,
    identityId: accountId,
    kind: "driver",
    permissions: new Set(["communication.driver.read", "communication.driver.send"]),
    profileId: driverId,
    sessionId: `driver-${accountId}`,
  };
}

/** A tiny, deliberately-fake buffer — the storage/DB layers under test never
 *  interpret audio content, only its declared MIME type/size/duration, so a
 *  real recording is unnecessary. */
function voiceFile(overrides: Partial<{ buffer: Buffer; mimetype: string; size: number }> = {}): {
  buffer: Buffer;
  mimetype: string;
  size: number;
} {
  const buffer = overrides.buffer ?? Buffer.from("fake-voice-bytes-for-testing");
  return {
    buffer,
    mimetype: overrides.mimetype ?? "audio/webm",
    size: overrides.size ?? buffer.length,
  };
}

async function outboxRecipients(
  transaction: Transaction<DatabaseSchema>,
  companyId: string,
  messageId: string,
): Promise<readonly string[]> {
  const rows = await sql<{ recipient_account_id: string }>`
    select recipient_account_id from communication_notification_outbox
     where company_id = ${companyId}::uuid and message_id = ${messageId}::uuid
  `.execute(transaction);
  return rows.rows.map((row) => row.recipient_account_id);
}

/** Prompt 14, Section P — permanent backend voice-message tests. */
describe.skipIf(!enabled)("guarded communication voice messages", () => {
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

  it("an authorized voice message is stored, previewed, ordered with text, and readable by the recipient", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "v1");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "v1", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "v1", []);
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      accessor.identity = traderIdentity(company.companyId, trader.accountId, trader.traderId);
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
      });
      await service.sendTextMessage(conversation.id, {
        clientMessageId: "v1-text",
        idempotencyKey: `v1-text-key-${runId}`,
        text: "Calling you now",
      });
      const voiceMessage = await service.sendVoiceMessage(
        conversation.id,
        {
          clientMessageId: "v1-voice",
          durationSeconds: 12,
          idempotencyKey: `v1-voice-key-${runId}`,
        },
        voiceFile(),
      );
      expect(voiceMessage.messageType).toBe("voice");
      expect(voiceMessage.text).toBeNull();
      expect(voiceMessage.mediaMimeType).toBe("audio/webm");
      expect(voiceMessage.mediaDurationSeconds).toBe(12);
      expect(voiceMessage.mediaSizeBytes).toBeGreaterThan(0);

      // Text and Voice remain in one chronological timeline.
      const history = await service.getMessages(conversation.id, {});
      expect(history.items.map((item) => item.messageType)).toEqual(["text", "voice"]);

      // The conversation preview never leaks a raw storage identifier — it
      // carries a neutral, frontend-translatable marker instead.
      const summary = (await service.listConversations({})).items.find(
        (item) => item.id === conversation.id,
      );
      expect(summary?.lastMessagePreview).toBe("voice_message");

      // Read/unread participates exactly like text: the Office (recipient,
      // not sender) sees an unread Voice message.
      accessor.identity = officeIdentity(company.companyId, office.accountId);
      const officeView = (await service.listConversations({})).items.find(
        (item) => item.id === conversation.id,
      );
      expect(officeView?.unreadCount).toBeGreaterThan(0);

      // The recipient can fetch the audio bytes back.
      const media = await service.getMessageMedia(voiceMessage.id);
      expect(media.mimeType).toBe("audio/webm");
      expect(Buffer.from(media.content).toString()).toBe("fake-voice-bytes-for-testing");
      return undefined;
    });
  });

  it("an identity with no access to the conversation is rejected", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "v2");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "v2", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const outsider = await createFixtureOfficeUser(transaction, company.companyId, "v2-out", []);
      const trader = await createFixtureTrader(transaction, company.companyId, "v2", []);
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      accessor.identity = officeIdentity(company.companyId, office.accountId);
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
        participantContextType: "trader",
      });

      // Neither an operator reader nor a seated participant.
      accessor.identity = officeIdentity(company.companyId, outsider.accountId, []);
      await expect(
        service.sendVoiceMessage(
          conversation.id,
          { clientMessageId: "v2-voice", durationSeconds: 5, idempotencyKey: `v2-key-${runId}` },
          voiceFile(),
        ),
      ).rejects.toMatchObject({ errorCode: "conversation_access_denied" });
      return undefined;
    });
  });

  it("a different Company can neither send a voice message into, nor read media from, this conversation", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const companyA = await createFixtureCompany(transaction, runId, "v3a");
      const officeA = await createFixtureOfficeUser(transaction, companyA.companyId, "v3a", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const traderA = await createFixtureTrader(transaction, companyA.companyId, "v3a", []);
      const orderA = await createFixtureOrder(transaction, companyA.companyId, officeA.accountId, {
        traderId: traderA.traderId,
      });
      const companyB = await createFixtureCompany(transaction, runId, "v3b");
      const officeB = await createFixtureOfficeUser(transaction, companyB.companyId, "v3b", [
        "communication.operator.read",
        "communication.operator.send",
      ]);

      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);
      accessor.identity = officeIdentity(companyA.companyId, officeA.accountId);
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: orderA.orderId,
        participantContextType: "trader",
      });
      const voiceMessage = await service.sendVoiceMessage(
        conversation.id,
        { clientMessageId: "v3-voice", durationSeconds: 5, idempotencyKey: `v3-key-${runId}` },
        voiceFile(),
      );

      accessor.identity = officeIdentity(companyB.companyId, officeB.accountId);
      await expect(
        service.sendVoiceMessage(
          conversation.id,
          {
            clientMessageId: "v3-voice-b",
            durationSeconds: 5,
            idempotencyKey: `v3-key-b-${runId}`,
          },
          voiceFile(),
        ),
      ).rejects.toMatchObject({ errorCode: "conversation_access_denied" });
      await expect(service.getMessageMedia(voiceMessage.id)).rejects.toMatchObject({
        errorCode: "voice_media_not_found",
      });
      return undefined;
    });
  });

  it("media download authorization is checked independently of message-list authorization — a forged id from another conversation is refused", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "v4");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "v4", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const traderOne = await createFixtureTrader(transaction, company.companyId, "v4-one", []);
      const traderTwo = await createFixtureTrader(transaction, company.companyId, "v4-two", []);
      const orderOne = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        traderId: traderOne.traderId,
      });
      const orderTwo = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        traderId: traderTwo.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      accessor.identity = traderIdentity(
        company.companyId,
        traderOne.accountId,
        traderOne.traderId,
      );
      await service.resolveConversation({
        conversationType: "order",
        orderId: orderOne.orderId,
      });

      accessor.identity = traderIdentity(
        company.companyId,
        traderTwo.accountId,
        traderTwo.traderId,
      );
      const conversationTwo = await service.resolveConversation({
        conversationType: "order",
        orderId: orderTwo.orderId,
      });
      const voiceInTwo = await service.sendVoiceMessage(
        conversationTwo.id,
        { clientMessageId: "v4-voice", durationSeconds: 5, idempotencyKey: `v4-key-${runId}` },
        voiceFile(),
      );

      // Trader One is a legitimate participant of Conversation One, and was
      // never shown Conversation Two's message list — but a guessed/forged
      // message id from it must still be refused on its own merits: the
      // media row is found (same Company), then the *separate*
      // conversation-authorization check — re-run independently of whatever
      // the caller was ever shown via `getMessages` — denies it.
      accessor.identity = traderIdentity(
        company.companyId,
        traderOne.accountId,
        traderOne.traderId,
      );
      await expect(service.getMessageMedia(voiceInTwo.id)).rejects.toMatchObject({
        errorCode: "conversation_access_denied",
      });
      return undefined;
    });
  });

  it("an unsupported MIME type is rejected", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "v5");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "v5", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const driver = await createFixtureDriver(transaction, company.companyId, "v5", []);
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        driverId: driver.driverId,
        traderId: (await createFixtureTrader(transaction, company.companyId, "v5", [])).traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      accessor.identity = driverIdentity(company.companyId, driver.accountId, driver.driverId);
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
        participantContextType: "driver",
      });
      await expect(
        service.sendVoiceMessage(
          conversation.id,
          { clientMessageId: "v5-voice", durationSeconds: 5, idempotencyKey: `v5-key-${runId}` },
          voiceFile({ mimetype: "video/mp4" }),
        ),
      ).rejects.toMatchObject({ errorCode: "voice_message_unsupported_type" });
      return undefined;
    });
  });

  it("an oversize upload is rejected", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "v6");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "v6", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "v6", []);
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      accessor.identity = officeIdentity(company.companyId, office.accountId);
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
        participantContextType: "trader",
      });
      const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
      await expect(
        service.sendVoiceMessage(
          conversation.id,
          { clientMessageId: "v6-voice", durationSeconds: 5, idempotencyKey: `v6-key-${runId}` },
          voiceFile({ buffer: oversized, size: oversized.length }),
        ),
      ).rejects.toMatchObject({ errorCode: "voice_message_too_large" });
      return undefined;
    });
  });

  it("an empty recording and a duration outside the 5-minute limit are both rejected", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "v7");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "v7", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "v7", []);
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);
      accessor.identity = officeIdentity(company.companyId, office.accountId);
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
        participantContextType: "trader",
      });

      await expect(
        service.sendVoiceMessage(
          conversation.id,
          { clientMessageId: "v7-empty", durationSeconds: 5, idempotencyKey: `v7-empty-${runId}` },
          voiceFile({ buffer: Buffer.alloc(0), size: 0 }),
        ),
      ).rejects.toMatchObject({ errorCode: "voice_message_empty" });

      await expect(
        service.sendVoiceMessage(
          conversation.id,
          {
            clientMessageId: "v7-long",
            durationSeconds: 301,
            idempotencyKey: `v7-long-${runId}`,
          },
          voiceFile(),
        ),
      ).rejects.toMatchObject({ errorCode: "voice_message_duration_invalid" });
      return undefined;
    });
  });

  it("an expired Customer session cannot send a voice message or read its media", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "v8");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "v8", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "v8", []);
      const customer = await createFixtureCustomer(
        transaction,
        company.companyId,
        office.accountId,
        "v8",
      );
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        customerId: customer.customerId,
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      const tracking = await createFixtureTrackingToken(
        transaction,
        company.companyId,
        order.orderId,
      );
      const session = await service.createCustomerMessagingSession({
        trackingToken: tracking.rawToken,
      });
      const conversation = await service.customerResolveConversation(
        session.customerMessagingToken,
      );
      const voiceMessage = await service.customerSendVoiceMessage(
        session.customerMessagingToken,
        { clientMessageId: "v8-voice", durationSeconds: 5, idempotencyKey: `v8-key-${runId}` },
        voiceFile(),
      );
      expect(voiceMessage.conversationId).toBe(conversation.id);

      await sql`
        update customer_messaging_sessions
           set expires_at = now() - interval '1 hour', created_at = now() - interval '2 hours'
         where id = (
           select id from customer_messaging_sessions
            where company_id = ${company.companyId}::uuid and order_id = ${order.orderId}::uuid
            order by created_at desc limit 1
         )
      `.execute(transaction);

      await expect(
        service.customerSendVoiceMessage(
          session.customerMessagingToken,
          {
            clientMessageId: "v8-voice-2",
            durationSeconds: 5,
            idempotencyKey: `v8-key-2-${runId}`,
          },
          voiceFile(),
        ),
      ).rejects.toMatchObject({ errorCode: "customer_messaging_session_invalid" });
      await expect(
        service.customerMessageMedia(session.customerMessagingToken, voiceMessage.id),
      ).rejects.toMatchObject({ errorCode: "customer_messaging_session_invalid" });
      return undefined;
    });
  });

  it("a revoked Customer session cannot send a voice message or read its media", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "v9");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "v9", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "v9", []);
      const customer = await createFixtureCustomer(
        transaction,
        company.companyId,
        office.accountId,
        "v9",
      );
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        customerId: customer.customerId,
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      const tracking = await createFixtureTrackingToken(
        transaction,
        company.companyId,
        order.orderId,
      );
      const session = await service.createCustomerMessagingSession({
        trackingToken: tracking.rawToken,
      });
      await service.customerResolveConversation(session.customerMessagingToken);
      const voiceMessage = await service.customerSendVoiceMessage(
        session.customerMessagingToken,
        { clientMessageId: "v9-voice", durationSeconds: 5, idempotencyKey: `v9-key-${runId}` },
        voiceFile(),
      );

      await sql`update customer_messaging_sessions set revoked_at = now() where id = (
        select id from customer_messaging_sessions where company_id = ${company.companyId}::uuid
          and order_id = ${order.orderId}::uuid order by created_at desc limit 1
      )`.execute(transaction);

      await expect(
        service.customerSendVoiceMessage(
          session.customerMessagingToken,
          {
            clientMessageId: "v9-voice-2",
            durationSeconds: 5,
            idempotencyKey: `v9-key-2-${runId}`,
          },
          voiceFile(),
        ),
      ).rejects.toMatchObject({ errorCode: "customer_messaging_session_invalid" });
      await expect(
        service.customerMessageMedia(session.customerMessagingToken, voiceMessage.id),
      ).rejects.toMatchObject({ errorCode: "customer_messaging_session_invalid" });
      return undefined;
    });
  });

  it("resending the same idempotency key replays the same voice message and never duplicates the outbox", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "v10");
      const officeOne = await createFixtureOfficeUser(transaction, company.companyId, "v10-one", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const officeTwo = await createFixtureOfficeUser(transaction, company.companyId, "v10-two", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "v10", []);
      const order = await createFixtureOrder(transaction, company.companyId, officeOne.accountId, {
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      accessor.identity = officeIdentity(company.companyId, officeOne.accountId);
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
        participantContextType: "trader",
      });
      // Office Two must be seated as an active participant before the first
      // send so the outbox has a recipient to (not) duplicate.
      accessor.identity = officeIdentity(company.companyId, officeTwo.accountId);
      await service.getMessages(conversation.id, {});

      accessor.identity = officeIdentity(company.companyId, officeOne.accountId);
      const key = `v10-key-${runId}`;
      const first = await service.sendVoiceMessage(
        conversation.id,
        { clientMessageId: "v10-voice", durationSeconds: 8, idempotencyKey: key },
        voiceFile(),
      );
      const second = await service.sendVoiceMessage(
        conversation.id,
        { clientMessageId: "v10-voice", durationSeconds: 8, idempotencyKey: key },
        voiceFile(),
      );
      expect(second.id).toBe(first.id);

      const recipients = await outboxRecipients(transaction, company.companyId, first.id);
      expect(recipients).toEqual([officeTwo.accountId]);

      // Reusing the key with a different recording is a conflict, not a
      // silent replacement.
      await expect(
        service.sendVoiceMessage(
          conversation.id,
          { clientMessageId: "v10-voice-different", durationSeconds: 8, idempotencyKey: key },
          voiceFile(),
        ),
      ).rejects.toMatchObject({ errorCode: "idempotency_conflict" });
      return undefined;
    });
  });

  it("a voice message produces a durable realtime event the recipient can recover", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const company = await createFixtureCompany(transaction, runId, "v11");
      const office = await createFixtureOfficeUser(transaction, company.companyId, "v11", [
        "communication.operator.read",
        "communication.operator.send",
      ]);
      const trader = await createFixtureTrader(transaction, company.companyId, "v11", []);
      const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
        traderId: trader.traderId,
      });
      const accessor = new StaticIdentityAccessor();
      const service = createTestCommunicationService(transaction, accessor);

      // The Trader resolving the conversation first is what seats them as an
      // actual participant — `resolveConversation` only auto-seats its own
      // caller (plus every Office read-permission account), never the
      // Order's Trader/Driver/Customer by inference.
      accessor.identity = traderIdentity(company.companyId, trader.accountId, trader.traderId);
      const conversation = await service.resolveConversation({
        conversationType: "order",
        orderId: order.orderId,
      });
      accessor.identity = officeIdentity(company.companyId, office.accountId);
      const voiceMessage = await service.sendVoiceMessage(
        conversation.id,
        { clientMessageId: "v11-voice", durationSeconds: 9, idempotencyKey: `v11-key-${runId}` },
        voiceFile(),
      );

      accessor.identity = traderIdentity(company.companyId, trader.accountId, trader.traderId);
      const recovered = await service.recoverEvents({});
      const event = recovered.events.find(
        (candidate) =>
          (candidate as { type: string; entityId: string }).type === "message.created" &&
          (candidate as { type: string; entityId: string }).entityId === voiceMessage.id,
      ) as { payload: unknown } | undefined;
      expect(event).toBeDefined();
      // Metadata only — the audio bytes are never inlined into the realtime payload.
      expect(JSON.stringify(event?.payload)).not.toContain("fake-voice-bytes-for-testing");
      return undefined;
    });
  });
});
