import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll } from "vitest";

import { DeploymentRegistryPage } from "./DeploymentRegistryPage.js";

/**
 * Platform Administration's Deployment Registry.
 *
 * Data is bundled from `Documentation/deployment-registry.json` via
 * `__DEPLOYMENT_REGISTRY__` (see `vite.config.ts`), not fetched -- it
 * describes the codebase itself, not Company data. Stubbed here the same way
 * `apps/web`'s equivalent screen would be, since this global only exists
 * once Vite's `define` has run.
 */
declare global {
  var __DEPLOYMENT_REGISTRY__: unknown;
}

beforeAll(() => {
  globalThis.__DEPLOYMENT_REGISTRY__ = {
    apps: [
      {
        confirmedLiveAt: null,
        confirmedLiveCommit: null,
        displayName: "API",
        id: "api",
        lastChangeBy: "claude",
        lastChangeDescription: "fix(api): stop type-only imports from erasing DTO validation",
        localCommit: "fc1bfa4",
        localCommitDate: "2026-08-12",
        path: "apps/api",
        renderService: "bluelinegpt-api-test",
        status: "pushed_awaiting_confirmation",
      },
      {
        confirmedLiveAt: null,
        confirmedLiveCommit: null,
        displayName: "Store",
        id: "store",
        lastChangeBy: "human",
        lastChangeDescription: "BluelineGPT checkpoint before GitHub testing deployment",
        localCommit: "b19889c",
        localCommitDate: "2026-08-09",
        path: "apps/store",
        renderService: null,
        status: "pushed_awaiting_confirmation",
      },
    ],
  };
});

describe("DeploymentRegistryPage", () => {
  it("renders one row per app tracked in the registry", () => {
    render(<DeploymentRegistryPage />);
    const table = screen.getByRole("table");
    expect(within(table).getByText("API")).toBeInTheDocument();
    expect(within(table).getByText("Store")).toBeInTheDocument();
  });

  it("narrows rows by application", () => {
    render(<DeploymentRegistryPage />);
    fireEvent.change(screen.getByLabelText("Application"), { target: { value: "api" } });
    const table = screen.getByRole("table");
    expect(within(table).getByText("API")).toBeInTheDocument();
    expect(within(table).queryByText("Store")).not.toBeInTheDocument();
  });

  it("narrows rows by a search term matching the commit or description", () => {
    render(<DeploymentRegistryPage />);
    fireEvent.change(screen.getByPlaceholderText("Application, commit, or description"), {
      target: { value: "fc1bfa4" },
    });
    const table = screen.getByRole("table");
    expect(within(table).getByText("API")).toBeInTheDocument();
    expect(within(table).queryByText("Store")).not.toBeInTheDocument();
  });

  it("shows an empty state when a status filter matches nothing yet confirmed", () => {
    render(<DeploymentRegistryPage />);
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "confirmed_live" },
    });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("No apps match these filters.")).toBeInTheDocument();
  });
});
