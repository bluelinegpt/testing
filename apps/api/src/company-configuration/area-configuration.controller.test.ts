import "reflect-metadata";

import {
  REQUIRED_ANY_PERMISSIONS,
  REQUIRED_PERMISSIONS,
} from "../authentication/authentication.decorators.js";

import { AreaConfigurationController } from "./area-configuration.controller.js";

describe("AreaConfigurationController inline Order authorization", () => {
  // Every handler on the controller, not a subset: the class-level
  // `users_roles.manage` is the fallback for any endpoint added later
  // without its own decorators, so each existing one is asserted here.
  it.each([
    "create",
    "update",
    "setStatus",
  ] as const)(
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

  // Reads also admit traders.manage: the Trader form picks a pickup Emirate
  // and Area. Writes stay with Order creators and administrators.
  it.each(["emirates", "list", "search", "get"] as const)(
    "allows Order creators and Trader managers to read %s",
    (method) => {
      const handler = AreaConfigurationController.prototype[method];
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual([]);
      expect(Reflect.getMetadata(REQUIRED_ANY_PERMISSIONS, handler)).toEqual([
        "orders.create",
        "traders.manage",
        "users_roles.manage",
      ]);
    },
  );
});
