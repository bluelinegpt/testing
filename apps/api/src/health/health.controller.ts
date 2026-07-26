import { Controller, Get, Inject } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { HealthService } from "./health.service.js";
import type { HealthStatus } from "./health.service.js";
import { Public } from "../authentication/authentication.decorators.js";

@ApiTags("health")
@Public()
@Controller("health")
export class HealthController {
  public constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @ApiOperation({ summary: "Process liveness" })
  @Get("live")
  public live(): HealthStatus {
    return this.health.live();
  }

  @ApiOperation({ summary: "Application and PostgreSQL readiness" })
  @Get("ready")
  public async ready(): Promise<HealthStatus> {
    return this.health.ready();
  }
}
