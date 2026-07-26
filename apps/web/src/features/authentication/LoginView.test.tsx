import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { LoginView } from "./LoginView.js";

describe("LoginView", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18nInstance.changeLanguage("en");
  });

  it("signs in with only an identifier and password, sending no Company", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({ permissions: [] }),
      post: vi.fn().mockResolvedValue({
        accessToken: "token",
        identity: { companyId: "company", permissions: ["users_roles.manage"] },
      }),
      setAccessToken: vi.fn(),
    };
    const authenticated = vi.fn();
    render(<LoginView api={api as unknown as ApiClient} onAuthenticated={authenticated} />);

    fireEvent.change(screen.getByLabelText("Username, Email, or Mobile Number"), {
      target: { value: "operator" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secure-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(authenticated).toHaveBeenCalledOnce());
    // The Company is resolved server-side from the request host. Sending one
    // from the client would let a caller aim a login at any tenant.
    expect(api.post).toHaveBeenCalledWith("auth/login", {
      password: "secure-password",
      identifier: "operator",
    });
  });

  it("never requests or renders a Company list", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({ permissions: [] }),
      post: vi.fn().mockResolvedValue({
        accessToken: "token",
        identity: { companyId: "company", permissions: ["users_roles.manage"] },
      }),
      setAccessToken: vi.fn(),
    };
    render(<LoginView api={api as unknown as ApiClient} onAuthenticated={vi.fn()} />);

    // No Company enumeration endpoint is called, and no selector is rendered.
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Company")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Password")).toBeInTheDocument());
  });

  it("trims the identifier without storing credentials or identifiers", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({ permissions: [] }),
      post: vi.fn().mockResolvedValue({
        accessToken: "token",
        identity: { companyId: "company", permissions: ["users_roles.manage"] },
      }),
      setAccessToken: vi.fn(),
    };
    render(<LoginView api={api as unknown as ApiClient} onAuthenticated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Username, Email, or Mobile Number"), {
      target: { value: "  operator  " },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secure-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("auth/login", {
        password: "secure-password",
        identifier: "operator",
      }),
    );
    expect(screen.queryByLabelText("Remember me")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Forgot password?" })).not.toBeInTheDocument();
    expect(localStorage.getItem("blueline.login.username")).toBeNull();
    expect(localStorage.getItem("blueline.login.company")).toBeNull();
  });

  it("refreshes effective permissions when the login response contains none", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({ permissions: ["users_roles.manage"] }),
      post: vi.fn().mockResolvedValue({
        accessToken: "token",
        identity: {
          companyId: "company",
          kind: "company_user",
          permissions: [],
          username: "administrator",
        },
      }),
      setAccessToken: vi.fn(),
    };
    const authenticated = vi.fn();
    render(<LoginView api={api as unknown as ApiClient} onAuthenticated={authenticated} />);

    fireEvent.change(screen.getByLabelText("Username, Email, or Mobile Number"), {
      target: { value: "administrator" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "secure-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(authenticated).toHaveBeenCalledWith(
        expect.objectContaining({
          identity: expect.objectContaining({
            permissions: ["users_roles.manage"],
          }),
        }),
      ),
    );
    expect(api.get).toHaveBeenCalledWith("auth/me");
  });
});
