// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import { i18nInstance } from "../../localization/i18n.js";
import { CommunicationCenter } from "./CommunicationCenter.js";

describe("CommunicationCenter", () => {
  it("renders the responsive three-panel safe unavailable state", () => {
    render(
      <I18nextProvider i18n={i18nInstance}>
        <CommunicationCenter />
      </I18nextProvider>,
    );
    expect(screen.getByRole("heading", { name: "Communication Center" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Communication service unavailable");
    expect(screen.getByRole("button", { name: /Voice messaging unavailable/ })).toBeDisabled();
  });
});
