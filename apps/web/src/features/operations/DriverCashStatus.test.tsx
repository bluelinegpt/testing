import { render, screen } from "@testing-library/react";

import { i18nInstance } from "../../localization/i18n.js";

import { DriverCashStatusLabel, driverCashStatusValues } from "./DriverCashStatus.js";

describe("Driver Cash Status labels", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("uses the approved dimension-specific vocabulary", () => {
    render(
      <ul>
        {driverCashStatusValues.map((value) => (
          <li key={value}>
            <DriverCashStatusLabel value={value} />
          </li>
        ))}
      </ul>,
    );
    expect(screen.getByText("Not Required")).toBeInTheDocument();
    expect(screen.getByText("Pending Collection")).toBeInTheDocument();
    expect(screen.getByText("Money Received from Driver")).toBeInTheDocument();
    expect(screen.getByText("Reversed")).toBeInTheDocument();
  });

  it("never renders the bare generic labels for Driver Cash Status", () => {
    render(
      <div>
        <DriverCashStatusLabel value="pending" />
        <DriverCashStatusLabel value="reconciled" />
      </div>,
    );
    // The generic statuses map would produce exactly "Pending" / "Reconciled".
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
    expect(screen.queryByText("Reconciled")).not.toBeInTheDocument();
  });

  it("leaves other status dimensions untouched", () => {
    // Delivery and Trader Settlement keep the shared vocabulary.
    expect(i18nInstance.t("statuses.delivered")).toBe("Delivered");
    expect(i18nInstance.t("statuses.unsettled")).not.toBe("Pending Collection");
    expect(i18nInstance.t("statuses.pending")).toBe("Pending");
    expect(i18nInstance.t("driverCashStatuses.pending")).toBe("Pending Collection");
  });

  it("renders Arabic labels when the language is Arabic", async () => {
    await i18nInstance.changeLanguage("ar");
    render(<DriverCashStatusLabel value="reconciled" />);
    expect(screen.getByText("تم استلام المبلغ من المندوب")).toBeInTheDocument();
    await i18nInstance.changeLanguage("en");
  });
});
