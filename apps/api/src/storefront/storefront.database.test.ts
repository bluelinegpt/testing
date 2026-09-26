import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  KyselyTransactionManager,
  TransactionWork,
} from "../infrastructure/database/transaction-manager.js";
import { FileOwnershipService } from "../files/file-ownership.service.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import type { IdentityContextAccessor, IdentityKind } from "../security/identity-context.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";

import { StorefrontService } from "./storefront.service.js";

/**
 * Storefront persistence against the real schema.
 *
 * Everything runs inside ONE transaction that is always rolled back, so no row
 * created here outlives the test and no existing record is touched. The claims
 * under test are the ones that are expensive to be wrong about: that a public
 * URL cannot be taken twice, that a Company cannot see or steer another
 * Company's shop, that a Trader cannot edit around an administrative
 * suspension, and that a private Storefront is indistinguishable from one that
 * does not exist.
 */

const runDatabaseTests = process.env.RUN_STOREFRONT_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `sf_${++this.sequence}`;
    await sql.raw(`savepoint ${savepoint}`).execute(this.transaction);
    try {
      const result = await work(this.transaction);
      await sql.raw(`release savepoint ${savepoint}`).execute(this.transaction);
      return result;
    } catch (error) {
      await sql.raw(`rollback to savepoint ${savepoint}`).execute(this.transaction);
      await sql.raw(`release savepoint ${savepoint}`).execute(this.transaction);
      throw error;
    }
  }
}

interface Fixture {
  readonly actorId: string;
  readonly companyId: string;
  readonly otherActorId: string;
  readonly otherCompanyId: string;
  readonly otherTraderId: string;
  readonly traderId: string;
}

async function seed(transaction: Transaction<DatabaseSchema>): Promise<Fixture> {
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const actorId = randomUUID();
  const otherActorId = randomUUID();
  const traderId = randomUUID();
  const otherTraderId = randomUUID();
  const short = companyId.slice(0, 8);
  const otherShort = otherCompanyId.slice(0, 8);

  for (const [id, code, label] of [
    [companyId, `SF-${short}`, `sf-${short}`],
    [otherCompanyId, `SFB-${otherShort}`, `sfb-${otherShort}`],
  ] as const) {
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values(${id}::uuid,${code},${label},'Storefront Test','active',now())`.execute(transaction);
  }
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash) values
    (${actorId}::uuid,${companyId}::uuid,'company_user',${`sf.a.${actorId}`},'x'),
    (${otherActorId}::uuid,${otherCompanyId}::uuid,'company_user',${`sf.b.${otherActorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into traders(id,company_id,code,name_en,mobile_number) values
    (${traderId}::uuid,${companyId}::uuid,${`T-${short}`},'Storefront Trader','971500000010'),
    (${otherTraderId}::uuid,${otherCompanyId}::uuid,${`T-${otherShort}`},'Other Trader','971500000011')`.execute(
    transaction,
  );
  return { actorId, companyId, otherActorId, otherCompanyId, otherTraderId, traderId };
}

/**
 * A competing Storefront created OUTSIDE the service, to stand in for a
 * concurrent claim on a public address.
 *
 * It has to mint its own Trader Commerce identity because `trader_commerce_id`
 * is now mandatory and only the service resolves one automatically. Writing the
 * insert by hand is the point of these two tests: they assert what the DATABASE
 * does when two Storefronts reach for one slug, so they must not route through
 * the code being tested.
 */
async function rivalStorefront(
  transaction: Transaction<DatabaseSchema>,
  companyId: string,
  traderId: string,
  slug: string,
): Promise<void> {
  const commerceId = randomUUID();
  await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status)
    values(${commerceId}::uuid,'Rival','delivery_company_registered','approved')`.execute(
    transaction,
  );
  await sql`insert into trader_commerce_company_links(trader_commerce_id,company_id,trader_id,link_source)
    values(${commerceId}::uuid,${companyId}::uuid,${traderId}::uuid,'migration_backfill')`.execute(
    transaction,
  );
  await sql`insert into trader_storefronts(
      company_id, trader_id, trader_commerce_id, display_name, slug, business_template, theme
    ) values(${companyId}::uuid, ${traderId}::uuid, ${commerceId}::uuid, 'Rival',
             ${slug}, 'general', 'modern')`.execute(transaction);
}

function buildService(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly actorId: string;
    readonly companyId: string;
    readonly kind?: IdentityKind;
    readonly permissions?: readonly string[];
    readonly traderProfileId?: string;
  },
): StorefrontService {
  const permissions = new Set(
    input.permissions ?? [
      "storefront.view",
      "storefront.manage",
      "storefront.publish",
      "storefront.suspend",
    ],
  );
  const tenants = {
    current: () => ({ companyId: input.companyId, identityId: input.actorId }),
  } as unknown as TenantContextAccessor;
  const identities = {
    current: () => ({
      companyId: input.companyId,
      forcePasswordChange: false,
      identityId: input.actorId,
      kind: input.kind ?? "company_user",
      permissions,
      sessionId: randomUUID(),
      ...(input.traderProfileId === undefined ? {} : { profileId: input.traderProfileId }),
    }),
  } as unknown as IdentityContextAccessor;
  return new StorefrontService(
    transaction as unknown as Kysely<DatabaseSchema>,
    new SavepointTransactionManager(transaction) as unknown as KyselyTransactionManager,
    tenants,
    identities,
    new OperationsHistoryWriter(),
    new FileOwnershipService(transaction as unknown as Kysely<DatabaseSchema>),
  );
}

/** A complete profile, so publication requirements are satisfiable. */
async function completeProfile(
  service: StorefrontService,
  storefrontId: string,
  version: number,
): Promise<number> {
  const updated = await service.update(
    storefrontId,
    {
      deliveryInformation: "Next-day delivery across the UAE",
      expectedVersion: version,
      publicMobile: "+971500000010",
      returnPolicy: "Returns accepted within 7 days",
      storeDescription: "Contemporary modest fashion",
    },
    randomUUID(),
  );
  return updated.version;
}

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const marker = new Error("rollback storefront test");
  try {
    await expect(
      database.transaction().execute(async (transaction) => {
        await work(transaction);
        throw marker;
      }),
    ).rejects.toBe(marker);
  } finally {
    await database.destroy();
  }
}

describe.skipIf(!runDatabaseTests)("Trader Storefront persistence", () => {
  it("creates a Storefront owned by the Company and Trader", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const created = await service.create(
        {
          businessTemplate: "fashion",
          displayName: "Al Noor Fashion",
          slug: "al-noor-fashion",
          theme: "luxury_minimal",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      expect(created.slug).toBe("al-noor-fashion");
      expect(created.status).toBe("draft");
      expect(created.traderId).toBe(fixture.traderId);
      expect(created.publicUrl).toBe("/store/al-noor-fashion");
      expect(created.version).toBe(1);
    });
  });

  it("mints one Trader Commerce identity for a Trader that has none", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      await service.create(
        {
          businessTemplate: "fashion",
          displayName: "Al Noor Fashion",
          slug: "al-noor-fashion",
          theme: "luxury_minimal",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      // The identity is resolved server-side from the Trader, and the Storefront
      // agrees with the link table about which shop it belongs to.
      const resolved = await sql<{
        identities: string;
        matched: string;
        relationships: string;
      }>`
        select
          (select count(*)::text from trader_commerce_company_links
            where trader_id = ${fixture.traderId}::uuid) as identities,
          (select count(*)::text from trader_storefronts storefront
             join trader_commerce_company_links link
               on link.trader_id = storefront.trader_id
              and link.trader_commerce_id = storefront.trader_commerce_id
            where storefront.trader_id = ${fixture.traderId}::uuid) as matched,
          (select count(*)::text from trader_delivery_company_relationships
            where company_id = ${fixture.companyId}::uuid
              and trader_id = ${fixture.traderId}::uuid
              and is_default_for_store_orders) as relationships
      `.execute(transaction);
      expect(resolved.rows[0]).toStrictEqual({
        identities: "1",
        matched: "1",
        relationships: "1",
      });
    });
  });

  it("reuses the existing Commerce identity rather than minting a second", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const commerceId = randomUUID();
      await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status)
        values(${commerceId}::uuid,'Existing','delivery_company_registered','approved')`.execute(
        transaction,
      );
      await sql`insert into trader_commerce_company_links(trader_commerce_id,company_id,trader_id,link_source)
        values(${commerceId}::uuid,${fixture.companyId}::uuid,${fixture.traderId}::uuid,'migration_backfill')`.execute(
        transaction,
      );
      const created = await service.create(
        {
          businessTemplate: "fashion",
          displayName: "Al Noor Fashion",
          slug: "al-noor-fashion",
          theme: "luxury_minimal",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      const found = await sql<{ traderCommerceId: string }>`
        select trader_commerce_id as "traderCommerceId" from trader_storefronts
         where id = ${created.id}::uuid
      `.execute(transaction);
      expect(found.rows[0]?.traderCommerceId).toBe(commerceId);
    });
  });

  it("allows only one Storefront per Trader", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const base = {
        businessTemplate: "fashion" as const,
        theme: "modern" as const,
        traderId: fixture.traderId,
      };
      await service.create(
        { ...base, displayName: "First", slug: "first-shop" },
        randomUUID(),
      );
      await expect(
        service.create({ ...base, displayName: "Second", slug: "second-shop" }, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "storefront_already_exists" });
    });
  });

  it("refuses a Trader session creating a Storefront for a DIFFERENT Trader in the SAME Company (T1 §31)", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      // A second Trader in the caller's OWN Company -- distinct from the
      // cross-Company case above, this proves `assertTraderInScope`'s own
      // `callerTrader !== traderId` guard, not just Company tenancy.
      const colleagueTraderId = randomUUID();
      await sql`insert into traders(id,company_id,code,name_en,mobile_number)
        values(${colleagueTraderId}::uuid,${fixture.companyId}::uuid,${`T-COLLEAGUE-${fixture.companyId.slice(0, 8)}`},
          'Colleague Trader','971500000012')`.execute(transaction);
      const service = buildService(transaction, {
        ...fixture,
        kind: "trader",
        traderProfileId: fixture.traderId,
      });
      await expect(
        service.create(
          {
            businessTemplate: "general",
            displayName: "Colleague's Store",
            slug: "colleagues-store",
            theme: "modern",
            traderId: colleagueTraderId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "storefront_not_found" });
    });
  });

  it("refuses to attach a Storefront to another Company's Trader", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      // Reported as not-found rather than forbidden: a 403 would confirm the
      // neighbour's Trader exists.
      await expect(
        service.create(
          {
            businessTemplate: "general",
            displayName: "Cross tenant",
            slug: "cross-tenant",
            theme: "modern",
            traderId: fixture.otherTraderId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "storefront_not_found" });
    });
  });

  it("never lets one Company read or edit another Company's Storefront", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const mine = buildService(transaction, fixture);
      const created = await mine.create(
        {
          businessTemplate: "jewelry",
          displayName: "Mine",
          slug: "mine-only",
          theme: "clean_light",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      const neighbour = buildService(transaction, {
        actorId: fixture.otherActorId,
        companyId: fixture.otherCompanyId,
      });
      await expect(neighbour.detail(created.id)).rejects.toMatchObject({
        errorCode: "storefront_not_found",
      });
      await expect(
        neighbour.update(created.id, { expectedVersion: created.version }, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "storefront_not_found" });
      expect((await neighbour.list({})).total).toBe(0);
    });
  });

  it("pins a Trader identity to its own Storefront", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const created = await buildService(transaction, fixture).create(
        {
          businessTemplate: "fashion",
          displayName: "Trader owned",
          slug: "trader-owned",
          theme: "modern",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      // A Trader in the SAME Company but a different Trader record.
      const strangerTrader = randomUUID();
      await sql`insert into traders(id,company_id,code,name_en,mobile_number)
        values(${strangerTrader}::uuid,${fixture.companyId}::uuid,
               ${`T2-${fixture.companyId.slice(0, 8)}`},'Stranger','971500000012')`.execute(
        transaction,
      );
      const stranger = buildService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        kind: "trader",
        permissions: [],
        traderProfileId: strangerTrader,
      });
      await expect(stranger.detail(created.id)).rejects.toMatchObject({
        errorCode: "storefront_not_found",
      });
      expect(await stranger.mine()).toBeNull();
    });
  });

  it("enforces global case-insensitive slug uniqueness across Companies", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await buildService(transaction, fixture).create(
        {
          businessTemplate: "fashion",
          displayName: "First",
          slug: "shared-name",
          theme: "modern",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      const neighbour = buildService(transaction, {
        actorId: fixture.otherActorId,
        companyId: fixture.otherCompanyId,
      });
      // The public namespace has no tenant dimension: a different Company gets
      // the same refusal, and casing does not create a second address.
      await expect(
        neighbour.create(
          {
            businessTemplate: "general",
            displayName: "Second",
            slug: "Shared-NAME",
            theme: "modern",
            traderId: fixture.otherTraderId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "storefront_slug_taken" });
    });
  });

  it("lets the unique index arbitrate a concurrent claim", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      // The availability read says yes...
      const availability = await service.slugAvailability({ slug: "contested-slug" });
      expect(availability.available).toBe(true);
      // ...and another writer takes it in between, exactly as a race would.
      const rival = randomUUID();
      await sql`insert into traders(id,company_id,code,name_en,mobile_number)
        values(${rival}::uuid,${fixture.otherCompanyId}::uuid,
               ${`R-${fixture.otherCompanyId.slice(0, 8)}`},'Rival','971500000013')`.execute(
        transaction,
      );
      await rivalStorefront(transaction, fixture.otherCompanyId, rival, "contested-slug");
      // The loser is told the URL is gone, not handed a constraint name.
      await expect(
        service.create(
          {
            businessTemplate: "fashion",
            displayName: "Loser",
            slug: "contested-slug",
            theme: "modern",
            traderId: fixture.traderId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "storefront_slug_taken" });
    });
  });

  it("rejects a reserved slug", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      await expect(
        service.create(
          {
            businessTemplate: "fashion",
            displayName: "Admin",
            slug: "admin",
            theme: "modern",
            traderId: fixture.traderId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "storefront_slug_reserved" });
      expect((await service.slugAvailability({ slug: "checkout" })).reason).toBe(
        "storefront_slug_reserved",
      );
    });
  });

  it("refuses to publish an incomplete profile and accepts a complete one", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const created = await service.create(
        {
          businessTemplate: "fashion",
          displayName: "Incomplete",
          slug: "incomplete-shop",
          theme: "modern",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      await expect(
        service.publish(created.id, { expectedVersion: created.version }, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "storefront_incomplete_for_publication" });

      const version = await completeProfile(service, created.id, created.version);
      const published = await service.publish(
        created.id,
        { expectedVersion: version },
        randomUUID(),
      );
      expect(published.status).toBe("published");
      expect(published.publishedAt).not.toBeNull();
    });
  });

  it("walks the permitted status transitions and refuses the rest", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const created = await service.create(
        {
          businessTemplate: "fashion",
          displayName: "Lifecycle",
          slug: "lifecycle-shop",
          theme: "modern",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      let version = await completeProfile(service, created.id, created.version);
      // A draft cannot jump straight to temporarily closed.
      await expect(
        service.temporarilyClose(created.id, { expectedVersion: version }, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "storefront_transition_invalid" });

      version = (await service.publish(created.id, { expectedVersion: version }, randomUUID()))
        .version;
      version = (
        await service.temporarilyClose(created.id, { expectedVersion: version }, randomUUID())
      ).version;
      version = (await service.reopen(created.id, { expectedVersion: version }, randomUUID()))
        .version;
      const unpublished = await service.unpublish(
        created.id,
        { expectedVersion: version },
        randomUUID(),
      );
      expect(unpublished.status).toBe("unpublished");
      // Unpublished keeps its publication history.
      expect(unpublished.publishedAt).not.toBeNull();
    });
  });

  it("lets an administrator suspend, and refuses the Trader any way out", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const admin = buildService(transaction, fixture);
      const created = await admin.create(
        {
          businessTemplate: "fashion",
          displayName: "Suspendable",
          slug: "suspendable-shop",
          theme: "modern",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      const version = await completeProfile(admin, created.id, created.version);
      const published = await admin.publish(
        created.id,
        { expectedVersion: version },
        randomUUID(),
      );
      const suspended = await admin.suspend(
        created.id,
        { expectedVersion: published.version, reason: "Policy review" },
        randomUUID(),
      );
      expect(suspended.status).toBe("suspended");
      expect(suspended.suspensionReason).toBe("Policy review");

      const trader = buildService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        kind: "trader",
        permissions: [],
        traderProfileId: fixture.traderId,
      });
      // No route out for the Trader: not by lifting it, not by editing, not by
      // steering the status graph.
      await expect(
        trader.removeSuspension(created.id, { expectedVersion: suspended.version }, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "storefront_permission_denied" });
      await expect(
        trader.update(
          created.id,
          { displayName: "Sneaky", expectedVersion: suspended.version },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "storefront_suspended" });
      await expect(
        trader.publish(created.id, { expectedVersion: suspended.version }, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "storefront_suspended" });

      const lifted = await admin.removeSuspension(
        created.id,
        { expectedVersion: suspended.version },
        randomUUID(),
      );
      // Back to unpublished, not straight back onto the public web.
      expect(lifted.status).toBe("unpublished");
      expect(lifted.suspensionReason).toBeNull();
    });
  });

  it("resolves a published Storefront publicly with only safe fields", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const created = await service.create(
        {
          businessTemplate: "fashion",
          displayName: "Public Shop",
          slug: "public-shop",
          theme: "luxury_minimal",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      const version = await completeProfile(service, created.id, created.version);
      await service.publish(created.id, { expectedVersion: version }, randomUUID());

      // Case-insensitive, as the public URL is.
      const resolved = await service.resolvePublic("Public-SHOP");
      expect(resolved.displayName).toBe("Public Shop");
      expect(resolved.status).toBe("published");
      const keys = Object.keys(resolved);
      for (const forbidden of ["companyId", "traderId", "id", "version", "suspensionReason"]) {
        expect(keys).not.toContain(forbidden);
      }
    });
  });

  it("keeps a temporarily closed Storefront publicly visible", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const created = await service.create(
        {
          businessTemplate: "general",
          displayName: "Closed Shop",
          slug: "closed-shop",
          theme: "modern",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      let version = await completeProfile(service, created.id, created.version);
      version = (await service.publish(created.id, { expectedVersion: version }, randomUUID()))
        .version;
      await service.temporarilyClose(created.id, { expectedVersion: version }, randomUUID());
      expect((await service.resolvePublic("closed-shop")).status).toBe("temporarily_closed");
    });
  });

  it("reports draft, unpublished, suspended and unknown slugs identically", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const created = await service.create(
        {
          businessTemplate: "fashion",
          displayName: "Private Shop",
          slug: "private-shop",
          theme: "modern",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      // Draft.
      await expect(service.resolvePublic("private-shop")).rejects.toMatchObject({
        errorCode: "storefront_not_found",
      });

      let version = await completeProfile(service, created.id, created.version);
      version = (await service.publish(created.id, { expectedVersion: version }, randomUUID()))
        .version;
      version = (await service.unpublish(created.id, { expectedVersion: version }, randomUUID()))
        .version;
      // Unpublished.
      await expect(service.resolvePublic("private-shop")).rejects.toMatchObject({
        errorCode: "storefront_not_found",
      });

      await service.suspend(
        created.id,
        { expectedVersion: version, reason: "Under review" },
        randomUUID(),
      );
      // Suspended — and an address that never existed. Identical answers, so a
      // caller cannot tell which slugs are taken.
      await expect(service.resolvePublic("private-shop")).rejects.toMatchObject({
        errorCode: "storefront_not_found",
      });
      await expect(service.resolvePublic("never-existed-at-all")).rejects.toMatchObject({
        errorCode: "storefront_not_found",
      });
    });
  });

  it("reserves a retired slug against every other Trader", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const created = await service.create(
        {
          businessTemplate: "fashion",
          displayName: "Renamer",
          slug: "original-address",
          theme: "modern",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      let version = await completeProfile(service, created.id, created.version);
      version = (await service.publish(created.id, { expectedVersion: version }, randomUUID()))
        .version;
      const renamed = await service.update(
        created.id,
        { expectedVersion: version, slug: "new-address" },
        randomUUID(),
      );
      expect(renamed.slug).toBe("new-address");

      const history = await sql<{ slug: string }>`
        select slug from trader_storefront_slugs where storefront_id = ${created.id}::uuid`.execute(
        transaction,
      );
      expect(history.rows.map((row) => row.slug)).toEqual(["original-address"]);

      // The old address is not claimable by anyone else.
      const neighbour = buildService(transaction, {
        actorId: fixture.otherActorId,
        companyId: fixture.otherCompanyId,
      });
      await expect(
        neighbour.create(
          {
            businessTemplate: "general",
            displayName: "Squatter",
            slug: "original-address",
            theme: "modern",
            traderId: fixture.otherTraderId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "storefront_slug_taken" });
      expect((await neighbour.slugAvailability({ slug: "original-address" })).available).toBe(
        false,
      );
    });
  });

  it("records an immutable audit trail for every lifecycle step", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const created = await service.create(
        {
          businessTemplate: "fashion",
          displayName: "Audited",
          slug: "audited-shop",
          theme: "modern",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      const version = await completeProfile(service, created.id, created.version);
      await service.publish(created.id, { expectedVersion: version }, randomUUID());

      const history = await service.history(created.id);
      const actions = history.items.map((row) => String(row.action));
      expect(actions).toContain("storefront.created");
      expect(actions).toContain("storefront.updated");
      expect(actions).toContain("storefront.published");

      const stored = await sql<{ companyId: string; subjectType: string }>`
        select company_id as "companyId", subject_type as "subjectType"
          from audit_events where subject_id = ${created.id}`.execute(transaction);
      expect(stored.rows.length).toBeGreaterThanOrEqual(3);
      for (const row of stored.rows) {
        expect(row.subjectType).toBe("trader_storefront");
        expect(row.companyId).toBe(fixture.companyId);
      }
    });
  });

  it("rolls back a failed write completely", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const created = await service.create(
        {
          businessTemplate: "fashion",
          displayName: "Rollback",
          slug: "rollback-shop",
          theme: "modern",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      const version = await completeProfile(service, created.id, created.version);
      await service.publish(created.id, { expectedVersion: version }, randomUUID());
      const beforeSlug = (await service.detail(created.id)).slug;

      // Rename onto a slug another Storefront already owns: the history insert
      // succeeds first, then the update fails. Both must disappear together, or
      // the Storefront would keep its address while having released it.
      const rival = randomUUID();
      await sql`insert into traders(id,company_id,code,name_en,mobile_number)
        values(${rival}::uuid,${fixture.otherCompanyId}::uuid,
               ${`RB-${fixture.otherCompanyId.slice(0, 8)}`},'Rival','971500000014')`.execute(
        transaction,
      );
      await rivalStorefront(transaction, fixture.otherCompanyId, rival, "taken-address");

      await expect(
        service.update(
          created.id,
          { expectedVersion: (await service.detail(created.id)).version, slug: "taken-address" },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "storefront_slug_taken" });

      const after = await service.detail(created.id);
      expect(after.slug).toBe(beforeSlug);
      const history = await sql<{ count: number }>`
        select count(*)::int as count from trader_storefront_slugs
         where storefront_id = ${created.id}::uuid`.execute(transaction);
      // No orphaned reservation left behind by the failed rename.
      expect(history.rows[0]!.count).toBe(0);
    });
  });

  it("refuses a caller without Storefront permissions", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const limited = buildService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        permissions: ["storefront.view"],
      });
      await expect(
        limited.create(
          {
            businessTemplate: "fashion",
            displayName: "Denied",
            slug: "denied-shop",
            theme: "modern",
            traderId: fixture.traderId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "storefront_permission_denied" });
    });
  });

  /* ---------------------------------------------------------------------
     The administrator escalation.

     `users_roles.manage` is the Company administrator super-permission. Every
     other module honours it, so Storefronts do too — an administrator who can
     reach Accounting, Payroll and Orders but not Storefronts is an
     inconsistency, not a boundary. Browser validation found the escalation
     missing here, so these tests pin BOTH halves of it: that it grants, and
     that it grants nothing across a Company line.
     --------------------------------------------------------------------- */

  it("accepts users_roles.manage in place of a Storefront permission", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const administrator = buildService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        // No storefront.* permission at all — only the administrator role.
        permissions: ["users_roles.manage"],
      });
      const created = await administrator.create(
        {
          businessTemplate: "fashion",
          displayName: "Administrator Shop",
          slug: "administrator-shop",
          theme: "modern",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      expect(created.slug).toBe("administrator-shop");

      // Read, write and the publication authorities all follow.
      expect((await administrator.detail(created.id)).id).toBe(created.id);
      const version = await completeProfile(administrator, created.id, created.version);
      const published = await administrator.publish(
        created.id,
        { expectedVersion: version },
        randomUUID(),
      );
      expect(published.status).toBe("published");
      const suspended = await administrator.suspend(
        created.id,
        { expectedVersion: published.version, reason: "Administrator action" },
        randomUUID(),
      );
      expect(suspended.status).toBe("suspended");
    });
  });

  it("still refuses a caller holding neither a Storefront permission nor users_roles.manage", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const outsider = buildService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        // A real permission set from another module: adjacent, but not this one.
        permissions: ["orders.view", "traders.view"],
      });
      await expect(
        outsider.create(
          {
            businessTemplate: "fashion",
            displayName: "Refused",
            slug: "refused-shop",
            theme: "modern",
            traderId: fixture.traderId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "storefront_permission_denied" });
      await expect(outsider.list({})).rejects.toMatchObject({
        errorCode: "storefront_permission_denied",
      });
    });
  });

  it("never lets users_roles.manage reach across a Company boundary", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const created = await buildService(transaction, fixture).create(
        {
          businessTemplate: "jewelry",
          displayName: "Neighbour Shop",
          slug: "neighbour-shop",
          theme: "clean_light",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      // An administrator of the OTHER Company. The escalation is a permission
      // check; it is not, and must never become, a tenancy check.
      const neighbourAdministrator = buildService(transaction, {
        actorId: fixture.otherActorId,
        companyId: fixture.otherCompanyId,
        permissions: ["users_roles.manage"],
      });
      await expect(neighbourAdministrator.detail(created.id)).rejects.toMatchObject({
        errorCode: "storefront_not_found",
      });
      await expect(
        neighbourAdministrator.update(created.id, { expectedVersion: created.version }, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "storefront_not_found" });
      await expect(
        neighbourAdministrator.suspend(
          created.id,
          { expectedVersion: created.version, reason: "Reaching over" },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "storefront_not_found" });
      // And it does not widen the list either.
      expect((await neighbourAdministrator.list({})).total).toBe(0);

      // The escalation must also not let an administrator adopt a Trader that
      // is not theirs.
      await expect(
        neighbourAdministrator.create(
          {
            businessTemplate: "general",
            displayName: "Adopted",
            slug: "adopted-shop",
            theme: "modern",
            traderId: fixture.traderId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "storefront_not_found" });
    });
  });

  it("lists a Company's own Storefronts and nobody else's", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const mine = buildService(transaction, fixture);
      // A second Trader in the same Company, so the list has something to sort.
      const secondTrader = randomUUID();
      await sql`insert into traders(id,company_id,code,name_en,mobile_number)
        values(${secondTrader}::uuid,${fixture.companyId}::uuid,
               ${`T3-${fixture.companyId.slice(0, 8)}`},'Second','971500000013')`.execute(
        transaction,
      );
      await mine.create(
        {
          businessTemplate: "fashion",
          displayName: "Zahra Boutique",
          slug: "zahra-boutique",
          theme: "modern",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      await mine.create(
        {
          businessTemplate: "general",
          displayName: "Amber Goods",
          slug: "amber-goods",
          theme: "modern",
          traderId: secondTrader,
        },
        randomUUID(),
      );
      // The neighbour Company creates one too, to prove the filter is real
      // rather than an artefact of an empty table.
      await buildService(transaction, {
        actorId: fixture.otherActorId,
        companyId: fixture.otherCompanyId,
      }).create(
        {
          businessTemplate: "fashion",
          displayName: "Not Mine",
          slug: "not-mine-shop",
          theme: "modern",
          traderId: fixture.otherTraderId,
        },
        randomUUID(),
      );

      const listed = await mine.list({});
      expect(listed.total).toBe(2);
      // Ordered by display name, so the Company sees a stable page.
      expect(listed.items.map((item) => item.slug)).toStrictEqual([
        "amber-goods",
        "zahra-boutique",
      ]);
      expect(listed.items.some((item) => item.slug === "not-mine-shop")).toBe(false);

      // An administrator without storefront.view reaches the same list.
      const administrator = buildService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        permissions: ["users_roles.manage"],
      });
      expect((await administrator.list({})).total).toBe(2);
    });
  });

  it("resolves a retired slug to the Storefront's current address", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const created = await service.create(
        {
          businessTemplate: "fashion",
          displayName: "Moved Shop",
          slug: "old-address",
          theme: "modern",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      let version = await completeProfile(service, created.id, created.version);
      version = (await service.publish(created.id, { expectedVersion: version }, randomUUID()))
        .version;
      await service.update(
        created.id,
        { expectedVersion: version, slug: "current-address" },
        randomUUID(),
      );

      // The retired address still answers, naming where to go instead.
      const redirected = await service.resolvePublic("old-address");
      expect(redirected.canonicalSlug).toBe("current-address");
      expect(redirected.displayName).toBe("Moved Shop");

      // The canonical address resolves directly, with no onward hop — which is
      // what makes a loop impossible.
      const canonical = await service.resolvePublic("current-address");
      expect(canonical.canonicalSlug).toBeUndefined();
    });
  });

  it("keeps a retired slug private when its Storefront is not public", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const created = await service.create(
        {
          businessTemplate: "fashion",
          displayName: "Withdrawn",
          slug: "withdrawn-old",
          theme: "modern",
          traderId: fixture.traderId,
        },
        randomUUID(),
      );
      let version = await completeProfile(service, created.id, created.version);
      version = (await service.publish(created.id, { expectedVersion: version }, randomUUID()))
        .version;
      version = (
        await service.update(
          created.id,
          { expectedVersion: version, slug: "withdrawn-new" },
          randomUUID(),
        )
      ).version;
      await service.unpublish(created.id, { expectedVersion: version }, randomUUID());

      // Unpublished: neither the old nor the new address may resolve, and the
      // old one must not reveal that the shop exists.
      await expect(service.resolvePublic("withdrawn-old")).rejects.toMatchObject({
        errorCode: "storefront_not_found",
      });
      await expect(service.resolvePublic("withdrawn-new")).rejects.toMatchObject({
        errorCode: "storefront_not_found",
      });
    });
  });

    /**
     * The marketplace listing is what a shopper sees first, and it was the one
     * Store projection that never showed a logo: `listPublic` hardcoded
     * `logoUrl: null` from before Commerce media existed, and nothing failed
     * when media arrived, because no test asserted the listing carried it.
     */
    it("carries the Store logo into the marketplace listing", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const fixture = await seed(transaction);
        const service = buildService(transaction, fixture);
        const created = await service.create(
          {
            businessTemplate: "fashion",
            displayName: "Listed Shop",
            slug: "listed-shop",
            theme: "luxury_minimal",
            traderId: fixture.traderId,
          },
          randomUUID(),
        );
        const version = await completeProfile(service, created.id, created.version);
        await service.publish(created.id, { expectedVersion: version }, randomUUID());

        const commerceId = await sql<{ id: string }>`
          select trader_commerce_id as id from trader_storefronts
           where id = ${created.id}::uuid
        `.execute(transaction);
        const fileId = randomUUID();
        await sql`
          insert into file_objects (
            id, owner_type, company_id, trader_commerce_id, storage_provider,
            storage_key, original_filename, media_type, size_bytes,
            classification, scan_status
          ) values (
            ${fileId}::uuid, 'trader_commerce', null,
            ${commerceId.rows[0]!.id}::uuid, 'local',
            ${`commerce/listing/${fileId}.png`}, 'logo.png', 'image/png', 10,
            'private', 'clean'
          )
        `.execute(transaction);
        await sql`
          update trader_storefronts set logo_file_id = ${fileId}::uuid
           where id = ${created.id}::uuid
        `.execute(transaction);

        const listed = await service.listPublic();
        const entry = listed.items.find((item) => item.slug === "listed-shop");
        expect(entry?.logoUrl).toBe(`/api/v1/public/commerce-media/${fileId}`);
      });
    });
  });
