import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import type { LoginResponse, PortalOrder } from "../../api/contracts.js";
import { Modal } from "../../components/Modal.js";
import { formatDate } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";
import { PasswordChangeView } from "../authentication/PasswordChangeView.js";

type PortalArea = {
  readonly emirateId: string;
  readonly emirateNameAr: string | null;
  readonly emirateNameEn: string;
  readonly id: string;
  readonly nameAr: string | null;
  readonly nameEn: string;
};
type TraderProfile = {
  readonly code: string;
  readonly email: string | null;
  readonly id: string;
  readonly mobileNumber: string;
  readonly name: string;
};

const editableStatuses = new Set(["new", "in_branch", "assigned_to_driver", "out_for_delivery"]);
const idempotencyKey = () => `trader-order:${crypto.randomUUID()}`;

export function PortalWorkspace({
  api,
  onLogout,
  session,
}: {
  api: ApiClient;
  onLogout: () => Promise<void>;
  session: LoginResponse;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const isDriver = session.identity.kind === "driver";
  const [orders, setOrders] = useState<readonly PortalOrder[]>([]);
  const [areas, setAreas] = useState<readonly PortalArea[]>([]);
  const [profile, setProfile] = useState<TraderProfile>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [view, setView] = useState<"orders" | "profile" | "password">("orders");
  const [notice, setNotice] = useState<string>();
  const [selectedOrder, setSelectedOrder] = useState<PortalOrder>();
  const [editingOrder, setEditingOrder] = useState<PortalOrder>();
  const [creatingOrder, setCreatingOrder] = useState(false);
  const displayName = profile?.name ?? session.identity.displayName ?? session.identity.username;

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      if (isDriver) {
        setOrders(await api.get<readonly PortalOrder[]>("portal/driver/orders"));
      } else {
        const [orderRows, traderProfile, areaRows] = await Promise.all([
          api.get<readonly PortalOrder[]>("portal/trader/orders"),
          api.get<TraderProfile>("portal/trader/profile"),
          api.get<readonly PortalArea[]>("portal/trader/areas"),
        ]);
        setOrders(orderRows);
        setProfile(traderProfile);
        setAreas(areaRows);
      }
    } catch (cause) {
      setError(apiMessage(cause, t("common.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [api, isDriver, t]);

  useEffect(() => void load(), [load]);

  const updateStatus = async (order: PortalOrder, status: string) => {
    setError(undefined);
    try {
      await api.patch<PortalOrder>(`portal/driver/orders/${order.id}/status`, { status });
      await load();
    } catch (cause) {
      setError(apiMessage(cause, t("portal.statusFailed")));
    }
  };

  return (
    <main className="admin-layout">
      <aside className="sidebar">
        <div className="sidebar-company">
          <span>{t("workspace.company")}</span>
          <strong>{displayName}</strong>
        </div>
        <nav aria-label={t("workspace.navigation")} className="side-nav">
          <button
            aria-current={view === "orders" ? "page" : undefined}
            onClick={() => setView("orders")}
            type="button"
          >
            {isDriver ? t("portal.driverTitle") : t("portal.traderTitle")}
          </button>
          <button
            aria-current={view === "profile" ? "page" : undefined}
            onClick={() => setView("profile")}
            type="button"
          >
            {t("portal.myProfile")}
          </button>
          <button
            aria-current={view === "password" ? "page" : undefined}
            onClick={() => setView("password")}
            type="button"
          >
            {t("portal.changePassword")}
          </button>
        </nav>
        <button
          className="button button-secondary logout-button"
          onClick={() => void onLogout()}
          type="button"
        >
          {t("auth.logout")}
        </button>
      </aside>
      <section className="admin-content">
        {notice ? <div className="alert alert-success">{notice}</div> : null}
        {view === "password" ? (
          <PasswordChangeView
            api={api}
            onChanged={() => {
              setNotice(t("portal.passwordChanged"));
              setView("orders");
            }}
          />
        ) : view === "profile" ? (
          <section className="data-surface">
            <div className="page-heading">
              <div>
                <p className="eyebrow">{t("portal.area")}</p>
                <h1>{t("portal.myProfile")}</h1>
              </div>
            </div>
            <dl className="detail-grid">
              <div>
                <dt>{t("common.name")}</dt>
                <dd>{displayName}</dd>
              </div>
              <div>
                <dt>{t("auth.username")}</dt>
                <dd>
                  <bdi>{session.identity.username}</bdi>
                </dd>
              </div>
              {profile ? (
                <>
                  <div>
                    <dt>{t("userAdmin.mobile")}</dt>
                    <dd>
                      <bdi>{profile.mobileNumber}</bdi>
                    </dd>
                  </div>
                  <div>
                    <dt>{t("userAdmin.email")}</dt>
                    <dd>{profile.email ?? "—"}</dd>
                  </div>
                </>
              ) : null}
            </dl>
          </section>
        ) : (
          <>
            {error ? (
              <div className="alert alert-error" role="alert">
                {error}
              </div>
            ) : null}
            <div className="page-heading">
              <div>
                <p className="eyebrow">{t("portal.area")}</p>
                <h1>{isDriver ? t("portal.driverTitle") : t("portal.traderTitle")}</h1>
              </div>
              <div className="page-actions">
                {!isDriver ? (
                  <button
                    className="button button-primary"
                    onClick={() => setCreatingOrder(true)}
                    type="button"
                  >
                    {t("portal.createOrder")}
                  </button>
                ) : null}
                <button
                  className="button button-secondary"
                  onClick={() => void load()}
                  type="button"
                >
                  {t("common.refresh")}
                </button>
              </div>
            </div>
            <div className="data-surface">
              <table>
                <thead>
                  <tr>
                    <th>{t("operations.order")}</th>
                    <th>{t("operations.customer")}</th>
                    <th>{t("operations.trader")}</th>
                    <th>{t("operations.status")}</th>
                    <th>{t("operations.customerAmountDue")}</th>
                    <th>
                      <span className="sr-only">{t("common.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.id}>
                      <td>
                        <strong>
                          <bdi>{order.orderNumber}</bdi>
                        </strong>
                        <span className="cell-secondary">{formatDate(order.orderDate, locale)}</span>
                      </td>
                      <td>
                        {order.customerName}
                        <span className="cell-secondary">
                          <bdi>{order.customerMobileNumber}</bdi>
                        </span>
                        <span className="cell-secondary">{order.customerAddress}</span>
                      </td>
                      <td>
                        {order.traderName}
                        <span className="cell-secondary">{order.areaName}</span>
                      </td>
                      <td>
                        <span className="status status-neutral">
                          {t(`statuses.${order.deliveryStatus}`)}
                        </span>
                      </td>
                      <td>{formatMoney(order.customerAmountDue)}</td>
                      <td>
                        <div className="row-actions">
                          <button onClick={() => setSelectedOrder(order)} type="button">
                            {t("common.view")}
                          </button>
                          {!isDriver && editableStatuses.has(order.deliveryStatus) ? (
                            <button onClick={() => setEditingOrder(order)} type="button">
                              {t("common.edit")}
                            </button>
                          ) : null}
                          {isDriver
                            ? driverActions(order.deliveryStatus).map((action) => (
                                <button
                                  key={action.status}
                                  onClick={() => void updateStatus(order, action.status)}
                                  type="button"
                                >
                                  {t(`operations.${action.label}`)}
                                </button>
                              ))
                            : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {orders.length === 0 ? (
                    <tr>
                      <td className="empty-state" colSpan={6}>
                        {t("portal.noOrders")}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              {loading ? <div className="loading-row">{t("common.loading")}</div> : null}
            </div>
          </>
        )}
      </section>
      {selectedOrder ? (
        <OrderDetailModal order={selectedOrder} onClose={() => setSelectedOrder(undefined)} />
      ) : null}
      {creatingOrder ? (
        <TraderOrderForm
          api={api}
          areas={areas}
          onClose={() => setCreatingOrder(false)}
          onSaved={async () => {
            setCreatingOrder(false);
            setNotice(t("portal.orderCreated"));
            await load();
          }}
        />
      ) : null}
      {editingOrder ? (
        <TraderOrderForm
          api={api}
          areas={areas}
          order={editingOrder}
          onClose={() => setEditingOrder(undefined)}
          onSaved={async () => {
            setEditingOrder(undefined);
            setNotice(t("portal.orderUpdated"));
            await load();
          }}
        />
      ) : null}
    </main>
  );
}

function OrderDetailModal({
  order,
  onClose,
}: {
  readonly order: PortalOrder;
  readonly onClose: () => void;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const rows = [
    [t("operations.order"), order.orderNumber],
    [t("portal.serialNumber"), order.serialNumber],
    [t("portal.referenceNumber"), order.referenceNumber ?? "—"],
    [t("operations.customer"), order.customerName],
    [t("userAdmin.mobile"), order.customerMobileNumber],
    [t("portal.address"), order.customerAddress],
    [t("portal.deliveryArea"), order.areaName],
    [t("portal.codAmount"), formatMoney(order.codAmount)],
    [t("portal.serviceFee"), formatMoney(order.serviceFee)],
    [t("operations.customerAmountDue"), formatMoney(order.customerAmountDue)],
    [t("portal.packageCount"), String(order.packageCount)],
    [t("operations.status"), t(`statuses.${order.deliveryStatus}`)],
    [t("portal.notes"), order.notes ?? "—"],
  ];
  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={`${t("portal.orderDetails")} · ${order.orderNumber}`}
      titleId="portal-order-detail-title"
    >
      <dl className="detail-grid">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="modal-actions">
        <button className="button button-primary" onClick={onClose} type="button">
          {t("common.close")}
        </button>
      </div>
    </Modal>
  );
}

function TraderOrderForm({
  api,
  areas,
  order,
  onClose,
  onSaved,
}: {
  readonly api: ApiClient;
  readonly areas: readonly PortalArea[];
  readonly order?: PortalOrder;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const initialArea = order
    ? areas.find((area) => area.id === order.areaId)
    : areas[0];
  const [serialNumber, setSerialNumber] = useState(order?.serialNumber ?? "");
  const [referenceNumber, setReferenceNumber] = useState(order?.referenceNumber ?? "");
  const [customerName, setCustomerName] = useState(order?.customerName ?? "");
  const [customerMobileNumber, setCustomerMobileNumber] = useState(
    order?.customerMobileNumber ?? "",
  );
  const [customerAddress, setCustomerAddress] = useState(order?.customerAddress ?? "");
  const [emirateId, setEmirateId] = useState(initialArea?.emirateId ?? "");
  const [areaId, setAreaId] = useState(order?.areaId ?? initialArea?.id ?? "");
  const [codAmount, setCodAmount] = useState(order?.codAmount ?? "0");
  const [packageCount, setPackageCount] = useState(String(order?.packageCount ?? 1));
  const [notes, setNotes] = useState(order?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const emirates = Array.from(
    new Map(
      areas.map((area) => [
        area.emirateId,
        {
          id: area.emirateId,
          name:
            locale === "ar"
              ? area.emirateNameAr ?? area.emirateNameEn
              : area.emirateNameEn,
        },
      ]),
    ).values(),
  );
  const filteredAreas = areas.filter((area) => area.emirateId === emirateId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      if (order) {
        const changes: Record<string, unknown> = {};
        if (customerName.trim() !== order.customerName) changes.customerName = customerName;
        if (customerMobileNumber.trim() !== order.customerMobileNumber) {
          changes.customerMobileNumber = customerMobileNumber;
        }
        if (customerAddress.trim() !== order.customerAddress) {
          changes.customerAddress = customerAddress;
        }
        if (Number(codAmount) !== Number(order.codAmount)) changes.codAmount = Number(codAmount);
        if (Number(packageCount) !== order.packageCount) {
          changes.packageCount = Number(packageCount);
        }
        if (notes.trim() !== (order.notes ?? "")) changes.notes = notes;
        await api.patch(`portal/trader/orders/${order.id}`, changes);
      } else {
        const customer = {
          address: customerAddress,
          areaId,
          mobileNumber: customerMobileNumber,
          name: customerName,
        };
        await api.post(
          "portal/trader/orders",
          {
            areaId,
            codAmount: Number(codAmount),
            customerAddress,
            customerMobileNumber,
            customerName,
            inlineCustomer: customer,
            notes: notes.trim() || undefined,
            packageCount: Number(packageCount),
            referenceNumber: referenceNumber.trim() || undefined,
            serialNumber,
          },
          { "X-Idempotency-Key": idempotencyKey() },
        );
      }
      await onSaved();
    } catch (cause) {
      setError(apiMessage(cause, t("portal.orderSaveFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t(order ? "portal.editOrder" : "portal.createOrder")}
      titleId="portal-order-form-title"
    >
      {error ? <div className="alert alert-error">{error}</div> : null}
      <form onSubmit={(event) => void submit(event)}>
        {!order ? (
          <>
            <label className="field">
              <span>{t("portal.serialNumber")} *</span>
              <input
                maxLength={160}
                onChange={(event) => setSerialNumber(event.target.value)}
                required
                value={serialNumber}
              />
            </label>
            <label className="field">
              <span>{t("portal.referenceNumber")}</span>
              <input
                maxLength={160}
                onChange={(event) => setReferenceNumber(event.target.value)}
                value={referenceNumber}
              />
            </label>
          </>
        ) : null}
        <label className="field">
          <span>{t("operations.customer")} *</span>
          <input
            maxLength={160}
            onChange={(event) => setCustomerName(event.target.value)}
            required
            value={customerName}
          />
        </label>
        <label className="field">
          <span>{t("userAdmin.mobile")} *</span>
          <input
            maxLength={32}
            onChange={(event) => setCustomerMobileNumber(event.target.value)}
            required
            value={customerMobileNumber}
          />
        </label>
        <label className="field">
          <span>{t("portal.address")} *</span>
          <textarea
            maxLength={500}
            onChange={(event) => setCustomerAddress(event.target.value)}
            required
            value={customerAddress}
          />
        </label>
        {order ? (
          <label className="field">
            <span>{t("portal.deliveryArea")}</span>
            <input disabled value={order.areaName} />
          </label>
        ) : (
          <>
            <label className="field">
              <span>{t("areas.emirate")} *</span>
              <select
                onChange={(event) => {
                  const nextEmirateId = event.target.value;
                  setEmirateId(nextEmirateId);
                  setAreaId(
                    areas.find((area) => area.emirateId === nextEmirateId)?.id ?? "",
                  );
                }}
                required
                value={emirateId}
              >
                <option value="">{t("common.select")}</option>
                {emirates.map((emirate) => (
                  <option key={emirate.id} value={emirate.id}>
                    {emirate.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("portal.deliveryArea")} *</span>
              <select
                onChange={(event) => setAreaId(event.target.value)}
                required
                value={areaId}
              >
                <option value="">{t("common.select")}</option>
                {filteredAreas.map((area) => (
                  <option key={area.id} value={area.id}>
                    {locale === "ar" ? area.nameAr ?? area.nameEn : area.nameEn}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="field">
          <span>{t("portal.codAmount")} *</span>
          <input
            min="0"
            onChange={(event) => setCodAmount(event.target.value)}
            required
            step="0.01"
            type="number"
            value={codAmount}
          />
        </label>
        <label className="field">
          <span>{t("portal.packageCount")} *</span>
          <input
            min="1"
            onChange={(event) => setPackageCount(event.target.value)}
            required
            step="1"
            type="number"
            value={packageCount}
          />
        </label>
        <label className="field">
          <span>{t("portal.notes")}</span>
          <textarea
            maxLength={1000}
            onChange={(event) => setNotes(event.target.value)}
            value={notes}
          />
        </label>
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button className="button button-primary" disabled={saving} type="submit">
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function driverActions(
  status: string,
): readonly { readonly label: string; readonly status: string }[] {
  if (status === "assigned_to_driver") {
    return [{ label: "outForDelivery", status: "out_for_delivery" }];
  }
  if (status === "out_for_delivery") {
    return [
      { label: "markDelivered", status: "delivered" },
      { label: "markReturned", status: "returned_to_branch" },
    ];
  }
  return [];
}

function formatMoney(value: string | undefined): string {
  return `${Number(value ?? 0).toFixed(2)} AED`;
}

function apiMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message || fallback : fallback;
}
