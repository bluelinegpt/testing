import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { NestFactory } from "@nestjs/core";
import { config as loadEnvironment } from "dotenv";

import { AppModule } from "../app.module.js";

import { importUaeAreas } from "./uae-area-import.js";

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });

const subdomain =
  process.argv
    .slice(2)
    .find((value) => !value.startsWith("--"))
    ?.trim() ??
  process.env.BLUELINE_DEV_COMPANY_SUBDOMAIN?.trim() ??
  "";
if (subdomain === "") {
  throw new Error(
    "A Company subdomain is required: pnpm --filter @blueline/api dev:import-areas <subdomain>",
  );
}

const context = await NestFactory.createApplicationContext(AppModule, { logger: false });
try {
  const result = await importUaeAreas(context, { correlationId: randomUUID(), subdomain });
  process.stdout.write(
    `UAE Area import for '${subdomain}':\n` +
      `  Reference rows:     ${result.total}\n` +
      `  Created:            ${result.created}\n` +
      `  Skipped (existing): ${result.skippedExisting}\n` +
      `  Arabic backfilled:  ${result.backfilledArabicNames}\n` +
      `  Failed:             ${result.failed.length}\n`,
  );
  for (const failure of result.failed.slice(0, 10)) {
    process.stdout.write(`    - ${failure.name}: ${failure.reason}\n`);
  }
} finally {
  await context.close();
}
