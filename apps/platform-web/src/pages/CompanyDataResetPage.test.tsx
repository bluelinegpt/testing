import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type CompanyDataResetPlan,
  type ResetUserPlan,
  platformApi,
  PlatformApiError,
} from "../api/platform-client.js";
import { CompanyDataResetPage } from "./CompanyDataResetPage.js";

const companyId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const pair = (remove: number, keep: number) => ({ delete: remove, preserve: keep });

function userPlan(overrides: Partial<ResetUserPlan>): ResetUserPlan {
  return {
    accountId: "11111111-0000-4000-8000-000000000001",
    accountKind: "company_user",
    classification: "KEEP",
    displayName: "User",
    driver: null,
    eligibility: { reason: null, state: "ELIGIBLE" },
    employee: null,
    identity: { action: "KEEP", references: [] },
    isCompanyAdmin: false,
    membershipRemoved: 0,
    reason: null,
    remove: false,
    roleAssignmentsRemoved: 0,
    roles: ["Member"],
    status: "active",
    username: "user",
    ...overrides,
  };
}

const admin = userPlan({
  accountId: "11111111-0000-4000-8000-0000000000a1",
  displayName: "Admin",
  eligibility: { reason: "Company Admin: deleted only with an explicit admin confirmation.", state: "PROTECTED" },
  isCompanyAdmin: true,
  roles: ["Company Administrator"],
  username: "admin",
});
const employeeUser = userPlan({ accountId: "11111111-0000-4000-8000-0000000000e1", displayName: "Employee User", username: "employee" });

function plan(overrides: Partial<CompanyDataResetPlan> = {}): CompanyDataResetPlan {
  return {
    blockers: [],
    company: { code: "DEV-ACME", environment: "development", id: companyId, name: "Acme" },
    confirmation: "RESET DEV-ACME",
    effectiveDomains: ["OPERATIONAL"],
    entityLinksRemoved: 0,
    executable: true,
    fiscalCalendar: { fiscalYearsPreserved: 1, fiscalYearsToOpen: 0, periodsPreserved: 12, periodsToOpen: 0 },
    lastReset: null,
    planVersion: `crp1:${"a".repeat(64)}`,
    requiredDependencies: [],
    summary: {
      accountingTransactions: pair(0, 3),
      collections: pair(0, 0),
      companyUsers: pair(0, 2),
      customers: pair(0, 4),
      drivers: pair(0, 1),
      employees: pair(0, 1),
      generalAudit: "PRESERVE",
      globalIdentities: pair(0, 0),
      membershipsDeleted: 0,
      orders: pair(12, 0),
      payrollTransactions: pair(0, 0),
      platformRepairAttempts: "PRESERVE",
      platformRepairExecutions: "PRESERVE",
      protectedAdmins: 1,
      referenceCounters: "PRESERVE",
      roleAssignmentsDeleted: 0,
      settlements: pair(0, 0),
      sharedIdentitiesPreserved: 0,
      traders: pair(0, 2),
    },
    tables: [{ domain: "OPERATIONAL", rows: 12, table: "orders" }],
    users: [admin, employeeUser],
    warnings: [],
    ...overrides,
  };
}

const executionExtras = {
  auditEventId: "99999999-0000-4000-8000-000000000001",
  backupBytes: 1024,
  backupSha256: "b".repeat(64),
  correlationId: "corr-1",
  fiscalYearsOpened: 0,
  periodsOpened: 0,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/companies/${companyId}/data-reset`]}>
      <Routes>
        <Route element={<CompanyDataResetPage />} path="/companies/:companyId/data-reset" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Company Data Reset page", () => {
  afterEach(() => vi.restoreAllMocks());

  it("Operational preset previews with NO user mode, shows delete/keep counts and audit PRESERVE, executes the previewed plan", async () => {
    const preview = vi.spyOn(platformApi, "companyDataResetPreview").mockResolvedValue(plan());
    const execute = vi.spyOn(platformApi, "companyDataResetExecute").mockResolvedValue({
      backupFile: "company-data-reset.dump",
      company: { code: "DEV-ACME", id: companyId, name: "Acme" },
      driversDeleted: 0,
      driversDetached: 0,
      effectiveDomains: ["OPERATIONAL"],
      employeesDeleted: 0,
      employeesDetached: 0,
      entityLinksRemoved: 0,
      identitiesDeleted: 0,
      identitiesPreserved: 0,
      integrityChecks: ["company preserved"],
      planVersion: `crp1:${"a".repeat(64)}`,
      preset: "OPERATIONAL_DATA",
      totalRemoved: 12,
      ...executionExtras,
    });
    renderPage();
    expect(screen.getByTestId("users-kept-note")).toHaveTextContent(/Every user, Employee and Driver is kept/u);
    fireEvent.click(screen.getByRole("button", { name: "Preview reset" }));
    await waitFor(() => expect(preview).toHaveBeenCalledWith(companyId, { preset: "OPERATIONAL_DATA" }));
    const summary = await screen.findByRole("table", { name: "Reset summary" });
    expect(within(summary).getByText("Orders").closest("tr")).toHaveTextContent("Orders120");
    expect(within(summary).getByText("Company users").closest("tr")).toHaveTextContent("Company users02");
    expect(screen.getByTestId("audit-preserved")).toHaveTextContent("PRESERVE");
    const button = screen.getByRole("button", { name: "Execute this reset plan" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Confirmation"), { target: { value: "RESET DEV-ACME" } });
    fireEvent.click(button);
    await screen.findByRole("status", { name: "Reset result" });
    expect(execute).toHaveBeenCalledWith(companyId, {
      confirmation: "RESET DEV-ACME",
      planVersion: `crp1:${"a".repeat(64)}`,
      preset: "OPERATIONAL_DATA",
    });
  });

  it("Delete selected users: lists users first, requires selection and a fresh preview, sends stable ids; admins need explicit confirmation", async () => {
    const preview = vi.spyOn(platformApi, "companyDataResetPreview").mockResolvedValue(plan({ effectiveDomains: [], executable: false }));
    renderPage();
    fireEvent.click(screen.getByLabelText(/Users & workforce/u));
    fireEvent.change(screen.getByLabelText("User mode"), { target: { value: "DELETE_SELECTED_USERS" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview reset" }));
    // Listing only: no selection yet.
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(companyId, { preset: "USERS_WORKFORCE", userMode: "KEEP_ALL_USERS" }));
    expect(await screen.findByTestId("preview-again")).toHaveTextContent(/Select the users to delete/u);
    expect(screen.queryByRole("button", { name: "Execute this reset plan" })).toBeNull();
    expect(screen.getByLabelText("Confirm deleting admin admin")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select employee"));
    preview.mockResolvedValue(
      plan({
        effectiveDomains: [],
        users: [
          admin,
          { ...employeeUser, classification: "ELIGIBLE", employee: { action: "DELETE", historyReferences: [], id: "e1", kind: "employee", name: "Emp", reason: "No history", reference: "EMP-0001" }, identity: { action: "DELETE", references: [] }, remove: true },
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview reset" }));
    await waitFor(() =>
      expect(preview).toHaveBeenLastCalledWith(companyId, {
        preset: "USERS_WORKFORCE",
        selectedAccountIds: [employeeUser.accountId],
        userMode: "DELETE_SELECTED_USERS",
      }),
    );
    const users = await screen.findByRole("table", { name: "Company users" });
    expect(within(users).getByText("EMP-0001: DELETE")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Execute this reset plan" })).toBeInTheDocument();
  });

  it("a blocked plan shows its blocked dependencies and offers no execute", async () => {
    vi.spyOn(platformApi, "companyDataResetPreview").mockResolvedValue(
      plan({ blockers: ["Driver login 'drv' would remain without Driver DRV-0001"], executable: false }),
    );
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Preview reset" }));
    expect(await screen.findByRole("list", { name: "Blockers" })).toHaveTextContent(/would remain without Driver/u);
    expect(screen.getByTestId("not-executable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Execute this reset plan" })).toBeNull();
  });

  it("a stale plan at execution asks for a new preview; a failure says nothing was changed", async () => {
    vi.spyOn(platformApi, "companyDataResetPreview").mockResolvedValue(plan());
    const execute = vi
      .spyOn(platformApi, "companyDataResetExecute")
      .mockRejectedValueOnce(new PlatformApiError("The Company changed after the reset preview.", "reset_plan_stale", 409));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Preview reset" }));
    await screen.findByRole("table", { name: "Reset summary" });
    fireEvent.change(screen.getByLabelText("Confirmation"), { target: { value: "RESET DEV-ACME" } });
    fireEvent.click(screen.getByRole("button", { name: "Execute this reset plan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Company data changed after Preview. Run Preview again. Nothing was changed.");
    expect(screen.queryByRole("table", { name: "Reset summary" })).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("Full preset sends explicit traders/customers, workforce and user choices", async () => {
    const preview = vi.spyOn(platformApi, "companyDataResetPreview").mockResolvedValue(plan());
    renderPage();
    fireEvent.click(screen.getByLabelText(/Full Company data/u));
    fireEvent.change(screen.getByLabelText("Workforce"), { target: { value: "RESET" } });
    fireEvent.change(screen.getByLabelText("User mode"), { target: { value: "DELETE_ALL_ELIGIBLE_USERS" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview reset" }));
    await waitFor(() =>
      expect(preview).toHaveBeenCalledWith(companyId, {
        preset: "FULL_COMPANY_DATA_KEEP_COMPANY",
        tradersCustomers: "KEEP",
        userMode: "DELETE_ALL_ELIGIBLE_USERS",
        workforce: "RESET",
      }),
    );
  });

  // ---------------------------------------------------------------- Prompt 3

  it("PRESETS: offers Operational, Financial, Users & workforce, Traders & customers, Full (keep Company) and Custom, with no table names", () => {
    renderPage();
    for (const label of [/^Operational data/u, /^Financial data/u, /^Users & workforce/u, /^Traders & customers/u, /^Full Company data/u, /^Custom/u]) {
      expect(screen.getAllByRole("radio").some((radio) => label.test((radio.closest("label")?.textContent ?? "").trim()))).toBe(true);
    }
    expect(screen.queryByText(/trader_collections|journal_entries|_id\b/u)).toBeNull();
  });

  it("Traders & customers sends CUSTOM + TRADERS_CUSTOMERS (users kept) and lists the required dependencies before anything runs", async () => {
    const preview = vi.spyOn(platformApi, "companyDataResetPreview").mockResolvedValue(
      plan({
        effectiveDomains: ["OPERATIONAL", "FINANCIAL", "TRADERS_CUSTOMERS"],
        requiredDependencies: [
          { domain: "OPERATIONAL", reason: "Orders reference the Traders being removed." },
          { domain: "FINANCIAL", reason: "Settlements reference the Traders being removed." },
        ],
      }),
    );
    renderPage();
    fireEvent.click(screen.getAllByRole("radio").find((radio) => /^Traders & customers/u.test((radio.closest("label")?.textContent ?? "").trim()))!);
    expect(screen.getByTestId("users-kept-note")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview reset" }));
    await waitFor(() => expect(preview).toHaveBeenCalledWith(companyId, { domains: ["TRADERS_CUSTOMERS"], preset: "CUSTOM" }));
    const dependencies = await screen.findByRole("list", { name: "Required dependencies" });
    expect(dependencies).toHaveTextContent(/Operational.*Orders reference/u);
    expect(dependencies).toHaveTextContent(/Financial.*Settlements reference/u);
    expect(screen.getByTestId("effective-domains")).toHaveTextContent("Operational, Financial, Traders & customers");
  });

  it("USERS: shows role, Employee / Driver association and Eligible / Protected state; a protected admin is never an ordinary selection", async () => {
    const driverUser = userPlan({
      accountId: "11111111-0000-4000-8000-0000000000d1",
      accountKind: "driver",
      displayName: "Driver User",
      driver: { action: "KEEP", historyReferences: [], id: "d1", kind: "driver", name: "Driver One", reason: "Kept", reference: "DRV-0001" },
      roles: [],
      username: "driver",
    });
    const preview = vi.spyOn(platformApi, "companyDataResetPreview").mockResolvedValue(plan({ users: [admin, employeeUser, driverUser] }));
    renderPage();
    fireEvent.click(screen.getByLabelText(/Users & workforce/u));
    fireEvent.change(screen.getByLabelText("User mode"), { target: { value: "DELETE_SELECTED_USERS" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview reset" }));
    const users = await screen.findByRole("table", { name: "Company users" });
    const adminRow = within(users).getByText("Admin").closest("tr")!;
    expect(adminRow).toHaveTextContent("Company Administrator");
    expect(adminRow).toHaveTextContent("Protected");
    expect(within(adminRow).queryByLabelText("Select admin")).toBeNull();
    expect(within(adminRow).getByLabelText("Confirm deleting admin admin")).toBeInTheDocument();
    const driverRow = within(users).getByText("Driver User").closest("tr")!;
    expect(driverRow).toHaveTextContent("DRV-0001: KEEP");
    expect(driverRow).toHaveTextContent("Driver login");
    expect(driverRow).toHaveTextContent("Eligible");
    // Explicit protected-admin deletion selects AND confirms it in one control.
    fireEvent.click(within(adminRow).getByLabelText("Confirm deleting admin admin"));
    fireEvent.click(screen.getByRole("button", { name: "Preview reset" }));
    await waitFor(() =>
      expect(preview).toHaveBeenLastCalledWith(companyId, {
        deleteAdminAccountIds: [admin.accountId],
        preset: "USERS_WORKFORCE",
        selectedAccountIds: [admin.accountId],
        userMode: "DELETE_SELECTED_USERS",
      }),
    );
  });

  it("ROLLBACK UX: an execution failure says it was rolled back and nothing changed -- never success", async () => {
    vi.spyOn(platformApi, "companyDataResetPreview").mockResolvedValue(plan());
    vi.spyOn(platformApi, "companyDataResetExecute").mockRejectedValue(
      new PlatformApiError("Post-reset integrity check failed. Nothing was changed.", "reset_integrity_failed", 409),
    );
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Preview reset" }));
    await screen.findByRole("table", { name: "Reset summary" });
    fireEvent.change(screen.getByLabelText("Confirmation"), { target: { value: "RESET DEV-ACME" } });
    fireEvent.click(screen.getByRole("button", { name: "Execute this reset plan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Reset failed and was rolled back — nothing was changed/u);
    expect(screen.queryByRole("status", { name: "Reset result" })).toBeNull();
    expect(screen.queryByText("Reset completed")).toBeNull();
  });

  it("BLOCKED at execution (direct refusal) is explained and the plan must be previewed again", async () => {
    vi.spyOn(platformApi, "companyDataResetPreview").mockResolvedValue(plan());
    vi.spyOn(platformApi, "companyDataResetExecute").mockRejectedValue(new PlatformApiError("The reset plan is blocked.", "reset_plan_blocked", 409));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Preview reset" }));
    await screen.findByRole("table", { name: "Reset summary" });
    fireEvent.change(screen.getByLabelText("Confirmation"), { target: { value: "RESET DEV-ACME" } });
    fireEvent.click(screen.getByRole("button", { name: "Execute this reset plan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/This plan is blocked and was not executed. Nothing was changed./u);
    expect(screen.queryByRole("button", { name: "Execute this reset plan" })).toBeNull();
  });

  it("DOUBLE SUBMIT: a double click sends ONE execution", async () => {
    vi.spyOn(platformApi, "companyDataResetPreview").mockResolvedValue(plan());
    let finish: (value: never) => void = () => undefined;
    const execute = vi.spyOn(platformApi, "companyDataResetExecute").mockImplementation(
      () => new Promise((resolve) => { finish = resolve as (value: never) => void; }),
    );
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Preview reset" }));
    await screen.findByRole("table", { name: "Reset summary" });
    fireEvent.change(screen.getByLabelText("Confirmation"), { target: { value: "RESET DEV-ACME" } });
    const button = screen.getByRole("button", { name: "Execute this reset plan" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(execute).toHaveBeenCalledTimes(1);
    finish(undefined as never);
  });

  it("RESULT: shows the audit event, correlation reference and backup checksum, then re-previews the Company's current state", async () => {
    const preview = vi.spyOn(platformApi, "companyDataResetPreview").mockResolvedValue(plan());
    vi.spyOn(platformApi, "companyDataResetExecute").mockResolvedValue({
      backupFile: "company-data-reset-x.dump",
      company: { code: "DEV-ACME", id: companyId, name: "Acme" },
      driversDeleted: 0,
      driversDetached: 0,
      effectiveDomains: ["OPERATIONAL"],
      employeesDeleted: 0,
      employeesDetached: 0,
      entityLinksRemoved: 0,
      identitiesDeleted: 0,
      identitiesPreserved: 0,
      integrityChecks: ["company preserved", "users kept"],
      planVersion: `crp1:${"a".repeat(64)}`,
      preset: "OPERATIONAL_DATA",
      totalRemoved: 12,
      ...executionExtras,
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Preview reset" }));
    await screen.findByRole("table", { name: "Reset summary" });
    expect(screen.getByTestId("reference-counters")).toHaveTextContent("PRESERVE");
    expect(screen.getByTestId("plan-reference")).toHaveTextContent("no previous reset");
    fireEvent.change(screen.getByLabelText("Confirmation"), { target: { value: "RESET DEV-ACME" } });
    fireEvent.click(screen.getByRole("button", { name: "Execute this reset plan" }));
    await screen.findByRole("status", { name: "Reset result" });
    expect(screen.getByTestId("result-audit")).toHaveTextContent(`Audit event ${executionExtras.auditEventId} · reference corr-1`);
    expect(screen.getByTestId("result-backup")).toHaveTextContent(`sha256 ${"b".repeat(16)}`);
    preview.mockResolvedValue(plan({ lastReset: { at: "2026-10-03 10:00:00+00", auditEventId: executionExtras.auditEventId } }));
    fireEvent.click(screen.getByRole("button", { name: "Preview the Company's current state" }));
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith(companyId, { preset: "OPERATIONAL_DATA" }));
    expect(await screen.findByTestId("plan-reference")).toHaveTextContent(`last reset 2026-10-03 10:00:00+00 (audit ${executionExtras.auditEventId})`);
  });

  it("UNKNOWN OUTCOME: a timeout never claims success or rollback; it says the outcome is unknown and to Preview instead of executing again", async () => {
    vi.spyOn(platformApi, "companyDataResetPreview").mockResolvedValue(plan());
    vi.spyOn(platformApi, "companyDataResetExecute").mockRejectedValue(new PlatformApiError("The request timed out.", "request_timeout", 0));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Preview reset" }));
    await screen.findByRole("table", { name: "Reset summary" });
    fireEvent.change(screen.getByLabelText("Confirmation"), { target: { value: "RESET DEV-ACME" } });
    fireEvent.click(screen.getByRole("button", { name: "Execute this reset plan" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/outcome is unknown. Do not execute again: run Preview/u);
    expect(alert).not.toHaveTextContent(/nothing was changed|rolled back/iu);
    expect(screen.queryByRole("button", { name: "Execute this reset plan" })).toBeNull();
  });
});
