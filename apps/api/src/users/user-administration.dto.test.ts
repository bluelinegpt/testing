import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";

import { CreateUserDto, UserListQueryDto } from "./user-administration.dto.js";

describe("User administration DTOs", () => {
  it("accepts one multilingual display Name and the approved UAE mobile", async () => {
    const input = plainToInstance(CreateUserDto, {
      username: "mariam.ops",
      displayName: "Mariam مريم",
      email: "Mariam@Example.com",
      mobileNumber: "971501234567",
      preferredLanguage: "ar",
      roleIds: ["10000000-0000-4000-8000-000000000001"],
      status: "active",
      forcePasswordChange: true,
    });
    expect(await validate(input)).toEqual([]);
  });
  it.each(["+971501234567", "0501234567", "971501234567"])(
    "accepts local and international UAE mobile forms %s",
    async (mobileNumber) => {
      const input = plainToInstance(CreateUserDto, {
        username: "mariam.ops",
        displayName: "Mariam",
        email: "mariam@example.com",
        mobileNumber,
        preferredLanguage: "en",
        roleIds: ["10000000-0000-4000-8000-000000000001"],
        status: "active",
        forcePasswordChange: true,
      });
      expect((await validate(input)).some((error) => error.property === "mobileNumber")).toBe(
        false,
      );
    },
  );
  it.each(["97150123456", "9715012345678", "9715ABC34567", "0401234567"])(
    "rejects invalid mobile %s",
    async (mobileNumber) => {
      const input = plainToInstance(CreateUserDto, {
        username: "mariam.ops",
        displayName: "Mariam",
        email: "mariam@example.com",
        mobileNumber,
        preferredLanguage: "en",
        roleIds: ["10000000-0000-4000-8000-000000000001"],
        status: "active",
        forcePasswordChange: true,
      });
      expect((await validate(input)).some((error) => error.property === "mobileNumber")).toBe(true);
    },
  );
  it("requires both email and mobile for a newly created User", async () => {
    const input = plainToInstance(CreateUserDto, {
      displayName: "Mariam",
      preferredLanguage: "en",
      roleIds: ["10000000-0000-4000-8000-000000000001"],
      status: "active",
      forcePasswordChange: true,
      username: "mariam.ops",
    });
    const properties = (await validate(input)).map((error) => error.property);
    expect(properties).toContain("email");
    expect(properties).toContain("mobileNumber");
  });
  it("accepts only approved server-side page sizes", async () => {
    const valid = plainToInstance(UserListQueryDto, { page: "2", pageSize: "50" });
    const invalid = plainToInstance(UserListQueryDto, { page: "1", pageSize: "500" });
    expect(await validate(valid)).toEqual([]);
    expect((await validate(invalid)).some((error) => error.property === "pageSize")).toBe(true);
  });
});
