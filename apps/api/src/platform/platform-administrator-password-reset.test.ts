import type { Kysely } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { resetPlatformAdministratorPassword } from "./platform-administrator-password-reset.js";

describe("platform administrator password reset", () => {
  it("rejects an invalid username before database access", async () => {
    await expect(
      resetPlatformAdministratorPassword({} as Kysely<DatabaseSchema>, {
        password: "a-secure-password-value",
        username: "bad username",
      }),
    ).rejects.toThrow("3-128 characters");
  });

  it("rejects a short privileged password before database access", async () => {
    await expect(
      resetPlatformAdministratorPassword({} as Kysely<DatabaseSchema>, {
        password: "too-short",
        username: "platform.admin",
      }),
    ).rejects.toThrow("between 16 and 256");
  });
});
