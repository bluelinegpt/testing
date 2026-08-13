import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql, type Transaction } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type {
  CommerceCustomerAddressDto,
  UpdateCommerceCustomerAddressDto,
  UpdateCommerceCustomerProfileDto,
} from "./commerce-customer-auth.dto.js";

export interface CommerceCustomerProfile {
  readonly email: string | null;
  readonly mobile: string;
  readonly name: string;
  readonly preferredLanguage: string;
  readonly status: string;
}

export interface CommerceCustomerAddress {
  readonly address: string;
  readonly area: string | null;
  readonly deliveryInstructions: string | null;
  readonly emirate: string;
  readonly id: string;
  readonly isDefault: boolean;
  readonly label: string | null;
  readonly locationLink: string | null;
  readonly mobile: string;
  readonly recipientName: string;
}

/**
 * Customer-scoped profile and address management (§43/§44).
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY METHOD TAKES `accountId`, NEVER A CUSTOMER/ADDRESS ID FROM THE CALLER
 * ---------------------------------------------------------------------------
 *
 * §37/§49: Customer identity is always resolved from the authenticated
 * session (`identity.identityId`, passed in by the controller), never from
 * a client-supplied id. Every query below re-derives `commerce_customers.id`
 * from `accountId` itself rather than trusting a `customerId` the caller
 * might send, and every address query is scoped to
 * `commerce_customer_id = (that derived id)` -- so Customer A manipulating
 * an address id it does not own resolves to zero rows, not another
 * Customer's address, regardless of what id is guessed.
 */
@Injectable()
export class CommerceCustomerProfileService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
  ) {}

  public async profile(accountId: string): Promise<CommerceCustomerProfile> {
    const result = await sql<CommerceCustomerProfile>`
      select name, mobile_number as mobile, email, preferred_language as "preferredLanguage", status
        from commerce_customers where account_id = ${accountId}::uuid
    `.execute(this.database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "customer_profile_not_found",
        "No Customer profile exists for this account",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  public async updateProfile(
    accountId: string,
    input: UpdateCommerceCustomerProfileDto,
  ): Promise<CommerceCustomerProfile> {
    // Mobile is deliberately absent from `UpdateCommerceCustomerProfileDto`
    // (§43: "Mobile-number change may remain read-only until verification
    // exists") -- there is nothing to strip here because the DTO itself
    // never accepts the field.
    await this.transactions.execute(async (transaction) => {
      const customer = await sql<{ id: string }>`
        select id from commerce_customers where account_id = ${accountId}::uuid for update
      `.execute(transaction);
      const customerId = customer.rows[0]?.id;
      if (customerId === undefined) {
        throw new ApplicationException(
          "customer_profile_not_found",
          "No Customer profile exists for this account",
          HttpStatus.NOT_FOUND,
        );
      }
      if (input.name !== undefined) {
        await sql`update commerce_customers set name = ${input.name}, updated_at = now(), version = version + 1
          where id = ${customerId}::uuid`.execute(transaction);
      }
      if (input.preferredLanguage !== undefined) {
        await sql`update commerce_customers set preferred_language = ${input.preferredLanguage}, updated_at = now(), version = version + 1
          where id = ${customerId}::uuid`.execute(transaction);
        // The login account's own preferred_language stays in step, matching
        // how every other account kind already keeps `preferred_language`
        // authoritative for locale.
        await sql`update accounts set preferred_language = ${input.preferredLanguage}, updated_at = now(), version = version + 1
          where id = ${accountId}::uuid`.execute(transaction);
      }
      if (input.email !== undefined) {
        try {
          await sql`update commerce_customers set email = ${input.email}, updated_at = now(), version = version + 1
            where id = ${customerId}::uuid`.execute(transaction);
          await sql`update accounts set email = ${input.email}, normalized_email = ${input.email}, updated_at = now(), version = version + 1
            where id = ${accountId}::uuid`.execute(transaction);
        } catch (cause) {
          if (this.isUniqueViolation(cause)) {
            throw new ApplicationException(
              "customer_email_in_use",
              "This email is already used by another account",
              HttpStatus.CONFLICT,
            );
          }
          throw cause;
        }
      }
    });
    return this.profile(accountId);
  }

  public async listAddresses(accountId: string): Promise<readonly CommerceCustomerAddress[]> {
    const result = await sql<CommerceCustomerAddress>`
      select a.id, a.label, a.recipient_name as "recipientName", a.mobile_number as mobile,
             a.emirate, a.area, a.address, a.location_link as "locationLink",
             a.delivery_instructions as "deliveryInstructions", a.is_default as "isDefault"
        from commerce_customer_addresses a
        join commerce_customers c on c.id = a.commerce_customer_id
       where c.account_id = ${accountId}::uuid
       order by a.is_default desc, a.created_at
    `.execute(this.database);
    return result.rows;
  }

  public async createAddress(
    accountId: string,
    input: CommerceCustomerAddressDto,
  ): Promise<CommerceCustomerAddress> {
    return this.transactions.execute(async (transaction) => {
      const customerId = await this.ownCustomerId(transaction, accountId);
      if (input.isDefault === true) {
        await sql`update commerce_customer_addresses set is_default = false, updated_at = now(), version = version + 1
          where commerce_customer_id = ${customerId}::uuid and is_default`.execute(transaction);
      }
      const inserted = await sql<{ id: string }>`
        insert into commerce_customer_addresses (
          commerce_customer_id, label, recipient_name, mobile_number, emirate, area, address,
          location_link, delivery_instructions, is_default
        ) values (
          ${customerId}::uuid, ${input.label ?? null}, ${input.recipientName}, ${input.mobile},
          ${input.emirate}, ${input.area ?? null}, ${input.address}, ${input.locationLink ?? null},
          ${input.deliveryInstructions ?? null}, ${input.isDefault ?? false}
        )
        returning id
      `.execute(transaction);
      const addressId = inserted.rows[0]?.id;
      if (addressId === undefined) throw new Error("Address creation did not return an identifier");
      return this.oneAddress(transaction, customerId, addressId);
    });
  }

  public async updateAddress(
    accountId: string,
    addressId: string,
    input: UpdateCommerceCustomerAddressDto,
  ): Promise<CommerceCustomerAddress> {
    return this.transactions.execute(async (transaction) => {
      const customerId = await this.ownCustomerId(transaction, accountId);
      await this.assertOwnedAddress(transaction, customerId, addressId);
      if (input.isDefault === true) {
        await sql`update commerce_customer_addresses set is_default = false, updated_at = now(), version = version + 1
          where commerce_customer_id = ${customerId}::uuid and is_default and id <> ${addressId}::uuid`.execute(
          transaction,
        );
      }
      await sql`
        update commerce_customer_addresses set
          label = coalesce(${input.label ?? null}, label),
          recipient_name = coalesce(${input.recipientName ?? null}, recipient_name),
          mobile_number = coalesce(${input.mobile ?? null}, mobile_number),
          emirate = coalesce(${input.emirate ?? null}, emirate),
          area = coalesce(${input.area ?? null}, area),
          address = coalesce(${input.address ?? null}, address),
          location_link = coalesce(${input.locationLink ?? null}, location_link),
          delivery_instructions = coalesce(${input.deliveryInstructions ?? null}, delivery_instructions),
          is_default = coalesce(${input.isDefault ?? null}, is_default),
          updated_at = now(), version = version + 1
         where id = ${addressId}::uuid
      `.execute(transaction);
      return this.oneAddress(transaction, customerId, addressId);
    });
  }

  public async setDefaultAddress(accountId: string, addressId: string): Promise<CommerceCustomerAddress> {
    return this.transactions.execute(async (transaction) => {
      const customerId = await this.ownCustomerId(transaction, accountId);
      await this.assertOwnedAddress(transaction, customerId, addressId);
      await sql`update commerce_customer_addresses set is_default = false, updated_at = now(), version = version + 1
        where commerce_customer_id = ${customerId}::uuid and is_default`.execute(transaction);
      await sql`update commerce_customer_addresses set is_default = true, updated_at = now(), version = version + 1
        where id = ${addressId}::uuid`.execute(transaction);
      return this.oneAddress(transaction, customerId, addressId);
    });
  }

  public async deleteAddress(accountId: string, addressId: string): Promise<void> {
    await this.transactions.execute(async (transaction) => {
      const customerId = await this.ownCustomerId(transaction, accountId);
      await this.assertOwnedAddress(transaction, customerId, addressId);
      await sql`delete from commerce_customer_addresses where id = ${addressId}::uuid`.execute(
        transaction,
      );
    });
  }

  private async ownCustomerId(
    transaction: Transaction<DatabaseSchema>,
    accountId: string,
  ): Promise<string> {
    const customer = await sql<{ id: string }>`
      select id from commerce_customers where account_id = ${accountId}::uuid
    `.execute(transaction);
    const customerId = customer.rows[0]?.id;
    if (customerId === undefined) {
      throw new ApplicationException(
        "customer_profile_not_found",
        "No Customer profile exists for this account",
        HttpStatus.NOT_FOUND,
      );
    }
    return customerId;
  }

  /** §37/§16: an address id belonging to a different Customer resolves to "not found", never another Customer's row. */
  private async assertOwnedAddress(
    transaction: Transaction<DatabaseSchema>,
    customerId: string,
    addressId: string,
  ): Promise<void> {
    const owned = await sql<{ id: string }>`
      select id from commerce_customer_addresses
       where id = ${addressId}::uuid and commerce_customer_id = ${customerId}::uuid
    `.execute(transaction);
    if (owned.rows[0] === undefined) {
      throw new ApplicationException(
        "customer_address_not_found",
        "This address does not belong to the authenticated Customer",
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private async oneAddress(
    transaction: Transaction<DatabaseSchema>,
    customerId: string,
    addressId: string,
  ): Promise<CommerceCustomerAddress> {
    const result = await sql<CommerceCustomerAddress>`
      select id, label, recipient_name as "recipientName", mobile_number as mobile, emirate, area,
             address, location_link as "locationLink", delivery_instructions as "deliveryInstructions",
             is_default as "isDefault"
        from commerce_customer_addresses
       where id = ${addressId}::uuid and commerce_customer_id = ${customerId}::uuid
    `.execute(transaction);
    const row = result.rows[0];
    if (row === undefined) throw new Error("Address lookup did not return the row just written");
    return row;
  }

  private isUniqueViolation(cause: unknown): boolean {
    return (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause as { code?: unknown }).code === "23505"
    );
  }
}
