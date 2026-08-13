import { useTranslation } from "react-i18next";

import { useNetworkStatus } from "./network-status.js";

/**
 * §25: a subtle, professional status line -- never a blocking modal, never
 * shown for an ordinary API error (only for genuine device offline, per
 * `useNetworkStatus`). `role="status"` + `aria-live="polite"` announces the
 * change without stealing focus.
 */
export function OfflineBanner() {
  const { t } = useTranslation();
  const status = useNetworkStatus();
  if (status !== "offline") return null;
  return (
    <div className="store-offline-banner" role="status">
      {t("common.offlineBanner")}
    </div>
  );
}
