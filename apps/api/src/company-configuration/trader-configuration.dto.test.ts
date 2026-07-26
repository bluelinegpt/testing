import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";

import { CreateConfiguredTraderDto, CreateTraderPricingDto } from "./trader-configuration.dto.js";

describe("Trader configuration DTOs", () => {
  it("accepts one mixed-language Name and the approved mobile format", async () => {
    const input = Object.assign(new CreateConfiguredTraderDto(), {
      mobileNumber: "971501234567",
      name: "Blue Store متجر بلو",
    });
    await expect(validate(input)).resolves.toEqual([]);
  });

  /*
   * Operators type the number the way they read it, so the boundary normalises
   * local and international forms to the stored 9715XXXXXXXX. plainToInstance
   * is used because that is what ValidationPipe (transform: true) does; a bare
   * Object.assign would skip the transform and not exercise the real path.
   */
  it.each([
    ["0501234567", "971501234567"],
    ["+971501234567", "971501234567"],
    ["971501234567", "971501234567"],
    ["050 123 4567", "971501234567"],
    ["501234567", "971501234567"],
  ])("accepts Trader mobile %s and stores it as %s", async (mobileNumber, stored) => {
    const input = plainToInstance(CreateConfiguredTraderDto, { mobileNumber, name: "Store" });
    await expect(validate(input)).resolves.toEqual([]);
    expect(input.mobileNumber).toBe(stored);
  });

  it.each(["97150123456", "9715ABCDEF12", "042345678", "+966501234567", ""])(
    "rejects invalid Trader mobile %s with the approved message",
    async (mobileNumber) => {
      const input = plainToInstance(CreateConfiguredTraderDto, { mobileNumber, name: "Store" });
      const messages = (await validate(input)).flatMap((error) =>
        Object.values(error.constraints ?? {}),
      );
      expect(messages).toContain(
        "Enter a UAE mobile number, for example 0506468442 or 9715XXXXXXXX.",
      );
    },
  );

  it("accepts a global price rule with no Emirate, Area, or reason", async () => {
    // emirate and area omitted = the global (flat) price; reason is optional.
    const input = Object.assign(new CreateTraderPricingDto(), { serviceFee: 20 });
    await expect(validate(input)).resolves.toEqual([]);
  });

  it("rejects a negative Service Fee", async () => {
    const input = Object.assign(new CreateTraderPricingDto(), { serviceFee: -1 });
    const messages = (await validate(input)).flatMap((error) =>
      Object.keys(error.constraints ?? {}),
    );
    expect(messages).toContain("min");
  });
});
