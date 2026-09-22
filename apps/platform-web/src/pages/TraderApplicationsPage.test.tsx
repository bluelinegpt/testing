// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({
  api: {
    deleteTraderApplications: vi.fn(),
    traderApplications: vi.fn(),
  },
}));

vi.mock("../api/platform-client.js", () => ({ platformApi: api }));
vi.mock("../app/PlatformSession.js", () => ({
  usePlatformSession: () => ({ can: () => true }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderPage() {
  const { TraderApplicationsPage } = await import("./TraderApplicationsPage.js");
  render(
    <MemoryRouter>
      <TraderApplicationsPage />
    </MemoryRouter>,
  );
}

describe("Trader Applications page", () => {
  it("finishes loading and shows the API error with a retry action", async () => {
    api.traderApplications.mockRejectedValueOnce(
      new Error("Request validation failed. page must be an integer number"),
    );

    await renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("page must be an integer number");
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("renders an explicit empty state", async () => {
    api.traderApplications.mockResolvedValueOnce({ items: [], page: 1, pageSize: 25, total: 0 });

    await renderPage();

    expect(await screen.findByText("No applications found.")).toBeVisible();
    expect(screen.getByText("0 applications")).toBeVisible();
  });

  it("sends search, status and Delivery Company filters", async () => {
    api.traderApplications.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0 });
    await renderPage();
    await screen.findByText("No applications found.");

    fireEvent.change(screen.getByPlaceholderText("Reference, store, contact, mobile or email"), {
      target: { value: "TRD-APP-000001" },
    });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "reviewing" } });
    fireEvent.change(screen.getByLabelText("Delivery Company"), { target: { value: "false" } });

    await waitFor(() =>
      expect(api.traderApplications).toHaveBeenLastCalledWith({
        search: "TRD-APP-000001",
        status: "reviewing",
        requiresDeliveryCompany: "false",
        page: 1,
      }),
    );
  });
});
