import { describe,expect,it } from "vitest";
import { workflowTestRejection } from "./platform-workflow-testing.service.js";

const enabled={name:"Lifecycle Test Company",environment:"demo",enabledAt:"2026-08-29T00:00:00Z"};

describe("automated workflow testing safety rules",()=>{
  it("blocks Dana regardless of mode",()=>expect(workflowTestRejection({...enabled,name:"Dana Delivery Services"},{mode:"smoke",ordersPerDay:1,durationDays:1,sideEffectsSuppressed:true})).toBe("dana_workflow_testing_blocked"));
  it("requires explicit Company enablement for full runs",()=>expect(workflowTestRejection({...enabled,enabledAt:null},{mode:"full",ordersPerDay:20,durationDays:1,sideEffectsSuppressed:true})).toBe("company_not_enabled_for_full_workflow_testing"));
  it("requires side-effect suppression for full runs",()=>expect(workflowTestRejection(enabled,{mode:"full",ordersPerDay:20,durationDays:1,sideEffectsSuppressed:false})).toBe("side_effect_suppression_required"));
  it("caps smoke mode at five total Orders",()=>expect(workflowTestRejection(enabled,{mode:"smoke",ordersPerDay:3,durationDays:2,sideEffectsSuppressed:true})).toBe("smoke_test_maximum_is_five_orders"));
  it("accepts a controlled enabled full run",()=>expect(workflowTestRejection(enabled,{mode:"full",ordersPerDay:200,durationDays:7,sideEffectsSuppressed:true})).toBeNull());
});
