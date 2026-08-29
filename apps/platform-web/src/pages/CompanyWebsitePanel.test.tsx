import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PlatformApiError, platformApi } from "../api/platform-client.js";
import { CompanyWebsitePanel } from "./CompanyWebsitePanel.js";

vi.mock("../app/PlatformSession.js", () => ({
  usePlatformSession: () => ({
    can: (code: string) => code === "platform.company_websites.manage",
  }),
}));

describe("CompanyWebsitePanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  it("configures a not-configured website with the Company slug", async () => {
    vi.spyOn(platformApi, "companyWebsite").mockResolvedValue({ status: "not_configured" });
    vi.spyOn(platformApi, "configureCompanyWebsite").mockResolvedValue({
      status: "draft",
      slug: "dana",
      websiteUrl: "https://dana.tawseelhub.com",
      version: 1,
    });
    render(<CompanyWebsitePanel companyId="company-a" suggestedSlug="dana" />);
    fireEvent.click(await screen.findByRole("button", { name: "Configure Website" }));
    expect(screen.getByDisplayValue("dana")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save and Continue" }));
    await waitFor(() =>
      expect(platformApi.configureCompanyWebsite).toHaveBeenCalledWith(
        "company-a",
        expect.objectContaining({ slug: "dana", templateKey: "corporate", expectedVersion: 0 }),
      ),
    );
  });
  it("shows only valid published lifecycle actions", async () => {
    vi.spyOn(platformApi, "companyWebsite").mockResolvedValue({
      status: "published",
      slug: "dana",
      enabled: true,
      published: true,
      templateKey: "modern",
      publishedTemplateKey: "corporate",
      hasUnpublishedChanges: true,
      version: 4,
    });
    render(<CompanyWebsitePanel companyId="company-a" suggestedSlug="dana" />);
    expect(await screen.findByRole("button", { name: "Disable Website" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable Website" })).not.toBeInTheDocument();
    expect(screen.getByText("Unpublished changes")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Preview" })).toHaveLength(20);
  });

  it("shows a conflict and reloads instead of silently retrying", async () => {
    const read = vi
      .spyOn(platformApi, "companyWebsite")
      .mockResolvedValueOnce({
        status: "draft",
        slug: "dana",
        templateKey: "corporate",
        version: 5,
      })
      .mockResolvedValueOnce({
        status: "draft",
        slug: "dana-new",
        templateKey: "modern",
        version: 6,
      });
    const configure = vi
      .spyOn(platformApi, "configureCompanyWebsite")
      .mockRejectedValue(new PlatformApiError("conflict", "website_version_conflict", 409));
    render(<CompanyWebsitePanel companyId="company-a" suggestedSlug="dana" />);
    const selectButtons = await screen.findAllByRole("button", { name: "Select" });
    fireEvent.click(selectButtons[1]!);
    expect(await screen.findByText(/changed by another administrator/i)).toBeInTheDocument();
    expect(configure).toHaveBeenCalledWith(
      "company-a",
      expect.objectContaining({ expectedVersion: 5, templateKey: "modern" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload Latest" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(configure).toHaveBeenCalledTimes(1);
  });

  it("previews a template without selecting or publishing it", async () => {
    vi.spyOn(platformApi, "companyWebsite").mockResolvedValue({
      status: "draft",
      slug: "dana",
      templateKey: "corporate",
    });
    const open = vi.spyOn(globalThis, "open").mockImplementation(() => null);
    const configure = vi.spyOn(platformApi, "configureCompanyWebsite");
    const publish = vi.spyOn(platformApi, "companyWebsiteAction");
    render(<CompanyWebsitePanel companyId="company-a" suggestedSlug="dana" />);
    const buttons = await screen.findAllByRole("button", { name: "Preview" });
    fireEvent.click(buttons[4]!);
    expect(open).toHaveBeenCalledWith(
      "/companies/company-a/website/preview/premium",
      "_blank",
      "noopener,noreferrer",
    );
    expect(configure).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
