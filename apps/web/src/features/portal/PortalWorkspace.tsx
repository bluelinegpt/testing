import { Plus, RefreshCw, Search } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { MobileAppQrPanel } from "../../components/MobileAppQrPanel.js";
import type {
  LoginResponse,
  OperationsOrderImportResult,
  PortalOrder,
  TraderPortalOrderPage,
  TraderPortalOrderSummary,
} from "../../api/contracts.js";
import { Modal } from "../../components/Modal.js";
import { formatDate } from "../../localization/formatters.js";
import { normalizeLocale, type SupportedLocale } from "../../localization/locale.js";
import { PasswordChangeView } from "../authentication/PasswordChangeView.js";
import { DeliveryCompaniesSection } from "../storefront/DeliveryCompaniesSection.js";
import { ProductCatalogueWorkspace } from "../storefront/ProductCatalogueWorkspace.js";
import { StorefrontConfigurationWorkspace } from "../storefront/StorefrontConfigurationWorkspace.js";

import { type TraderDashboardData, TraderDashboardView } from "./TraderDashboardView.js";
import { TraderCommerceIntegrationsView } from "./TraderCommerceIntegrationsView.js";

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
  readonly commercialNumber: string | null;
  readonly companyMobileCode: string;
  readonly contactPerson: string | null;
  readonly email: string | null;
  readonly id: string;
  readonly mobileNumber: string;
  readonly name: string;
  readonly nameAr: string | null;
  readonly preferredLanguage: string;
  readonly telephone: string | null;
};

/**
 * Every Storefront/Product permission string those reused screens check.
 *
 * A Trader identity carries no Company RBAC permissions (`permissions` is
 * always `[]` on that session) because the API already scopes every write to
 * "this Trader's own Storefront" through `callerTraderId()`, not through the
 * Company permission table. Passing the full set here only affects which
 * buttons the UI shows enabled — the server re-checks and re-scopes every
 * call regardless, so this cannot widen what a Trader can actually reach.
 */
const FULL_STORE_PERMISSIONS = [
  "storefront.manage",
  "storefront.publish",
  "storefront.suspend",
  "storefront_products.manage",
  "storefront_products.publish",
];

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
  const [dashboard, setDashboard] = useState<TraderDashboardData>();
  const [storefrontId, setStorefrontId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [view, setView] = useState<
    | "dashboard"
    | "delivery-companies"
    | "orders"
    | "password"
    | "products"
    | "profile"
    | "integrations"
    | "store"
  >(isDriver ? "orders" : "dashboard");
  const [notice, setNotice] = useState<string>();
  const [mobileQrOpen, setMobileQrOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<PortalOrder>();
  const [editingOrder, setEditingOrder] = useState<PortalOrder>();
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [bulkImporting, setBulkImporting] = useState(false);
  // Bumped after any Order create/edit/import so the Trader Orders table (and
  // the Dashboard, via `load()`) both show the change immediately rather than
  // a stale list the Trader has to manually refresh (§37).
  const [reload, setReload] = useState(0);
  const displayName = profile?.name ?? session.identity.displayName ?? session.identity.username;

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      if (isDriver) {
        setOrders(await api.get<readonly PortalOrder[]>("portal/driver/orders"));
      } else {
        const [orderRows, traderProfile, areaRows, dashboardData, mine] = await Promise.all([
          api.get<readonly PortalOrder[]>("portal/trader/orders"),
          api.get<TraderProfile>("portal/trader/profile"),
          api.get<readonly PortalArea[]>("portal/trader/areas"),
          api.get<TraderDashboardData>("portal/trader/dashboard"),
          // Store may not exist yet; a Trader-context storefront lookup
          // returns `null` rather than an error in that case (see
          // `StorefrontService.mine`).
          api.get<{ id: string } | null>("operations/trader-storefronts/mine"),
        ]);
        setOrders(orderRows);
        setProfile(traderProfile);
        setAreas(areaRows);
        setDashboard(dashboardData);
        setStorefrontId(mine?.id);
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
          {isDriver ? null : (
            <button
              aria-current={view === "dashboard" ? "page" : undefined}
              onClick={() => {
                // Picks up a Store created moments ago in "My Store" — the
                // Products tab is disabled until `storefrontId` reflects it.
                setView("dashboard");
                void load();
              }}
              type="button"
            >
              {t("portal.nav.dashboard")}
            </button>
          )}
          <button
            aria-current={view === "orders" ? "page" : undefined}
            onClick={() => setView("orders")}
            type="button"
          >
            {isDriver ? t("portal.driverTitle") : t("portal.traderTitle")}
          </button>
          {isDriver ? null : (
            <>
              <button
                aria-current={view === "store" ? "page" : undefined}
                onClick={() => setView("store")}
                type="button"
              >
                {t("portal.nav.myStore")}
              </button>
              <button
                aria-current={view === "products" ? "page" : undefined}
                disabled={storefrontId === undefined}
                onClick={() => setView("products")}
                title={
                  storefrontId === undefined
                    ? t("portal.dashboard.createStorePrompt")
                    : undefined
                }
                type="button"
              >
                {t("portal.nav.products")}
              </button>
              {/* Its own dedicated page (§29) — not folded only into Store
                  Settings, so a concept as important as "who delivers my
                  Orders" is not hidden a click deeper than it deserves. */}
              <button
                aria-current={view === "delivery-companies" ? "page" : undefined}
                onClick={() => setView("delivery-companies")}
                type="button"
              >
                {t("portal.nav.deliveryCompanies")}
              </button>
              <button
                aria-current={view === "integrations" ? "page" : undefined}
                onClick={() => setView("integrations")}
                type="button"
              >
                {t("portal.nav.integrations")}
              </button>
            </>
          )}
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
          {isDriver ? null : (
            <button onClick={() => setMobileQrOpen(true)} type="button">
              {t("shell.mobileAppQr")}
            </button>
          )}
        </nav>
        <button
          className="button button-secondary logout-button"
          onClick={() => void onLogout()}
          type="button"
        >
          {t("auth.logout")}
        </button>
      </aside>
      {mobileQrOpen ? (
        <MobileAppQrPanel
          code={profile?.companyMobileCode}
          companyName={displayName}
          onRequestClose={() => setMobileQrOpen(false)}
        />
      ) : null}
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
          <TraderProfileSection
            api={api}
            displayName={displayName}
            isDriver={isDriver}
            onManageStore={() => setView("store")}
            onSaved={(updated) => {
              setProfile(updated);
              setNotice(t("portal.profile.saved"));
            }}
            profile={profile}
            storeName={dashboard?.commerce.storeName ?? null}
            storeStatus={dashboard?.commerce.storeStatus ?? null}
            storeUrl={dashboard?.commerce.storeUrl ?? null}
            username={session.identity.username}
          />
        ) : !isDriver && view === "dashboard" ? (
          dashboard === undefined ? (
            <div className="loading-row">{t("common.loading")}</div>
          ) : (
            <TraderDashboardView
              data={dashboard}
              onAddProduct={() => setView(storefrontId === undefined ? "store" : "products")}
              onCreateBulkOrder={() => {
                setView("orders");
                setBulkImporting(true);
              }}
              onCreateOrder={() => {
                setView("orders");
                setCreatingOrder(true);
              }}
              onManageDeliveryCompanies={() => setView("delivery-companies")}
              onManageStore={() => setView("store")}
              onViewAllOrders={() => setView("orders")}
            />
          )
        ) : !isDriver && view === "delivery-companies" ? (
          storefrontId === undefined ? (
            <section className="data-surface">
              <div className="page-heading">
                <div>
                  <p className="eyebrow">{t("portal.area")}</p>
                  <h1>{t("portal.nav.deliveryCompanies")}</h1>
                </div>
              </div>
              {/* §31: this must never look like Store management is blocked
                  by it — the empty state says only what it is honestly true
                  of, which is this page. */}
              <p>{t("portal.deliveryCompanies.noStoreYet")}</p>
            </section>
          ) : (
            <section className="data-surface">
              <div className="page-heading">
                <div>
                  <p className="eyebrow">{t("portal.area")}</p>
                  <h1>{t("portal.nav.deliveryCompanies")}</h1>
                </div>
              </div>
              <DeliveryCompaniesSection api={api} canManage storefrontId={storefrontId} />
            </section>
          )
        ) : !isDriver && view === "store" ? (
          <StorefrontConfigurationWorkspace
            api={api}
            onCreated={() => void load()}
            permissions={FULL_STORE_PERMISSIONS}
            traderId={profile?.id}
          />
        ) : !isDriver && view === "integrations" ? (
          <TraderCommerceIntegrationsView api={api} />
        ) : !isDriver && view === "products" && storefrontId !== undefined ? (
          <ProductCatalogueWorkspace
            api={api}
            permissions={FULL_STORE_PERMISSIONS}
            storefrontId={storefrontId}
          />
        ) : isDriver ? (
          <>
            {error ? (
              <div className="alert alert-error" role="alert">
                {error}
              </div>
            ) : null}
            <div className="page-heading">
              <div>
                <p className="eyebrow">{t("portal.area")}</p>
                <h1>{t("portal.driverTitle")}</h1>
              </div>
              <div className="heading-actions">
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
                        <span className="cell-secondary">
                          {formatDate(order.orderDate, locale)}
                        </span>
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
                          {driverActions(order.deliveryStatus).map((action) => (
                            <button
                              key={action.status}
                              onClick={() => void updateStatus(order, action.status)}
                              type="button"
                            >
                              {t(`operations.${action.label}`)}
                            </button>
                          ))}
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
        ) : (
          <TraderOrdersTable
            api={api}
            locale={locale}
            onCreateBulk={() => setBulkImporting(true)}
            onCreateOrder={() => setCreatingOrder(true)}
            onEditOrder={setEditingOrder}
            onViewOrder={setSelectedOrder}
            reloadToken={reload}
          />
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
            setReload((current) => current + 1);
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
            setReload((current) => current + 1);
            await load();
          }}
        />
      ) : null}
      {bulkImporting ? (
        <TraderBulkImportDialog
          api={api}
          onClose={() => setBulkImporting(false)}
          onImported={async () => {
            setNotice(t("portal.bulk.imported"));
            setReload((current) => current + 1);
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
  const { t } = useTranslation();
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

/**
 * The Delivery Companies a Trader may create Orders under (Trader Portal
 * Prompt 3T-C, Part D): "one Company = auto-select, multiple Companies =
 * default preselected dropdown, zero Companies = block manual Order
 * creation". Shared by the single-Order form and the bulk import dialog so
 * both stay consistent with each other and with the read-side filter
 * (`portal/trader/orders/companies` also backs the Orders table's Delivery
 * Company filter in `TraderOrdersTable`).
 */
function useTraderDeliveryCompanyOptions(api: ApiClient) {
  const [companies, setCompanies] = useState<
    readonly { readonly id: string; readonly isOwn: boolean; readonly name: string }[]
  >();
  useEffect(() => {
    // A fetch failure (network hiccup, transient error) is left `undefined`
    // rather than treated as a confirmed empty list — only a genuine
    // successful-but-empty response ever blocks Order creation. The server
    // side (`resolveTraderPortalDeliveryCompany`) always includes the
    // caller's own Company, so a real empty list should not occur; this
    // just keeps a transport error from masquerading as that business state.
    api
      .get<readonly { readonly id: string; readonly isOwn: boolean; readonly name: string }[]>(
        "portal/trader/orders/companies",
      )
      .then(setCompanies)
      .catch(() => {});
  }, [api]);
  return companies;
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
  const initialArea = order ? areas.find((area) => area.id === order.areaId) : areas[0];
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
  const [deliveryCompanyId, setDeliveryCompanyId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const deliveryCompanies = useTraderDeliveryCompanyOptions(api);
  const blockedForNoCompany = !order && deliveryCompanies !== undefined && deliveryCompanies.length === 0;
  const emirates = Array.from(
    new Map(
      areas.map((area) => [
        area.emirateId,
        {
          id: area.emirateId,
          name: locale === "ar" ? (area.emirateNameAr ?? area.emirateNameEn) : area.emirateNameEn,
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
            deliveryCompanyId: deliveryCompanyId === "" ? undefined : deliveryCompanyId,
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
      {blockedForNoCompany ? (
        <div className="alert alert-error" role="alert">
          {t("portal.orders.noDeliveryCompanyBlocked")}
        </div>
      ) : null}
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
            {/* Only rendered once there is something to choose from — a
                single-Company Trader (the vast majority today) sees no
                selector at all, matching "one Company = auto-select". */}
            {deliveryCompanies !== undefined && deliveryCompanies.length > 1 ? (
              <label className="field">
                <span>{t("portal.orders.deliveryCompany")}</span>
                <select
                  onChange={(event) => setDeliveryCompanyId(event.target.value)}
                  value={deliveryCompanyId}
                >
                  <option value="">{t("portal.orders.deliveryCompanyDefault")}</option>
                  {deliveryCompanies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
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
                  setAreaId(areas.find((area) => area.emirateId === nextEmirateId)?.id ?? "");
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
              <select onChange={(event) => setAreaId(event.target.value)} required value={areaId}>
                <option value="">{t("common.select")}</option>
                {filteredAreas.map((area) => (
                  <option key={area.id} value={area.id}>
                    {locale === "ar" ? (area.nameAr ?? area.nameEn) : area.nameEn}
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
          <button className="button button-primary" disabled={saving || blockedForNoCompany} type="submit">
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

const quickViews = ["active", "closed", "cancelled", "hold", "all"] as const;
const pageSizes = [25, 50, 100] as const;

/**
 * The Trader's searchable, paginated Order list.
 *
 * Filtering and pagination happen server-side against
 * `GET trader/orders/search/all-companies` — the read-only, cross-Company
 * aggregation added for Trader Portal Prompt 3T-C, Part C ("one common
 * Trader Order history"): every Order across every Delivery Company the
 * caller's Trader Commerce identity is actively linked to, not just the
 * single Company the current login session belongs to. There is no
 * client-side filtering of an unbounded list here.
 */
function TraderOrdersTable({
  api,
  locale,
  onCreateBulk,
  onCreateOrder,
  onEditOrder,
  onViewOrder,
  reloadToken,
}: {
  readonly api: ApiClient;
  readonly locale: SupportedLocale;
  readonly onCreateBulk: () => void;
  readonly onCreateOrder: () => void;
  readonly onEditOrder: (order: PortalOrder) => void;
  readonly onViewOrder: (order: PortalOrder) => void;
  readonly reloadToken: number;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [quickView, setQuickView] = useState<(typeof quickViews)[number]>("active");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [deliveryCompanyId, setDeliveryCompanyId] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof pageSizes)[number]>(25);
  const [result, setResult] = useState<TraderPortalOrderPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const companies = useTraderDeliveryCompanyOptions(api) ?? [];

  const runSearch = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const query = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        quickView,
      });
      if (search.trim() !== "") query.set("search", search.trim());
      if (dateFrom !== "") query.set("dateFrom", dateFrom);
      if (dateTo !== "") query.set("dateTo", dateTo);
      if (deliveryCompanyId !== "") query.set("deliveryCompanyId", deliveryCompanyId);
      setResult(
        await api.get<TraderPortalOrderPage>(`portal/trader/orders/search/all-companies?${query}`),
      );
    } catch (cause) {
      setError(apiMessage(cause, t("common.loadFailed")));
    } finally {
      setLoading(false);
    }
  }, [api, dateFrom, dateTo, deliveryCompanyId, page, pageSize, quickView, search, t]);

  useEffect(() => void runSearch(), [runSearch, reloadToken]);

  // A new search or filter always returns to page 1: staying on page 6 of a
  // now-shorter result set would silently show an empty page and look broken.
  useEffect(() => {
    setPage(1);
  }, [dateFrom, dateTo, deliveryCompanyId, search, quickView, pageSize]);

  const totalPages = result === undefined ? 1 : Math.max(1, Math.ceil(result.filteredCount / pageSize));

  /** A minimal shape compatible with the shared detail/edit modals below. */
  const asPortalOrder = (row: TraderPortalOrderSummary): PortalOrder => ({
    amountCollected: "0",
    areaId: "",
    areaName: row.areaName,
    codAmount: row.codAmount,
    customerAddress: row.customerAddress,
    customerAmountDue: row.customerAmountDue,
    customerMobileNumber: row.customerMobileNumber,
    customerName: row.customerName,
    deliveryStatus: row.deliveryStatus,
    id: row.id,
    notes: null,
    orderDate: row.orderDate,
    orderNumber: row.orderNumber,
    packageCount: 0,
    referenceNumber: row.referenceNumber,
    serialNumber: "",
    serviceFee: row.serviceFee,
    traderName: "",
    traderSettlementStatus: "",
  });

  return (
    <>
      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t("portal.area")}</p>
          <h1>{t("portal.traderTitle")}</h1>
        </div>
        {/* Consistent hierarchy: primary action, secondary action, then a
            tertiary icon-only Refresh — matching the Company Orders toolbar
            rather than three same-weight buttons in a row. */}
        <div className="heading-actions">
          <button className="button button-primary" onClick={onCreateOrder} type="button">
            <Plus aria-hidden="true" size={16} />
            {t("portal.createOrder")}
          </button>
          <button className="button button-secondary" onClick={onCreateBulk} type="button">
            {t("portal.bulk.createMultiple")}
          </button>
          <button
            className="icon-button"
            onClick={() => void runSearch()}
            title={t("common.refresh")}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} />
          </button>
        </div>
      </div>

      {/* Search and status live directly under the heading — not off in an
          isolated column — because they are the first thing a Trader uses
          on this page, not a secondary refinement. */}
      <label className="orders-search">
        <Search aria-hidden="true" size={17} />
        <span className="sr-only">{t("common.search")}</span>
        <input
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void runSearch();
          }}
          placeholder={t("operations.searchOrdersPlaceholder")}
          type="search"
          value={search}
        />
      </label>

      <div aria-label={t("portal.statusFilter")} className="orders-quick-views" role="tablist">
        {quickViews.map((view) => (
          <button
            aria-selected={quickView === view}
            className={quickView === view ? "active" : undefined}
            key={view}
            onClick={() => setQuickView(view)}
            role="tab"
            type="button"
          >
            {t(`portal.quickViews.${view}`)}
          </button>
        ))}
      </div>

      <div className="orders-filter-bar">
        <label className="filter-date">
          <span>{t("operations.dateFrom")}</span>
          <input onChange={(event) => setDateFrom(event.target.value)} type="date" value={dateFrom} />
        </label>
        <label className="filter-date">
          <span>{t("operations.dateTo")}</span>
          <input onChange={(event) => setDateTo(event.target.value)} type="date" value={dateTo} />
        </label>
        {companies.length > 1 ? (
          <label className="filter-select">
            <span>{t("portal.nav.deliveryCompanies")}</span>
            <select
              onChange={(event) => setDeliveryCompanyId(event.target.value)}
              value={deliveryCompanyId}
            >
              <option value="">{t("portal.orders.allDeliveryCompanies")}</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          className="button button-secondary"
          onClick={() => {
            setSearch("");
            setDateFrom("");
            setDateTo("");
            setDeliveryCompanyId("");
            setQuickView("active");
          }}
          type="button"
        >
          {t("operations.clearFilters")}
        </button>
      </div>

      <div className="data-surface">
        <table>
          <thead>
            <tr>
              <th>{t("operations.order")}</th>
              <th>{t("operations.customer")}</th>
              <th>{t("userAdmin.mobile")}</th>
              <th>{t("portal.deliveryArea")}</th>
              {companies.length > 1 ? <th>{t("portal.nav.deliveryCompanies")}</th> : null}
              <th>{t("operations.status")}</th>
              <th>{t("portal.codAmount")}</th>
              <th>{t("portal.serviceFee")}</th>
              <th>{t("operations.customerAmountDue")}</th>
              <th>{t("portal.referenceNumber")}</th>
              <th>
                <span className="sr-only">{t("common.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(result?.items ?? []).map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>
                    <bdi>{row.orderNumber}</bdi>
                  </strong>
                  <span className="cell-secondary">{formatDate(row.orderDate, locale)}</span>
                </td>
                <td>{row.customerName}</td>
                <td>
                  <bdi dir="ltr">{row.customerMobileNumber}</bdi>
                </td>
                <td>{row.areaName}</td>
                {companies.length > 1 ? <td dir="auto">{row.deliveryCompanyName ?? "—"}</td> : null}
                <td>
                  <span className="status status-neutral">
                    {t(`statuses.${row.deliveryStatus}`)}
                  </span>
                </td>
                <td>{formatMoney(row.codAmount)}</td>
                <td>{formatMoney(row.serviceFee)}</td>
                <td>{formatMoney(row.customerAmountDue)}</td>
                <td>
                  <bdi dir="ltr">{row.referenceNumber ?? "—"}</bdi>
                </td>
                <td>
                  <div className="row-actions">
                    <button onClick={() => onViewOrder(asPortalOrder(row))} type="button">
                      {t("common.view")}
                    </button>
                    {editableStatuses.has(row.deliveryStatus) ? (
                      <button onClick={() => onEditOrder(asPortalOrder(row))} type="button">
                        {t("common.edit")}
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
            {!loading && (result?.items.length ?? 0) === 0 ? (
              <tr>
                <td className="empty-state" colSpan={companies.length > 1 ? 11 : 10}>
                  {t("portal.noOrders")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {loading ? <div className="loading-row">{t("common.loading")}</div> : null}

        {result === undefined || result.filteredCount === 0 ? null : (
          <div className="heading-actions">
            <span className="cell-secondary">
              {t("common.pageOf", { page, pageCount: totalPages })}
            </span>
            <button
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              type="button"
            >
              {t("common.previous", "‹")}
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              type="button"
            >
              {t("common.next", "›")}
            </button>
            <select
              onChange={(event) => setPageSize(Number(event.target.value) as (typeof pageSizes)[number])}
              value={pageSize}
            >
              {pageSizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * "Create Multiple Orders" for a Trader.
 *
 * Reuses the exact same import engine and CSV shape the Company portal's
 * `ImportOrdersDialog` uses (§23/§28) — only the template omits `traderId` and
 * `driverId`: a Trader has no Trader to choose and no Driver to pre-assign,
 * and the server strips/ignores those columns even if a pasted file still
 * carries them (§24, `scopeCsvToTrader` in the API).
 *
 * The API call is atomic-with-detail rather than a strict two-step
 * preview/commit: a submission with any invalid row writes nothing and
 * reports every row's problem at once (`OperationsOrderImportResult`), and a
 * fully valid submission both creates the Orders and returns the same
 * per-row detail — which is what this dialog shows as the result. See
 * `scopeCsvToTrader`'s doc comment for why a second, genuinely separate
 * preview step was not built on top of an engine that does not have one.
 */
function TraderBulkImportDialog({
  api,
  onClose,
  onImported,
}: {
  readonly api: ApiClient;
  readonly onClose: () => void;
  readonly onImported: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [csv, setCsv] = useState(
    "serialNumber,referenceNumber,customerName,customerMobileNumber,customerAddress," +
      "codAmount,packageCount\n",
  );
  const [deliveryCompanyId, setDeliveryCompanyId] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<OperationsOrderImportResult>();
  const [error, setError] = useState<string>();
  const deliveryCompanies = useTraderDeliveryCompanyOptions(api);
  const blockedForNoCompany = deliveryCompanies !== undefined && deliveryCompanies.length === 0;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    setResult(undefined);
    try {
      const response = await api.post<OperationsOrderImportResult>(
        "portal/trader/orders/import-csv",
        { csv, deliveryCompanyId: deliveryCompanyId === "" ? undefined : deliveryCompanyId },
      );
      setResult(response);
      if (response.importedRows > 0) await onImported();
    } catch (cause) {
      setError(apiMessage(cause, t("operations.importFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("portal.bulk.createMultiple")}
      titleId="trader-bulk-import-title"
    >
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      {blockedForNoCompany ? (
        <div className="alert alert-error" role="alert">
          {t("portal.orders.noDeliveryCompanyBlocked")}
        </div>
      ) : null}
      <form onSubmit={(event) => void submit(event)}>
        <p className="cell-secondary">{t("portal.bulk.hint")}</p>
        {deliveryCompanies !== undefined && deliveryCompanies.length > 1 ? (
          <label className="field">
            <span>{t("portal.orders.deliveryCompany")}</span>
            <select onChange={(event) => setDeliveryCompanyId(event.target.value)} value={deliveryCompanyId}>
              <option value="">{t("portal.orders.deliveryCompanyDefault")}</option>
              {deliveryCompanies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="field">
          <span>{t("operations.csvRows")}</span>
          <textarea
            dir="ltr"
            onChange={(event) => setCsv(event.target.value)}
            required
            rows={10}
            value={csv}
          />
        </label>
        {result === undefined ? null : (
          <div
            className={result.errors.length > 0 ? "alert alert-error" : "alert alert-info"}
            role="status"
          >
            <strong>
              {t("portal.bulk.summary", {
                imported: result.importedRows,
                total: result.totalRows,
              })}
            </strong>
            {result.errors.map((item) => (
              <span className="cell-secondary" key={item}>
                {item}
              </span>
            ))}
            {(result.rows ?? []).map((row) => (
              <span className="cell-secondary" key={`row-${row.rowNumber}`}>
                {t("operations.import.row", { number: row.rowNumber })}
                {row.referenceNumber === null ? "" : ` (${row.referenceNumber})`}
                {": "}
                {row.status === "invalid" ? row.errorMessage : row.orderNumber}
              </span>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button className="button button-primary" disabled={saving || blockedForNoCompany} type="submit">
            {saving ? t("common.working") : t("portal.bulk.submit")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function formatMoney(value: string | undefined): string {
  return `${Number(value ?? 0).toFixed(2)} AED`;
}

function apiMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message || fallback : fallback;
}

/**
 * The Trader's own identity screen — deliberately not a second Store editor.
 *
 * Only `contactPerson`, `telephone`, `email`, `commercialNumber` and
 * `preferredLanguage` are editable here; see `UpdateTraderPortalProfileDto`
 * for why the primary name and login mobile are excluded (they are already
 * referenced by Delivery Orders and settlements, and changing them without a
 * verification step is a later prompt's concern, not this one's).
 *
 * The Store summary at the bottom is READ-ONLY with a link to "My Store" —
 * branding, policies and lifecycle stay in exactly one place.
 */
function TraderProfileSection({
  api,
  displayName,
  isDriver,
  onManageStore,
  onSaved,
  profile,
  storeName,
  storeStatus,
  storeUrl,
  username,
}: {
  readonly api: ApiClient;
  readonly displayName: string;
  readonly isDriver: boolean;
  readonly onManageStore: () => void;
  readonly onSaved: (profile: TraderProfile) => void;
  readonly profile: TraderProfile | undefined;
  readonly storeName: string | null;
  readonly storeStatus: string | null;
  readonly storeUrl: string | null;
  readonly username: string;
}) {
  const { i18n, t } = useTranslation();
  const [contactPerson, setContactPerson] = useState(profile?.contactPerson ?? "");
  const [telephone, setTelephone] = useState(profile?.telephone ?? "");
  const [email, setEmail] = useState(profile?.email ?? "");
  const [commercialNumber, setCommercialNumber] = useState(profile?.commercialNumber ?? "");
  const [preferredLanguage, setPreferredLanguage] = useState(profile?.preferredLanguage ?? "en");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (profile === undefined) return;
    setContactPerson(profile.contactPerson ?? "");
    setTelephone(profile.telephone ?? "");
    setEmail(profile.email ?? "");
    setCommercialNumber(profile.commercialNumber ?? "");
    setPreferredLanguage(profile.preferredLanguage);
  }, [profile]);

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const updated = await api.patch<TraderProfile>("portal/trader/profile", {
        commercialNumber: commercialNumber.trim() || null,
        contactPerson: contactPerson.trim() || null,
        email: email.trim() || null,
        preferredLanguage,
        telephone: telephone.trim() || null,
      });
      onSaved(updated);
      if (preferredLanguage !== i18n.resolvedLanguage) void i18n.changeLanguage(preferredLanguage);
    } catch (cause) {
      setError(apiMessage(cause, t("portal.profile.saveFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="data-surface">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t("portal.area")}</p>
          <h1>{t("portal.myProfile")}</h1>
        </div>
      </div>
      {error !== undefined ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}
      <h2>{t("portal.profile.accountInformation")}</h2>
      <dl className="detail-grid">
        <div>
          <dt>{t("common.name")}</dt>
          <dd dir="auto">{displayName}</dd>
        </div>
        <div>
          <dt>{t("auth.username")}</dt>
          <dd>
            <bdi>{username}</bdi>
          </dd>
        </div>
        {profile === undefined ? null : (
          <div>
            <dt>{t("userAdmin.mobile")}</dt>
            <dd>
              <bdi dir="ltr">{profile.mobileNumber}</bdi>
            </dd>
          </div>
        )}
      </dl>

      {isDriver || profile === undefined ? null : (
        <div className="accounting-form">
          <fieldset className="accounting-form-section" disabled={saving}>
            <legend>{t("portal.profile.businessInformation")}</legend>
            {/* `.accounting-form-grid` is what actually grids these fields
                2-up on desktop / 1-up on mobile. Bare `<label>` elements have
                no display rule of their own and flow inline — that gap is
                exactly what squeezed every field onto one long row. */}
            <div className="accounting-form-grid">
              <label>
                {t("portal.profile.contactPerson")}
                <input
                  onChange={(event) => setContactPerson(event.target.value)}
                  value={contactPerson}
                />
              </label>
              <label>
                {t("portal.profile.telephone")}
                <input
                  dir="ltr"
                  onChange={(event) => setTelephone(event.target.value)}
                  value={telephone}
                />
              </label>
              <label>
                {t("userAdmin.email")}
                <input
                  dir="ltr"
                  onChange={(event) => setEmail(event.target.value)}
                  type="email"
                  value={email}
                />
              </label>
              <label>
                {t("portal.profile.commercialNumber")}
                <input
                  dir="ltr"
                  onChange={(event) => setCommercialNumber(event.target.value)}
                  value={commercialNumber}
                />
              </label>
              <label>
                {t("portal.profile.language")}
                <select
                  onChange={(event) => setPreferredLanguage(event.target.value)}
                  value={preferredLanguage}
                >
                  <option value="en">English</option>
                  <option value="ar">العربية</option>
                </select>
              </label>
            </div>
          </fieldset>
          {/* Save sits on its own row at the end of the form, not inline
              with the final field — a language dropdown is not a natural
              neighbour for a submit button. `.heading-actions` is reused for
              its `justify-content: flex-end`, so Save lands at the trailing
              edge rather than the leading one. */}
          <div className="accounting-form-actions heading-actions">
            <button className="button button-primary" onClick={() => void save()} type="button">
              {saving ? t("common.saving") : t("common.save")}
            </button>
          </div>
        </div>
      )}

      {isDriver ? null : (
        <section className="data-surface">
          <div className="page-heading-copy">
            <h2>{t("portal.profile.commerceSummary")}</h2>
          </div>
          {storeName === null ? (
            <p>{t("portal.profile.noStoreYet")}</p>
          ) : (
            <dl className="detail-grid">
              <div>
                <dt>{t("portal.profile.storeName")}</dt>
                <dd dir="auto">{storeName}</dd>
              </div>
              <div>
                <dt>{t("portal.profile.storeStatus")}</dt>
                <dd>
                  {storeStatus === null ? "—" : t(`storefront.status.${storeStatus}`, storeStatus)}
                </dd>
              </div>
              {storeUrl === null ? null : (
                <div>
                  <dt>{t("portal.profile.storeUrl")}</dt>
                  <dd>
                    <bdi dir="ltr">{storeUrl}</bdi>
                  </dd>
                </div>
              )}
            </dl>
          )}
          <div className="heading-actions">
            <button className="button button-secondary" onClick={onManageStore} type="button">
              {storeName === null
                ? t("portal.dashboard.createStoreAction")
                : t("portal.dashboard.manageStore")}
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
