import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import { useSessionAccess } from "../../app/SessionAccessContext.js";
import { formatDateTime } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";

interface OrderWhatsAppRow {
  readonly id: string;
  readonly messageType: string;
  readonly groupNameSnapshot: string | null;
  readonly messageLanguage: string;
  readonly status: string;
  readonly orderStatus: string | null;
  readonly sentAt: string | null;
  readonly createdAt: string;
}

/**
 * Read-only WhatsApp notification history on the Order details view. Renders
 * nothing unless the viewer holds the history permission AND this Order has
 * at least one recorded WhatsApp message — most Orders have none, and an
 * empty section on every Order would be noise, not information.
 */
export function OrderWhatsAppHistory({ api, orderId }: { api: ApiClient; orderId: string }) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const permissions = useSessionAccess()?.permissions ?? [];
  const canView =
    permissions.includes("whatsapp.history.view") || permissions.includes("users_roles.manage");
  const [rows, setRows] = useState<readonly OrderWhatsAppRow[]>([]);

  useEffect(() => {
    if (!canView) return;
    let active = true;
    api
      .get<readonly OrderWhatsAppRow[]>(
        `whatsapp/orders/${encodeURIComponent(orderId)}/notifications`,
      )
      .then((result) => {
        if (active) setRows(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, canView, orderId]);

  if (!canView || rows.length === 0) return null;
  return (
    <section className="order-detail-section">
      <h2>{t("whatsapp.notifications")}</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{t("common.date")}</th>
              <th scope="col">{t("whatsapp.historyType")}</th>
              <th scope="col">{t("whatsapp.historyGroup")}</th>
              <th scope="col">{t("whatsapp.messageLanguage")}</th>
              <th scope="col">{t("common.status")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{formatDateTime(row.sentAt ?? row.createdAt, locale)}</td>
                <td>
                  {row.messageType === "test"
                    ? t("whatsapp.typeTest")
                    : `${t("whatsapp.typeOrderStatus")}${
                        row.orderStatus === null
                          ? ""
                          : ` · ${t(`statuses.${row.orderStatus}`, { defaultValue: row.orderStatus })}`
                      }`}
                </td>
                <td>{row.groupNameSnapshot ?? "—"}</td>
                <td>{t(`whatsapp.language.${row.messageLanguage}`)}</td>
                <td>
                  <span className={`status-badge status-${row.status.replaceAll("_", "-")}`}>
                    {t(`whatsapp.messageStatus.${row.status}`)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
