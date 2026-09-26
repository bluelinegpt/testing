import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { ConfigService } from "@nestjs/config";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";

import type { AppConfiguration } from "../configuration/environment.js";
import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { AuthenticationRepository } from "../authentication/authentication.repository.js";
import { AuthenticationService } from "../authentication/authentication.service.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { SessionTokenService } from "../authentication/session-token.service.js";
import { CommerceCustomerAuthService } from "./commerce-customer-auth.service.js";
import { CommerceCustomerProfileService } from "./commerce-customer-profile.service.js";

/**
 * Shared Commerce Foundation Prompt 3A: registration, login isolation,
 * session/lockout reuse, password reset lifecycle, and cross-Customer
 * profile/address isolation.
 */
const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

async function inRolledBackTransaction(
  work: (
    transaction: Transaction<DatabaseSchema>,
    services: {
      readonly authentication: AuthenticationService;
      readonly customerAuth: CommerceCustomerAuthService;
      readonly profiles: CommerceCustomerProfileService;
      readonly repository: AuthenticationRepository;
    },
  ) => Promise<void>,
): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const rollback = Symbol("rollback commerce customer auth test");
  try {
    await database.transaction().execute(async (transaction) => {
      const kyselyTransaction = transaction as unknown as Kysely<DatabaseSchema>;
      const hasher = new PasswordHasher();
      const sessionTokens = new SessionTokenService();
      const repository = new AuthenticationRepository(kyselyTransaction);
      const config = {
        get: (key: string) => (key === "auth.lockoutMinutes" ? 15 : 720),
      } as unknown as ConfigService<AppConfiguration, true>;
      const authentication = new AuthenticationService(repository, hasher, sessionTokens, config);
      // Kysely refuses a nested `.transaction()` call on a Transaction that
      // is already open, so this test's already-open outer transaction (its
      // own rollback mechanism) is threaded straight through as "the
      // transaction" every service call gets -- mirroring how every other
      // `*.database.test.ts` file in this codebase stubs
      // `KyselyTransactionManager`/`transactions.execute`.
      const transactions = {
        execute: async <T>(work: (tx: Transaction<DatabaseSchema>) => Promise<T>) => work(transaction),
      } as unknown as KyselyTransactionManager;
      const customerAuth = new CommerceCustomerAuthService(
        kyselyTransaction,
        transactions,
        hasher,
        sessionTokens,
        authentication,
      );
      const profiles = new CommerceCustomerProfileService(kyselyTransaction, transactions);
      await work(transaction, { authentication, customerAuth, profiles, repository });
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await database.destroy();
  }
}

async function seedCompanyTrader(transaction: Transaction<DatabaseSchema>) {
  const companyId = randomUUID();
  const suffix = companyId.slice(0, 8);
  await sql`insert into companies(id, code, subdomain, name_en, status, activated_at)
    values(${companyId}::uuid, ${`TR-${suffix}`}, ${`tr-${suffix}`}, 'Trader Co', 'active', now())`.execute(
    transaction,
  );
  const accountId = randomUUID();
  const hasher = new PasswordHasher();
  const passwordHash = await hasher.hash("Trader-Password-1");
  await sql`insert into accounts(id, company_id, account_kind, username, normalized_username, password_hash)
    values(${accountId}::uuid, ${companyId}::uuid, 'trader', ${`trader-${suffix}`}, ${`trader-${suffix}`}, ${passwordHash})`.execute(
    transaction,
  );
  return { accountId, companyId, username: `trader-${suffix}` };
}

const registerInput = (mobile: string, overrides: Record<string, unknown> = {}) => ({
  acceptedTerms: true as const,
  mobile,
  name: "Dev Customer",
  password: "Customer-Password-1",
  ...overrides,
});

describe.skipIf(!runDatabaseTests)("Commerce Customer registration (Prompt 3A)", () => {
  it("atomically creates the account and profile, and signs the Customer in", async () => {
    await inRolledBackTransaction(async (transaction, { customerAuth }) => {
      const result = await customerAuth.register(registerInput("971501111001"), {});
      expect(result.identity.kind).toBe("customer");
      expect(result.identity.companyId).toBeNull();
      expect(result.accessToken).toBeDefined();

      const account = await sql<{ companyId: string | null; kind: string }>`
        select account_kind as kind, company_id as "companyId" from accounts where id = ${result.identity.id}::uuid
      `.execute(transaction);
      expect(account.rows[0]?.kind).toBe("customer");
      expect(account.rows[0]?.companyId).toBeNull();

      const profile = await sql<{ count: string }>`
        select count(*)::text as count from commerce_customers where account_id = ${result.identity.id}::uuid
      `.execute(transaction);
      expect(profile.rows[0]?.count).toBe("1");
    });
  });

  /**
   * Regression: every other registration test in this file passes an
   * already-normalized `9715XXXXXXXX` mobile, which silently never
   * exercised `commerce_customers.mobile_number`'s own format CHECK — a raw,
   * as-a-shopper-would-type-it local mobile ("0507654321") is the realistic
   * input, and browser verification (not this suite) is what actually
   * caught the mismatch between the raw value and the normalized one the
   * constraint requires.
   */
  it("registers successfully with a raw, non-normalized local mobile number", async () => {
    await inRolledBackTransaction(async (transaction, { customerAuth }) => {
      const result = await customerAuth.register(registerInput("0507654321"), {});
      const profile = await sql<{ mobile: string }>`
        select mobile_number as mobile from commerce_customers where account_id = ${result.identity.id}::uuid
      `.execute(transaction);
      expect(profile.rows[0]?.mobile).toBe("971507654321");
    });
  });

  it("rejects a duplicate mobile registration without a partial account", async () => {
    await inRolledBackTransaction(async (transaction, { customerAuth }) => {
      await customerAuth.register(registerInput("971501111002"), {});
      // The failed duplicate INSERT is a real Postgres unique-violation,
      // which aborts the current transaction until a ROLLBACK -- a SAVEPOINT
      // around just the failing call keeps the outer (test-rollback)
      // transaction usable for the assertion query below, exactly the way a
      // real (non-nested, top-level) production transaction would already
      // be usable again after its own failure.
      await sql`savepoint duplicate_registration_check`.execute(transaction);
      await expect(customerAuth.register(registerInput("971501111002"), {})).rejects.toMatchObject({
        errorCode: "customer_already_registered",
      });
      await sql`rollback to savepoint duplicate_registration_check`.execute(transaction);
      const count = await sql<{ count: string }>`
        select count(*)::text as count from accounts where normalized_mobile_number = '971501111002'
      `.execute(transaction);
      expect(count.rows[0]?.count).toBe("1");
    });
  });

  it("rejects a duplicate email registration", async () => {
    await inRolledBackTransaction(async (transaction, { customerAuth }) => {
      await customerAuth.register(
        registerInput("971501111003", { email: "shopper@example.test" }),
        {},
      );
      await expect(
        customerAuth.register(
          registerInput("971501111004", { email: "Shopper@Example.Test" }),
          {},
        ),
      ).rejects.toMatchObject({ errorCode: "customer_already_registered" });
    });
  });

  it("rejects an invalid mobile number", async () => {
    await inRolledBackTransaction(async (transaction, { customerAuth }) => {
      await expect(
        customerAuth.register(registerInput("not-a-mobile"), {}),
      ).rejects.toMatchObject({ errorCode: "invalid_mobile" });
    });
  });
});

describe.skipIf(!runDatabaseTests)("Commerce Customer login isolation (Prompt 3A)", () => {
  it("logs a valid Customer in", async () => {
    await inRolledBackTransaction(async (transaction, { authentication, customerAuth }) => {
      await customerAuth.register(registerInput("971501111010"), {});
      const login = await authentication.loginCustomer({
        identifier: "971501111010",
        password: "Customer-Password-1",
      });
      expect(login.identity.kind).toBe("customer");
    });
  });

  it("rejects an invalid password", async () => {
    await inRolledBackTransaction(async (transaction, { authentication, customerAuth }) => {
      await customerAuth.register(registerInput("971501111011"), {});
      await expect(
        authentication.loginCustomer({ identifier: "971501111011", password: "wrong-password-1" }),
      ).rejects.toMatchObject({ errorCode: "invalid_credentials" });
    });
  });

  it("Trader credentials cannot Customer-login", async () => {
    await inRolledBackTransaction(async (transaction, { authentication }) => {
      const trader = await seedCompanyTrader(transaction);
      await expect(
        authentication.loginCustomer({
          identifier: trader.username,
          password: "Trader-Password-1",
        }),
      ).rejects.toMatchObject({ errorCode: "invalid_credentials" });
    });
  });

  it("locks a Customer account out after repeated failures, matching the reused threshold", async () => {
    await inRolledBackTransaction(async (transaction, { authentication, customerAuth }) => {
      await customerAuth.register(registerInput("971501111012"), {});
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await expect(
          authentication.loginCustomer({ identifier: "971501111012", password: "wrong-password-1" }),
        ).rejects.toMatchObject({ errorCode: "invalid_credentials" });
      }
      // The 5th failure trips the lock (recordFailedLogin: `>= 5`).
      await expect(
        authentication.loginCustomer({ identifier: "971501111012", password: "wrong-password-1" }),
      ).rejects.toMatchObject({ errorCode: "invalid_credentials" });
      // Even the CORRECT password is now refused while locked.
      await expect(
        authentication.loginCustomer({ identifier: "971501111012", password: "Customer-Password-1" }),
      ).rejects.toMatchObject({ errorCode: "invalid_credentials" });
    });
  });

  it("resets the failure counter on a successful login", async () => {
    await inRolledBackTransaction(async (transaction, { authentication, customerAuth }) => {
      const result = await customerAuth.register(registerInput("971501111013"), {});
      await expect(
        authentication.loginCustomer({ identifier: "971501111013", password: "wrong-password-1" }),
      ).rejects.toMatchObject({ errorCode: "invalid_credentials" });
      await authentication.loginCustomer({
        identifier: "971501111013",
        password: "Customer-Password-1",
      });
      const account = await sql<{ failedLoginAttempts: number }>`
        select failed_login_attempts as "failedLoginAttempts" from accounts where id = ${result.identity.id}::uuid
      `.execute(transaction);
      expect(account.rows[0]?.failedLoginAttempts).toBe(0);
    });
  });
});

describe.skipIf(!runDatabaseTests)("Commerce Customer session (Prompt 3A)", () => {
  it("resolves a session created at registration through the shared authenticate() path", async () => {
    await inRolledBackTransaction(async (transaction, { authentication, customerAuth }) => {
      const result = await customerAuth.register(registerInput("971501111020"), {});
      const identity = await authentication.authenticate(result.accessToken);
      expect(identity.kind).toBe("customer");
      expect(identity.companyId).toBeNull();
    });
  });

  it("logout revokes the session", async () => {
    await inRolledBackTransaction(async (transaction, { authentication, customerAuth }) => {
      const result = await customerAuth.register(registerInput("971501111021"), {});
      const identity = await authentication.authenticate(result.accessToken);
      await authentication.logout(identity);
      await expect(authentication.authenticate(result.accessToken)).rejects.toMatchObject({
        errorCode: "invalid_session",
      });
    });
  });

  it("issues a fresh session token on every login (fixation prevention)", async () => {
    await inRolledBackTransaction(async (transaction, { authentication, customerAuth }) => {
      const registered = await customerAuth.register(registerInput("971501111022"), {});
      const secondLogin = await authentication.loginCustomer({
        identifier: "971501111022",
        password: "Customer-Password-1",
      });
      expect(secondLogin.accessToken).not.toBe(registered.accessToken);
    });
  });
});

describe.skipIf(!runDatabaseTests)("Commerce Customer password reset (Prompt 3A)", () => {
  it("completes a reset: old password fails, new password works, token cannot reuse", async () => {
    await inRolledBackTransaction(async (transaction, { authentication, customerAuth }) => {
      await customerAuth.register(registerInput("971501111030"), {});
      const token = await customerAuth.issueResetTokenForTesting("971501111030");
      expect(token).toBeDefined();

      await customerAuth.completePasswordReset({ newPassword: "New-Password-99", token: token! });

      await expect(
        authentication.loginCustomer({ identifier: "971501111030", password: "Customer-Password-1" }),
      ).rejects.toMatchObject({ errorCode: "invalid_credentials" });
      await expect(
        authentication.loginCustomer({ identifier: "971501111030", password: "New-Password-99" }),
      ).resolves.toBeDefined();

      // One-time use.
      await expect(
        customerAuth.completePasswordReset({ newPassword: "Another-Password-1", token: token! }),
      ).rejects.toMatchObject({ errorCode: "password_reset_token_invalid" });
    });
  });

  it("rejects an expired token", async () => {
    await inRolledBackTransaction(async (transaction, { customerAuth }) => {
      const result = await customerAuth.register(registerInput("971501111031"), {});
      const token = await customerAuth.issueResetTokenForTesting("971501111031");
      // `expires_at > created_at` is enforced by CHECK, so an already-past
      // `expires_at` requires backdating `created_at` too, not just moving
      // `expires_at` behind "now" while `created_at` stays at insertion time.
      await sql`update password_reset_tokens
        set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
        where account_id = ${result.identity.id}::uuid`.execute(transaction);
      await expect(
        customerAuth.completePasswordReset({ newPassword: "New-Password-99", token: token! }),
      ).rejects.toMatchObject({ errorCode: "password_reset_token_invalid" });
    });
  });

  it("rejects a wrong/garbage token", async () => {
    await inRolledBackTransaction(async (transaction, { customerAuth }) => {
      await customerAuth.register(registerInput("971501111032"), {});
      await expect(
        customerAuth.completePasswordReset({
          newPassword: "New-Password-99",
          token: "not-a-real-token-at-all",
        }),
      ).rejects.toMatchObject({ errorCode: "password_reset_token_invalid" });
    });
  });

  it("is enumeration-safe: an unknown identifier issues no token and reports no error", async () => {
    await inRolledBackTransaction(async (transaction, { customerAuth }) => {
      // The table may already carry rows from real, unrelated accounts
      // (this is the live database, guarded only by this test's own
      // transaction rollback) -- so the assertion is a before/after row
      // count, not an assumption the table starts empty.
      const before = await sql<{ count: string }>`select count(*)::text as count from password_reset_tokens`.execute(
        transaction,
      );
      await expect(
        customerAuth.requestPasswordReset("971509999999"),
      ).resolves.toBeUndefined();
      const after = await sql<{ count: string }>`select count(*)::text as count from password_reset_tokens`.execute(
        transaction,
      );
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    });
  });

  it("revokes other active sessions on a successful reset", async () => {
    await inRolledBackTransaction(async (transaction, { authentication, customerAuth }) => {
      const registered = await customerAuth.register(registerInput("971501111033"), {});
      const token = await customerAuth.issueResetTokenForTesting("971501111033");
      await customerAuth.completePasswordReset({ newPassword: "New-Password-99", token: token! });
      await expect(authentication.authenticate(registered.accessToken)).rejects.toMatchObject({
        errorCode: "invalid_session",
      });
    });
  });
});

describe.skipIf(!runDatabaseTests)("Commerce Customer profile/address isolation (Prompt 3A)", () => {
  it("returns the authenticated Customer's own profile", async () => {
    await inRolledBackTransaction(async (transaction, { customerAuth, profiles }) => {
      const result = await customerAuth.register(registerInput("971501111040"), {});
      const profile = await profiles.profile(result.identity.id);
      expect(profile.mobile).toBe("971501111040");
      expect(profile.name).toBe("Dev Customer");
    });
  });

  it("updates the profile's name and language", async () => {
    await inRolledBackTransaction(async (transaction, { customerAuth, profiles }) => {
      const result = await customerAuth.register(registerInput("971501111041"), {});
      const updated = await profiles.updateProfile(result.identity.id, {
        name: "Updated Name",
        preferredLanguage: "ar",
      });
      expect(updated.name).toBe("Updated Name");
      expect(updated.preferredLanguage).toBe("ar");
    });
  });

  it("Customer A cannot read, edit or delete Customer B's address", async () => {
    await inRolledBackTransaction(async (transaction, { customerAuth, profiles }) => {
      const customerA = await customerAuth.register(registerInput("971501111042"), {});
      const customerB = await customerAuth.register(registerInput("971501111043"), {});
      const addressB = await profiles.createAddress(customerB.identity.id, {
        address: "Marina, Dubai",
        emirate: "Dubai",
        mobile: "971501111043",
        recipientName: "Customer B",
      });

      await expect(
        profiles.updateAddress(customerA.identity.id, addressB.id, { recipientName: "Hijacked" }),
      ).rejects.toMatchObject({ errorCode: "customer_address_not_found" });
      await expect(
        profiles.deleteAddress(customerA.identity.id, addressB.id),
      ).rejects.toMatchObject({ errorCode: "customer_address_not_found" });
      await expect(
        profiles.setDefaultAddress(customerA.identity.id, addressB.id),
      ).rejects.toMatchObject({ errorCode: "customer_address_not_found" });

      // B's address is untouched.
      const stillThere = await profiles.listAddresses(customerB.identity.id);
      expect(stillThere).toHaveLength(1);
      expect(stillThere[0]?.recipientName).toBe("Customer B");
    });
  });

  it("enforces a single default address, switching default correctly", async () => {
    await inRolledBackTransaction(async (transaction, { customerAuth, profiles }) => {
      const customer = await customerAuth.register(registerInput("971501111044"), {});
      const first = await profiles.createAddress(customer.identity.id, {
        address: "Deira, Dubai",
        emirate: "Dubai",
        isDefault: true,
        mobile: "971501111044",
        recipientName: "Home",
      });
      const second = await profiles.createAddress(customer.identity.id, {
        address: "Marina, Dubai",
        emirate: "Dubai",
        isDefault: true,
        mobile: "971501111044",
        recipientName: "Work",
      });
      const addresses = await profiles.listAddresses(customer.identity.id);
      expect(addresses.find((row) => row.id === first.id)?.isDefault).toBe(false);
      expect(addresses.find((row) => row.id === second.id)?.isDefault).toBe(true);

      await profiles.setDefaultAddress(customer.identity.id, first.id);
      const afterSwitch = await profiles.listAddresses(customer.identity.id);
      expect(afterSwitch.find((row) => row.id === first.id)?.isDefault).toBe(true);
      expect(afterSwitch.find((row) => row.id === second.id)?.isDefault).toBe(false);
    });
  });

  it("deletes an address", async () => {
    await inRolledBackTransaction(async (transaction, { customerAuth, profiles }) => {
      const customer = await customerAuth.register(registerInput("971501111045"), {});
      const address = await profiles.createAddress(customer.identity.id, {
        address: "Deira, Dubai",
        emirate: "Dubai",
        mobile: "971501111045",
        recipientName: "Home",
      });
      await profiles.deleteAddress(customer.identity.id, address.id);
      expect(await profiles.listAddresses(customer.identity.id)).toHaveLength(0);
    });
  });
});
