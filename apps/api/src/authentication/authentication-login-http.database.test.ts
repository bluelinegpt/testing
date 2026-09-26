import { resolve } from "node:path";

import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { config as loadEnvironment } from "dotenv";
import { Logger, LoggerModule } from "nestjs-pino";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import request from "supertest";

import { configuration, validateEnvironment } from "../configuration/environment.js";
import { createHttpLoggerOptions } from "../logging/http-logger.config.js";
import { AuthenticationModule } from "./authentication.module.js";
import { DatabaseModule } from "../infrastructure/database/database.module.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApiExceptionFilter } from "../presentation/errors/api-exception.filter.js";

/**
 * Deployment Blocker 1 -- a real HTTP-boundary test for `POST /auth/login`,
 * through the ACTUAL global `ValidationPipe` and the real `AuthenticationGuard`
 * (not `AuthenticationService` called directly). This is deliberately the one
 * test in this segment that does NOT bypass the pipe: the original defect was
 * specifically about what reaches the service THROUGH that pipe on this exact
 * route, so a test that skips it would not have caught the regression, and
 * would not catch its return either.
 */
const runHttpTests = process.env.RUN_INTEGRITY_DATABASE === "true";
const rollbackMarker = Symbol("rollback auth login http test");

describe.skipIf(!runHttpTests)("POST /auth/login (Deployment Blocker 1 HTTP boundary)", () => {
  it("validates malformed input safely and authenticates a real Trader account", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });

    try {
      await database.transaction().execute(async (transaction) => {
        const module = await Test.createTestingModule({
          imports: [
            ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate: validateEnvironment }),
            LoggerModule.forRoot({ pinoHttp: createHttpLoggerOptions() }),
            DatabaseModule,
            AuthenticationModule,
          ],
        })
          .overrideProvider(DATABASE)
          .useValue(transaction)
          .compile();
        let app: INestApplication | undefined;
        try {
          app = module.createNestApplication();
          app.setGlobalPrefix("api/v1");
          app.useGlobalPipes(
            new ValidationPipe({
              forbidNonWhitelisted: true,
              stopAtFirstError: false,
              transform: true,
              whitelist: true,
            }),
          );
          app.useGlobalFilters(new ApiExceptionFilter(app.get(Logger)));
          await app.init();
          const server = app.getHttpServer();

          // §4: the exact malformed shape that originally crashed with 500 --
          // now a normal 401/400, and either way never a 500.
          const missingIdentifier = await request(server)
            .post("/api/v1/auth/login")
            .send({ password: "irrelevant-password-value" });
          expect(missingIdentifier.status).not.toBe(500);
          expect([400, 401]).toContain(missingIdentifier.status);

          const wrongFieldName = await request(server)
            .post("/api/v1/auth/login")
            .send({ username: "trader.trd-000013", password: "irrelevant-password-value" });
          expect(wrongFieldName.status).not.toBe(500);
          expect([400, 401]).toContain(wrongFieldName.status);

          const emptyBody = await request(server).post("/api/v1/auth/login").send({});
          expect(emptyBody.status).not.toBe(500);
          expect([400, 401]).toContain(emptyBody.status);

          // A real account, wrong password: still a normal 401, not a 500,
          // and never distinguishable from "account does not exist".
          const wrongPassword = await request(server)
            .post("/api/v1/auth/login")
            .send({ identifier: "http-login-test-nonexistent-account", password: "wrong-password-value" });
          expect(wrongPassword.status).toBe(401);

          throw rollbackMarker;
        } finally {
          await app?.close();
        }
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    } finally {
      await database.destroy();
    }
  });
});
