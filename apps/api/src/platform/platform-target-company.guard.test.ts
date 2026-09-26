import type { ExecutionContext } from "@nestjs/common";
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { IdentityContext } from "../security/identity-context.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { PlatformTargetCompanyGuard } from "./platform-target-company.guard.js";

const companyA = {
  companyId: "11111111-1111-4111-8111-111111111111",
  code: "DEV-AAAA",
  subdomain: "alpha",
  nameEn: "Alpha Deliveries",
  status: "active",
};
const companyB = {
  companyId: "22222222-2222-4222-8222-222222222222",
  code: "DEV-BBBB",
  subdomain: "beta",
  nameEn: "Beta Deliveries",
  status: "active",
};
const knownCompanies = [companyA, companyB];

/**
 * A real Kysely instance over a driver that answers the guard's one lookup.
 *
 * Deliberately not a hand-written stub of Kysely's executor: using the genuine
 * PostgreSQL compiler means the guard's actual statement is compiled, its
 * `where id = $1` really becomes a bound parameter, and the assertions below
 * about tampered identifiers are testing the statement that ships rather than a
 * mock's idea of it.
 */
class StubConnection implements DatabaseConnection {
  public executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const requested = compiled.parameters[0];
    const found = knownCompanies.find((company) => company.companyId === requested);
    return Promise.resolve({ rows: (found === undefined ? [] : [found]) as R[] });
  }

  public async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    // Never used by the guard; present to satisfy the connection contract.
  }
}

class StubDriver implements Driver {
  public init(): Promise<void> {
    return Promise.resolve();
  }
  public acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve(new StubConnection());
  }
  public beginTransaction(): Promise<void> {
    return Promise.resolve();
  }
  public commitTransaction(): Promise<void> {
    return Promise.resolve();
  }
  public rollbackTransaction(): Promise<void> {
    return Promise.resolve();
  }
  public releaseConnection(): Promise<void> {
    return Promise.resolve();
  }
  public destroy(): Promise<void> {
    return Promise.resolve();
  }
}

function fakeDatabase(): Kysely<DatabaseSchema> {
  return new Kysely<DatabaseSchema>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new StubDriver(),
      createIntrospector: (database: Kysely<DatabaseSchema>) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

function platformIdentity(accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"): IdentityContext {
  return {
    identityId: accountId,
    kind: "platform_administrator",
    permissions: new Set(["platform.access", "platform.companies.read"]),
    companyId: null,
    sessionId: "session-1",
    forcePasswordChange: false,
  };
}

function contextWith(companyId: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ params: companyId === undefined ? {} : { companyId } }),
    }),
  } as unknown as ExecutionContext;
}

describe("PlatformTargetCompanyGuard", () => {
  let store: RequestSecurityContextStore;
  let guard: PlatformTargetCompanyGuard;

  beforeEach(() => {
    store = new RequestSecurityContextStore();
    guard = new PlatformTargetCompanyGuard(fakeDatabase(), store);
  });

  /** Mirrors production: the middleware opens the store, then the guard runs. */
  function withinRequest<T>(identity: IdentityContext, work: () => Promise<T>): Promise<T> {
    return store.run({ identity, tenant: undefined }, work);
  }

  it("resolves a valid Company from the database", async () => {
    await withinRequest(platformIdentity(), async () => {
      await expect(guard.canActivate(contextWith(companyA.companyId))).resolves.toBe(true);
      expect(store.targetCompany()).toEqual(companyA);
    });
  });

  /**
   * Everything downstream reads the Company from the row, never from the
   * request. A later phase decides whether destructive maintenance is allowed;
   * if that answer came from the browser it would be whatever the browser said.
   */
  it("takes every Company fact from the database row", async () => {
    await withinRequest(platformIdentity(), async () => {
      await guard.canActivate(contextWith(companyB.companyId));
      const target = store.targetCompany();
      expect(target?.code).toBe("DEV-BBBB");
      expect(target?.subdomain).toBe("beta");
      expect(target?.nameEn).toBe("Beta Deliveries");
      expect(target?.status).toBe("active");
    });
  });

  it("rejects an unknown Company", async () => {
    await withinRequest(platformIdentity(), async () => {
      await expect(
        guard.canActivate(contextWith("33333333-3333-4333-8333-333333333333")),
      ).rejects.toMatchObject({ errorCode: "company_not_found" });
      expect(store.targetCompany()).toBeUndefined();
    });
  });

  it("rejects a malformed Company identifier the same way as an unknown one", async () => {
    // Identical responses on purpose: a distinct "no such Company" would turn
    // this route into a Company-id oracle for anyone holding a Platform session.
    await withinRequest(platformIdentity(), async () => {
      for (const tampered of ["not-a-uuid", "1", "' or 1=1 --", "../../etc/passwd", ""]) {
        await expect(guard.canActivate(contextWith(tampered))).rejects.toMatchObject({
          errorCode: "company_not_found",
        });
      }
      expect(store.targetCompany()).toBeUndefined();
    });
  });

  it("refuses a route that carries no Company identifier at all", async () => {
    await withinRequest(platformIdentity(), async () => {
      await expect(guard.canActivate(contextWith(undefined))).rejects.toMatchObject({
        errorCode: "target_company_required",
      });
    });
  });

  it("leaves the Platform actor's own Company null", async () => {
    await withinRequest(platformIdentity(), async () => {
      await guard.canActivate(contextWith(companyA.companyId));
      expect(store.current().identity.companyId).toBeNull();
      expect(store.current().identity.kind).toBe("platform_administrator");
    });
  });

  /**
   * This is the reuse mechanism: moving the tenant slot is what lets an
   * existing Company-scoped service run under an explicit target without ever
   * being taught that Platform actors exist.
   */
  it("points the tenant context at the target Company", async () => {
    await withinRequest(platformIdentity("actor-1"), async () => {
      await guard.canActivate(contextWith(companyA.companyId));
      expect(store.current().tenant).toEqual({
        companyId: companyA.companyId,
        identityId: "actor-1",
      });
    });
  });

  it("refuses to establish a target with no authenticated context", async () => {
    await expect(guard.canActivate(contextWith(companyA.companyId))).rejects.toThrow(
      "requires an authenticated request security context",
    );
  });

  it("does not leak a target Company into a later request", async () => {
    await withinRequest(platformIdentity(), async () => {
      await guard.canActivate(contextWith(companyA.companyId));
      expect(store.targetCompany()).toEqual(companyA);
    });
    await withinRequest(platformIdentity(), () => {
      expect(store.targetCompany()).toBeUndefined();
      return Promise.resolve();
    });
  });

  /**
   * The failure this rules out is the one a second, `enterWith`-style store
   * would have produced: two concurrent Platform requests targeting different
   * Companies, one of them silently acting on the other's.
   */
  it("keeps concurrent requests targeting different Companies isolated", async () => {
    const observed: (string | undefined)[] = [];
    const run = (company: typeof companyA, delayTicks: number): Promise<void> =>
      withinRequest(platformIdentity(), async () => {
        await guard.canActivate(contextWith(company.companyId));
        for (let tick = 0; tick < delayTicks; tick += 1) await Promise.resolve();
        observed.push(store.targetCompany()?.companyId);
        expect(store.current().tenant?.companyId).toBe(company.companyId);
      });

    await Promise.all([run(companyA, 5), run(companyB, 1), run(companyA, 3)]);
    expect(observed.sort()).toEqual(
      [companyA.companyId, companyA.companyId, companyB.companyId].sort(),
    );
  });
});
