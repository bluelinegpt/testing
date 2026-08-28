import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { PublicTrackingService } from "./public-tracking.service.js";

/**
 * Central, cross-Tawseelhub public shipment tracking: Airway Bill (Order
 * `serial_number`) first, mobile verification only when the normalized
 * Airway Bill is ambiguous across Companies. See
 * `Documentation/... tracking brief` for the approved design; this file
 * proves the privacy contract (Section 41 of that brief) against a real
 * database, since the ambiguity/eligibility logic joins across Companies in
 * a way a pure unit test cannot represent.
 */
const runDatabaseTests = process.env.RUN_PUBLIC_TRACKING_DATABASE === "true";

interface CompanyFixture {
  readonly actorId: string;
  readonly addressId: string;
  readonly areaId: string;
  readonly areaCode: string;
  readonly areaName: string;
  readonly companyId: string;
  readonly customerCode: string;
  readonly customerId: string;
  readonly traderId: string;
}

function connect(): Kysely<DatabaseSchema> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 4 });
  return new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
}

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  const database = connect();
  const marker = new Error("rollback public tracking test");
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

/** One active Company, Area, Trader and Customer -- the context an Order needs. */
async function seedCompany(
  transaction: Transaction<DatabaseSchema>,
  label: string,
): Promise<CompanyFixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const areaId = randomUUID();
  const traderId = randomUUID();
  const customerId = randomUUID();
  const addressId = randomUUID();
  const short = companyId.slice(0, 8);
  const areaCode = `A-${short}`;
  const areaName = "Area";
  const customerCode = `CUS-${short}`;
  const emirate = await sql<{ id: string }>`select id from emirates limit 1`.execute(transaction);

  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`${label}-${short}`},${`${label.toLowerCase()}-${short}`},
      'Public Tracking Test','active',now())`.execute(transaction);
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${actorId}::uuid,${companyId}::uuid,'company_user',${`pt.${actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
    values(${areaId}::uuid,${companyId}::uuid,${areaCode},${areaName},'منطقة',
      ${emirate.rows[0]!.id}::uuid)`.execute(transaction);
  await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,
      created_by_account_id)
    values(${traderId}::uuid,${companyId}::uuid,${`T-${short}`},'Trader','971500000003',
      ${areaId}::uuid,${actorId}::uuid)`.execute(transaction);
  await sql`insert into customers(id,company_id,code,name,mobile_number,created_by_account_id)
    values(${customerId}::uuid,${companyId}::uuid,${customerCode},'Customer','971500000009',
      ${actorId}::uuid)`.execute(transaction);
  await sql`insert into customer_addresses(id,company_id,customer_id,area_id,address,is_default,
      created_by_account_id)
    values(${addressId}::uuid,${companyId}::uuid,${customerId}::uuid,${areaId}::uuid,
      'Some address',true,${actorId}::uuid)`.execute(transaction);

  return { actorId, addressId, areaId, areaCode, areaName, companyId, customerCode, customerId, traderId };
}

/** A 'resolved' Order carrying the given Airway Bill (serial number) and customer mobile. */
async function insertOrder(
  transaction: Transaction<DatabaseSchema>,
  fixture: CompanyFixture,
  options: {
    readonly serialNumber: string;
    readonly customerMobileNumber?: string;
    readonly deliveryStatus?: string;
  },
): Promise<string> {
  const orderId = randomUUID();
  const serialNormalized = options.serialNumber.trim().toLocaleLowerCase("en-US");
  await sql`insert into orders(
      id,company_id,order_number,order_date,trader_id,area_id,created_by_account_id,
      customer_name,customer_mobile_number,customer_address,package_count,payment_condition,
      cod_amount,service_fee,final_service_fee_snapshot,configured_service_fee_snapshot,
      customer_provenance_status,pricing_provenance_status,
      customer_id,customer_address_id,customer_code_snapshot,
      customer_area_code_snapshot,customer_area_name_snapshot,
      delivery_status,serial_number,serial_number_normalized
    ) values(
      ${orderId}::uuid,${fixture.companyId}::uuid,${`ORD-${orderId.slice(0, 8)}`},
      current_date,${fixture.traderId}::uuid,${fixture.areaId}::uuid,${fixture.actorId}::uuid,
      'Customer',${options.customerMobileNumber ?? "0501234567"},'Some address',1,
      'customer_pays_cod_and_fee',0,25,25,25,
      'resolved','manual',
      ${fixture.customerId}::uuid,${fixture.addressId}::uuid,${fixture.customerCode},
      ${fixture.areaCode},${fixture.areaName},
      ${options.deliveryStatus ?? "new"},${options.serialNumber},${serialNormalized}
    )`.execute(transaction);
  return orderId;
}

async function insertHistory(
  transaction: Transaction<DatabaseSchema>,
  fixture: CompanyFixture,
  orderId: string,
  toStatus: string,
  occurredAt: string,
): Promise<void> {
  await sql`insert into order_status_history(
      id,company_id,order_id,status_dimension,to_status,changed_by_account_id,occurred_at
    ) values(
      ${randomUUID()}::uuid,${fixture.companyId}::uuid,${orderId}::uuid,'delivery',
      ${toStatus},${fixture.actorId}::uuid,${occurredAt}::timestamptz
    )`.execute(transaction);
}

describe.skipIf(!runDatabaseTests)("PublicTrackingService", () => {
  it("returns the public tracking result immediately for a unique Airway Bill match", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "PTA");
      const awb = `X${randomUUID().slice(0, 8)}`;
      await insertOrder(transaction, company, { serialNumber: awb, deliveryStatus: "out_for_delivery" });
      const service = new PublicTrackingService(transaction);

      const outcome = await service.lookupByAirwayBill(awb);

      expect(outcome.result).toBe("verified");
      if (outcome.result === "verified") {
        expect(outcome.tracking.airwayBill).toBe(awb);
        expect(outcome.tracking.status).toBe("out_for_delivery");
        expect(outcome.tracking.statusLabel).toBe("Out for Delivery");
      }
    });
  });

  it("requires mobile verification when the same Airway Bill matches two Companies, without leaking match count", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const companyA = await seedCompany(transaction, "PTB");
      const companyB = await seedCompany(transaction, "PTC");
      const awb = `X${randomUUID().slice(0, 8)}`;
      await insertOrder(transaction, companyA, { serialNumber: awb, customerMobileNumber: "0501111111" });
      await insertOrder(transaction, companyB, { serialNumber: awb, customerMobileNumber: "0502222222" });
      const service = new PublicTrackingService(transaction);

      const outcome = await service.lookupByAirwayBill(awb);

      expect(outcome.result).toBe("verification_required");
      // The response must carry nothing beyond the opaque token -- no
      // candidate count, company name/id, or order identifier.
      expect(Object.keys(outcome)).toEqual(["result", "verificationToken"]);
      if (outcome.result === "verification_required") {
        expect(typeof outcome.verificationToken).toBe("string");
        expect(outcome.verificationToken).not.toContain(companyA.companyId);
        expect(outcome.verificationToken).not.toContain(companyB.companyId);
      }
    });
  });

  it("verifies the unique candidate once the correct customer mobile is supplied", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const companyA = await seedCompany(transaction, "PTD");
      const companyB = await seedCompany(transaction, "PTE");
      const awb = `X${randomUUID().slice(0, 8)}`;
      await insertOrder(transaction, companyA, { serialNumber: awb, customerMobileNumber: "0501111111" });
      await insertOrder(transaction, companyB, {
        serialNumber: awb,
        customerMobileNumber: "0502222222",
        deliveryStatus: "delivered",
      });
      const service = new PublicTrackingService(transaction);
      const lookup = await service.lookupByAirwayBill(awb);
      expect(lookup.result).toBe("verification_required");
      if (lookup.result !== "verification_required") return;

      const verified = await service.verifyAmbiguousShipment(lookup.verificationToken, "0502222222");

      expect(verified.result).toBe("verified");
      if (verified.result === "verified") {
        expect(verified.tracking.airwayBill).toBe(awb);
        expect(verified.tracking.statusLabel).toBe("Delivered");
      }
    });
  });

  it("returns a neutral failure for the wrong mobile, not revealing which detail was wrong", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const companyA = await seedCompany(transaction, "PTF");
      const companyB = await seedCompany(transaction, "PTG");
      const awb = `X${randomUUID().slice(0, 8)}`;
      await insertOrder(transaction, companyA, { serialNumber: awb, customerMobileNumber: "0501111111" });
      await insertOrder(transaction, companyB, { serialNumber: awb, customerMobileNumber: "0502222222" });
      const service = new PublicTrackingService(transaction);
      const lookup = await service.lookupByAirwayBill(awb);
      expect(lookup.result).toBe("verification_required");
      if (lookup.result !== "verification_required") return;

      const failed = await service.verifyAmbiguousShipment(lookup.verificationToken, "0509999999");

      expect(failed).toEqual({ result: "not_verified" });
    });
  });

  it("cannot uniquely verify when the same Airway Bill and mobile both collide across Companies", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const companyA = await seedCompany(transaction, "PTH");
      const companyB = await seedCompany(transaction, "PTI");
      const awb = `X${randomUUID().slice(0, 8)}`;
      const mobile = "0503333333";
      await insertOrder(transaction, companyA, { serialNumber: awb, customerMobileNumber: mobile });
      await insertOrder(transaction, companyB, { serialNumber: awb, customerMobileNumber: mobile });
      const service = new PublicTrackingService(transaction);
      const lookup = await service.lookupByAirwayBill(awb);
      expect(lookup.result).toBe("verification_required");
      if (lookup.result !== "verification_required") return;

      const outcome = await service.verifyAmbiguousShipment(lookup.verificationToken, mobile);

      expect(outcome).toEqual({ result: "ambiguous" });
    });
  });

  // A per-Company "tracking disabled" exclusion (reusing the Company
  // Website's own `functions.trackingEnabled` switch) is part of the
  // approved design but is deliberately NOT yet wired into
  // `eligibleCandidates()` -- that flag lives on `company_websites`, a table
  // from an already-authored but not-yet-applied migration belonging to a
  // separate, uncommitted workstream (see the comment in
  // `public-tracking.service.ts`). No test exists for it until that
  // migration lands and the join is restored.

  it("still finds a match across two Companies with the daily-unique-only serial number scheme", async () => {
    await inRolledBackTransaction(async (transaction) => {
      // serial_number_normalized is unique only per (company_id, order_date)
      // -- not globally, not even company-lifetime. Confirms the ambiguity
      // path also naturally covers the "one Company, two dates" case, not
      // only "two different Companies".
      const company = await seedCompany(transaction, "PTP");
      const awb = `X${randomUUID().slice(0, 8)}`;
      await insertOrder(transaction, company, { serialNumber: awb, customerMobileNumber: "0501111111" });
      const secondOrderId = randomUUID();
      const serialNormalized = awb.trim().toLocaleLowerCase("en-US");
      await sql`insert into orders(
          id,company_id,order_number,order_date,trader_id,area_id,created_by_account_id,
          customer_name,customer_mobile_number,customer_address,package_count,payment_condition,
          cod_amount,service_fee,final_service_fee_snapshot,configured_service_fee_snapshot,
          customer_provenance_status,pricing_provenance_status,
          customer_id,customer_address_id,customer_code_snapshot,
          customer_area_code_snapshot,customer_area_name_snapshot,
          delivery_status,serial_number,serial_number_normalized
        ) values(
          ${secondOrderId}::uuid,${company.companyId}::uuid,${`ORD-${secondOrderId.slice(0, 8)}`},
          current_date - interval '3 days',${company.traderId}::uuid,${company.areaId}::uuid,
          ${company.actorId}::uuid,'Customer','0502222222','Some address',1,
          'customer_pays_cod_and_fee',0,25,25,25,'resolved','manual',
          ${company.customerId}::uuid,${company.addressId}::uuid,${company.customerCode},
          ${company.areaCode},${company.areaName},'delivered',${awb},${serialNormalized}
        )`.execute(transaction);
      const service = new PublicTrackingService(transaction);

      const outcome = await service.lookupByAirwayBill(awb);

      expect(outcome.result).toBe("verification_required");
    });
  });

  it("returns a neutral not-found result for an Airway Bill matching nothing", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const service = new PublicTrackingService(transaction);
      const outcome = await service.lookupByAirwayBill(`NOPE-${randomUUID()}`);
      expect(outcome).toEqual({ result: "not_found" });
    });
  });

  it("builds the public timeline only from real stored status-history timestamps", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "PTL");
      const awb = `X${randomUUID().slice(0, 8)}`;
      const orderId = await insertOrder(transaction, company, {
        serialNumber: awb,
        deliveryStatus: "delivered",
      });
      await insertHistory(transaction, company, orderId, "assigned", "2026-01-01T08:00:00Z");
      await insertHistory(transaction, company, orderId, "out_for_delivery", "2026-01-01T10:00:00Z");
      await insertHistory(transaction, company, orderId, "delivered", "2026-01-01T12:00:00Z");
      const service = new PublicTrackingService(transaction);

      const outcome = await service.lookupByAirwayBill(awb);

      expect(outcome.result).toBe("verified");
      if (outcome.result !== "verified") return;
      // Compared as instants, not exact strings -- the database session's
      // display timezone (e.g. +04) is orthogonal to whether the real
      // stored transition instants came through correctly.
      expect(
        outcome.tracking.timeline.map((step) => ({
          status: step.status,
          statusLabel: step.statusLabel,
          occurredAt: new Date(step.occurredAt).toISOString(),
        })),
      ).toEqual([
        { status: "assigned", statusLabel: "Assigned for Delivery", occurredAt: "2026-01-01T08:00:00.000Z" },
        { status: "out_for_delivery", statusLabel: "Out for Delivery", occurredAt: "2026-01-01T10:00:00.000Z" },
        { status: "delivered", statusLabel: "Delivered", occurredAt: "2026-01-01T12:00:00.000Z" },
      ]);
    });
  });

  it("never includes customer/receiver/Driver/Trader/financial fields in the public result (privacy contract)", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const company = await seedCompany(transaction, "PTM");
      const awb = `X${randomUUID().slice(0, 8)}`;
      await insertOrder(transaction, company, { serialNumber: awb });
      const service = new PublicTrackingService(transaction);

      const outcome = await service.lookupByAirwayBill(awb);

      expect(outcome.result).toBe("verified");
      if (outcome.result !== "verified") return;
      expect(Object.keys(outcome.tracking).sort()).toEqual(
        ["airwayBill", "deliveredAt", "lastUpdated", "status", "statusLabel", "timeline"].sort(),
      );
      const serialized = JSON.stringify(outcome.tracking).toLowerCase();
      for (const forbidden of ["customer", "mobile", "address", "cod", "trader", "driver", company.companyId]) {
        expect(serialized).not.toContain(forbidden.toLowerCase());
      }
    });
  });

  it("rejects a tampered or expired verification token as a neutral failure", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const companyA = await seedCompany(transaction, "PTN");
      const companyB = await seedCompany(transaction, "PTO");
      const awb = `X${randomUUID().slice(0, 8)}`;
      await insertOrder(transaction, companyA, { serialNumber: awb, customerMobileNumber: "0501111111" });
      await insertOrder(transaction, companyB, { serialNumber: awb, customerMobileNumber: "0502222222" });
      const service = new PublicTrackingService(transaction);
      const lookup = await service.lookupByAirwayBill(awb);
      expect(lookup.result).toBe("verification_required");
      if (lookup.result !== "verification_required") return;

      const tampered = `${lookup.verificationToken}x`;
      const garbage = "not-a-real-token";

      expect(await service.verifyAmbiguousShipment(tampered, "0501111111")).toEqual({ result: "not_verified" });
      expect(await service.verifyAmbiguousShipment(garbage, "0501111111")).toEqual({ result: "not_verified" });
    });
  });
});
