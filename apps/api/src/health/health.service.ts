import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";

import { DatabaseHealthService } from "../infrastructure/database/database-health.service.js";

export interface HealthStatus {
  readonly status: "ok";
}

@Injectable()
export class HealthService {
  public constructor(
    @Inject(DatabaseHealthService) private readonly databaseHealth: DatabaseHealthService,
  ) {}

  public live(): HealthStatus {
    return { status: "ok" };
  }

  public async ready(): Promise<HealthStatus> {
    try {
      await this.databaseHealth.check();
      return { status: "ok" };
    } catch {
      throw new ServiceUnavailableException("Service dependencies are not ready");
    }
  }
}
