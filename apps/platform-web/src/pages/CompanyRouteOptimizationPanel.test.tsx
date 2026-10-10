import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { platformApi, type CompanyRouteOptimization } from "../api/platform-client.js";
import { CompanyRouteOptimizationPanel } from "./CompanyRouteOptimizationPanel.js";

let permissions: string[] = ["platform.company_route_optimization.manage"];
vi.mock("../app/PlatformSession.js", () => ({
  usePlatformSession: () => ({ can: (code: string) => permissions.includes(code) }),
}));

const off: CompanyRouteOptimization = {
  areaCount: 10,
  branchSet: false,
  companyId: "c1",
  dailyCallBudget: 200,
  isEnabled: false,
  platformEnabled: true,
  provider: "area_matrix",
  runsByDay: [],
  updatedAt: null,
  usageByDay: [],
  verifiedAreaCount: 3,
  version: 0,
};

describe("CompanyRouteOptimizationPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    permissions = ["platform.company_route_optimization.manage"];
  });

  it("shows pins and branch readiness and turns route planning on with the loaded version", async () => {
    vi.spyOn(platformApi, "companyRouteOptimization").mockResolvedValue(off);
    vi.spyOn(platformApi, "routeKillSwitch").mockResolvedValue({
      isEnabled: true,
      note: null,
      updatedAt: "2026-10-10T08:00:00Z",
    });
    const update = vi
      .spyOn(platformApi, "updateCompanyRouteOptimization")
      .mockResolvedValue({ ...off, isEnabled: true, version: 1 });
    render(<CompanyRouteOptimizationPanel companyId="c1" />);
    expect(await screen.findByText(/3 of 10/)).toBeTruthy();
    expect(screen.getByText(/Not set/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on for this Company" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("c1", {
        dailyCallBudget: 200,
        expectedVersion: 0,
        isEnabled: true,
      }),
    );
    expect(await screen.findByText("Route planning is on for this Company.")).toBeTruthy();
  });

  it("says when the kill switch stops an enabled Company, and lets the admin stop it for all", async () => {
    vi.spyOn(platformApi, "companyRouteOptimization").mockResolvedValue({
      ...off,
      isEnabled: true,
      version: 2,
    });
    vi.spyOn(platformApi, "routeKillSwitch").mockResolvedValue({
      isEnabled: false,
      note: "incident",
      updatedAt: "2026-10-10T08:00:00Z",
    });
    const configure = vi
      .spyOn(platformApi, "configureRouteKillSwitch")
      .mockResolvedValue({ isEnabled: true, note: null, updatedAt: "2026-10-10T09:00:00Z" });
    render(<CompanyRouteOptimizationPanel companyId="c1" />);
    expect(await screen.findByText("On, but stopped by the Platform kill switch")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow route planning" }));
    await waitFor(() => expect(configure).toHaveBeenCalledWith({ isEnabled: true }));
  });

  it("is read-only without the manage permission", async () => {
    permissions = [];
    vi.spyOn(platformApi, "companyRouteOptimization").mockResolvedValue(off);
    vi.spyOn(platformApi, "routeKillSwitch").mockResolvedValue({
      isEnabled: true,
      note: null,
      updatedAt: "2026-10-10T08:00:00Z",
    });
    render(<CompanyRouteOptimizationPanel companyId="c1" />);
    expect(
      await screen.findByText("You can view these settings but not change them."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on for this Company" })).toBeNull();
  });
});
