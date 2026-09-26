import "reflect-metadata";

import {
  REQUIRED_ANY_PERMISSIONS,
  REQUIRED_PERMISSIONS,
} from "../authentication/authentication.decorators.js";

import { AreaConfigurationController } from "./area-configuration.controller.js";

describe("AreaConfigurationController inline Order authorization", () => {
  it.each(["emirates", "search", "create"] as const)(
    "allows Order creators to use %s without inheriting administrator-only permission",
    (method) => {
      const handler = AreaConfigurationController.prototype[method];
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual([]);
      expect(Reflect.getMetadata(REQUIRED_ANY_PERMISSIONS, handler)).toEqual([
        "orders.create",
        "users_roles.manage",
      ]);
    },
  );
});
