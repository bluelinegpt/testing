import type { Kysely } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import {
  PLATFORM_SEO_CONSULTANT_PERMISSIONS,
  provisionPlatformSeoConsultant,
} from "./platform-user-provisioning.js";

describe("Platform SEO Consultant provisioning", () => {
  it("grants draft, media and SEO permissions without publishing or administration", () => {
    expect(PLATFORM_SEO_CONSULTANT_PERMISSIONS).toEqual([
      "platform.access",
      "platform.blog.read",
      "platform.blog.create",
      "platform.blog.edit",
      "platform.blog.categories.manage",
      "platform.website.read",
      "platform.website.media.manage",
      "platform.website.seo.manage",
    ]);
    expect(PLATFORM_SEO_CONSULTANT_PERMISSIONS).not.toContain("platform.blog.publish");
    expect(PLATFORM_SEO_CONSULTANT_PERMISSIONS).not.toContain("platform.companies.manage");
    expect(PLATFORM_SEO_CONSULTANT_PERMISSIONS).not.toContain("platform.users.manage");
  });

  it("rejects invalid identity input before database access", async () => {
    const database = {} as Kysely<DatabaseSchema>;
    await expect(
      provisionPlatformSeoConsultant(database, {
        email: "not-an-email",
        temporaryPassword: "a-secure-temporary-password",
        username: "bad username",
      }),
    ).rejects.toThrow("Username");
  });

  it("requires a secure temporary password before database access", async () => {
    await expect(
      provisionPlatformSeoConsultant({} as Kysely<DatabaseSchema>, {
        email: "seo@example.com",
        temporaryPassword: "short",
        username: "seo@example.com",
      }),
    ).rejects.toThrow("between 16 and 256");
  });
});
