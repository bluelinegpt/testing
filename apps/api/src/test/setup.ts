import { config as loadEnvironment } from "dotenv";

import { assertNonDestructiveDatabaseTestPreflight } from "./non-destructive-database-guard.js";

loadEnvironment({ path: "../../.env" });
assertNonDestructiveDatabaseTestPreflight();
