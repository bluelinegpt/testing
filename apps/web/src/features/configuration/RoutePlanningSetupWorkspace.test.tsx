import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { type RouteSetup, RoutePlanningSetupWorkspace } from "./RoutePlanningSetupWorkspace.js";

const base = (): RouteSetup => ({
  areaCount: 2,
  areas: [
    {
      code: "AREA-000001",
      coordinatesVerifiedAt: null,
      coordinatesVerifiedBy: null,
      emirateId: "shj",
      emirateNameAr: "الشارقة",
      emirateNameEn: "Sharjah",
      id: "a1",
      latitude: null,
      longitude: null,
      nameAr: "المجاز",
      nameEn: "Al Majaz",
    },
    {
      code: "AREA-000002",
      coordinatesVerifiedAt: "2026-10-10T08:00:00Z",
      coordinatesVerifiedBy: "aiman",
      emirateId: "ajm",
      emirateNameAr: "عجمان",
      emirateNameEn: "Ajman",
      id: "a2",
      latitude: 25.392,
      longitude: 55.453,
      nameAr: "النعيمية",
      nameEn: "Al Nuaimiya",
    },
  ],
  branch: null,
  companyEnabled: false,
  enabled: false,
  platformEnabled: true,
  provider: "area_matrix",
  verifiedAreaCount: 1,
});

function setup(initial: RouteSetup = base()) {
  const api = {
    delete: vi.fn(() => Promise.resolve(initial)),
    get: vi.fn().mockResolvedValue(initial),
    put: vi.fn((path: string, body: { latitude: number; longitude: number }) =>
      Promise.resolve(
        path.endsWith("/branch")
          ? { ...initial, branch: body }
          : {
              ...initial,
              areas: initial.areas.map((area) =>
                path.includes(`/areas/${area.id}/`)
                  ? {
                      ...area,
                      ...body,
                      coordinatesVerifiedAt: "2026-10-10T09:00:00Z",
                      coordinatesVerifiedBy: "admin",
                    }
                  : area,
              ),
              verifiedAreaCount: initial.verifiedAreaCount + 1,
            },
      ),
    ),
  };
  render(<RoutePlanningSetupWorkspace api={api as unknown as ApiClient} />);
  return { api };
}

describe("RoutePlanningSetupWorkspace", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
  });

  it("shows the read-only status and pin progress", async () => {
    setup();
    expect(await screen.findByText(/not switched on for your company yet/)).toBeTruthy();
    expect(screen.getByTestId("route-pin-progress").textContent).toContain("1 of 2 Areas pinned");
    expect(screen.getByText("No pin")).toBeTruthy();
  });

  it("saves a pin pasted as a Google Maps link", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Set pin" }));
    fireEvent.change(screen.getByLabelText("Google Maps link or coordinates"), {
      target: {
        value: "https://www.google.com/maps/place/x/@25.3,55.3,15z/data=!3d25.3262!4d55.3834",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("configuration/route-planning/areas/a1/coordinates", {
        latitude: 25.3262,
        longitude: 55.3834,
      }),
    );
    expect(await screen.findByText("Pin saved for Al Majaz.")).toBeTruthy();
  });

  it("refuses an unreadable short link without calling the API", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Set pin" }));
    fireEvent.change(screen.getByLabelText("Google Maps link or coordinates"), {
      target: { value: "https://maps.app.goo.gl/abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("filters to Areas without a pin and saves the branch from typed coordinates", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByLabelText("Only Areas without a pin"));
    expect(screen.queryByText("Al Nuaimiya")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set branch location" }));
    fireEvent.change(
      screen.getAllByLabelText("Google Maps link or coordinates")[0] as HTMLElement,
      {
        target: { value: "25.27, 55.38" },
      },
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0] as HTMLElement);
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("configuration/route-planning/branch", {
        latitude: 25.27,
        longitude: 55.38,
      }),
    );
  });

  it("renders in Arabic", async () => {
    await i18nInstance.changeLanguage("ar");
    setup();
    expect(await screen.findByText("المجاز")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "تخطيط المسارات" })).toBeTruthy();
  });
});
