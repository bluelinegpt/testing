import { useTranslation } from "react-i18next";

/**
 * Driver Cash Status presentation.
 *
 * This dimension has its own vocabulary — `pending` means "Pending Collection"
 * and `reconciled` means "Money Received from Driver". The generic `statuses.*`
 * map labels them "Pending" and "Reconciled", which is wrong for Driver Cash and
 * right for other dimensions, so every Driver Cash Status surface must go
 * through this helper rather than the shared map.
 *
 * Stored database values are unchanged.
 */
export const driverCashStatusValues = [
  "not_applicable",
  "pending",
  "reconciled",
  "reversed",
] as const;

export type DriverCashStatusValue = (typeof driverCashStatusValues)[number];

export function useDriverCashStatusLabel(): (value: string) => string {
  const { t } = useTranslation();
  return (value: string) => t(`driverCashStatuses.${value}`, value);
}

export function DriverCashStatusLabel({ value }: { value: string }) {
  const label = useDriverCashStatusLabel();
  return <span data-driver-cash-status={value}>{label(value)}</span>;
}
