import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import type { RouteFeedbackReport } from "./RouteFeedbackSection.js";
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
      suggestion: null,
      suggestionRejected: false,
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
      suggestion: null,
      suggestionRejected: false,
    },
  ],
  branch: null,
  companyEnabled: false,
  enabled: false,
  flaggedSuggestionCount: 0,
  geocoderConfigured: true,
  openSuggestionCount: 0,
  platformEnabled: true,
  provider: "area_matrix",
  verifiedAreaCount: 1,
});

const emptyFeedback: RouteFeedbackReport = {
  days: 30,
  dislikeCount: 0,
  flaggedAreas: [],
  likeCount: 0,
  reasons: [],
  rows: [],
  runCount: 0,
};

function setup(
  initial: RouteSetup = base(),
  feedback: RouteFeedbackReport = emptyFeedback,
  post: (path: string) => Promise<unknown> = () => Promise.resolve(initial),
) {
  const api = {
    delete: vi.fn(() => Promise.resolve(initial)),
    get: vi.fn((path: string) =>
      Promise.resolve(path.endsWith("/feedback") ? feedback : initial),
    ),
    post: vi.fn(post),
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

  it("asks Google in batches until every Area has a suggestion, then accepts only clean ones", async () => {
    const suggested: RouteSetup = {
      ...base(),
      flaggedSuggestionCount: 0,
      openSuggestionCount: 1,
      areas: base().areas.map((area) =>
        area.id === "a1"
          ? {
              ...area,
              suggestion: {
                createdAt: "2026-10-25T10:00:00Z",
                flag: null,
                formattedAddress: "Al Majaz - Sharjah - United Arab Emirates",
                latitude: 25.3262,
                longitude: 55.3834,
              },
            }
          : area,
      ),
    };
    let rounds = 0;
    const { api } = setup(base(), emptyFeedback, (path) => {
      if (path.endsWith("/suggestions")) {
        rounds += 1;
        return Promise.resolve({
          flagged: 0,
          looked: 1,
          notFound: 0,
          remaining: rounds === 1 ? 1 : 0,
          setup: suggested,
          stopped: null,
        });
      }
      return Promise.resolve({ accepted: 1, setup: { ...base(), verifiedAreaCount: 2 } });
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Suggest pins for Areas without one" }),
    );
    expect(await screen.findByText(/Google looked up 2 Areas/)).toBeTruthy();
    expect(rounds).toBe(2);
    expect(screen.getByText("Suggested")).toBeTruthy();
    expect(screen.getByText("Al Majaz - Sharjah - United Arab Emirates")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept all without a warning (1)" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("configuration/route-planning/suggestions/accept-clean"),
    );
    expect(await screen.findByText("1 suggested pins accepted.")).toBeTruthy();
  });

  it("shows a warning on a doubtful suggestion and lets it be accepted or rejected one by one", async () => {
    const flagged: RouteSetup = {
      ...base(),
      flaggedSuggestionCount: 1,
      openSuggestionCount: 1,
      areas: base().areas.map((area) =>
        area.id === "a1"
          ? {
              ...area,
              suggestion: {
                createdAt: "2026-10-25T10:00:00Z",
                flag: "outside_emirate",
                formattedAddress: null,
                latitude: 25.2,
                longitude: 55.27,
              },
            }
          : area,
      ),
    };
    const { api } = setup(flagged);
    expect(await screen.findByText("Outside its Emirate")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Accept all without a warning/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("configuration/route-planning/areas/a1/suggestion/reject"),
    );
  });

  it("says when the Google key is missing", async () => {
    setup({ ...base(), geocoderConfigured: false });
    expect(await screen.findByText(/Google Maps key is not set/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Suggest pins for Areas without one" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows Driver feedback with the planned and the delivered order", async () => {
    setup(base(), {
      ...emptyFeedback,
      dislikeCount: 1,
      flaggedAreas: [{ areaId: "a1", count: 1, nameAr: "المجاز", nameEn: "Al Majaz" }],
      reasons: [{ count: 1, reason: "wrong_order" }],
      rows: [
        {
          actualAreas: [
            { areaId: "a2", nameAr: null, nameEn: "Al Nuaimiya" },
            { areaId: "a1", nameAr: null, nameEn: "Al Majaz" },
          ],
          businessDate: "2026-10-25",
          comment: "Started too far",
          direction: "recommended",
          driverNameAr: null,
          driverNameEn: "Driver 14",
          flaggedAreas: [],
          plannedAreas: [
            { areaId: "a1", nameAr: null, nameEn: "Al Majaz" },
            { areaId: "a2", nameAr: null, nameEn: "Al Nuaimiya" },
          ],
          rating: "dislike",
          reason: "wrong_order",
          referenceNumber: "RUN-000003",
          runId: "r1",
          updatedAt: "2026-10-25T12:00:00Z",
        },
      ],
      runCount: 4,
    });
    expect((await screen.findByTestId("route-feedback-summary")).textContent).toContain(
      "4 routes planned",
    );
    expect(screen.getByText("Al Majaz → Al Nuaimiya")).toBeTruthy();
    expect(screen.getByText("Al Nuaimiya → Al Majaz")).toBeTruthy();
    expect(screen.getByText("“Started too far”")).toBeTruthy();
  });

  it("renders in Arabic", async () => {
    await i18nInstance.changeLanguage("ar");
    setup();
    expect(await screen.findByText("المجاز")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "تخطيط المسارات" })).toBeTruthy();
  });
});
