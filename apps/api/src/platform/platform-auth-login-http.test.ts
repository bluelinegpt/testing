import { Controller as NestController, Module, ValidationPipe, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { Logger, LoggerModule } from "nestjs-pino";
import request from "supertest";

import { createHttpLoggerOptions } from "../logging/http-logger.config.js";
import { ApiExceptionFilter } from "../presentation/errors/api-exception.filter.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AuthenticationService } from "../authentication/authentication.service.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { PlatformAuditService } from "./platform-audit.service.js";
import { PlatformAuthController } from "./platform-auth.controller.js";
import { PlatformService } from "./platform.service.js";

/**
 * P1 corrective -- real HTTP-boundary coverage for `POST /platform/auth/login`
 * through the actual global `ValidationPipe` and the real controller, the same
 * way `authentication-login-http.database.test.ts` covers `/auth/login`. This
 * is deliberately NOT a full `PlatformModule` bootstrap (that module pulls in
 * Blog/WebsiteCms/Agent/TraderApplications/... transitively, none of which
 * this fix touches) -- only `AuthenticationService`/`PlatformAuditService`/
 * `PlatformService`/`IdentityContextAccessor` are mocked collaborators, kept
 * to exactly what `PlatformAuthController` itself depends on.
 */
@NestController()
class NoopController {}

@Module({
  controllers: [NoopController, PlatformAuthController],
  providers: [
    { provide: AuthenticationService, useValue: {} },
    { provide: PlatformAuditService, useValue: {} },
    { provide: PlatformService, useValue: {} },
    { provide: IdentityContextAccessor, useValue: {} },
    { provide: ConfigService, useValue: { get: () => "development" } },
  ],
})
class TestPlatformAuthModule {}

const invalidCredentials = () =>
  new ApplicationException("invalid_credentials", "The login identifier or password is invalid", 401);

async function buildApp(loginPlatform: (input: unknown) => Promise<unknown>): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    imports: [LoggerModule.forRoot({ pinoHttp: createHttpLoggerOptions() }), TestPlatformAuthModule],
  })
    .overrideProvider(AuthenticationService)
    .useValue({ loginPlatform })
    .overrideProvider(PlatformAuditService)
    .useValue({ recordBestEffort: async () => undefined })
    .overrideProvider(PlatformService)
    .useValue({ describeSession: async () => undefined })
    .overrideProvider(IdentityContextAccessor)
    .useValue({ current: () => undefined })
    .compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix("api/v1");
  app.useGlobalPipes(
    new ValidationPipe({ forbidNonWhitelisted: true, stopAtFirstError: false, transform: true, whitelist: true }),
  );
  app.useGlobalFilters(new ApiExceptionFilter(app.get(Logger)));
  await app.init();
  return app;
}

describe("POST /platform/auth/login (P1 HTTP boundary)", () => {
  it("never returns 500 for malformed input, and returns 401 for a well-formed wrong-credential attempt", async () => {
    const app = await buildApp(async () => {
      throw invalidCredentials();
    });
    try {
      const server = app.getHttpServer();

      const emptyBody = await request(server).post("/api/v1/platform/auth/login").send({});
      expect(emptyBody.status).not.toBe(500);

      const missingIdentifier = await request(server)
        .post("/api/v1/platform/auth/login")
        .send({ password: "irrelevant-password-value" });
      expect(missingIdentifier.status).not.toBe(500);

      const missingPassword = await request(server)
        .post("/api/v1/platform/auth/login")
        .send({ identifier: "platform.admin" });
      expect(missingPassword.status).not.toBe(500);

      const wrongCredentials = await request(server)
        .post("/api/v1/platform/auth/login")
        .send({ identifier: "platform.admin", password: "wrong-password-value" });
      expect(wrongCredentials.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("succeeds for valid credentials and sets a session cookie, without exposing the access token", async () => {
    const app = await buildApp(async () => ({
      accessToken: "super-secret-token-value",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      identity: {
        displayName: "Platform Admin",
        id: "10000000-0000-4000-8000-000000000099",
        permissions: ["platform.dashboard.view"],
        username: "platform.admin",
      },
    }));
    try {
      const response = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/login")
        .send({ identifier: "platform.admin", password: "correct-horse-battery" });
      expect(response.status).toBe(200);
      expect(response.body.identity.username).toBe("platform.admin");
      expect(response.body.identity.companyId).toBeNull();
      expect(JSON.stringify(response.body)).not.toContain("super-secret-token-value");
      const cookies = response.headers["set-cookie"];
      expect(cookies).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
