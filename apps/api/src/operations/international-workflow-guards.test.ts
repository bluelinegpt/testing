import { describe, expect, it } from "vitest";

import { internationalCollectionError } from "./driver-cash-reconciliation.service.js";
import { internationalDriverAssignmentError } from "./orders-workflow.service.js";

describe("International workflow API guards", () => {
  it("rejects direct Driver assignment requests for International Orders", () => {
    expect(internationalDriverAssignmentError("gcc_international", true)).toContain("cannot be assigned");
    expect(internationalDriverAssignmentError("delivery", true)).toBeNull();
  });

  it("rejects direct Driver Collection requests for International Orders", () => {
    expect(internationalCollectionError("gcc_international")).toContain("not eligible");
    expect(internationalCollectionError("delivery")).toBeNull();
  });

  it("keeps Domestic orders eligible for the existing bulk semantics", () => {
    expect(internationalDriverAssignmentError("delivery", true)).toBeNull();
    expect(internationalCollectionError("collect_order")).toBeNull();
  });
});
