import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import type { PublicOrderTracking } from "../../api/contracts.js";
import { formatDate } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";

export function TrackingView({ api, token }: { api: ApiClient; token: string }) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const [tracking, setTracking] = useState<PublicOrderTracking>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    api
      .get<PublicOrderTracking>(`public/tracking/${encodeURIComponent(token)}`)
      .then((result) => {
        if (active) setTracking(result);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [api, token]);

  return (
    <main className="tracking-page">
      <section className="tracking-panel" aria-live="polite">
        <p className="eyebrow">{t("tracking.title")}</p>
        {failed ? (
          <h1>{t("tracking.notFound")}</h1>
        ) : tracking === undefined ? (
          <h1>{t("common.working")}</h1>
        ) : (
          <>
            <h1>{tracking.orderNumber}</h1>
            <div className="tracking-status">{tracking.deliveryStatus}</div>
            <div className="tracking-grid">
              <TrackingLine label={t("tracking.company")} value={tracking.companyName} />
              <TrackingLine label={t("tracking.order")} value={tracking.orderNumber} />
              <TrackingLine label={t("operations.customer")} value={tracking.customerName} />
              <TrackingLine label={t("tracking.area")} value={tracking.areaName} />
              <TrackingLine
                label={t("tracking.driver")}
                value={tracking.assignedDriverName ?? t("operations.unassigned")}
              />
              <TrackingLine
                label={t("tracking.lastUpdated")}
                value={formatDate(tracking.lastUpdatedAt, locale)}
              />
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function TrackingLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="tracking-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
