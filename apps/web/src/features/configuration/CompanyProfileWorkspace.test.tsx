import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import type { CompanyBranding, CompanyProfile } from "../../api/contracts.js";
import { CompanyBrandingProvider } from "../../app/CompanyBrandingContext.js";
import { i18nInstance } from "../../localization/i18n.js";
import { CompanyProfileWorkspace } from "./CompanyProfileWorkspace.js";

function baseProfile(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    logo: null,
    nameAr: "شركة أكمي",
    nameEn: "Acme Logistics",
    subtitleAr: null,
    subtitleEn: null,
    telephone: "+971 4 000 0000",
    ...overrides,
  };
}

function baseBranding(overrides: Partial<CompanyBranding> = {}): CompanyBranding {
  return {
    dataQuality: { nameArMissing: false, subtitleArMissing: false, subtitleEnMissing: false },
    hasLogo: false,
    logoFileId: null,
    nameAr: "شركة أكمي",
    nameEn: "Acme Logistics",
    subtitleAr: null,
    subtitleEn: null,
    telephone: "+971 4 000 0000",
    ...overrides,
  };
}

function makeApi(profile: CompanyProfile, branding: CompanyBranding) {
  return {
    delete: vi.fn().mockResolvedValue(profile),
    get: vi.fn((path: string) => {
      if (path === "company-profile") return Promise.resolve(profile);
      if (path === "company-profile/branding") return Promise.resolve(branding);
      if (path === "me/preferences") return Promise.resolve({ textLanguage: "en" });
      return Promise.reject(new Error(`unexpected get ${path}`));
    }),
    getBinary: vi.fn().mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])])),
    patch: vi.fn().mockResolvedValue(profile),
    post: vi.fn(),
    postMultipart: vi.fn().mockResolvedValue(profile),
    put: vi.fn(),
    setAccessToken: vi.fn(),
  };
}

function renderPage(api: ReturnType<typeof makeApi>) {
  return render(
    <CompanyBrandingProvider api={api as unknown as ApiClient}>
      <CompanyProfileWorkspace api={api as unknown as ApiClient} />
    </CompanyBrandingProvider>,
  );
}

describe("CompanyProfileWorkspace", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:mock" });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
  });

  it("loads the profile and saves English and Arabic names and telephone (trimmed)", async () => {
    const api = makeApi(baseProfile(), baseBranding());
    renderPage(api);

    const nameEn = await screen.findByLabelText("Company name (English)");
    fireEvent.change(nameEn, { target: { value: "  New Company  " } });
    fireEvent.change(screen.getByLabelText("Company name (Arabic)"), {
      target: { value: "شركة جديدة" },
    });
    fireEvent.change(screen.getByLabelText("Telephone number"), {
      target: { value: " +971 4 012 3456 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith(
      "company-profile",
      expect.objectContaining({
        nameAr: "شركة جديدة",
        nameEn: "New Company",
        subtitleAr: undefined,
        subtitleEn: undefined,
        telephone: "+971 4 012 3456",
      }),
    );
    expect(await screen.findByText("Company profile saved.")).toBeInTheDocument();
  });

  it("uploads a PNG logo via multipart", async () => {
    const api = makeApi(baseProfile(), baseBranding());
    renderPage(api);
    await screen.findByLabelText("Company name (English)");

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByLabelText("Choose a logo file"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload logo" }));

    await waitFor(() => expect(api.postMultipart).toHaveBeenCalledTimes(1));
    const [path, form] = api.postMultipart.mock.calls[0] ?? [];
    expect(path).toBe("company-profile/logo");
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).get("file")).toBeInstanceOf(File);
  });

  it("accepts a JPEG logo", async () => {
    const api = makeApi(baseProfile(), baseBranding());
    renderPage(api);
    await screen.findByLabelText("Company name (English)");
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "logo.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByLabelText("Choose a logo file"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload logo" }));
    await waitFor(() => expect(api.postMultipart).toHaveBeenCalledTimes(1));
  });

  it("rejects a non-image file and an oversize file without uploading", async () => {
    const api = makeApi(baseProfile(), baseBranding());
    renderPage(api);
    await screen.findByLabelText("Company name (English)");
    const input = screen.getByLabelText("Choose a logo file");

    const script = new File(["<script>"], "evil.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [script] } });
    expect(screen.getByText("Only PNG or JPEG images are allowed.")).toBeInTheDocument();

    const huge = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [huge] } });
    expect(screen.getByText("The logo must be 2 MB or smaller.")).toBeInTheDocument();

    expect(api.postMultipart).not.toHaveBeenCalled();
  });

  it("shows Replace and Remove when a logo exists and can remove it", async () => {
    const api = makeApi(
      baseProfile({
        logo: {
          fileId: "f1",
          mediaType: "image/png",
          originalFilename: "logo.png",
          sizeBytes: 1024,
          updatedAt: "2026-07-27T00:00:00.000Z",
        },
      }),
      baseBranding({ hasLogo: true, logoFileId: "f1" }),
    );
    renderPage(api);
    await screen.findByLabelText("Company name (English)");

    expect(screen.getByRole("button", { name: "Replace logo" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove logo" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("company-profile/logo"));
  });

  it("shows placeholder initials when no logo is set", async () => {
    const api = makeApi(baseProfile(), baseBranding());
    renderPage(api);
    await screen.findByLabelText("Company name (English)");
    // "Acme Logistics" -> "AL"
    expect(screen.getByText("AL")).toBeInTheDocument();
  });
});
