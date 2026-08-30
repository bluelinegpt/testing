import { randomUUID } from "node:crypto";

import { config as loadEnvironment } from "dotenv";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

loadEnvironment({ path: "../../.env" });

const runDatabaseTests = process.env.RUN_SHIPMENT_SERIAL_DATABASE === "true";

describe.skipIf(!runDatabaseTests)("PSystem Serial allocation", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const companyId = randomUUID();
  const suffix = companyId.replaceAll("-", "").slice(0, 8);
  const prefix = "ABC";

  beforeAll(async () => {
    await pool.query(
      `insert into companies(id,code,subdomain,name_en,status,activated_at,shipment_prefix)
       values($1,$2,$3,'Disposable Shipment Serial Certification Company','active',now(),$4)`,
      [companyId, `SER-${suffix}`, `serial-${suffix}`, prefix],
    );
  });

  afterAll(async () => {
    await pool.query("delete from company_shipment_serial_counters where company_id=$1", [
      companyId,
    ]);
    await pool.query("delete from companies where id=$1", [companyId]);
    await pool.query("delete from shipment_prefix_reservations where original_company_id=$1", [
      companyId,
    ]);
    await pool.end();
  });

  it("activates the disposable ABC Company and generates the first two exact serials", async () => {
    await pool.query("update companies set shipment_serial_enabled_at=now() where id=$1", [
      companyId,
    ]);
    const first = await pool.query<{ serial: string }>(
      "select allocate_company_psystem_serial($1::uuid) serial",
      [companyId],
    );
    const second = await pool.query<{ serial: string }>(
      "select allocate_company_psystem_serial($1::uuid) serial",
      [companyId],
    );
    expect(first.rows[0]!.serial).toBe("ABC0000001");
    expect(second.rows[0]!.serial).toBe("ABC0000002");
  });

  it("rolls back allocation without corrupting the counter", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const rolledBack = await client.query<{ serial: string }>(
        "select allocate_company_psystem_serial($1::uuid) serial",
        [companyId],
      );
      expect(rolledBack.rows[0]!.serial).toBe("ABC0000003");
      await client.query("rollback");
    } finally {
      client.release();
    }

    const committed = await pool.query<{ serial: string }>(
      "select allocate_company_psystem_serial($1::uuid) serial",
      [companyId],
    );
    expect(committed.rows[0]!.serial).toBe("ABC0000003");
  });

  it("allocates unique gap-free values under concurrent calls", async () => {
    const values = await Promise.all(
      Array.from({ length: 40 }, async () => {
        const result = await pool.query<{ serial: string }>(
          "select allocate_company_psystem_serial($1::uuid) serial",
          [companyId],
        );
        return result.rows[0]!.serial;
      }),
    );
    expect(new Set(values).size).toBe(40);
    expect(values.toSorted()).toEqual(
      Array.from({ length: 40 }, (_, index) => `${prefix}${String(index + 4).padStart(7, "0")}`),
    );
  });

  it("makes activation and the first-used prefix immutable", async () => {
    await expect(
      pool.query("update companies set shipment_prefix='ZZZ' where id=$1", [companyId]),
    ).rejects.toThrow(/immutable/i);
    await expect(
      pool.query("update companies set shipment_serial_enabled_at=null where id=$1", [companyId]),
    ).rejects.toThrow(/immutable/i);
  });
});
