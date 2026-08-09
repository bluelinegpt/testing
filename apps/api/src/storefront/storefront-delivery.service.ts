import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

import { accessibleStorefrontIds } from "./storefront-access.js";
import type { DeliveryRelationshipUpdateDto } from "./storefront.dto.js";

/**
 * The Delivery Companies a Trader Commerce identity works with.
 *
 * ---------------------------------------------------------------------------
 * THIS SCREEN CANNOT CREATE A RELATIONSHIP
 * ---------------------------------------------------------------------------
 *
 * Only rows that already exist in `trader_delivery_company_relationships` are
 * listed, and the only things that can be changed are whether a relationship is
 * enabled for Store orders and which one is the default. A Trader cannot reach
 * out and attach itself to a Delivery Company from here, and no global Company
 * directory is ever returned — that would turn a settings screen into a
 * discovery surface for every Company on the platform.
 *
 * ---------------------------------------------------------------------------
 * THE DEFAULT RULE, AND WHAT HAPPENS WHEN A DEFAULT IS DISABLED
 * ---------------------------------------------------------------------------
 *
 * At most one relationship per Commerce identity may be BOTH enabled and
 * default; a partial unique index in the database settles that, not this
 * service. What the database cannot decide is the intent behind disabling the
 * relationship that currently holds the default.
 *
 * The deterministic rule chosen here: disabling a relationship CLEARS its
 * default. The alternative — refusing until another default is nominated —
 * makes "turn this off" fail for a reason the user did not ask about, and
 * leaves a disabled row still marked as the effective default in the meantime,
 * which is precisely the trap worth avoiding. Zero defaults is a valid, honest
 * state; a default that cannot be routed to is not.
 */
@Injectable()
export class StorefrontDeliveryService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(OperationsHistoryWriter) private readonly auditWriter: OperationsHistoryWriter,
  ) {}

  /** Every Delivery Company relationship of the Store's Commerce identity. */
  public async list(storefrontId: string) {
    this.assertRead();
    const commerceId = await this.commerceIdFor(storefrontId);
    const rows = await sql<{
      companyName: string;
      companyId: string;
      effectiveFrom: Date;
      effectiveTo: Date | null;
      enabledForStoreOrders: boolean;
      id: string;
      isDefaultForStoreOrders: boolean;
      relationshipSource: string;
      status: string;
    }>`
      select relationship.id,
             relationship.company_id as "companyId",
             company.name_en as "companyName",
             relationship.status,
             relationship.relationship_source as "relationshipSource",
             relationship.enabled_for_store_orders as "enabledForStoreOrders",
             relationship.is_default_for_store_orders as "isDefaultForStoreOrders",
             relationship.effective_from as "effectiveFrom",
             relationship.effective_to as "effectiveTo"
        from trader_delivery_company_relationships relationship
        join companies company on company.id = relationship.company_id
       where relationship.trader_commerce_id = ${commerceId}::uuid
       order by lower(company.name_en)
    `.execute(this.database);
    return { items: rows.rows };
  }

  public async update(
    storefrontId: string,
    relationshipId: string,
    input: DeliveryRelationshipUpdateDto,
    correlationId: string,
  ) {
    this.assertManage();
    const commerceId = await this.commerceIdFor(storefrontId);
    await this.transactions.execute(async (transaction) => {
      // Locked before anything is decided: "is this the last enabled one?" is a
      // COUNT, and two concurrent disables would otherwise both read "two".
      const current = await sql<{
        enabledForStoreOrders: boolean;
        id: string;
        isDefaultForStoreOrders: boolean;
      }>`
        select id,
               enabled_for_store_orders as "enabledForStoreOrders",
               is_default_for_store_orders as "isDefaultForStoreOrders"
          from trader_delivery_company_relationships
         where id = ${relationshipId}::uuid and trader_commerce_id = ${commerceId}::uuid
         for update
      `.execute(transaction);
      const row = current.rows[0];
      if (row === undefined) throw this.relationshipNotFound();

      const enabled = input.enabledForStoreOrders ?? row.enabledForStoreOrders;
      // Disabling clears the default — see the class comment. Stated as a
      // derivation rather than a separate UPDATE so no intermediate state ever
      // exists in which a disabled row is still the default.
      const isDefault = enabled
        ? (input.isDefaultForStoreOrders ?? row.isDefaultForStoreOrders)
        : false;

      if (isDefault) {
        // Only one default may be enabled at a time. Cleared first so the
        // partial unique index is never momentarily violated within the
        // statement order.
        await sql`
          update trader_delivery_company_relationships
             set is_default_for_store_orders = false, updated_at = now()
           where trader_commerce_id = ${commerceId}::uuid
             and id <> ${relationshipId}::uuid
             and is_default_for_store_orders
        `.execute(transaction);
      }

      const updated = await sql<{ id: string }>`
        update trader_delivery_company_relationships
           set enabled_for_store_orders = ${enabled},
               is_default_for_store_orders = ${isDefault},
               updated_at = now(),
               version = version + 1
         where id = ${relationshipId}::uuid and trader_commerce_id = ${commerceId}::uuid
        returning id
      `.execute(transaction);
      if (updated.rows[0] === undefined) throw this.relationshipNotFound();

      await this.auditWriter.audit(transaction as unknown as Kysely<DatabaseSchema>, {
        action: "storefront_delivery_relationship.updated",
        actorId: this.actorId(),
        after: {
          enabledForStoreOrders: enabled,
          isDefaultForStoreOrders: isDefault,
          relationshipId,
          storefrontId,
        },
        companyId: this.tenants.current().companyId,
        correlationId,
        subjectId: relationshipId,
        subjectType: "trader_delivery_company_relationship",
      });
    });

    // Re-read AFTER the transaction commits. `list()` runs against the pool,
    // not the transaction, so calling it from inside the callback returned the
    // pre-commit rows and the screen rendered the change as though it had not
    // happened. The database was correct throughout; only the response was stale.
    return this.list(storefrontId);
  }

  /**
   * The Commerce identity that owns the named Store, if the actor may reach it.
   *
   * Resolved from the Storefront rather than accepted as a `traderCommerceId`
   * parameter. A caller that could name the Commerce identity directly could
   * read and re-point another shop's delivery arrangements.
   */
  private async commerceIdFor(storefrontId: string): Promise<string> {
    const result = await sql<{ traderCommerceId: string }>`
      select trader_commerce_id as "traderCommerceId"
        from trader_storefronts
       where id = ${storefrontId}::uuid
         and id in (${this.accessibleStorefronts()})
    `.execute(this.database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException(
        "storefront_not_found",
        "Storefront not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return row.traderCommerceId;
  }

  private accessibleStorefronts() {
    return accessibleStorefrontIds({
      callerTraderId: this.callerTraderId(),
      companyId: this.tenants.current().companyId,
    });
  }

  private callerTraderId(): string | null {
    const identity = this.identities.current();
    if (identity.kind !== "trader") return null;
    const traderId = identity.profileId ?? identity.profileLinkId;
    if (traderId === undefined) {
      throw new ApplicationException(
        "storefront_trader_context_required",
        "This Trader account is not linked to a Trader record",
        HttpStatus.FORBIDDEN,
      );
    }
    return traderId;
  }

  private actorId(): string {
    return this.tenants.current().identityId;
  }

  private assertRead(): void {
    if (this.callerTraderId() !== null) return;
    this.assertCompanyPermission("storefront.view", "storefront.manage");
  }

  private assertManage(): void {
    if (this.callerTraderId() !== null) return;
    this.assertCompanyPermission("storefront.manage");
  }

  private assertCompanyPermission(...permissions: readonly string[]): void {
    const held = this.identities.current().permissions;
    if (permissions.some((permission) => held.has(permission))) return;
    if (held.has("users_roles.manage")) return;
    throw new ApplicationException(
      "permission_denied",
      "You do not have permission to perform this action",
      HttpStatus.FORBIDDEN,
    );
  }

  private relationshipNotFound(): ApplicationException {
    return new ApplicationException(
      "storefront_delivery_relationship_not_found",
      "Delivery Company relationship not found",
      HttpStatus.NOT_FOUND,
    );
  }
}
