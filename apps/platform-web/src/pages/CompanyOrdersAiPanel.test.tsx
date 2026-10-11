import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { platformApi } from "../api/platform-client.js";
import { CompanyOrdersAiPanel } from "./CompanyOrdersAiPanel.js";

let permissions: string[] = ["platform.companies.manage"];
vi.mock("../app/PlatformSession.js", () => ({
  usePlatformSession: () => ({ can: (code: string) => permissions.includes(code) }),
}));

describe("CompanyOrdersAiPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    permissions = ["platform.companies.manage"];
  });

  it("turns Orders AI on with the loaded version", async () => {
    vi.spyOn(platformApi, "companyOrdersAi").mockResolvedValue({
      isEnabled: false,
      updatedAt: null,
      version: 0,
    });
    const update = vi
      .spyOn(platformApi, "updateCompanyOrdersAi")
      .mockResolvedValue({ isEnabled: true, updatedAt: "2026-10-11T15:00:00Z", version: 1 });
    render(<CompanyOrdersAiPanel companyId="c1" />);
    expect(await screen.findByText("Off")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn on Orders AI" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("c1", { expectedVersion: 0, isEnabled: true }));
    expect(await screen.findByText("Orders AI is on for this Company.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn off Orders AI" })).toBeTruthy();
  });

  it("is read-only without the manage permission", async () => {
    permissions = [];
    vi.spyOn(platformApi, "companyOrdersAi").mockResolvedValue({
      isEnabled: true,
      updatedAt: null,
      version: 2,
    });
    render(<CompanyOrdersAiPanel companyId="c1" />);
    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Orders AI/ })).toBeNull();
    expect(screen.getByText("You can view this setting but not change it.")).toBeTruthy();
  });
});
