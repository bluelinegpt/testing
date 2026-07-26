import { ArrowLeft, Pencil, Plus, RefreshCw, UserRound } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import type {
  CompanyArea,
  CustomerPage,
  CustomerSummary,
  OperationsTraderOption,
} from "../../api/contracts.js";
import { normalizeUaeMobile } from "../../domain/uae-mobile.js";
import { Modal } from "../../components/Modal.js";
import { AreaSelector } from "./AreaSelector.js";
import { PageHeader } from "../../components/PageHeader.js";
import { SearchCombobox } from "../../components/SearchCombobox.js";

type CustomerDetail = {
  addresses: readonly Record<string, unknown>[];
  audit: readonly Record<string, unknown>[];
  code: string;
  createdAt: string;
  createdBy: string | null;
  customerReference: string | null;
  deliveryNotes: string | null;
  email: string | null;
  id: string;
  internalNotes: string | null;
  metrics: Record<string, unknown>;
  mobileNumber: string;
  name: string;
  orders: CustomerPage<Record<string, unknown>>;
  secondMobileNumber: string | null;
  status: "active" | "disabled";
};

export function CustomerConfigurationWorkspace({
  api,
  onNavigate,
}: {
  api: ApiClient;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState<CustomerPage<CustomerSummary>>({
    items: [],
    page: 1,
    pageSize: 25,
    total: 0,
  });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [activity, setActivity] = useState("");
  const [area, setArea] = useState<CompanyArea>();
  const [trader, setTrader] = useState<OperationsTraderOption>();
  const [sortBy, setSortBy] = useState("name");
  const [sortDirection, setSortDirection] = useState("asc");
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<"create" | "status">();
  const [selected, setSelected] = useState<CustomerSummary>();
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams({
        activity,
        areaId: area?.id ?? "",
        page: String(pageNumber),
        pageSize: String(pageSize),
        search,
        sortBy,
        sortDirection,
        status,
        traderId: trader?.id ?? "",
      });
      void api
        .get<CustomerPage<CustomerSummary>>(
          `configuration/customers?${params.toString()}`,
          controller.signal,
        )
        .then(setPage)
        .finally(() => setLoading(false));
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    activity,
    api,
    area,
    pageNumber,
    pageSize,
    refresh,
    search,
    sortBy,
    sortDirection,
    status,
    trader,
  ]);

  const areaLabel = useCallback((option: CompanyArea) => `${option.code} - ${option.nameEn}`, []);
  const traderLabel = useCallback(
    (option: OperationsTraderOption) => `${option.code} - ${option.nameEn}`,
    [],
  );

  return (
    <section>
      <PageHeader
        eyebrow={t("nav.configuration")}
        title={t("customerConfig.customers")}
        actions={
          <>
            <button
              className="button button-secondary"
              onClick={() => setRefresh((x) => x + 1)}
              type="button"
            >
              <RefreshCw size={17} /> {t("common.refresh")}
            </button>
            <button
              className="button button-primary"
              onClick={() => setDialog("create")}
              type="button"
            >
              <Plus size={17} /> {t("customerConfig.create")}
            </button>
          </>
        }
      />
      <div className="customer-filters" role="search">
        <label className="field">
          <span>{t("common.search")}</span>
          <input
            onChange={(e) => {
              setSearch(e.target.value);
              setPageNumber(1);
            }}
            placeholder={t("customerConfig.searchPlaceholder")}
            value={search}
          />
        </label>
        <label className="field">
          <span>{t("common.status")}</span>
          <select
            onChange={(e) => {
              setStatus(e.target.value);
              setPageNumber(1);
            }}
            value={status}
          >
            <option value="active">{t("common.active")}</option>
            <option value="disabled">{t("common.disabled")}</option>
            <option value="all">{t("common.all")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("customerConfig.activity")}</span>
          <select
            onChange={(e) => {
              setActivity(e.target.value);
              setPageNumber(1);
            }}
            value={activity}
          >
            <option value="">{t("common.all")}</option>
            <option value="has_orders">{t("customerConfig.hasOrders")}</option>
            <option value="no_orders">{t("customerConfig.noOrders")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("customerConfig.area")}</span>
          <SearchCombobox
            api={api}
            emptyText={t("customerConfig.noAreas")}
            getLabel={areaLabel}
            label={t("customerConfig.area")}
            onChange={(value) => {
              setArea(value);
              setPageNumber(1);
            }}
            path="configuration/areas/search"
            placeholder={t("customerConfig.searchArea")}
            value={area}
          />
        </label>
        <label className="field">
          <span>{t("customerConfig.trader")}</span>
          <SearchCombobox
            api={api}
            emptyText={t("operations.noTradersFound")}
            getLabel={traderLabel}
            label={t("customerConfig.trader")}
            onChange={(value) => {
              setTrader(value);
              setPageNumber(1);
            }}
            path="operations/traders/search"
            placeholder={t("operations.searchTrader")}
            value={trader}
          />
        </label>
        <label className="field">
          <span>{t("customerConfig.sortBy")}</span>
          <select
            onChange={(event) => {
              setSortBy(event.target.value);
              setPageNumber(1);
            }}
            value={sortBy}
          >
            <option value="name">{t("common.name")}</option>
            <option value="code">{t("customerConfig.code")}</option>
            <option value="mobile">{t("customerConfig.mobile")}</option>
            <option value="orderCount">{t("customerConfig.orders")}</option>
            <option value="lastOrderDate">{t("customerConfig.lastOrder")}</option>
            <option value="status">{t("common.status")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("customerConfig.sortDirection")}</span>
          <select onChange={(event) => setSortDirection(event.target.value)} value={sortDirection}>
            <option value="asc">{t("customerConfig.ascending")}</option>
            <option value="desc">{t("customerConfig.descending")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("customerConfig.pageSize")}</span>
          <select
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPageNumber(1);
            }}
            value={pageSize}
          >
            {[25, 50, 100].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>
      <section className="data-panel customer-list-panel" aria-busy={loading}>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {[
                  "code",
                  "name",
                  "mobile",
                  "area",
                  "address",
                  "orders",
                  "lastOrder",
                  "status",
                  "actions",
                ].map((key) => (
                  <th key={key}>{t(`customerConfig.${key}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.code}</strong>
                  </td>
                  <td>{item.name}</td>
                  <td>{item.mobileNumber}</td>
                  <td>{item.area ?? "-"}</td>
                  <td>{item.primaryAddress ?? "-"}</td>
                  <td>{item.orderCount}</td>
                  <td>{item.lastOrderDate ?? "-"}</td>
                  <td>
                    <span className={`status-badge status-${item.status}`}>
                      {t(`common.${item.status}`)}
                    </span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        onClick={() =>
                          onNavigate(`/configuration/customers/${encodeURIComponent(item.code)}`)
                        }
                        type="button"
                      >
                        {t("common.view")}
                      </button>
                      <button
                        onClick={() => {
                          setSelected(item);
                          setDialog("status");
                        }}
                        type="button"
                      >
                        {item.status === "active" ? t("common.disable") : t("common.reactivate")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {page.items.length === 0 && !loading ? (
          <p className="empty-state">{t("customerConfig.noCustomers")}</p>
        ) : null}
        <div className="pagination-row">
          <span>
            {page.total} {t("customerConfig.customers")}
          </span>
          <div>
            <button
              className="button button-secondary"
              disabled={pageNumber === 1}
              onClick={() => setPageNumber((x) => x - 1)}
              type="button"
            >
              {t("common.previous")}
            </button>
            <span>
              {pageNumber} / {Math.max(Math.ceil(page.total / pageSize), 1)}
            </span>
            <button
              className="button button-secondary"
              disabled={pageNumber * pageSize >= page.total}
              onClick={() => setPageNumber((x) => x + 1)}
              type="button"
            >
              {t("common.next")}
            </button>
          </div>
        </div>
      </section>
      {dialog === "create" ? (
        <CustomerFormDialog
          api={api}
          onClose={() => setDialog(undefined)}
          onSaved={(item) => {
            setDialog(undefined);
            onNavigate(`/configuration/customers/${encodeURIComponent(String(item.code))}`);
          }}
        />
      ) : null}
      {dialog === "status" && selected ? (
        <CustomerStatusDialog
          api={api}
          customer={selected}
          onClose={() => setDialog(undefined)}
          onSaved={() => {
            setDialog(undefined);
            setRefresh((x) => x + 1);
          }}
        />
      ) : null}
    </section>
  );
}

export function CustomerDetailWorkspace({
  api,
  code,
  onBack,
  onCreateOrder,
  onNavigate,
}: {
  api: ApiClient;
  code: string;
  onBack: () => void;
  onCreateOrder: () => void;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<CustomerDetail>();
  const [tab, setTab] = useState("overview");
  const [dialog, setDialog] = useState<"edit" | "address" | "addressStatus" | "status">();
  const [selectedAddress, setSelectedAddress] = useState<Record<string, unknown>>();
  const load = useCallback(() => {
    void api
      .get<CustomerDetail>(`configuration/customers/${encodeURIComponent(code)}`)
      .then(setDetail);
  }, [api, code]);
  useEffect(load, [load]);
  if (!detail) return <p>{t("common.loading")}</p>;
  const tabs = ["overview", "addresses", "orders", "notes", "history"];
  return (
    <section>
      <PageHeader
        eyebrow={t("customerConfig.details")}
        title={`${detail.code} - ${detail.name}`}
        actions={
          <>
            <button className="button button-secondary" onClick={onBack} type="button">
              <ArrowLeft size={17} />
              {t("common.back")}
            </button>
            <button
              className="button button-secondary"
              onClick={() => setDialog("edit")}
              type="button"
            >
              <Pencil size={17} />
              {t("common.edit")}
            </button>
            <button className="button button-primary" onClick={onCreateOrder} type="button">
              <Plus size={17} />
              {t("customerConfig.createOrder")}
            </button>
          </>
        }
      />
      <nav className="workspace-tabs" aria-label={t("customerConfig.details")}>
        {tabs.map((name) => (
          <button
            aria-selected={tab === name}
            key={name}
            onClick={() => setTab(name)}
            role="tab"
            type="button"
          >
            {t(`customerConfig.tab.${name}`)}
          </button>
        ))}
      </nav>
      {tab === "overview" ? (
        <div className="customer-detail-grid">
          <Info
            title={t("customerConfig.identity")}
            rows={[
              [t("customerConfig.code"), detail.code],
              [t("common.name"), detail.name],
              [t("common.status"), detail.status],
              [t("customerConfig.createdAt"), new Date(detail.createdAt).toLocaleString()],
              [t("customerConfig.createdBy"), detail.createdBy],
            ]}
          />
          <Info
            title={t("customerConfig.contact")}
            rows={[
              [t("customerConfig.mobile"), detail.mobileNumber],
              [t("customerConfig.secondMobile"), detail.secondMobileNumber],
              [t("customerConfig.email"), detail.email],
              [t("customerConfig.reference"), detail.customerReference],
            ]}
          />
          <section className="detail-panel customer-metrics">
            <h2>{t("customerConfig.activity")}</h2>
            <div className="metric-strip">
              {Object.entries(detail.metrics).map(([key, value]) => (
                <div key={key}>
                  <span>{humanize(key)}</span>
                  <strong>{String(value ?? "-")}</strong>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}
      {tab === "addresses" ? (
        <AddressSection
          customer={detail}
          onAdd={() => setDialog("address")}
          onEdit={(address) => {
            setSelectedAddress(address);
            setDialog("address");
          }}
          onStatus={(address) => {
            setSelectedAddress(address);
            setDialog("addressStatus");
          }}
        />
      ) : null}
      {tab === "orders" ? (
        <RelatedOrdersSection api={api} customerId={detail.id} onNavigate={onNavigate} />
      ) : null}
      {tab === "notes" ? (
        <div className="customer-detail-grid">
          <Info
            title={t("customerConfig.deliveryNotes")}
            rows={[[t("customerConfig.deliveryNotes"), detail.deliveryNotes]]}
          />
          <Info
            title={t("customerConfig.internalNotes")}
            rows={[[t("customerConfig.internalNotes"), detail.internalNotes]]}
          />
        </div>
      ) : null}
      {tab === "history" ? (
        <DataSection
          title={t("customerConfig.audit")}
          columns={[
            "eventType",
            "entityType",
            "actor",
            "actorRole",
            "occurredAt",
            "source",
            "reason",
          ]}
          rows={detail.audit}
        />
      ) : null}
      <div className="detail-actions">
        <button
          className="button button-secondary"
          onClick={() => setDialog("status")}
          type="button"
        >
          {detail.status === "active" ? t("common.disable") : t("common.reactivate")}
        </button>
      </div>
      {dialog === "edit" ? (
        <CustomerFormDialog
          api={api}
          customer={detail}
          onClose={() => setDialog(undefined)}
          onSaved={() => {
            setDialog(undefined);
            load();
          }}
        />
      ) : null}
      {dialog === "address" ? (
        <CustomerAddressDialog
          api={api}
          customerId={detail.id}
          onClose={() => {
            setDialog(undefined);
            setSelectedAddress(undefined);
          }}
          onSaved={() => {
            setDialog(undefined);
            setSelectedAddress(undefined);
            load();
          }}
          {...(selectedAddress === undefined ? {} : { address: selectedAddress })}
        />
      ) : null}
      {dialog === "addressStatus" && selectedAddress ? (
        <CustomerAddressStatusDialog
          address={selectedAddress}
          api={api}
          customerId={detail.id}
          onClose={() => {
            setDialog(undefined);
            setSelectedAddress(undefined);
          }}
          onSaved={() => {
            setDialog(undefined);
            setSelectedAddress(undefined);
            load();
          }}
        />
      ) : null}
      {dialog === "status" ? (
        <CustomerStatusDialog
          api={api}
          customer={detail}
          onClose={() => setDialog(undefined)}
          onSaved={() => {
            setDialog(undefined);
            load();
          }}
        />
      ) : null}
    </section>
  );
}

export function CustomerFormDialog({
  api,
  customer,
  initial,
  onClose,
  onSaved,
  source = "customer_configuration",
}: {
  api: ApiClient;
  customer?: CustomerDetail;
  initial?: Partial<Record<string, string>>;
  onClose: () => void;
  onSaved: (customer: Record<string, unknown>) => void;
  source?: string;
}) {
  const { t } = useTranslation();
  const [area, setArea] = useState<CompanyArea>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [overrideNeeded, setOverrideNeeded] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!customer && !area) {
      setError(t("customerConfig.areaRequired"));
      return;
    }
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const nullableNumber = (name: string) => (text(name) === "" ? undefined : Number(text(name)));
    // Accept 0506468442, 9715XXXXXXXX or +9715XXXXXXXX and store one form.
    const mobileNumber = normalizeUaeMobile(text("mobileNumber"));
    const secondRaw = text("secondMobileNumber");
    const secondMobileNumber = secondRaw === "" ? undefined : normalizeUaeMobile(secondRaw);
    if (mobileNumber === undefined || (secondRaw !== "" && secondMobileNumber === undefined)) {
      setError(t("customerConfig.mobileError"));
      return;
    }
    const body = {
      name: text("name"),
      mobileNumber,
      secondMobileNumber,
      email: text("email") || undefined,
      customerReference: text("customerReference") || undefined,
      deliveryNotes: text("deliveryNotes") || undefined,
      internalNotes: text("internalNotes") || undefined,
      ...(!customer
        ? {
            areaId: area!.id,
            address: text("address"),
            label: text("label") || undefined,
            locationLink: text("locationLink") || undefined,
            latitude: nullableNumber("latitude"),
            longitude: nullableNumber("longitude"),
            deliveryInstructions: text("deliveryInstructions") || undefined,
            duplicateOverrideReason: text("duplicateOverrideReason") || undefined,
            source,
          }
        : {}),
    };
    setSaving(true);
    setError(undefined);
    try {
      const result = customer
        ? await api.patch<Record<string, unknown>>(`configuration/customers/${customer.id}`, body)
        : await api.post<Record<string, unknown>>("configuration/customers", body);
      onSaved(result);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.code === "customer_duplicate") {
        setOverrideNeeded(true);
        setError(t("customerConfig.duplicateFound"));
      } else
        setError(requestError instanceof Error ? requestError.message : t("common.saveFailed"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Modal
        className={customer ? "modal-small" : "trader-modal"}
        closeLabel={t("common.close")}
        onRequestClose={onClose}
        title={customer ? t("customerConfig.edit") : t("customerConfig.create")}
        titleId="customer-form-title"
      >
        <form className={customer ? "" : "customer-form-grid"} onSubmit={(e) => void submit(e)}>
          <label>
            <span>{t("common.name")}</span>
            <input
              autoFocus
              defaultValue={customer?.name ?? initial?.name ?? ""}
              maxLength={160}
              name="name"
              required
            />
          </label>
          <label>
            <span>{t("customerConfig.mobile")}</span>
            <input
              defaultValue={customer?.mobileNumber ?? initial?.mobileNumber ?? ""}
              inputMode="tel"
              maxLength={16}
              name="mobileNumber"
              placeholder={t("common.mobilePlaceholder")}
              required
            />
          </label>
          <label>
            <span>{t("customerConfig.secondMobile")}</span>
            <input
              defaultValue={customer?.secondMobileNumber ?? ""}
              inputMode="tel"
              maxLength={16}
              name="secondMobileNumber"
              placeholder={t("common.mobilePlaceholder")}
            />
          </label>
          <label>
            <span>{t("customerConfig.email")}</span>
            <input defaultValue={customer?.email ?? ""} name="email" type="email" />
          </label>
          <label>
            <span>{t("customerConfig.reference")}</span>
            <input defaultValue={customer?.customerReference ?? ""} name="customerReference" />
          </label>
          {!customer ? (
            <>
              {/* Emirate first, then its Areas; searchable in Arabic or English.
                  The Area Code is never shown, and Add Area is a small inline
                  action beside the field rather than a large block. */}
              <div className="customer-area-span">
                <AreaSelector api={api} onChange={setArea} value={area} />
              </div>
              <label>
                <span>{t("customerConfig.address")}</span>
                <textarea
                  defaultValue={initial?.address ?? ""}
                  maxLength={500}
                  name="address"
                  required
                />
              </label>
              <label>
                <span>{t("customerConfig.addressLabel")}</span>
                <input name="label" />
              </label>
              <label>
                <span>{t("customerConfig.locationLink")}</span>
                <input name="locationLink" type="url" />
              </label>
              <label>
                <span>{t("customerConfig.latitude")}</span>
                <input max="90" min="-90" name="latitude" step="0.000001" type="number" />
              </label>
              <label>
                <span>{t("customerConfig.longitude")}</span>
                <input max="180" min="-180" name="longitude" step="0.000001" type="number" />
              </label>
              <label>
                <span>{t("customerConfig.deliveryInstructions")}</span>
                <textarea name="deliveryInstructions" />
              </label>
            </>
          ) : null}
          <label>
            <span>{t("customerConfig.deliveryNotes")}</span>
            <textarea defaultValue={customer?.deliveryNotes ?? ""} name="deliveryNotes" />
          </label>
          <label>
            <span>{t("customerConfig.internalNotes")}</span>
            <textarea defaultValue={customer?.internalNotes ?? ""} name="internalNotes" />
          </label>
          {overrideNeeded ? (
            <label className="field-span">
              <span>{t("customerConfig.duplicateReason")}</span>
              <textarea name="duplicateOverrideReason" required />
            </label>
          ) : null}
          {error ? <p className="alert alert-error field-span">{error}</p> : null}
          <div className="modal-actions field-span">
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button className="button button-primary" disabled={saving} type="submit">
              {saving ? t("common.saving") : t("common.save")}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

function AddressSection({
  customer,
  onAdd,
  onEdit,
  onStatus,
}: {
  customer: CustomerDetail;
  onAdd: () => void;
  onEdit: (address: Record<string, unknown>) => void;
  onStatus: (address: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="data-panel">
      <div className="panel-heading">
        <h2>{t("customerConfig.addresses")}</h2>
        <button className="button button-primary" onClick={onAdd} type="button">
          <Plus size={17} />
          {t("customerConfig.addAddress")}
        </button>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {[
                "label",
                "address",
                "areaName",
                "locationLink",
                "deliveryInstructions",
                "isDefault",
                "isActive",
                "actions",
              ].map((x) => (
                <th key={x}>{humanize(x)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {customer.addresses.map((row) => (
              <tr key={String(row.id)}>
                {[
                  "label",
                  "address",
                  "areaName",
                  "locationLink",
                  "deliveryInstructions",
                  "isDefault",
                  "isActive",
                ].map((x) => (
                  <td key={x}>{formatCell(row[x])}</td>
                ))}
                <td>
                  <div className="row-actions">
                    <button onClick={() => onEdit(row)} type="button">
                      {t("common.edit")}
                    </button>
                    <button onClick={() => onStatus(row)} type="button">
                      {row.isActive ? t("common.disable") : t("common.reactivate")}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CustomerAddressDialog({
  address,
  api,
  customerId,
  onClose,
  onSaved,
}: {
  address?: Record<string, unknown>;
  api: ApiClient;
  customerId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [area, setArea] = useState<CompanyArea | undefined>(() =>
    address
      ? {
          // Rebuilt from the saved address snapshot, which stores no Emirate
          // detail; only the identifier and label are used for display.
          code: String(address.areaCode),
          emirateCode: "",
          emirateId: "",
          emirateNameAr: "",
          emirateNameEn: "",
          id: String(address.areaId),
          isActive: true,
          notes: null,
          updatedAt: "",
          nameAr: null,
          nameEn: String(address.areaName),
        }
      : undefined,
  );
  const [error, setError] = useState<string>();
  const areaLabel = useCallback((a: CompanyArea) => `${a.code} - ${a.nameEn}`, []);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!area) {
      setError(t("customerConfig.areaRequired"));
      return;
    }
    const f = new FormData(e.currentTarget);
    const read = (x: string) => String(f.get(x) ?? "").trim();
    const number = (x: string) => (read(x) === "" ? undefined : Number(read(x)));
    try {
      const body = {
        areaId: area.id,
        address: read("address"),
        label: read("label") || undefined,
        locationLink: read("locationLink") || undefined,
        latitude: number("latitude"),
        longitude: number("longitude"),
        deliveryInstructions: read("deliveryInstructions") || undefined,
        isDefault: f.get("isDefault") === "on",
        ...(address ? { isActive: Boolean(address.isActive), reason: read("reason") } : {}),
      };
      if (address) {
        await api.patch(
          `configuration/customers/${customerId}/addresses/${String(address.id)}`,
          body,
        );
      } else {
        await api.post(`configuration/customers/${customerId}/addresses`, body);
      }
      onSaved();
    } catch (x) {
      setError(x instanceof Error ? x.message : t("common.saveFailed"));
    }
  };
  return (
    <Modal
      className="modal-small"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={address ? t("customerConfig.editAddress") : t("customerConfig.addAddress")}
      titleId="customer-address-title"
    >
      <form onSubmit={(e) => void submit(e)}>
        <label>
          <span>{t("customerConfig.area")}</span>
          <SearchCombobox
            api={api}
            emptyText={t("customerConfig.noAreas")}
            getLabel={areaLabel}
            label={t("customerConfig.area")}
            onChange={setArea}
            path="configuration/areas/search"
            placeholder={t("customerConfig.searchArea")}
            value={area}
          />
        </label>
        <label>
          <span>{t("customerConfig.address")}</span>
          <textarea defaultValue={String(address?.address ?? "")} name="address" required />
        </label>
        <label>
          <span>{t("customerConfig.addressLabel")}</span>
          <input defaultValue={String(address?.label ?? "")} name="label" />
        </label>
        <label>
          <span>{t("customerConfig.locationLink")}</span>
          <input
            defaultValue={String(address?.locationLink ?? "")}
            name="locationLink"
            type="url"
          />
        </label>
        <label>
          <span>{t("customerConfig.latitude")}</span>
          <input
            defaultValue={String(address?.latitude ?? "")}
            max="90"
            min="-90"
            name="latitude"
            step="0.000001"
            type="number"
          />
        </label>
        <label>
          <span>{t("customerConfig.longitude")}</span>
          <input
            defaultValue={String(address?.longitude ?? "")}
            max="180"
            min="-180"
            name="longitude"
            step="0.000001"
            type="number"
          />
        </label>
        <label>
          <span>{t("customerConfig.deliveryInstructions")}</span>
          <textarea
            defaultValue={String(address?.deliveryInstructions ?? "")}
            name="deliveryInstructions"
          />
        </label>
        <label className="checkbox-row">
          <input defaultChecked={Boolean(address?.isDefault)} name="isDefault" type="checkbox" />
          <span>{t("customerConfig.defaultAddress")}</span>
        </label>
        {address ? (
          <label>
            <span>{t("common.reason")}</span>
            <textarea name="reason" required />
          </label>
        ) : null}
        {error ? <p className="alert alert-error">{error}</p> : null}
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button className="button button-primary" type="submit">
            {t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CustomerStatusDialog({
  api,
  customer,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  customer: { id: string; name: string; status: "active" | "disabled" };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const active = customer.status === "disabled";
  return (
    <Modal
      className="modal-small"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={active ? t("common.reactivate") : t("common.disable")}
      titleId="customer-status-title"
    >
      <p>{customer.name}</p>
      <label>
        <span>{t("common.reason")}</span>
        <textarea autoFocus onChange={(e) => setReason(e.target.value)} required value={reason} />
      </label>
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={!reason.trim()}
          onClick={() =>
            void api
              .patch(`configuration/customers/${customer.id}/status`, { isActive: active, reason })
              .then(onSaved)
          }
          type="button"
        >
          {active ? t("common.reactivate") : t("common.disable")}
        </button>
      </div>
    </Modal>
  );
}

function CustomerAddressStatusDialog({
  address,
  api,
  customerId,
  onClose,
  onSaved,
}: {
  address: Record<string, unknown>;
  api: ApiClient;
  customerId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const activating = !address.isActive;
  return (
    <Modal
      className="modal-small"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={activating ? t("common.reactivate") : t("common.disable")}
      titleId="customer-address-status-title"
    >
      <p>{String(address.address)}</p>
      <label>
        <span>{t("common.reason")}</span>
        <textarea
          autoFocus
          onChange={(event) => setReason(event.target.value)}
          required
          value={reason}
        />
      </label>
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={!reason.trim()}
          onClick={() =>
            void api
              .patch(
                `configuration/customers/${customerId}/addresses/${String(address.id)}/status`,
                { isActive: activating, isDefault: activating, reason },
              )
              .then(onSaved)
          }
          type="button"
        >
          {activating ? t("common.reactivate") : t("common.disable")}
        </button>
      </div>
    </Modal>
  );
}

function Info({
  title,
  rows,
}: {
  title: string;
  rows: readonly (readonly [string, string | null])[];
}) {
  return (
    <section className="detail-panel">
      <h2>
        <UserRound size={18} />
        {title}
      </h2>
      <dl>
        {rows.map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value || "-"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function RelatedOrdersSection({
  api,
  customerId,
  onNavigate,
}: {
  api: ApiClient;
  customerId: string;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [pageNumber, setPageNumber] = useState(1);
  const [page, setPage] = useState<CustomerPage<Record<string, unknown>>>({
    items: [],
    page: 1,
    pageSize: 10,
    total: 0,
  });
  useEffect(() => {
    const controller = new AbortController();
    void api
      .get<CustomerPage<Record<string, unknown>>>(
        `configuration/customers/${customerId}/orders?page=${pageNumber}&pageSize=10`,
        controller.signal,
      )
      .then(setPage);
    return () => controller.abort();
  }, [api, customerId, pageNumber]);
  const columns = [
    "orderNumber",
    "orderDate",
    "trader",
    "area",
    "addressSnapshot",
    "amountToCollect",
    "assignedDriver",
    "deliveryStatus",
    "driverCashStatus",
    "traderSettlementStatus",
  ];
  return (
    <section className="data-panel">
      <div className="panel-heading">
        <h2>{t("customerConfig.relatedOrders")}</h2>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{humanize(column)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.items.map((row) => (
              <tr key={String(row.id)}>
                {columns.map((column) => (
                  <td key={column}>
                    {column === "orderNumber" ? (
                      <button
                        className="link-button"
                        onClick={() =>
                          onNavigate(`/orders/${encodeURIComponent(String(row[column]))}`)
                        }
                        type="button"
                      >
                        {formatCell(row[column])}
                      </button>
                    ) : (
                      formatCell(row[column])
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page.items.length === 0 ? (
        <p className="empty-state">{t("customerConfig.noOrders")}</p>
      ) : null}
      <div className="pagination-row">
        <span>{page.total}</span>
        <div>
          <button
            className="button button-secondary"
            disabled={pageNumber === 1}
            onClick={() => setPageNumber((value) => value - 1)}
            type="button"
          >
            {t("common.previous")}
          </button>
          <span>{pageNumber}</span>
          <button
            className="button button-secondary"
            disabled={pageNumber * page.pageSize >= page.total}
            onClick={() => setPageNumber((value) => value + 1)}
            type="button"
          >
            {t("common.next")}
          </button>
        </div>
      </div>
    </section>
  );
}

function DataSection({
  title,
  columns,
  rows,
}: {
  title: string;
  columns: readonly string[];
  rows: readonly Record<string, unknown>[];
}) {
  return (
    <section className="data-panel">
      <div className="panel-heading">
        <h2>{title}</h2>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{humanize(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={String(row.id ?? index)}>
                {columns.map((c) => (
                  <td key={c}>{formatCell(row[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? <p className="empty-state">No records</p> : null}
    </section>
  );
}
function humanize(value: string) {
  return value.replaceAll(/([A-Z])/g, " $1").replace(/^./, (x) => x.toUpperCase());
}
function formatCell(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
