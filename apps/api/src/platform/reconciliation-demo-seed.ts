import { randomUUID } from "node:crypto";

import type { INestApplicationContext } from "@nestjs/common";
import { sql, type Kysely } from "kysely";

import { AreaConfigurationService } from "../company-configuration/area-configuration.service.js";
import { CustomerConfigurationService } from "../company-configuration/customer-configuration.service.js";
import { TraderConfigurationService } from "../company-configuration/trader-configuration.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { OperationsService } from "../operations/operations.service.js";
import { OrdersWorkflowService } from "../operations/orders-workflow.service.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";

/**
 * Development-only reconciliation demonstration fixture.
 *
 * Every record is produced through the same domain services the API uses, so
 * history, snapshots, status rules, tenant scope and audit events are created
 * correctly. No status is forced and no financial row is written directly.
 */
export const demoMarker = "DEV-DEMO";
const demoDriverCode = `${demoMarker}-DRIVER`;
/** 32 Orders: two pages at size 25, with room for exclusions. */
const demoOrderCount = 32;

export type FixtureState = "complete" | "missing" | "partial";

export interface FixtureInventory {
  readonly areaId: string | undefined;
  readonly customerId: string | undefined;
  readonly deliveredPending: number;
  readonly driverId: string | undefined;
  readonly orders: number;
  readonly state: FixtureState;
  readonly traderId: string | undefined;
}

export class PartialFixtureError extends Error {
  public constructor(public readonly inventory: FixtureInventory) {
    super(
      `Refusing to run: the demonstration fixture is partial or inconsistent ` +
        `(area=${inventory.areaId === undefined ? "missing" : "present"}, ` +
        `trader=${inventory.traderId === undefined ? "missing" : "present"}, ` +
        `driver=${inventory.driverId === undefined ? "missing" : "present"}, ` +
        `customer=${inventory.customerId === undefined ? "missing" : "present"}, ` +
        `orders=${inventory.orders}/${demoOrderCount}, ` +
        `delivered+pending=${inventory.deliveredPending}). ` +
        `Re-run with --resume to complete it in development.`,
    );
    this.name = "PartialFixtureError";
  }
}

export interface DemoSeedResult {
  readonly alreadyPresent: boolean;
  readonly areaId: string;
  readonly companyId: string;
  readonly customerId: string;
  readonly deliveredPendingOrders: number;
  readonly driverId: string;
  readonly orderNumbers: readonly string[];
  readonly traderId: string;
}

/**
 * Reads NODE_ENV directly rather than through `configuration()`, so the refusal
 * cannot be short-circuited by unrelated configuration validation failing first.
 * An unset value mirrors the application default of `development`.
 */
function assertDevelopmentEnvironment(): void {
  const environment = (process.env.NODE_ENV ?? "development").trim().toLowerCase();
  if (environment === "production") {
    throw new Error("Refusing to seed demonstration data in production");
  }
  if (environment !== "development" && environment !== "test") {
    throw new Error(`Refusing to seed demonstration data in '${environment}'`);
  }
}

/** Varied but deterministic collection amounts, so totals are reproducible. */
function collectionAmount(index: number): number {
  return Number((25 + ((index * 7) % 40) + (index % 4) * 0.25).toFixed(2));
}

export async function inspectFixture(
  database: Kysely<DatabaseSchema>,
  companyId: string,
): Promise<FixtureInventory> {
  const one = async (text: ReturnType<typeof sql<{ id: string }>>): Promise<string | undefined> =>
    (await text.execute(database)).rows[0]?.id;

  const areaId = await one(sql<{ id: string }>`
    select id from areas where company_id = ${companyId}::uuid and name_en = ${`${demoMarker} Area`}
  `);
  const traderId = await one(sql<{ id: string }>`
    select id from traders
     where company_id = ${companyId}::uuid and name_en = ${`${demoMarker} Trader`}
  `);
  const driverId = await one(sql<{ id: string }>`
    select id from drivers where company_id = ${companyId}::uuid and code = ${demoDriverCode}
  `);
  const customerId = await one(sql<{ id: string }>`
    select id from customers
     where company_id = ${companyId}::uuid and name = ${`${demoMarker} Customer`} limit 1
  `);
  const counts = await sql<{ delivered: number; orders: number }>`
    select
      (select count(*)::int from orders
        where company_id = ${companyId}::uuid and notes like ${`${demoMarker}%`}) as orders,
      (select count(*)::int from orders
        where company_id = ${companyId}::uuid and notes like ${`${demoMarker}%`}
          and delivery_status = 'delivered'
          and driver_reconciliation_status = 'pending') as delivered
  `.execute(database);
  const orders = counts.rows[0]?.orders ?? 0;
  const deliveredPending = counts.rows[0]?.delivered ?? 0;

  const nothing =
    areaId === undefined &&
    traderId === undefined &&
    driverId === undefined &&
    customerId === undefined &&
    orders === 0;
  const everything =
    areaId !== undefined &&
    traderId !== undefined &&
    driverId !== undefined &&
    customerId !== undefined &&
    orders === demoOrderCount &&
    deliveredPending === demoOrderCount;

  return {
    areaId,
    customerId,
    deliveredPending,
    driverId,
    orders,
    state: nothing ? "missing" : everything ? "complete" : "partial",
    traderId,
  };
}

export async function seedReconciliationDemo(
  context: INestApplicationContext,
  options: { readonly resume?: boolean; readonly subdomain: string },
): Promise<DemoSeedResult> {
  assertDevelopmentEnvironment();
  const subdomain = options.subdomain.trim().toLowerCase();
  if (subdomain === "") throw new Error("An explicit Company subdomain is required");

  const database = context.get<Kysely<DatabaseSchema>>(DATABASE);
  const store = context.get(RequestSecurityContextStore);

  // Resolve exactly one Company by subdomain; never touch any other Company.
  const companies = await sql<{ id: string; name: string; status: string }>`
    select id, name_en as name, status from companies where lower(subdomain) = ${subdomain}
  `.execute(database);
  const company = companies.rows[0];
  if (company === undefined) throw new Error(`No Company found for subdomain '${subdomain}'`);
  const companyId = company.id;

  if (company.status !== "active") {
    throw new Error(`Company '${subdomain}' is not active`);
  }

  // Policy: complete → do nothing; missing → create; partial → fail safely.
  const inventory = await inspectFixture(database, companyId);
  if (inventory.state === "complete") {
    return {
      alreadyPresent: true,
      areaId: inventory.areaId ?? "",
      companyId,
      customerId: inventory.customerId ?? "",
      deliveredPendingOrders: inventory.deliveredPending,
      driverId: inventory.driverId ?? "",
      orderNumbers: [],
      traderId: inventory.traderId ?? "",
    };
  }
  if (inventory.state === "partial" && options.resume !== true) {
    throw new PartialFixtureError(inventory);
  }

  const administrators = await sql<{ id: string }>`
    select a.id from accounts a
     where a.company_id = ${companyId}::uuid and a.account_kind = 'company_user'
       and a.status = 'active'
     order by a.created_at limit 1
  `.execute(database);
  const accountId = administrators.rows[0]?.id;
  if (accountId === undefined) {
    throw new Error(`Company '${subdomain}' has no active administrator to act as`);
  }

  const permissions = await sql<{ code: string }>`
    select distinct rp.permission_code as code
      from account_roles ar
      join role_permissions rp on rp.role_id = ar.role_id
     where ar.account_id = ${accountId}::uuid
  `.execute(database);

  const areas = context.get(AreaConfigurationService);
  const traders = context.get(TraderConfigurationService);
  const customers = context.get(CustomerConfigurationService);
  const operations = context.get(OperationsService);
  const workflow = context.get(OrdersWorkflowService);

  return store.run(
    {
      identity: {
        companyId,
        forcePasswordChange: false,
        identityId: accountId,
        kind: "company_user",
        permissions: new Set(permissions.rows.map((row) => row.code)),
        sessionId: randomUUID(),
      },
      tenant: { companyId, identityId: accountId },
    },
    async () => {
      const correlationId = randomUUID();

      // Each step is independently resumable, so a partial run can be completed
      // safely rather than leaving the fixture half-built.
      const existingArea = await sql<{ id: string }>`
        select id from areas
         where company_id = ${companyId}::uuid and name_en = ${`${demoMarker} Area`}
      `.execute(database);
      let areaId = existingArea.rows[0]?.id;
      if (areaId === undefined) {
        // Areas now require an Emirate. The fixture files its demo Area under
        // Dubai explicitly rather than picking one implicitly.
        const emirate = await sql<{ id: string }>`
          select id from emirates where code = 'DXB'
        `.execute(database);
        const emirateId = emirate.rows[0]?.id;
        if (emirateId === undefined) throw new Error("Emirate master is not provisioned");
        const area = await areas.create(
          // Area and Trader codes are Company-scoped and backend-generated.
          { emirateId, nameEn: `${demoMarker} Area`, nameAr: "منطقة تجريبية" },
          correlationId,
        );
        areaId = String((area as unknown as { id: string }).id);
      }

      const existingTrader = await sql<{ id: string }>`
        select id from traders
         where company_id = ${companyId}::uuid and name_en = ${`${demoMarker} Trader`}
      `.execute(database);
      let traderId = existingTrader.rows[0]?.id;
      if (traderId === undefined) {
        const trader = await traders.create(
          {
            mobileNumber: "971500000101",
            name: `${demoMarker} Trader`,
          } as never,
          correlationId,
        );
        traderId = String((trader as { id: unknown }).id);
        const areaScope = await sql<{ emirateId: string }>`
          select emirate_id as "emirateId" from areas
           where id = ${areaId}::uuid and company_id = ${companyId}::uuid
        `.execute(database);
        const emirateId = areaScope.rows[0]?.emirateId;
        if (emirateId === undefined) throw new Error("Demo Area Emirate was not found");
        await traders.createPricing(
          traderId,
          {
            areaId,
            emirateId,
            effectiveFrom: new Date().toISOString().slice(0, 10),
            pricingType: "by_area",
            reason: `${demoMarker} fixture pricing`,
            serviceFee: 12,
          } as never,
          correlationId,
        );
      }

      const existingDriver = await sql<{ id: string }>`
        select id from drivers where company_id = ${companyId}::uuid and code = ${demoDriverCode}
      `.execute(database);
      let driverId = existingDriver.rows[0]?.id;
      if (driverId === undefined) {
        const driver = await operations.createDriver(
          {
            code: demoDriverCode,
            mobileNumber: "971500000102",
            nameEn: `${demoMarker} Driver`,
            outsourcedFeePerDeliveredOrder: 7.5,
          } as never,
          correlationId,
        );
        driverId = String((driver as unknown as { id: string }).id);
      }

      const existingCustomer = await sql<{ id: string }>`
        select id from customers where company_id = ${companyId}::uuid
           and name = ${`${demoMarker} Customer`} limit 1
      `.execute(database);
      let customerId = existingCustomer.rows[0]?.id;
      if (customerId === undefined) {
        const customer = await customers.create(
          {
            address: `${demoMarker} Street 1`,
            areaId,
            mobileNumber: "971500000103",
            name: `${demoMarker} Customer`,
          } as never,
          correlationId,
        );
        customerId = String((customer as { id: unknown }).id);
      }
      const addresses = await sql<{ id: string }>`
        select id from customer_addresses
         where company_id = ${companyId}::uuid and customer_id = ${customerId}::uuid
         order by created_at limit 1
      `.execute(database);
      const customerAddressId = addresses.rows[0]?.id;
      if (customerAddressId === undefined) throw new Error("Customer address was not created");

      // Orders are created and transitioned only through approved services.
      const alreadySeeded = await sql<{ value: number }>`
        select count(*)::int as value from orders
         where company_id = ${companyId}::uuid and notes like ${`${demoMarker}%`}
      `.execute(database);
      const remaining = Math.max(0, demoOrderCount - (alreadySeeded.rows[0]?.value ?? 0));

      const orderNumbers: string[] = [];
      for (let index = 0; index < remaining; index += 1) {
        const created = await operations.createOrder(
          {
            areaId,
            codAmount: collectionAmount(index),
            customerAddress: `${demoMarker} Street 1`,
            customerAddressId,
            customerId,
            customerMobileNumber: "971500000103",
            customerName: `${demoMarker} Customer`,
            notes: `${demoMarker} fixture order ${index + 1}`,
            serialNumber: `DEMO-${companyId.slice(0, 8)}-${index + 1}`,
            traderId,
          } as never,
          correlationId,
          `dev-demo-order-${randomUUID()}`,
        );
        orderNumbers.push(String((created as unknown as { orderNumber: string }).orderNumber));
      }

      // Assign any fixture Order that is still unassigned.
      const unassigned = await sql<{ id: string }>`
        select id from orders
         where company_id = ${companyId}::uuid and notes like ${`${demoMarker}%`}
           and delivery_status = 'new' and assigned_driver_id is null
         order by order_number
      `.execute(database);
      if (unassigned.rows.length > 0) {
        await workflow.bulkAssignDriver(
          {
            driverIdToAssign: driverId,
            excludedOrderIds: [],
            orderIds: unassigned.rows.map((row) => row.id),
            selectionMode: "ids",
          } as never,
          correlationId,
        );
      }

      // Out for delivery and Delivered are driver-only transitions, so these
      // steps run as the Driver's own identity rather than bypassing the rule.
      const driverAccounts = await sql<{ accountId: string }>`
        select account_id as "accountId" from drivers where id = ${driverId}::uuid
      `.execute(database);
      const driverAccountId = driverAccounts.rows[0]?.accountId;
      if (driverAccountId === undefined) throw new Error("Driver account was not found");

      const toAdvance = await sql<{ id: string; status: string }>`
        select id, delivery_status as status from orders
         where company_id = ${companyId}::uuid and notes like ${`${demoMarker}%`}
           and delivery_status in ('assigned_to_driver', 'out_for_delivery')
         order by order_number
      `.execute(database);

      await store.run(
        {
          identity: {
            companyId,
            forcePasswordChange: false,
            identityId: driverAccountId,
            kind: "driver",
            permissions: new Set<string>(),
            profileId: driverId,
            profileType: "driver",
            sessionId: randomUUID(),
          },
          tenant: { companyId, identityId: driverAccountId },
        },
        async () => {
          for (const row of toAdvance.rows) {
            if (row.status === "assigned_to_driver") {
              await operations.changeOrderStatus(
                row.id,
                { status: "out_for_delivery" } as never,
                correlationId,
              );
            }
            await operations.changeOrderStatus(
              row.id,
              { status: "delivered" } as never,
              correlationId,
            );
          }
        },
      );

      const delivered = await sql<{ value: number }>`
        select count(*)::int as value from orders
         where company_id = ${companyId}::uuid and delivery_status = 'delivered'
           and driver_reconciliation_status = 'pending' and assigned_driver_id = ${driverId}::uuid
      `.execute(database);

      return {
        alreadyPresent: false,
        areaId,
        companyId,
        customerId,
        deliveredPendingOrders: delivered.rows[0]?.value ?? 0,
        driverId,
        orderNumbers,
        traderId,
      };
    },
  );
}
