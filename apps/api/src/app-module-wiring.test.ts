import { resolve } from "node:path";

import { Test } from "@nestjs/testing";
import { config as loadEnvironment } from "dotenv";
import { describe, expect, it } from "vitest";

import { AppModule } from "./app.module.js";

/**
 * The whole dependency graph must resolve.
 *
 * This exists because it did not, and the API would not boot: a service was
 * added with a constructor dependency its module neither provided nor imported,
 * and Nest failed at startup with `UnknownDependenciesException`. Nothing
 * caught it. Every other suite constructs services by hand -- `new Service(a, b)`
 * -- which is fast and hermetic and proves precisely nothing about the wiring
 * Nest actually performs at runtime.
 *
 * `compile()` builds the full injector and resolves every provider, which is
 * exactly the step that failed. It binds no port, starts no listener and issues
 * no query -- the database provider hands out a lazy Pool -- so this stays a
 * unit test in cost while covering the one thing unit tests structurally miss.
 *
 * If this fails with `Nest can't resolve dependencies of X (..., ?)`, the fix is
 * almost always to add the missing provider to that service's module, or to
 * import the module that exports it.
 */

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });

describe("application wiring", () => {
  it("resolves every provider in the application module graph", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 60000);
});
