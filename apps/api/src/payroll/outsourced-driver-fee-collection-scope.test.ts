import "reflect-metadata";

import { Decimal } from "decimal.js";
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import { describe, expect, it } from "vitest";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { OutsourcedDriverFeeService } from "./outsourced-driver-fee.service.js";

/**
 * Driver Collection offset scope (Aiman, 9 Oct 2026): only the fee accruals of
 * the Orders in the collection can be offset. These tests record the SQL the
 * service sends, so they need no database.
 */
type Row = { accrualId: string; orderNumber: string; outstanding: string };

function recordingDatabase(rows: readonly Row[]) {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      queries.push(query);
      return { rows: rows as unknown as R[] };
    },
    streamQuery: () => {
      throw new Error("not used");
    },
  };
  const driver: Driver = {
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    destroy: async () => undefined,
    init: async () => undefined,
    releaseConnection: async () => undefined,
    rollbackTransaction: async () => undefined,
  };
  const database = new Kysely<DatabaseSchema>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { database, queries };
}

function service(database: Kysely<DatabaseSchema>) {
  const support = { assertPermission: () => undefined };
  return new OutsourcedDriverFeeService(
    database as never,
    {} as never,
    support as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

const companyId = "00000000-0000-4000-8000-000000000001";
const driverId = "00000000-0000-4000-8000-000000000002";
const selected = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];

describe("Driver Collection fee offset is limited to the selected Orders", () => {
  it("filters the payable accruals to the selected Order ids", async () => {
    const { database, queries } = recordingDatabase([
      { accrualId: "a1", orderNumber: "ORD-000001", outstanding: "15.00" },
      { accrualId: "a2", orderNumber: "ORD-000002", outstanding: "10.00" },
    ]);
    const result = await service(database).collectionOffsetProposal(
      database as never,
      companyId,
      driverId,
      new Decimal(500),
      new Decimal(0),
      undefined,
      false,
      selected,
    );
    const accrualQuery = queries.find((query) =>
      query.sql.includes("outsourced_driver_fee_accruals"),
    );
    expect(accrualQuery?.sql).toMatch(/f\.order_id in \(\$\d+::uuid, \$\d+::uuid\)/);
    expect(accrualQuery?.parameters).toEqual(expect.arrayContaining(selected));
    expect(result.totalOutstanding).toBe("25.00");
    expect(result.eligibleAccrualCount).toBe(2);
    expect(result.safeMaximumOffset).toBe("25.00");
  });

  it("offsets nothing when the selection is empty", async () => {
    const { database, queries } = recordingDatabase([]);
    await service(database).collectionOffsetProposal(
      database as never,
      companyId,
      driverId,
      new Decimal(500),
      new Decimal(0),
      undefined,
      false,
      [],
    );
    expect(queries.find((query) => query.sql.includes("outsourced_driver_fee_accruals"))?.sql)
      .toContain("and false");
  });

  it("keeps the Driver-wide behaviour when no Order list is passed", async () => {
    const { database, queries } = recordingDatabase([]);
    await service(database).collectionOffsetProposal(
      database as never,
      companyId,
      driverId,
      new Decimal(500),
      new Decimal(0),
    );
    const sqlText =
      queries.find((query) => query.sql.includes("outsourced_driver_fee_accruals"))?.sql ?? "";
    expect(sqlText).not.toContain("f.order_id in");
    expect(sqlText).not.toContain("and false");
  });

  it("caps the offset at the selected Orders' fees, not the Driver's whole balance", async () => {
    const { database } = recordingDatabase([
      { accrualId: "a1", orderNumber: "ORD-000001", outstanding: "15.00" },
    ]);
    await expect(
      service(database).collectionOffsetProposal(
        database as never,
        companyId,
        driverId,
        new Decimal(500),
        new Decimal(40),
        undefined,
        false,
        [selected[0]!],
      ),
    ).rejects.toMatchObject({ errorCode: "outsourced_driver_fee_offset_above_safe_amount" });
  });
});
