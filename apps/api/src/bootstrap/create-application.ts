import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import express from "express";
import helmet from "helmet";
import { Logger } from "nestjs-pino";

import { AppModule } from "../app.module.js";
import { CommunicationRealtimeGateway } from "../communication/communication-realtime.gateway.js";
import type { AppConfiguration } from "../configuration/environment.js";
import { ApiExceptionFilter } from "../presentation/errors/api-exception.filter.js";

export interface BluelineApplication {
  listen(): Promise<void>;
}

export async function createApplication(): Promise<BluelineApplication> {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
  });
  const config = app.get<ConfigService<AppConfiguration, true>>(ConfigService);
  const logger = app.get(Logger);
  const realtime = app.get(CommunicationRealtimeGateway);

  app.useLogger(logger);
  app.enableShutdownHooks();
  app.setGlobalPrefix("api/v1");
  app.use(helmet());
  app.use(express.json({ limit: `${config.get("app.requestBodyLimitMb", { infer: true })}mb` }));
  app.use(
    express.urlencoded({
      extended: false,
      limit: `${config.get("app.requestBodyLimitMb", { infer: true })}mb`,
    }),
  );
  // `credentials` is required for the HttpOnly session cookie to travel on
  // browser requests. It does NOT widen who may call: `origin` remains the
  // configured allow-list, and a credentialed request from any other origin is
  // still refused by the browser. The custom session header is added to the
  // allowed set because cookie-authenticated mutations must carry it.
  app.enableCors({
    allowedHeaders: ["Authorization", "Content-Type", "X-Blueline-Session", "X-Idempotency-Key"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    origin: config.get("app.corsOrigins", { infer: true }),
  });
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      stopAtFirstError: false,
      transform: true,
      whitelist: true,
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter(logger));

  if (config.get("app.environment", { infer: true }) !== "production") {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("BluelineGPT API")
        .setDescription("Versioned technical API foundation")
        .setVersion("1")
        .build(),
    );
    SwaggerModule.setup("api/docs", app, document);
  }

  return {
    async listen(): Promise<void> {
      const port = config.get("app.port", { infer: true });
      realtime.attach(app.getHttpServer());
      await app.listen(port, "0.0.0.0");
      logger.log(`BluelineGPT API listening on port ${port}`);
    },
  };
}
