import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";

import { DatabaseHealthService } from "../infrastructure/database/database-health.service.js";

export interface HealthStatus {
  readonly status: "ok";
  /** Short git commit of the running build, or "unknown" outside a deploy.
   *  The API has no version badge the way the web apps do, so this is the
   *  one direct way to confirm which commit Render is actually serving. */
  readonly version: string;
}

/** Render injects RENDER_GIT_COMMIT into every deploy; locally it is absent. */
const buildVersion = (process.env["RENDER_GIT_COMMIT"] ?? "unknown").slice(0, 7);

@Injectable()
export class HealthService {
  public constructor(
    @Inject(DatabaseHealthService) private readonly databaseHealth: DatabaseHealthService,
  ) {}

  public live(): HealthStatus {
    return { status: "ok", version: buildVersion };
  }

  public async ready(): Promise<HealthStatus> {
    try {
      await this.databaseHealth.check();
      return { status: "ok", version: buildVersion };
    } catch {
      throw new ServiceUnavailableException("Service dependencies are not ready");
    }
  }
}
