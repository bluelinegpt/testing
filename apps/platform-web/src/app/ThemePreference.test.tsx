import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { App } from "../App.js";
import {
  THEME_STORAGE_KEY,
  applyResolvedTheme,
  readStoredPreference,
  resolveThemePreference,
  writeStoredPreference,
} from "../theme/theme-preference.js";
import { PlatformSessionProvider } from "./PlatformSession.js";

const permissions = ["platform.access", "platform.companies.read"];

function stubFetch(): typeof fetch {
  return vi.fn(
    (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const body = url.includes("platform/auth/me")
        ? {
            accountId: "6f1d0d5e-1c1b-4a2f-9f4e-2f9b7a5c1d33",
            username: "platform.admin",
            displayName: "platform.admin",
            kind: "platform_administrator",
            companyId: null,
            permissions,
            roles: ["platform_super_admin"],
          }
        : { items: [], total: 0, page: 1, pageSize: 25 };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );
    },
  ) as unknown as typeof fetch;
}

/**
 * A `matchMedia` that reports the given dark preference and records listeners.
 *
 * `removeEventListener` genuinely removes, because a no-op version would keep
 * firing listeners the component had already cleaned up — the test would then
 * fail on behaviour the component gets right, and would pass if the component
 * ever stopped cleaning up.
 *
 * Listeners live outside the stub so a later `stubMatchMedia` call — used to
 * simulate the OS flipping — changes what `matches` reports without losing the
 * subscription that was made against the earlier one.
 */
const mediaListeners: (() => void)[] = [];

function stubMatchMedia(dark: boolean): { fire: () => void } {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: dark && query.includes("dark"),
      media: query,
      addEventListener: (_: string, handler: () => void) => {
        mediaListeners.push(handler);
      },
      removeEventListener: (_: string, handler: () => void) => {
        const at = mediaListeners.indexOf(handler);
        if (at >= 0) mediaListeners.splice(at, 1);
      },
    })),
  );
  return {
    fire: () => {
      for (const handler of [...mediaListeners]) handler();
    },
  };
}

beforeEach(() => {
  mediaListeners.length = 0;
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Theme preference storage", () => {
  it("defaults to light when nothing is stored", () => {
    expect(readStoredPreference()).toBe("light");
  });

  it("round-trips a stored preference", () => {
    writeStoredPreference("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(readStoredPreference()).toBe("dark");
  });

  /**
   * Anything else in that key is untrusted input — a stale value from an older
   * build, or something a user typed into devtools. It must not reach the DOM.
   */
  it("ignores a stored value that is not one of the three choices", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "midnight");
    expect(readStoredPreference()).toBe("light");
  });

  /** Storage throws in private browsing. A theme must not break the Portal. */
  it("survives storage being unavailable", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredPreference(throwing)).toBe("light");
    expect(() => writeStoredPreference("dark", throwing)).not.toThrow();
  });

  /**
   * The PREFERENCE is stored, not the resolved theme. Storing "dark" for a
   * system-following administrator would freeze them on whatever their OS
   * happened to be on their first visit.
   */
  it("stores the preference, never the resolved value", () => {
    stubMatchMedia(true);
    writeStoredPreference("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("stores nothing except the theme key", () => {
    writeStoredPreference("light");
    expect(Object.keys(localStorage)).toEqual([THEME_STORAGE_KEY]);
  });
});

describe("Theme resolution", () => {
  it("resolves an explicit choice to itself", () => {
    expect(resolveThemePreference("dark")).toBe("dark");
    expect(resolveThemePreference("light")).toBe("light");
  });

  it("resolves system from the OS preference", () => {
    stubMatchMedia(true);
    expect(resolveThemePreference("system")).toBe("dark");
    stubMatchMedia(false);
    expect(resolveThemePreference("system")).toBe("light");
  });

  /** A host with no `matchMedia` is not a dark host. */
  it("treats a missing media query as light", () => {
    expect(resolveThemePreference("system", {} as Window)).toBe("light");
  });

  it("sets both the attribute and the browser colour-scheme hint", () => {
    applyResolvedTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    // Without colorScheme the browser keeps rendering its own widgets —
    // scrollbars, autofill — for the wrong theme.
    expect(document.documentElement.style.colorScheme).toBe("light");
  });
});

describe("Theme control", () => {
  const renderShell = (): void => {
    vi.stubGlobal("fetch", stubFetch());
    render(
      <MemoryRouter initialEntries={["/"]}>
        <PlatformSessionProvider>
          <App />
        </PlatformSessionProvider>
      </MemoryRouter>,
    );
  };

  it("offers the same three choices as the Company Portal", async () => {
    stubMatchMedia(false);
    renderShell();
    const group = await screen.findByRole("group", { name: "Theme" });
    expect(
      Array.from(group.querySelectorAll("button")).map((button) => button.textContent),
    ).toEqual(["Light", "Dark", "System"]);
  });

  it("applies and stores a chosen theme", async () => {
    stubMatchMedia(false);
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Dark" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "false");
  });

  /**
   * The highlight must agree with the palette already on screen. Starting the
   * control's state at a default rather than at the stored value would show a
   * dark Portal with "System" highlighted.
   */
  it("starts on the stored preference, not on a default", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    stubMatchMedia(true);
    renderShell();
    expect(await screen.findByRole("button", { name: "Light" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("follows the OS while the preference is System", async () => {
    const media = stubMatchMedia(false);
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "System" }));
    expect(document.documentElement.dataset.theme).toBe("light");

    // The OS switches to dark — a night-shift schedule, or a manual toggle.
    stubMatchMedia(true);
    media.fire();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
  });

  /** An explicit choice must NOT be overridden by the OS changing. */
  it("does not follow the OS once a theme is chosen explicitly", async () => {
    const media = stubMatchMedia(false);
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "Light" }));

    stubMatchMedia(true);
    media.fire();
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
