import "reflect-metadata";

import { validate } from "class-validator";

import {
  ChangeEmployeeRoleStatusDto,
  CreateCommissionRuleDto,
  EmployeeAllowanceDto,
  SaveCollectionEarningRuleDto,
  SaveDriverDto,
  SaveEmployeeDto,
} from "./workforce-configuration.dto.js";

describe("workforce configuration DTOs", () => {
  it("accepts a Role status change with isActive true or false", async () => {
    for (const isActive of [true, false]) {
      const input = Object.assign(new ChangeEmployeeRoleStatusDto(), { isActive });
      await expect(validate(input)).resolves.toEqual([]);
    }
  });

  it("rejects a Role status change missing isActive or given a non-boolean", async () => {
    const missing = await validate(Object.assign(new ChangeEmployeeRoleStatusDto(), {}));
    expect(missing.map((error) => error.property)).toEqual(["isActive"]);

    const wrongType = await validate(
      Object.assign(new ChangeEmployeeRoleStatusDto(), { isActive: "yes" }),
    );
    expect(wrongType.map((error) => error.property)).toEqual(["isActive"]);
  });

  it("accepts an Employee with a role, salary and four allowances", async () => {
    const input = Object.assign(new SaveEmployeeDto(), {
      allowances: Array.from({ length: 4 }, (_, index) =>
        Object.assign(new EmployeeAllowanceDto(), {
          allowanceTypeId: `10000000-0000-4000-8000-00000000000${index}`,
          amount: 100,
          effectiveFrom: "2026-07-01",
        }),
      ),
      basicSalary: 5000,
      employeeRoleId: "20000000-0000-4000-8000-000000000001",
      mobileNumber: "971501234567",
      name: "Aisha عائشة",
      salaryEffectiveFrom: "2026-07-01",
    });
    await expect(validate(input)).resolves.toEqual([]);
  });

  it("requires a role and rejects invalid mobile, negative salary, and too many allowances", async () => {
    const input = Object.assign(new SaveEmployeeDto(), {
      allowances: Array.from({ length: 5 }, () => ({})),
      basicSalary: -1,
      // No employeeRoleId, and 97 is too short a mobile.
      mobileNumber: "97150123456",
      name: "Aisha",
    });
    const errors = await validate(input);
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(["allowances", "basicSalary", "employeeRoleId", "mobileNumber"]),
    );
  });

  it("normalises a local Employee mobile to the stored form", async () => {
    const { plainToInstance } = await import("class-transformer");
    const input = plainToInstance(SaveEmployeeDto, {
      employeeRoleId: "20000000-0000-4000-8000-000000000001",
      mobileNumber: "0501234567",
      name: "Ali",
    });
    await expect(validate(input)).resolves.toEqual([]);
    expect(input.mobileNumber).toBe("971501234567");
  });

  it("accepts an Outsourced Driver with a fixed fee and no salary", async () => {
    const input = Object.assign(new SaveDriverDto(), {
      driverType: "outsourced",
      mobileNumber: "971501234567",
      name: "سائق Driver",
      outsourcedFeePerDeliveredOrder: 5,
    });
    await expect(validate(input)).resolves.toEqual([]);
  });

  it("accepts an Employee Driver with salary and allowances", async () => {
    const input = Object.assign(new SaveDriverDto(), {
      allowances: [
        Object.assign(new EmployeeAllowanceDto(), {
          allowanceTypeId: "10000000-0000-4000-8000-000000000001",
          amount: 200,
          effectiveFrom: "2026-07-01",
        }),
      ],
      basicSalary: 3000,
      driverType: "employee",
      mobileNumber: "971501234567",
      name: "Ali",
      salaryEffectiveFrom: "2026-07-01",
    });
    await expect(validate(input)).resolves.toEqual([]);
  });

  it("normalises a local Driver mobile to the stored form", async () => {
    const { plainToInstance } = await import("class-transformer");
    // The unified Driver form accepts 05..., like every other party.
    const input = plainToInstance(SaveDriverDto, {
      driverType: "outsourced",
      mobileNumber: "0501234567",
      name: "Sam",
    });
    await expect(validate(input)).resolves.toEqual([]);
    expect(input.mobileNumber).toBe("971501234567");
  });

  it("accepts percentage commission only within the validated numeric range", async () => {
    const valid = Object.assign(new CreateCommissionRuleDto(), {
      effectiveFrom: "2026-07-01",
      frequency: "monthly",
      method: "percentage",
      name: "Service fee share",
      rate: 12.5,
    });
    const invalid = Object.assign(new CreateCommissionRuleDto(), { ...valid, rate: -1 });
    await expect(validate(valid)).resolves.toEqual([]);
    await expect(validate(invalid)).resolves.not.toEqual([]);
  });

  it("accepts None and Per Collected Order but rejects legacy flat collection rules", async () => {
    const rule = (collectionPaymentType: string, amount: number) =>
      Object.assign(new SaveCollectionEarningRuleDto(), {
        amount,
        collectionPaymentType,
        effectiveFrom: "2026-08-08",
      });
    await expect(validate(rule("none", 0))).resolves.toEqual([]);
    await expect(validate(rule("per_collected_order", 1))).resolves.toEqual([]);
    const errors = await validate(rule("flat_per_confirmed_collection", 5));
    expect(errors.map((error) => error.property)).toContain("collectionPaymentType");
  });
});
