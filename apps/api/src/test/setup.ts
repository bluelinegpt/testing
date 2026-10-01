import { config as loadEnvironment } from "dotenv";

import { assertNonDestructiveDatabaseTestPreflight } from "./non-destructive-database-guard.js";

if (process.env.BLUELINE_DISABLE_DOTENV !== "1") {
  loadEnvironment({ path: "../../.env" });
}
assertNonDestructiveDatabaseTestPreflight();
