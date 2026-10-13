import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  platformApi,
  type CompanyAccountingModePreview,
  type CompanyAccountingModeStatus,
} from "../api/platform-client.js";
import { CompanyAccountingModePanel } from "./CompanyAccountingModePanel.js";

let permissions: string[] = ["platform.companies.accounting_mode.manage"];
vi.mock("../app/PlatformSession.js", () => ({
  usePlatformSession: () => ({ can: (code: string) => permissions.includes(code) }),
}));

const on: CompanyAccountingModeStatus = {
  accountingEnabled: true,
  accountingMode: "enabled",
  automaticPostingEnabled: true,
  configurationVersion: "7",
  unresolved: { failed: 0, otherUnresolved: 0, pending: 0 },
};
const off: CompanyAccountingModeStatus = {
  ...on,
  accountingEnabled: false,
  accountingMode: "disabled",
  automaticPostingEnabled: false,
  configurationVersion: "8",
};
const cleanDisable: CompanyAccountingModePreview = {
  action: "disable",
  blockers: [],
  confirmation: "DISABLE ACCOUNTING CMP-000004",
  executable: true,
  expectedConfigurationVersion: "7",
};

describe("CompanyAccountingModePanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    permissions = ["platform.companies.accounting_mode.manage"];
  });

  it("turns accounting off only with a reason and the exact typed confirmation, sending the preview's version", async () => {
    vi.spyOn(platformApi, "companyAccountingMode").mockResolvedValueOnce(on).mockResolvedValueOnce(off);
    vi.spyOn(platformApi, "companyAccountingModePreview").mockResolvedValue(cleanDisable);
    const change = vi.spyOn(platformApi, "changeCompanyAccountingMode").mockResolvedValue(undefined);
    render(<CompanyAccountingModePanel companyCode="CMP-000004" companyId="c1" />);

    expect((await screen.findByTestId("accounting-mode-state")).textContent).toBe("ON");
    fireEvent.click(screen.getByRole("button", { name: "Turn accounting off…" }));
    const confirm = await screen.findByRole("button", { name: "Turn accounting off" });

    fireEvent.click(confirm);
    expect(await screen.findByText("Enter a reason for this change.")).toBeTruthy();
    const [reasonBox, typedBox] = screen.getAllByRole("textbox");
    fireEvent.change(reasonBox!, { target: { value: "Company does not use accounting" } });
    fireEvent.change(typedBox!, { target: { value: "disable accounting" } });
    fireEvent.click(confirm);
    expect(await screen.findByText("Type DISABLE ACCOUNTING CMP-000004 exactly to confirm.")).toBeTruthy();
    expect(change).not.toHaveBeenCalled();

    fireEvent.change(typedBox!, { target: { value: "DISABLE ACCOUNTING CMP-000004" } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith("c1", "disable", {
        confirmation: "DISABLE ACCOUNTING CMP-000004",
        expectedConfigurationVersion: "7",
        reason: "Company does not use accounting",
      }),
    );
    await waitFor(() => expect(screen.getByTestId("accounting-mode-state").textContent).toBe("OFF"));
    expect(screen.getByRole("button", { name: "Turn accounting on…" })).toBeTruthy();
  });

  it("lists the blockers and offers no confirm button when the server refuses", async () => {
    vi.spyOn(platformApi, "companyAccountingMode").mockResolvedValue({
      ...on,
      unresolved: { failed: 4, otherUnresolved: 0, pending: 0 },
    });
    vi.spyOn(platformApi, "companyAccountingModePreview").mockResolvedValue({
      ...cleanDisable,
      blockers: [{ code: "failed_accounting_events", detail: "4" }],
      executable: false,
    });
    render(<CompanyAccountingModePanel companyCode="CMP-000004" companyId="c1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn accounting off…" }));
    expect(await screen.findByText("Failed accounting entries: 4")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn accounting off" })).toBeNull();
  });

  it("is read-only without the accounting-mode permission", async () => {
    permissions = ["platform.companies.manage"];
    vi.spyOn(platformApi, "companyAccountingMode").mockResolvedValue(on);
    render(<CompanyAccountingModePanel companyCode="CMP-000004" companyId="c1" />);
    expect(await screen.findByText("You can view this setting but not change it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Turn accounting/ })).toBeNull();
  });
});
