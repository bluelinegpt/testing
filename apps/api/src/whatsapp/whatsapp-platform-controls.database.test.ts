import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assertGuardedCommunicationDatabase,
  createFixtureCompany,
  createFixtureOfficeUser,
  createFixtureOrder,
  createFixtureTrader,
  withRolledBackCommunicationFixtures,
} from "../communication/communication.database-test-helpers.js";
import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { PlatformCompanyWhatsAppService } from "../platform/platform-company-whatsapp.service.js";
import type { CompanyWhatsAppProvider } from "./company-whatsapp-provider.port.js";
import { WhatsAppOutboxDispatcher } from "./whatsapp-outbox-dispatcher.service.js";
import { WhatsAppOutboxWriter } from "./whatsapp-outbox-writer.service.js";

const enabled = process.env.RUN_WHATSAPP_DATABASE === "true";

vi.setConfig({ testTimeout: 30_000 });

/**
 * Platform Administration's per-Company WhatsApp controls:
 * the kill switch (absence of a row = enabled; a disabled Company records
 * nothing new and the dispatcher never claims its parked rows) and the
 * per-status message-template overrides (custom wording with placeholders,
 * defaults when no override, snapshots never rewritten).
 */
describe.skipIf(!enabled)("platform WhatsApp controls", () => {
  let database: Kysely<DatabaseSchema>;

  beforeAll(async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    await assertGuardedCommunicationDatabase(database);
  });

  afterAll(async () => {
    await database.destroy();
  });

  const history = () => new OperationsHistoryWriter(new WhatsAppOutboxWriter());

  interface World {
    readonly companyId: string;
    readonly accountId: string;
    readonly traderId: string;
    readonly orderId: string;
    readonly orderNumber: string;
  }

  async function createWorld(
    transaction: Transaction<DatabaseSchema>,
    runId: string,
    label: string,
  ): Promise<World> {
    const company = await createFixtureCompany(transaction, runId, label);
    const office = await createFixtureOfficeUser(transaction, company.companyId, label, [
      "whatsapp.trader_settings.manage",
    ]);
    const trader = await createFixtureTrader(transaction, company.companyId, `${label}-t`, []);
    const order = await createFixtureOrder(transaction, company.companyId, office.accountId, {
      traderId: trader.traderId,
    });
    await sql`
      insert into company_whatsapp_connections (
        company_id, status, provider_type, connected_phone_number, last_connected_at
      ) values (${company.companyId}::uuid, 'connected', 'baileys', '+971500000060', now())
    `.execute(transaction);
    await sql`
      insert into trader_whatsapp_settings (
        company_id, trader_id, notifications_enabled, provider_group_id,
        group_name_snapshot, message_language, configured_by_account_id
      ) values (
        ${company.companyId}::uuid, ${trader.traderId}::uuid, true,
        '120363000000000088@g.us', 'Controls Group', 'en', ${office.accountId}::uuid
      )
    `.execute(transaction);
    return {
      accountId: office.accountId,
      companyId: company.companyId,
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      traderId: trader.traderId,
    };
  }

  async function setPlatformEnabled(
    transaction: Transaction<DatabaseSchema>,
    world: World,
    isEnabled: boolean,
  ): Promise<void> {
    await sql`
      insert into company_whatsapp_platform_settings (
        company_id, whatsapp_enabled, updated_by_account_id
      ) values (${world.companyId}::uuid, ${isEnabled}, ${world.accountId}::uuid)
      on conflict (company_id) do update
        set whatsapp_enabled = excluded.whatsapp_enabled, updated_at = now(),
            version = company_whatsapp_platform_settings.version + 1
    `.execute(transaction);
  }

  async function outboxBodies(transaction: Transaction<DatabaseSchema>, companyId: string) {
    return (
      await sql<{ id: string; body: string; status: string }>`
        select id, message_body as "body", status from whatsapp_message_outbox
         where company_id = ${companyId}::uuid order by created_at
      `.execute(transaction)
    ).rows;
  }

  it("records nothing for a platform-disabled Company and resumes on re-enable", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId, "wa-kill");
      await setPlatformEnabled(transaction, world, false);
      const writer = history();
      await writer.statusHistory(transaction, {
        actorId: world.accountId,
        companyId: world.companyId,
        from: "assigned_to_driver",
        orderId: world.orderId,
        to: "out_for_delivery",
      });
      expect(await outboxBodies(transaction, world.companyId)).toHaveLength(0);

      await setPlatformEnabled(transaction, world, true);
      await writer.statusHistory(transaction, {
        actorId: world.accountId,
        companyId: world.companyId,
        from: "out_for_delivery",
        orderId: world.orderId,
        to: "delivered",
      });
      expect(await outboxBodies(transaction, world.companyId)).toHaveLength(1);
    });
  });

  it("renders a Company's custom template with placeholders; other statuses keep the default", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId, "wa-tpl");
      await sql`
        insert into company_whatsapp_message_templates (
          company_id, status, body_ar, body_en, updated_by_account_id
        ) values (
          ${world.companyId}::uuid, 'delivered',
          ${"تم تسليم {{orderNumber}} — {{companyName}}"},
          ${"Delivered! Order {{orderNumber}} ({{status}}) — {{companyName}}"},
          ${world.accountId}::uuid
        )
      `.execute(transaction);
      const writer = history();
      await writer.statusHistory(transaction, {
        actorId: world.accountId,
        companyId: world.companyId,
        from: "out_for_delivery",
        orderId: world.orderId,
        to: "delivered",
      });
      await writer.statusHistory(transaction, {
        actorId: world.accountId,
        companyId: world.companyId,
        from: "delivered",
        orderId: world.orderId,
        to: "returned_to_branch",
      });

      const rows = await outboxBodies(transaction, world.companyId);
      expect(rows).toHaveLength(2);
      // The Trader's language is `en` — the English override body renders with
      // every placeholder substituted (no `{{` survives).
      expect(rows[0]?.body).toContain(`Delivered! Order ${world.orderNumber} (Delivered)`);
      expect(rows[0]?.body).not.toContain("{{");
      // A status with no override keeps the built-in default wording.
      expect(rows[1]?.body).toContain("Order Status Update");
      expect(rows[1]?.body).toContain("Returned to branch");
    });
  });

  it("editing a template never rewrites an already-recorded message body", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId, "wa-snap");
      const writer = history();
      await writer.statusHistory(transaction, {
        actorId: world.accountId,
        companyId: world.companyId,
        from: "assigned_to_driver",
        orderId: world.orderId,
        to: "out_for_delivery",
      });
      const before = await outboxBodies(transaction, world.companyId);
      const service = new PlatformCompanyWhatsAppService(
        transaction as unknown as Kysely<DatabaseSchema>,
      );
      await service.updateTemplate(
        world.companyId,
        "out_for_delivery",
        { bodyAr: "جديد {{orderNumber}}", bodyEn: "New wording {{orderNumber}}" },
        { accountId: world.accountId, correlationId: "corr-tpl-1" },
      );
      const after = await outboxBodies(transaction, world.companyId);
      expect(after[0]?.body).toBe(before[0]?.body);
    });
  });

  it("never claims a disabled Company's parked rows, while other Companies dispatch", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const disabledWorld = await createWorld(transaction, runId, "wa-off");
      const enabledWorld = await createWorld(transaction, runId, "wa-on");
      const writer = history();
      // Both Companies queue one pending intent while still enabled…
      for (const world of [disabledWorld, enabledWorld]) {
        await writer.statusHistory(transaction, {
          actorId: world.accountId,
          companyId: world.companyId,
          from: "assigned_to_driver",
          orderId: world.orderId,
          to: "out_for_delivery",
        });
      }
      // …then the Platform switches one of them off.
      await setPlatformEnabled(transaction, disabledWorld, false);

      const sends: { companyId: string }[] = [];
      const provider = {
        getConnectionStatus: async () => "connected",
        sendMessage: async (input: { companyId: string }) => {
          sends.push(input);
          return { outcome: "sent", providerMessageId: "3EB0KILL1" };
        },
      };
      const dispatcher = new WhatsAppOutboxDispatcher(
        transaction as unknown as Kysely<DatabaseSchema>,
        provider as unknown as CompanyWhatsAppProvider,
      );
      await dispatcher.tick();

      expect(sends.map((send) => send.companyId)).toEqual([enabledWorld.companyId]);
      const parked = await outboxBodies(transaction, disabledWorld.companyId);
      expect(parked[0]?.status).toBe("pending");
      const delivered = await outboxBodies(transaction, enabledWorld.companyId);
      expect(delivered[0]?.status).toBe("sent");
    });
  });

  it("platform service: overview defaults, toggle upsert, template lifecycle and audit", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const world = await createWorld(transaction, runId, "wa-svc");
      const service = new PlatformCompanyWhatsAppService(
        transaction as unknown as Kysely<DatabaseSchema>,
      );
      const actor = { accountId: world.accountId, correlationId: "corr-svc-1" };

      const initial = await service.overview(world.companyId);
      expect(initial.enabled).toBe(true);
      expect(initial.templates).toHaveLength(6);
      expect(initial.templates.every((template) => !template.isCustom)).toBe(true);

      const disabled = await service.setEnabled(
        world.companyId,
        { enabled: false, reason: "Certification pending" },
        actor,
      );
      expect(disabled.enabled).toBe(false);
      expect(disabled.disabledReason).toBe("Certification pending");

      const reEnabled = await service.setEnabled(world.companyId, { enabled: true }, actor);
      expect(reEnabled.enabled).toBe(true);
      expect(reEnabled.disabledReason).toBeNull();

      const withTemplate = await service.updateTemplate(
        world.companyId,
        "delivered",
        { bodyAr: "تم {{orderNumber}}", bodyEn: "Done {{orderNumber}}" },
        actor,
      );
      expect(
        withTemplate.templates.find((template) => template.status === "delivered")?.isCustom,
      ).toBe(true);

      const afterReset = await service.resetTemplate(world.companyId, "delivered", actor);
      expect(
        afterReset.templates.find((template) => template.status === "delivered")?.isCustom,
      ).toBe(false);

      await expect(
        service.updateTemplate(world.companyId, "new", { bodyAr: "x", bodyEn: "y" }, actor),
      ).rejects.toMatchObject({ errorCode: "whatsapp_template_status_unknown" });

      // All four rows share the transaction's now(), so ordering by time is
      // not deterministic here — the set (with multiplicities) is the claim.
      const audits = (
        await sql<{ action: string }>`
          select action from audit_events
           where company_id = ${world.companyId}::uuid
             and action like 'platform.company_whatsapp.%'
        `.execute(transaction)
      ).rows.map((row) => row.action);
      expect([...audits].sort()).toEqual([
        "platform.company_whatsapp.enabled_changed",
        "platform.company_whatsapp.enabled_changed",
        "platform.company_whatsapp.template_reset",
        "platform.company_whatsapp.template_updated",
      ]);
    });
  });

  it("platform service: lists one Company's messages with totals and a date range", async () => {
    await withRolledBackCommunicationFixtures(database, async (transaction, runId) => {
      const worldA = await createWorld(transaction, runId, "wa-lst-a");
      const worldB = await createWorld(transaction, runId, "wa-lst-b");
      const writer = history();
      for (const world of [worldA, worldB]) {
        await writer.statusHistory(transaction, {
          actorId: world.accountId,
          companyId: world.companyId,
          from: "assigned_to_driver",
          orderId: world.orderId,
          to: "out_for_delivery",
        });
      }
      const service = new PlatformCompanyWhatsAppService(
        transaction as unknown as Kysely<DatabaseSchema>,
      );

      const all = await service.listMessages(worldA.companyId, {});
      expect(all.totals).toMatchObject({ pending: 1, total: 1 });
      expect(all.items).toHaveLength(1);
      expect(all.items[0]?.orderNumber).toBe(worldA.orderNumber);
      // Tenant isolation: Company B's message never appears in A's list.
      expect(all.items.some((item) => item.orderNumber === worldB.orderNumber)).toBe(false);

      const futureOnly = await service.listMessages(worldA.companyId, { from: "2999-01-01" });
      expect(futureOnly.totals.total).toBe(0);
      const pastOnly = await service.listMessages(worldA.companyId, { to: "2000-01-01" });
      expect(pastOnly.totals.total).toBe(0);
      const wide = await service.listMessages(worldA.companyId, {
        from: "2000-01-01",
        to: "2999-01-01",
      });
      expect(wide.totals.total).toBe(1);
    });
  });
});
