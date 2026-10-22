import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { platformApi } from "../api/platform-client.js";
import { CompanySettlementOptionsPanel } from "./CompanySettlementOptionsPanel.js";

let permissions: string[] = ["platform.companies.manage"];
vi.mock("../app/PlatformSession.js", () => ({
  usePlatformSession: () => ({ can: (code: string) => permissions.includes(code) }),
}));

const off = { codShortfall: false, oneScreen: false, openDrafts: 0, ordersWaitingReceipt: 1056 };

describe("CompanySettlementOptionsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    permissions = ["platform.companies.manage"];
  });

  it("turns one switch on with the typed reason, and back off (rollback)", async () => {
    vi.spyOn(platformApi, "companySettlementOptions").mockResolvedValue(off);
    const update = vi
      .spyOn(platformApi, "updateCompanySettlementOptions")
      .mockResolvedValueOnce({ ...off, oneScreen: true })
      .mockResolvedValueOnce(off);
    render(<CompanySettlementOptionsPanel companyId="c1" />);
    expect(await screen.findByText("1056")).toBeTruthy();

    // A reason is required before anything changes.
    fireEvent.click(screen.getByRole("button", { name: "Turn on One-screen settlement" }));
    expect(await screen.findByText("Enter a reason first. It is kept in the audit trail.")).toBeTruthy();
    expect(update).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Reason for the change"), { target: { value: "Go live" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on One-screen settlement" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("c1", { oneScreen: true, reason: "Go live" }));
    expect(await screen.findByText("One-screen settlement is now on for this Company.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Reason for the change"), { target: { value: "Roll back" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn off One-screen settlement" }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith("c1", { oneScreen: false, reason: "Roll back" }));
    expect(await screen.findByText("One-screen settlement is now off for this Company.")).toBeTruthy();
  });

  it("is read-only without the manage permission", async () => {
    permissions = [];
    vi.spyOn(platformApi, "companySettlementOptions").mockResolvedValue({ ...off, oneScreen: true });
    render(<CompanySettlementOptionsPanel companyId="c1" />);
    expect(await screen.findByText("You can view these settings but not change them.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /One-screen settlement/ })).toBeNull();
  });
});
