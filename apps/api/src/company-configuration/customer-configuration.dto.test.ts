import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";

import {
  ChangeCustomerStatusDto,
  CreateCustomerDto,
  UpdateCustomerAddressDto,
} from "./customer-configuration.dto.js";

const validCustomer = {
  address: "Building 4, Dubai",
  areaId: "10000000-0000-4000-8000-000000000001",
  mobileNumber: "971501234567",
  name: "Aisha عميلة",
};

describe("Customer configuration DTOs", () => {
  it("accepts one mixed-language Name, optional location, and approved mobiles", async () => {
    const input = Object.assign(new CreateCustomerDto(), {
      ...validCustomer,
      latitude: 25.2048,
      locationLink: "https://maps.google.com/?q=25.2048,55.2708",
      longitude: 55.2708,
      secondMobileNumber: "971509876543",
    });
    await expect(validate(input)).resolves.toEqual([]);
  });

  it.each([
    ["0501234567", "971501234567"],
    ["+971501234567", "971501234567"],
    ["971501234567", "971501234567"],
    ["050 123 4567", "971501234567"],
  ])("accepts Customer mobile %s and stores it as %s", async (mobileNumber, stored) => {
    // plainToInstance runs the same @Transform the ValidationPipe applies.
    const input = plainToInstance(CreateCustomerDto, { ...validCustomer, mobileNumber });
    await expect(validate(input)).resolves.toEqual([]);
    expect(input.mobileNumber).toBe(stored);
  });

  it.each(["97150123456", "9715ABCDEF12", "042345678", "+966501234567"])(
    "rejects invalid Customer mobile %s with the approved message",
    async (mobileNumber) => {
      const input = plainToInstance(CreateCustomerDto, { ...validCustomer, mobileNumber });
      const messages = (await validate(input)).flatMap((error) =>
        Object.values(error.constraints ?? {}),
      );
      expect(messages).toContain(
        "Enter a UAE mobile number, for example 0506468442 or 9715XXXXXXXX.",
      );
    },
  );

  it("requires reasons for status and address changes", async () => {
    const status = Object.assign(new ChangeCustomerStatusDto(), { isActive: false, reason: "" });
    const address = Object.assign(new UpdateCustomerAddressDto(), {
      address: "Office",
      areaId: validCustomer.areaId,
      reason: "",
    });
    await expect(validate(status)).resolves.toHaveLength(1);
    await expect(validate(address)).resolves.toHaveLength(1);
  });
});
