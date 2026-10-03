import { REQUIRED_IDENTITY_KINDS, REQUIRED_PERMISSIONS } from "../authentication/authentication.decorators.js";
import { PLATFORM_ACCESS, PLATFORM_COMPANIES_RESET } from "./platform-authorization.js";
import { PlatformTargetCompanyController } from "./platform-company.controller.js";

describe("selective company-user reset routes", () => {
  it("keeps eligibility, preview, and execution behind the target-company Platform reset guard", () => {
    const expected = new Map([
      ["usersResetEligible", "users-reset-eligible"],
      ["usersResetPreview", "users-reset-preview"],
      ["usersResetExecute", "users-reset-execute"],
    ]);
    const prototype = PlatformTargetCompanyController.prototype;
    for (const [method, path] of expected) {
      const handler = Object.getOwnPropertyDescriptor(prototype, method)?.value as Function | undefined;
      if (handler === undefined) throw new Error(`Missing route handler ${method}`);
      expect(Reflect.getMetadata("path", handler)).toBe(path);
      expect(Reflect.getMetadata(REQUIRED_IDENTITY_KINDS, handler)).toEqual(["platform_administrator"]);
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual([PLATFORM_ACCESS, PLATFORM_COMPANIES_RESET]);
    }
  });
});
