import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { platformApi, type CompanyMobileApp } from "../api/platform-client.js";
import { CompanyMobileAppPanel } from "./CompanyMobileAppPanel.js";

let permissions: string[] = ["platform.companies.manage"];
vi.mock("../app/PlatformSession.js", () => ({
  usePlatformSession: () => ({ can: (code: string) => permissions.includes(code) }),
}));

const on: CompanyMobileApp = { activeMobileSessions: 4, changedAt: null, isEnabled: true };

describe("CompanyMobileAppPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    permissions = ["platform.companies.manage"];
  });

  it("needs a reason to turn the mobile app off, then sends it", async () => {
    vi.spyOn(platformApi, "companyMobileApp").mockResolvedValue(on);
    const update = vi
      .spyOn(platformApi, "updateCompanyMobileApp")
      .mockResolvedValue({ ...on, activeMobileSessions: 0, isEnabled: false });
    render(<CompanyMobileAppPanel companyId="c1" />);
    expect(await screen.findByText("4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn off the mobile app" }));
    expect(await screen.findByText("Enter a reason for turning off the mobile app.")).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Contract paused" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn off the mobile app" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("c1", { isEnabled: false, reason: "Contract paused" }),
    );
    expect(await screen.findByRole("button", { name: "Turn on the mobile app" })).toBeTruthy();
  });

  it("is read-only without the manage permission", async () => {
    permissions = [];
    vi.spyOn(platformApi, "companyMobileApp").mockResolvedValue(on);
    render(<CompanyMobileAppPanel companyId="c1" />);
    expect(await screen.findByText("You can view this setting but not change it.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
