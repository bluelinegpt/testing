import type { Kysely } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { bootstrapPlatformAdministrator } from "./platform-administrator-bootstrap.js";

describe("platform administrator bootstrap", () => {
  it("rejects an invalid username before database access", async () => {
    await expect(
      bootstrapPlatformAdministrator({} as Kysely<DatabaseSchema>, {
        password: "a-secure-password-value",
        username: "bad username",
      }),
    ).rejects.toThrow("Bootstrap username");
  });

  it("rejects a short privileged password before database access", async () => {
    await expect(
      bootstrapPlatformAdministrator({} as Kysely<DatabaseSchema>, {
        password: "too-short",
        username: "platform.admin",
      }),
    ).rejects.toThrow("between 16 and 256");
  });
});
