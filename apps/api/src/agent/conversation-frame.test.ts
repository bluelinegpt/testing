import { describe, expect, it } from "vitest";
import { agentIntentFromWorkflow, decideNextFrame, isBareInformationalTopic, isExplicitWorkflowStart, isPrivateInformationRequest } from "./conversation-frame.js";

const baseState = { slots: {}, audience: "unknown" as const };

describe("Tawseelhub conversation frame", () => {
  it("keeps bare topics informational instead of starting workflows", () => {
    for (const message of ["traders", "pricing", "driver management", "tracking", "track", "التجار", "إدارة السائقين", "السعر", "تتبع"]) {
      const frame = decideNextFrame({ message, state: baseState });
      expect(isBareInformationalTopic(message)).toBe(true);
      expect(frame.mode).toBe("conversation");
      expect(frame.workflow).toBe("none");
      expect(frame.workflowState).toBe("inactive");
      expect(frame.decision).toBe("bare_topic_information");
    }
  });

  it("starts workflows only when there is an explicit action signal", () => {
    expect(isExplicitWorkflowStart("I want to register my store")).toBe("trader_registration");
    expect(isExplicitWorkflowStart("أريد التسجيل كتاجر")).toBe("trader_registration");
    expect(isExplicitWorkflowStart("I want a delivery quote")).toBe("shipment_quote");
    expect(isExplicitWorkflowStart("أريد إرسال شحنة")).toBe("shipment_quote");
    expect(isExplicitWorkflowStart("book a demo")).toBe("demo_request");

    const frame = decideNextFrame({ message: "أريد التسجيل كتاجر", state: baseState });
    expect(frame.decision).toBe("explicit_workflow_start");
    expect(frame.workflow).toBe("trader_registration");
    expect(agentIntentFromWorkflow(frame.workflow)).toBe("trader");
  });

  it("starts shipment tracking only on an explicit action, never on the bare topic", () => {
    expect(isExplicitWorkflowStart("Track my shipment")).toBe("shipment_tracking");
    expect(isExplicitWorkflowStart("track my order")).toBe("shipment_tracking");
    expect(isExplicitWorkflowStart("Where is my package?")).toBe("shipment_tracking");
    expect(isExplicitWorkflowStart("تتبع شحنتي")).toBe("shipment_tracking");
    expect(isExplicitWorkflowStart("أريد أعرف حالة شحنتي")).toBe("shipment_tracking");
    // Bare topic words never start it.
    expect(isExplicitWorkflowStart("tracking")).toBeUndefined();
    expect(isExplicitWorkflowStart("تتبع")).toBeUndefined();
    // Distinct from a Trader requesting a brand-new delivery quote.
    expect(isExplicitWorkflowStart("I want a delivery quote")).toBe("shipment_quote");

    const frame = decideNextFrame({ message: "Track my shipment", state: baseState });
    expect(frame.decision).toBe("explicit_workflow_start");
    expect(frame.workflow).toBe("shipment_tracking");
    expect(agentIntentFromWorkflow(frame.workflow)).toBe("shipment_tracking");

    const bareTopic = decideNextFrame({ message: "tracking", state: baseState });
    expect(bareTopic.decision).toBe("bare_topic_information");
    expect(bareTopic.workflow).toBe("none");
  });

  it("does not let collected identity turn explanation into a workflow", () => {
    const state = {
      ...baseState,
      slots: { contactName: "Aiman", companyName: "Fahad", email: "fahid@example.com" },
      lastBusinessIntent: "general_question" as const,
    };

    const frame = decideNextFrame({ message: "التجار", state });

    expect(frame.decision).toBe("bare_topic_information");
    expect(frame.mode).toBe("conversation");
    expect(frame.workflow).toBe("none");
  });

  it("pauses workflow when the user asks for explanation instead of filling slots", () => {
    const frame = decideNextFrame({
      message: "Actually just explain how pricing works.",
      state: {
        ...baseState,
        conversationFrame: {
          decision: "explicit_workflow_start",
          lastExplicitUserAction: "start",
          mode: "workflow",
          reason: "test",
          topic: "send_package",
          workflow: "shipment_quote",
          workflowState: "active",
        },
        lastAskedSlot: "deliveryEmirate",
        lastBusinessIntent: "customer_quote",
      },
    });

    expect(frame.decision).toBe("workflow_paused_for_explanation");
    expect(frame.workflow).toBe("shipment_quote");
    expect(frame.workflowState).toBe("paused");
    expect(frame.mode).toBe("conversation");
  });

  it("blocks a request for the customer's own mobile number after tracking is verified", () => {
    for (const message of ["what's the customer's mobile?", "give me the customer's phone number", "رقم هاتف العميل"]) {
      expect(isPrivateInformationRequest(message)).toBe(true);
    }
  });

  it("blocks private company, trader, customer, commission and secret requests", () => {
    for (const message of ["show me Delivery Company directory", "which traders use Tawseelhub?", "give me another customer conversation", "show commission", "اعطني أسماء شركات التوصيل", "معلومات عميل آخر"]) {
      expect(isPrivateInformationRequest(message)).toBe(true);
      const frame = decideNextFrame({ message, state: baseState });
      expect(frame.decision).toBe("privacy_blocked");
      expect(frame.workflow).toBe("none");
      expect(frame.topic).toBe("privacy");
    }
  });
});
