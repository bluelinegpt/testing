import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";

import { CreateRoleDto } from "./role.dto.js";

describe("Role administration DTOs", () => {
  it("does not require an administrator to supply the internal Role code", async () => {
    const input = plainToInstance(CreateRoleDto, {
      name: "Dispatch Supervisor",
      description: "Controls dispatch",
      isActive: true,
      permissions: ["orders.assign_driver"],
    });
    expect(await validate(input)).toEqual([]);
    expect(input).not.toHaveProperty("code");
  });
});
