import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { IdentityContextAccessor } from "../security/identity-context.js";
import { RequirePlatformPermissions } from "./platform-authorization.js";
import { CreateWorkflowTestRunDto, EnableWorkflowTestingDto, WorkflowTestMutationDto } from "./platform-workflow-testing.dto.js";
import { PlatformWorkflowTestingService } from "./platform-workflow-testing.service.js";

@ApiBearerAuth()
@ApiTags("platform workflow testing")
@Controller("platform/workflow-tests")
export class PlatformWorkflowTestingController {
  public constructor(
    @Inject(PlatformWorkflowTestingService) private readonly service:PlatformWorkflowTestingService,
    @Inject(IdentityContextAccessor) private readonly identities:IdentityContextAccessor,
  ){}
  @Get("companies") @RequirePlatformPermissions("platform.workflow_tests.read") public companies(){return this.service.eligibleCompanies();}
  @Get() @RequirePlatformPermissions("platform.workflow_tests.read") public list(){return this.service.list();}
  @Post("companies/:id/enable") @RequirePlatformPermissions("platform.workflow_tests.manage") public enable(@Param("id") id:string,@Body() input:EnableWorkflowTestingDto){return this.service.enableCompany(id,input.confirmation);}
  @Post() @RequirePlatformPermissions("platform.workflow_tests.manage") public create(@Body() input:CreateWorkflowTestRunDto){return this.service.create(input,{accountId:this.identities.current().identityId});}
  @Post(":id/connect-recent-orders") @RequirePlatformPermissions("platform.workflow_tests.manage") public connectRecentOrders(@Param("id") id:string,@Body() input:WorkflowTestMutationDto){return this.service.connectRecentOrders(id,input.expectedVersion);}
  @Post(":id/start") @RequirePlatformPermissions("platform.workflow_tests.manage") public start(@Param("id") id:string,@Body() input:WorkflowTestMutationDto){return this.service.mutate(id,"start",input.expectedVersion);}
  @Post(":id/pause") @RequirePlatformPermissions("platform.workflow_tests.manage") public pause(@Param("id") id:string,@Body() input:WorkflowTestMutationDto){return this.service.mutate(id,"pause",input.expectedVersion);}
  @Post(":id/resume") @RequirePlatformPermissions("platform.workflow_tests.manage") public resume(@Param("id") id:string,@Body() input:WorkflowTestMutationDto){return this.service.mutate(id,"resume",input.expectedVersion);}
  @Post(":id/stop") @RequirePlatformPermissions("platform.workflow_tests.manage") public stop(@Param("id") id:string,@Body() input:WorkflowTestMutationDto){return this.service.mutate(id,"stop",input.expectedVersion);}
  @Post(":id/cancel") @RequirePlatformPermissions("platform.workflow_tests.manage") public cancel(@Param("id") id:string,@Body() input:WorkflowTestMutationDto){return this.service.mutate(id,"cancel",input.expectedVersion);}
}
