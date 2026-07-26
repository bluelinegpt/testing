import { resolve } from "node:path";

import { NestFactory } from "@nestjs/core";
import { config as loadEnvironment } from "dotenv";

import { AppModule } from "../app.module.js";

import { seedReconciliationDemo } from "./reconciliation-demo-seed.js";

loadEnvironment({ path: resolve(process.cwd(), "../../.env") });

const args = process.argv.slice(2).filter((value) => value.trim() !== "");
const resume = args.includes("--resume");
const subdomain =
  args.find((value) => !value.startsWith("--"))?.trim() ??
  process.env.BLUELINE_DEV_COMPANY_SUBDOMAIN?.trim() ??
  "";
if (subdomain === "") {
  throw new Error(
    "A Company subdomain is required: pnpm --filter @blueline/api dev:seed-reconciliation-demo <subdomain>",
  );
}

// No HTTP listener: the fixture only needs the dependency-injection container.
const context = await NestFactory.createApplicationContext(AppModule, { logger: false });
try {
  const result = await seedReconciliationDemo(context, { resume, subdomain });
  if (result.alreadyPresent) {
    process.stdout.write(
      `Demonstration fixture already present for '${subdomain}'. ` +
        `Delivered/Pending Orders: ${result.deliveredPendingOrders}\n`,
    );
  } else {
    process.stdout.write(
      `Demonstration fixture created for '${subdomain}':\n` +
        `  Company:                  ${result.companyId}\n` +
        `  Area:                     ${result.areaId}\n` +
        `  Trader:                   ${result.traderId}\n` +
        `  Driver:                   ${result.driverId}\n` +
        `  Customer:                 ${result.customerId}\n` +
        `  Orders created:           ${result.orderNumbers.length}\n` +
        `  Delivered/Pending Orders: ${result.deliveredPendingOrders}\n`,
    );
  }
} finally {
  await context.close();
}
