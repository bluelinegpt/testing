import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import type { AnnouncementInput } from "./announcements.js";
import { AnnouncementsService } from "./announcements.service.js";

/**
 * Platform announcements against a real PostgreSQL schema.
 *
 * Disposable database only: refuses to run unless the connected database is
 * named `blueline` on a local host. Every test runs in a transaction that is
 * rolled back, so nothing is left behind.
 *
 *   RUN_ANNOUNCEMENTS_DATABASE=true pnpm --filter @blueline/api exec vitest run src/announcements/announcements.database.test.ts
 */
const run = process.env.RUN_ANNOUNCEMENTS_DATABASE === "true";

class Rollback extends Error {}

let pool: Pool;
let database: Kysely<DatabaseSchema>;

async function inRollback(work: (tx: Transaction<DatabaseSchema>) => Promise<void>): Promise<void> {
  try {
    await database.transaction().execute(async (tx) => {
      await work(tx);
      throw new Rollback("rollback");
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

/** The service, running every statement inside the test's transaction. */
function serviceIn(tx: Transaction<DatabaseSchema>): AnnouncementsService {
  const transactions = {
    execute: <T>(work: (transaction: Transaction<DatabaseSchema>) => Promise<T>) => work(tx),
  } as unknown as KyselyTransactionManager;
  return new AnnouncementsService(tx, transactions);
}

async function companyId(tx: Transaction<DatabaseSchema>, label: string): Promise<string> {
  const id = randomUUID();
  const tag = id.slice(0, 8);
  await sql`insert into companies(id, code, subdomain, name_en, status, activated_at)
    values (${id}::uuid, ${`AN-${tag}`}, ${`an-${tag}`}, ${label}, 'active', now())`.execute(tx);
  return id;
}

async function platformActor(tx: Transaction<DatabaseSchema>) {
  const id = randomUUID();
  await sql`insert into accounts(id, company_id, account_kind, username, password_hash, preferred_language)
    values (${id}::uuid, null, 'platform_administrator', ${`an.p.${id}`}, 'x', 'en')`.execute(tx);
  return { accountId: id, correlationId: "announcement-test" };
}

const hours = (offset: number) => new Date(Date.now() + offset * 3_600_000).toISOString();

const announcement = (overrides: Partial<AnnouncementInput> = {}): AnnouncementInput => ({
  audience: "all_companies",
  bodyAr: "صيانة مجدولة الليلة.",
  bodyEn: "Planned maintenance tonight.",
  showFrom: hours(-1),
  showUntil: hours(2),
  surfaces: ["office_web"],
  titleAr: "صيانة",
  titleEn: "Maintenance",
  type: "warning",
  ...overrides,
});

describe.skipIf(!run)("Platform announcements (database)", () => {
  beforeAll(async () => {
    if (process.env.BLUELINE_DISABLE_DOTENV !== "1") {
      loadEnvironment({ path: resolve(process.cwd(), "../../.env"), quiet: true });
    }
    pool = new Pool({ connectionString: configuration().database.url, max: 2 });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const identity = await sql<{ name: string; local: boolean }>`
      select current_database() as name,
             coalesce(host(inet_server_addr()) in ('127.0.0.1', '::1'), true) as local
    `.execute(database);
    const row = identity.rows[0];
    if (row?.name !== "blueline" || !row.local) {
      throw new Error(`Refusing announcement tests against database ${String(row?.name)}`);
    }
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it("shows a live all-Companies announcement only on its own surface", async () => {
    await inRollback(async (tx) => {
      const service = serviceIn(tx);
      const actor = await platformActor(tx);
      const company = await companyId(tx, "Announcement A");
      const created = await service.create(announcement(), actor);
      expect(created.displayStatus).toBe("live");
      const office = await service.active(company, "office_web");
      expect(office.map((item) => item.id)).toContain(created.id);
      const portal = await service.active(company, "trader_portal");
      expect(portal.map((item) => item.id)).not.toContain(created.id);
    });
  });

  it("keeps a selected-Companies announcement away from other Companies", async () => {
    await inRollback(async (tx) => {
      const service = serviceIn(tx);
      const actor = await platformActor(tx);
      const targeted = await companyId(tx, "Announcement Target");
      const other = await companyId(tx, "Announcement Other");
      const created = await service.create(
        announcement({ audience: "selected_companies", companyIds: [targeted] }),
        actor,
      );
      expect(created.companies.map((company) => company.id)).toEqual([targeted]);
      expect((await service.active(targeted, "office_web")).map((item) => item.id)).toContain(
        created.id,
      );
      expect((await service.active(other, "office_web")).map((item) => item.id)).not.toContain(
        created.id,
      );
    });
  });

  it("hides scheduled, ended and cancelled announcements", async () => {
    await inRollback(async (tx) => {
      const service = serviceIn(tx);
      const actor = await platformActor(tx);
      const company = await companyId(tx, "Announcement Window");
      const scheduled = await service.create(
        announcement({ showFrom: hours(5), showUntil: hours(6) }),
        actor,
      );
      expect(scheduled.displayStatus).toBe("scheduled");
      const live = await service.create(announcement(), actor);
      const ended = await service.endNow(live.id, actor);
      expect(ended.displayStatus).toBe("ended");
      const another = await service.create(announcement(), actor);
      const cancelled = await service.cancel(another.id, actor);
      expect(cancelled.displayStatus).toBe("cancelled");
      const visible = (await service.active(company, "office_web")).map((item) => item.id);
      expect(visible).not.toContain(scheduled.id);
      expect(visible).not.toContain(live.id);
      expect(visible).not.toContain(another.id);
      await expect(service.update(another.id, announcement(), actor)).rejects.toMatchObject({
        errorCode: "announcement_cancelled",
      });
    });
  });

  it("bumps the version on every edit and writes audit events", async () => {
    await inRollback(async (tx) => {
      const service = serviceIn(tx);
      const actor = await platformActor(tx);
      const created = await service.create(announcement(), actor);
      const edited = await service.update(
        created.id,
        announcement({ titleEn: "Maintenance moved" }),
        actor,
      );
      expect(edited.version).toBe(created.version + 1);
      expect(edited.titleEn).toBe("Maintenance moved");
      const audits = await sql<{ action: string }>`
        select action from audit_events
         where subject_type = 'platform_announcement' and subject_id::text = ${created.id}
         order by created_at, action
      `.execute(tx);
      expect(audits.rows.map((row) => row.action).sort()).toEqual([
        "platform.announcement.create",
        "platform.announcement.update",
      ]);
    });
  });

  it("refuses an unknown target Company", async () => {
    await inRollback(async (tx) => {
      const service = serviceIn(tx);
      const actor = await platformActor(tx);
      await expect(
        service.create(
          announcement({ audience: "selected_companies", companyIds: [randomUUID()] }),
          actor,
        ),
      ).rejects.toMatchObject({ errorCode: "announcement_company_unknown" });
    });
  });

  it("orders stacked banners most severe first", async () => {
    await inRollback(async (tx) => {
      const service = serviceIn(tx);
      const actor = await platformActor(tx);
      const company = await companyId(tx, "Announcement Order");
      const info = await service.create(announcement({ type: "info" }), actor);
      const critical = await service.create(announcement({ type: "critical" }), actor);
      const ids = (await service.active(company, "office_web")).map((item) => item.id);
      expect(ids.indexOf(critical.id)).toBeLessThan(ids.indexOf(info.id));
    });
  });
});
