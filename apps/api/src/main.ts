import "reflect-metadata";

import { createApplication } from "./bootstrap/create-application.js";

const application = await createApplication();
await application.listen();
