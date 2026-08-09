import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  Pencil,
  Plus,
  RefreshCw,
  Store,
  WalletCards,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import type { CompanyArea, Emirate, TraderPage, TraderSummary } from "../../api/contracts.js";
import { BusinessAccessPanel } from "../administration/BusinessAccessPanel.js";
import { normalizeLocale } from "../../localization/locale.js";
import { normalizeUaeMobile } from "../../domain/uae-mobile.js";
import { Modal } from "../../components/Modal.js";
import { AreaSelector } from "./AreaSelector.js";
import { PageHeader } from "../../components/PageHeader.js";

type Detail = {
  audit: readonly Record<string, unknown>[];
  banks: readonly Record<string, unknown>[];
  code: string;
  commercialNumber: string | null;
  contactPerson: string | null;
  createdAt: string;
  createdBy: string | null;
  email: string | null;
  id: string;
  latitude: string | null;
  legacyArabicName: string | null;
  locationLink: string | null;
  longitude: string | null;
  mobileNumber: string;
  mobileWarning: boolean;
  name: string;
  notes: string | null;
  orders: TraderPage<Record<string, unknown>>;
  pickupAddress: string | null;
  pickupArea: string | null;
  pickupAreaId: string | null;
  pricing: readonly Record<string, unknown>[];
  secondMobileNumber: string | null;
  settlements: Record<string, unknown>;
  status: "active" | "disabled";
  taxRegistrationNumber: string | null;
};

interface PricingRow {
  areaId: string | null;
  areaNameAr: string | null;
  areaNameEn: string | null;
  emirateId: string | null;
  emirateNameAr: string | null;
  emirateNameEn: string | null;
  id: string;
  reason: string | null;
  serviceFee: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string | null;
}

export function TraderConfigurationWorkspace({
  api,
  onNavigate,
}: {
  api: ApiClient;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState<TraderPage<TraderSummary>>({
    items: [],
    page: 1,
    pageSize: 25,
    total: 0,
  });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [pricing, setPricing] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState<TraderSummary>();

  const load = useCallback(
    async (target = 1) => {
      setLoading(true);
      setError(undefined);
      try {
        const params = new URLSearchParams({
          page: String(target),
          pageSize: String(page.pageSize),
          search,
          status,
        });
        if (pricing) params.set("pricingType", pricing);
        setPage(
          await api.get<TraderPage<TraderSummary>>(`configuration/traders?${params.toString()}`),
        );
      } catch {
        setError(t("common.loadFailed"));
      } finally {
        setLoading(false);
      }
    },
    [api, page.pageSize, pricing, search, status, t],
  );
  useEffect(() => void load(), [load]);

  return (
    <>
      <PageHeader
        eyebrow={t("nav.configuration")}
        title={t("traderConfig.title")}
        actions={
          <>
            <button
              className="button button-secondary"
              onClick={() => void load(page.page)}
              type="button"
            >
              <RefreshCw size={17} />
              {t("common.refresh")}
            </button>
            <button
              className="button button-primary"
              onClick={() => setCreateOpen(true)}
              type="button"
            >
              <Plus size={17} />
              {t("traderConfig.create")}
            </button>
          </>
        }
      />
      <section className="filter-bar trader-filters" aria-label={t("traderConfig.filters")}>
        <label>
          <span>{t("common.search")}</span>
          <input
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("traderConfig.searchPlaceholder")}
            value={search}
          />
        </label>
        <label>
          <span>{t("common.status")}</span>
          <select onChange={(e) => setStatus(e.target.value)} value={status}>
            <option value="active">{t("common.active")}</option>
            <option value="disabled">{t("common.disabled")}</option>
            <option value="">{t("common.all")}</option>
          </select>
        </label>
        <label>
          <span>{t("traderConfig.pricingType")}</span>
          <select onChange={(e) => setPricing(e.target.value)} value={pricing}>
            <option value="">{t("common.all")}</option>
            <option value="configured">{t("traderConfig.configured")}</option>
            <option value="not_configured">{t("traderConfig.notConfigured")}</option>
          </select>
        </label>
      </section>
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="data-panel trader-list-panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("traderConfig.code")}</th>
                <th>{t("common.name")}</th>
                <th>{t("traderConfig.mobile")}</th>
                <th>{t("traderConfig.contact")}</th>
                <th>{t("traderConfig.pickupArea")}</th>
                <th>{t("traderConfig.pricingType")}</th>
                <th>{t("traderConfig.outstanding")}</th>
                <th>{t("common.status")}</th>
                <th>{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.code}</strong>
                  </td>
                  <td>{item.name}</td>
                  <td>
                    {item.mobileNumber}
                    {item.mobileWarning ? (
                      <AlertTriangle
                        className="inline-warning"
                        size={15}
                        aria-label={t("traderConfig.legacyMobile")}
                      />
                    ) : null}
                  </td>
                  <td>{item.contactPerson ?? "-"}</td>
                  <td>{item.pickupArea ?? "-"}</td>
                  <td>
                    {item.pricingType === null
                      ? t("traderConfig.notConfigured")
                      : t("traderConfig.rulesConfigured", { count: item.priceRuleCount ?? 0 })}
                    {item.currentServiceFee
                      ? ` · AED ${Number(item.currentServiceFee).toFixed(2)}`
                      : ""}
                  </td>
                  <td>AED {Number(item.outstandingAmount).toFixed(2)}</td>
                  <td>
                    <span className={`status-badge status-${item.status}`}>
                      {t(`common.${item.status}`)}
                    </span>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="link-button"
                        onClick={() =>
                          onNavigate(`/configuration/traders/${encodeURIComponent(item.code)}`)
                        }
                        type="button"
                      >
                        {t("common.view")}
                      </button>
                      <button
                        className="link-button"
                        onClick={() => setStatusTarget(item)}
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
        {loading ? (
          <p className="empty-state">{t("common.loading")}</p>
        ) : page.items.length === 0 ? (
          <p className="empty-state">{t("traderConfig.none")}</p>
        ) : null}
        <div className="pagination">
          <button
            className="button button-secondary"
            disabled={page.page <= 1}
            onClick={() => void load(page.page - 1)}
            type="button"
          >
            {t("common.previous")}
          </button>
          <span>
            {page.page} / {Math.max(Math.ceil(page.total / page.pageSize), 1)}
          </span>
          <button
            className="button button-secondary"
            disabled={page.page * page.pageSize >= page.total}
            onClick={() => void load(page.page + 1)}
            type="button"
          >
            {t("common.next")}
          </button>
        </div>
      </section>
      {createOpen ? (
        <TraderForm
          api={api}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            void load();
          }}
        />
      ) : null}
      {statusTarget ? (
        <StatusDialog
          api={api}
          item={statusTarget}
          onClose={() => setStatusTarget(undefined)}
          onSaved={() => {
            setStatusTarget(undefined);
            void load(page.page);
          }}
        />
      ) : null}
    </>
  );
}

export function TraderDetailWorkspace({
  api,
  code,
  onBack,
}: {
  api: ApiClient;
  code: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<Detail>();
  const [tab, setTab] = useState("overview");
  const [dialog, setDialog] = useState<"bank" | "edit" | "pricing" | "status">();
  const [pricingEdit, setPricingEdit] = useState<PricingRow>();
  const [bankEdit, setBankEdit] = useState<Record<string, unknown>>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      setDetail(await api.get<Detail>(`configuration/traders/${encodeURIComponent(code)}`));
    } catch {
      setError(t("common.loadFailed"));
    }
  }, [api, code, t]);
  useEffect(() => void load(), [load]);
  if (!detail)
    return (
      <>
        <button className="button button-secondary" onClick={onBack} type="button">
          <ArrowLeft size={17} />
          {t("common.back")}
        </button>
        <p className={error ? "alert alert-error" : "empty-state"}>
          {error ?? t("common.loading")}
        </p>
      </>
    );
  const tabs = ["overview", "portalUsers", "pricing", "banks", "orders", "settlements", "audit"];
  return (
    <>
      <PageHeader
        eyebrow={t("traderConfig.details")}
        title={`${detail.code} · ${detail.name}`}
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
            <button
              className="button button-primary"
              onClick={() => setDialog("pricing")}
              type="button"
            >
              <Plus size={17} />
              {t("traderConfig.addPricing")}
            </button>
            <a
              className="button button-secondary"
              href={`/trader-settlements?openStatement=true&statementTraderId=${encodeURIComponent(detail.id)}`}
            >
              {t("traderSettlements.accountStatement")}
            </a>
          </>
        }
      />
      {detail.mobileWarning ? (
        <p className="alert alert-warning">
          <AlertTriangle size={17} />
          {t("traderConfig.legacyMobile")}
        </p>
      ) : null}
      <nav className="workspace-tabs" aria-label={t("traderConfig.details")}>
        {tabs.map((name) => (
          <button
            aria-selected={tab === name}
            key={name}
            onClick={() => setTab(name)}
            role="tab"
            type="button"
          >
            {t(`traderConfig.tab.${name}`)}
          </button>
        ))}
      </nav>
      {tab === "overview" ? (
        <div className="trader-detail-grid">
          <Info
            title={t("traderConfig.identity")}
            icon={<Store size={18} />}
            rows={[
              [t("traderConfig.code"), detail.code],
              [t("common.name"), detail.name],
              [t("common.status"), detail.status],
              [t("traderConfig.commercial"), detail.commercialNumber],
              [t("traderConfig.trn"), detail.taxRegistrationNumber],
              [t("traderConfig.created"), new Date(detail.createdAt).toLocaleString()],
            ]}
          />
          <Info
            title={t("traderConfig.contactPickup")}
            icon={<Building2 size={18} />}
            rows={[
              [t("traderConfig.contact"), detail.contactPerson],
              [t("traderConfig.mobile"), detail.mobileNumber],
              [t("traderConfig.secondMobile"), detail.secondMobileNumber],
              [t("traderConfig.email"), detail.email],
              [t("traderConfig.pickupArea"), detail.pickupArea],
              [t("traderConfig.address"), detail.pickupAddress],
            ]}
          />
        </div>
      ) : null}
      {tab === "pricing" ? (
        <PricingSection
          rows={detail.pricing as unknown as readonly PricingRow[]}
          onAdd={() => {
            setPricingEdit(undefined);
            setDialog("pricing");
          }}
          onEdit={(row) => {
            setPricingEdit(row);
            setDialog("pricing");
          }}
        />
      ) : null}
      {tab === "portalUsers" ? (
        <BusinessAccessPanel
          api={api}
          entityId={String(detail.id)}
          kind="trader"
          onNavigate={(path) => globalThis.location.assign(path)}
        />
      ) : null}
      {tab === "banks" ? (
        <BankSection
          rows={detail.banks}
          onAdd={() => {
            setBankEdit(undefined);
            setDialog("bank");
          }}
          onEdit={(bank) => {
            setBankEdit(bank);
            setDialog("bank");
          }}
        />
      ) : null}
      {tab === "orders" ? (
        <DataSection
          title={t("traderConfig.relatedOrders")}
          columns={[
            "orderNumber",
            "orderDate",
            "customer",
            "area",
            "amountToCollect",
            "serviceFee",
            "deliveryStatus",
            "driverCashStatus",
            "traderSettlementStatus",
          ]}
          rows={detail.orders.items}
        />
      ) : null}
      {tab === "settlements" ? (
        <>
          <div className="metric-grid">
            <Metric
              label={t("traderConfig.outstanding")}
              value={`AED ${Number(detail.settlements.outstandingAmount ?? 0).toFixed(2)}`}
            />
            <Metric
              label={t("traderConfig.unsettledOrders")}
              value={String(detail.settlements.unsettledOrders ?? 0)}
            />
            <Metric
              label={t("traderConfig.moneySent")}
              value={`AED ${Number(detail.settlements.moneySent ?? 0).toFixed(2)}`}
            />
            <Metric
              label={t("traderConfig.lastSettlement")}
              value={String(detail.settlements.lastSettlementDate ?? "-")}
            />
          </div>
          <DataSection
            title={t("traderConfig.settlementHistory")}
            columns={[
              "settlementNumber",
              "businessDate",
              "netPayable",
              "status",
              "paymentMethod",
              "bankReference",
            ]}
            rows={
              (detail.settlements.history as readonly Record<string, unknown>[] | undefined) ?? []
            }
          />
        </>
      ) : null}
      {tab === "audit" ? (
        <DataSection
          title={t("traderConfig.audit")}
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
        <TraderForm
          api={api}
          detail={detail}
          onClose={() => setDialog(undefined)}
          onSaved={() => {
            setDialog(undefined);
            void load();
          }}
        />
      ) : null}
      {dialog === "pricing" ? (
        <PricingDialog
          editing={pricingEdit}
          api={api}
          trader={detail}
          onClose={() => setDialog(undefined)}
          onSaved={() => {
            setDialog(undefined);
            void load();
          }}
        />
      ) : null}
      {dialog === "bank" ? (
        <BankDialog
          api={api}
          bank={bankEdit}
          trader={detail}
          onClose={() => setDialog(undefined)}
          onSaved={() => {
            setDialog(undefined);
            void load();
          }}
        />
      ) : null}
      {dialog === "status" ? (
        <StatusDialog
          api={api}
          item={{ id: detail.id, name: detail.name, status: detail.status } as TraderSummary}
          onClose={() => setDialog(undefined)}
          onSaved={() => {
            setDialog(undefined);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

export function TraderForm({
  api,
  detail,
  onClose,
  onSaved,
  primaryLabel,
  title,
}: {
  api: ApiClient;
  detail?: Detail;
  onClose: () => void;
  onSaved: (created?: Record<string, unknown>) => void;
  primaryLabel?: string;
  title?: string;
}) {
  const { t } = useTranslation();
  const [pickupArea, setPickupArea] = useState<CompanyArea | undefined>();
  const [mobileError, setMobileError] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  // Resolve the saved pickup Area so editing shows Emirate and Area already
  // filled in, including an Area that has since been disabled.
  useEffect(() => {
    const areaId = detail?.pickupAreaId;
    if (areaId === undefined || areaId === null) return;
    let active = true;
    void api
      .get<CompanyArea>(`configuration/areas/${areaId}`)
      .then((area) => active && setPickupArea(area))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, detail?.pickupAreaId]);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    const formElement = e.currentTarget;
    const f = new FormData(formElement);
    // Accept 0506468442, 9715XXXXXXXX or +9715XXXXXXXX and store one form.
    const mobile = normalizeUaeMobile(String(f.get("mobileNumber")));
    const secondRaw = String(f.get("secondMobileNumber") ?? "").trim();
    const secondMobile = secondRaw === "" ? undefined : normalizeUaeMobile(secondRaw);
    if (mobile === undefined || (secondRaw !== "" && secondMobile === undefined)) {
      setMobileError(t("traderConfig.mobileError"));
      setSaving(false);
      /* Move the caret to the field that stopped the save. A short line of red
         text under one field of a tall modal is easy to miss -- the reported
         symptom was "nothing happens and there is no error" when the message
         was in fact on screen the whole time. Focusing scrolls it into view and
         announces it, since the input owns `aria-describedby`. */
      const invalid = mobile === undefined ? "mobileNumber" : "secondMobileNumber";
      const field = formElement.elements.namedItem(invalid);
      if (field instanceof HTMLInputElement) field.focus();
      return;
    }
    setMobileError(undefined);
    const body = {
      name: String(f.get("name")),
      mobileNumber: mobile,
      secondMobileNumber: secondMobile,
      contactPerson: String(f.get("contactPerson")) || undefined,
      email: String(f.get("email")) || undefined,
      commercialNumber: String(f.get("commercialNumber")) || undefined,
      taxRegistrationNumber: String(f.get("taxRegistrationNumber")) || undefined,
      pickupAreaId: pickupArea?.id,
      pickupAddress: String(f.get("pickupAddress")) || undefined,
      notes: String(f.get("notes")) || undefined,
    };
    try {
      if (detail) {
        await api.patch(`configuration/traders/${detail.id}`, body);
        onSaved();
      } else {
        const created = await api.post<Record<string, unknown>>("configuration/traders", body);
        /* A 204 or an empty body resolves to `undefined`, and the Order flow's
           `onSaved` quietly returns when it gets that -- leaving the dialog open
           with no message and nothing saved. Treat it as the failure it is. */
        if (created?.id === undefined) {
          setError(t("common.saveFailed"));
          return;
        }
        onSaved(created);
      }
    } catch (caught) {
      /* Show what the backend actually said. Every rejection used to collapse
         into one generic sentence, so a duplicate mobile, an Area that is no
         longer active and a missing permission were indistinguishable -- and
         the operator had nothing to act on. The API envelope is already safe to
         display: `api-exception.filter` replaces 5xx and raw database errors
         with generic text and only lets through the operator-facing message of
         a deliberate ApplicationException. */
      const failure = caught as {
        code?: string;
        details?: readonly string[];
        message?: string;
        status?: number;
      };
      if (failure.code === "trader_mobile_invalid") {
        // Belongs against the field, not in the banner at the bottom.
        setMobileError(failure.message ?? t("traderConfig.mobileError"));
      } else {
        const detailed = failure.details?.length ? failure.details.join(" ") : undefined;
        const message = detailed ?? failure.message ?? t("common.saveFailed");
        /* `request_failed` is the client's own fallback code, used when the
           response carried no error envelope at all -- the API never returns
           it. That means the reply did not come from the API: a dev-proxy
           error while it restarts, a gateway in front of it, or a body that is
           not JSON. The bare message is a dead end for the operator and for
           support, so the status is appended to make it traceable. */
        setError(
          failure.code === "request_failed"
            ? `${message} (HTTP ${failure.status ?? "?"})`
            : message,
        );
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      className="modal-wide trader-modal"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={title ?? (detail ? t("traderConfig.edit") : t("traderConfig.create"))}
      titleId="trader-form-title"
    >
      <form onSubmit={(e) => void submit(e)}>
        <div className="form-grid">
          <label className="field required-field">
            <span>{t("common.name")}</span>
            <input autoFocus defaultValue={detail?.name} name="name" required />
          </label>
          <div className="field-group">
            <label className="field required-field">
              <span>{t("traderConfig.mobile")}</span>
              <input
                aria-describedby={mobileError === undefined ? undefined : "trader-mobile-error"}
                aria-invalid={mobileError !== undefined}
                defaultValue={detail?.mobileNumber}
                inputMode="tel"
                name="mobileNumber"
                placeholder={t("common.mobilePlaceholder")}
                required
              />
            </label>
            {mobileError === undefined ? null : (
              <small className="field-error" id="trader-mobile-error" role="alert">
                {mobileError}
              </small>
            )}
          </div>
          <label className="field">
            <span>{t("traderConfig.secondMobile")}</span>
            <input
              defaultValue={detail?.secondMobileNumber ?? ""}
              inputMode="tel"
              name="secondMobileNumber"
              placeholder={t("common.mobilePlaceholder")}
            />
          </label>
          <label className="field">
            <span>{t("traderConfig.contact")}</span>
            <input defaultValue={detail?.contactPerson ?? ""} name="contactPerson" />
          </label>
          <label className="field">
            <span>{t("traderConfig.email")}</span>
            <input defaultValue={detail?.email ?? ""} name="email" type="email" />
          </label>
          <label className="field">
            <span>{t("traderConfig.commercial")}</span>
            <input defaultValue={detail?.commercialNumber ?? ""} name="commercialNumber" />
          </label>
          <label className="field">
            <span>{t("traderConfig.trn")}</span>
            <input
              defaultValue={detail?.taxRegistrationNumber ?? ""}
              name="taxRegistrationNumber"
            />
          </label>
          {/* Pickup Emirate then Area, searchable in Arabic or English. The
              Area Code is never shown or entered here. */}
          <div className="field-wide">
            <AreaSelector
              api={api}
              areaLabel={t("traderConfig.pickupArea")}
              emirateLabel={t("traderConfig.pickupEmirate")}
              includeDisabled={detail !== undefined}
              onChange={setPickupArea}
              value={pickupArea}
            />
          </div>
          <label className="field field-wide">
            <span>{t("traderConfig.address")}</span>
            <textarea defaultValue={detail?.pickupAddress ?? ""} name="pickupAddress" rows={3} />
          </label>
          <label className="field field-wide">
            <span>{t("traderConfig.notes")}</span>
            <textarea defaultValue={detail?.notes ?? ""} name="notes" rows={3} />
          </label>
        </div>
        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button className="button button-primary" disabled={saving} type="submit">
            {saving ? t("common.saving") : (primaryLabel ?? t("common.save"))}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Add or edit one Trader price rule. Scope is Emirate + Area, where "All Areas"
 * is an Emirate default and "All Emirates" is the single global (flat) price.
 * Editing keeps the scope fixed and only changes the fee and reason.
 */
export function PricingDialog({
  api,
  editing,
  trader,
  onClose,
  onSaved,
  primaryLabel,
  title,
}: {
  api: ApiClient;
  editing?: PricingRow | undefined;
  trader: Pick<Detail, "code" | "id" | "name">;
  onClose: () => void;
  onSaved: () => void;
  primaryLabel?: string;
  title?: string;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const isEdit = editing !== undefined;

  const [emirates, setEmirates] = useState<readonly Emirate[]>([]);
  const [areas, setAreas] = useState<readonly CompanyArea[]>([]);
  const [emirateId, setEmirateId] = useState(editing?.emirateId ?? "");
  const [areaId, setAreaId] = useState(editing?.areaId ?? "");
  const [serviceFee, setServiceFee] = useState(editing?.serviceFee ?? "");
  const [reason, setReason] = useState(editing?.reason ?? "");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.get<readonly Emirate[]>("configuration/emirates").then(setEmirates);
  }, [api]);

  // Areas depend on the chosen Emirate; there are none for the global row.
  useEffect(() => {
    if (isEdit || emirateId === "") {
      setAreas([]);
      return;
    }
    let active = true;
    void api
      .get<{ items: readonly CompanyArea[] }>(
        `configuration/areas/search?emirateId=${encodeURIComponent(emirateId)}&limit=50&offset=0`,
      )
      .then((page) => active && setAreas(page.items));
    return () => {
      active = false;
    };
  }, [api, emirateId, isEdit]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      if (isEdit) {
        await api.patch(`configuration/traders/${trader.id}/pricing/${editing.id}`, {
          reason: reason.trim() || undefined,
          serviceFee: Number(serviceFee),
        });
      } else {
        await api.post(`configuration/traders/${trader.id}/pricing`, {
          areaId: areaId === "" ? undefined : areaId,
          emirateId: emirateId === "" ? undefined : emirateId,
          reason: reason.trim() || undefined,
          serviceFee: Number(serviceFee),
        });
      }
      onSaved();
    } catch (caught) {
      const code = (caught as { code?: string }).code;
      setError(
        code === "pricing_scope_exists"
          ? t("traderConfig.pricingDuplicate")
          : t("traderConfig.pricingError"),
      );
      setSaving(false);
    }
  };

  const emirateName = (emirate: Emirate) => (locale === "ar" ? emirate.nameAr : emirate.nameEn);

  return (
    <Modal
      className="modal-small"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={title ?? (isEdit ? t("traderConfig.editPricing") : t("traderConfig.addPricing"))}
      titleId="pricing-title"
    >
      <form className="form-grid-single" onSubmit={(event) => void submit(event)}>
        <p className="modal-subtitle">
          {trader.code} · {trader.name}
        </p>

        {isEdit ? (
          <p className="field-hint">
            {editing.emirateId === null
              ? t("traderConfig.allEmirates")
              : locale === "ar"
                ? editing.emirateNameAr
                : editing.emirateNameEn}
            {" · "}
            {editing.areaId === null
              ? t("traderConfig.allAreas")
              : locale === "ar"
                ? editing.areaNameAr
                : editing.areaNameEn}
          </p>
        ) : (
          <>
            <label className="field">
              <span>{t("areas.emirate")}</span>
              <select
                onChange={(event) => {
                  setEmirateId(event.target.value);
                  setAreaId("");
                }}
                value={emirateId}
              >
                <option value="">{t("traderConfig.allEmirates")}</option>
                {emirates.map((emirate) => (
                  <option key={emirate.id} value={emirate.id}>
                    {emirateName(emirate)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("areas.area")}</span>
              <select
                disabled={emirateId === ""}
                onChange={(event) => setAreaId(event.target.value)}
                value={areaId}
              >
                <option value="">{t("traderConfig.allAreas")}</option>
                {areas.map((area) => (
                  <option key={area.id} value={area.id}>
                    {locale === "ar" ? (area.nameAr ?? area.nameEn) : area.nameEn}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        <label className="field required-field">
          <span>{t("traderConfig.serviceFee")}</span>
          <input
            autoFocus={isEdit}
            min="0"
            onChange={(event) => setServiceFee(event.target.value)}
            required
            step="0.01"
            type="number"
            value={serviceFee}
          />
        </label>
        <label className="field">
          <span>{t("common.reason")}</span>
          <textarea onChange={(event) => setReason(event.target.value)} rows={2} value={reason} />
        </label>

        {error ? <p className="alert alert-error">{error}</p> : null}
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button className="button button-primary" disabled={saving} type="submit">
            {saving ? t("common.working") : (primaryLabel ?? t("common.save"))}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function BankDialog({
  api,
  bank,
  trader,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  bank: Record<string, unknown> | undefined;
  trader: Detail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      bankName: String(f.get("bankName")),
      accountName: String(f.get("accountName")),
      accountNumber: String(f.get("accountNumber")),
      iban: String(f.get("iban")),
      swiftCode: String(f.get("swiftCode")) || undefined,
      isDefault: f.get("isDefault") === "on",
      notes: String(f.get("notes")) || undefined,
    };
    try {
      if (bank)
        await api.patch(
          `configuration/traders/${trader.id}/bank-accounts/${String(bank.id)}`,
          body,
        );
      else await api.post(`configuration/traders/${trader.id}/bank-accounts`, body);
      onSaved();
    } catch {
      setError(t("common.saveFailed"));
    }
  };
  return (
    <Modal
      className="modal-small"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={bank ? t("traderConfig.editBank") : t("traderConfig.addBank")}
      titleId="bank-title"
    >
      <form onSubmit={(e) => void submit(e)}>
        <label>
          <span>{t("traderConfig.bankName")}</span>
          <input autoFocus defaultValue={String(bank?.bankName ?? "")} name="bankName" required />
        </label>
        <label>
          <span>{t("traderConfig.accountName")}</span>
          <input defaultValue={String(bank?.accountName ?? "")} name="accountName" required />
        </label>
        <label>
          <span>{t("traderConfig.accountNumber")}</span>
          <input defaultValue={String(bank?.accountNumber ?? "")} name="accountNumber" required />
        </label>
        <label>
          <span>IBAN</span>
          <input defaultValue={String(bank?.iban ?? "")} name="iban" required />
        </label>
        <label>
          <span>SWIFT</span>
          <input defaultValue={String(bank?.swiftCode ?? "")} name="swiftCode" />
        </label>
        <label className="checkbox-row">
          <input defaultChecked={Boolean(bank?.isDefault)} name="isDefault" type="checkbox" />
          <span>{t("traderConfig.defaultBank")}</span>
        </label>
        <label>
          <span>{t("traderConfig.notes")}</span>
          <textarea defaultValue={String(bank?.notes ?? "")} name="notes" />
        </label>
        {error ? <p className="alert alert-error">{error}</p> : null}
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button className="button button-primary" type="submit">
            <WalletCards size={17} />
            {t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function StatusDialog({
  api,
  item,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  item: TraderSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const active = item.status !== "active";
  return (
    <Modal
      className="modal-small"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={active ? t("common.reactivate") : t("common.disable")}
      titleId="trader-status-title"
    >
      <p>{item.name}</p>
      <label>
        <span>{t("common.reason")}</span>
        <textarea autoFocus onChange={(e) => setReason(e.target.value)} required value={reason} />
      </label>
      {error ? <p className="alert alert-error">{error}</p> : null}
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={!reason.trim()}
          onClick={() =>
            void api
              .patch(`configuration/traders/${item.id}/status`, { isActive: active, reason })
              .then(onSaved)
              .catch(() => setError(t("common.saveFailed")))
          }
          type="button"
        >
          {t("common.confirm")}
        </button>
      </div>
    </Modal>
  );
}

function Info({
  title,
  icon,
  rows,
}: {
  title: string;
  icon: React.ReactNode;
  rows: readonly (readonly [string, string | null])[];
}) {
  return (
    <section className="detail-panel">
      <h2>
        {icon}
        {title}
      </h2>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v || "-"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}
function BankSection({
  rows,
  onAdd,
  onEdit,
}: {
  rows: readonly Record<string, unknown>[];
  onAdd: () => void;
  onEdit: (row: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="data-panel">
      <div className="panel-heading">
        <h2>{t("traderConfig.bankAccounts")}</h2>
        <button className="button button-primary" onClick={onAdd} type="button">
          <Plus size={17} />
          {t("traderConfig.addBank")}
        </button>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {["bankName", "accountName", "iban", "currency", "isDefault", "isActive"].map((c) => (
                <th key={c}>{humanize(c)}</th>
              ))}
              <th>{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={String(row.id)}>
                {["bankName", "accountName", "iban", "currency", "isDefault", "isActive"].map(
                  (c) => (
                    <td key={c}>{formatCell(row[c], c)}</td>
                  ),
                )}
                <td>
                  <button className="link-button" onClick={() => onEdit(row)} type="button">
                    {t("common.edit")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
/**
 * Trader price rules, shown Emirate + Area with the wildcard scopes spelled out
 * ("All Emirates", "All Areas") rather than blank cells. Each row is editable.
 */
function PricingSection({
  rows,
  onAdd,
  onEdit,
}: {
  rows: readonly PricingRow[];
  onAdd: () => void;
  onEdit: (row: PricingRow) => void;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  const emirateCell = (row: PricingRow) =>
    row.emirateId === null
      ? t("traderConfig.allEmirates")
      : ((locale === "ar" ? row.emirateNameAr : row.emirateNameEn) ?? "-");
  const areaCell = (row: PricingRow) =>
    row.areaId === null
      ? t("traderConfig.allAreas")
      : ((locale === "ar" ? row.areaNameAr : row.areaNameEn) ?? "-");

  return (
    <section className="data-panel">
      <div className="panel-heading">
        <h2>{t("traderConfig.pricingHistory")}</h2>
        <button className="button button-primary" onClick={onAdd} type="button">
          <Plus size={17} />
          {t("traderConfig.addPricing")}
        </button>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("areas.emirate")}</th>
              <th>{t("areas.area")}</th>
              <th>{t("traderConfig.serviceFee")}</th>
              <th>{t("traderConfig.updatedAt")}</th>
              <th>{t("traderConfig.createdBy")}</th>
              <th>{t("common.reason")}</th>
              <th>
                <span className="sr-only">{t("common.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{emirateCell(row)}</td>
                <td>{areaCell(row)}</td>
                <td>AED {Number(row.serviceFee).toFixed(2)}</td>
                <td>{row.updatedAt.slice(0, 16).replace("T", " ")}</td>
                <td>{row.createdBy}</td>
                <td>{row.reason ?? "-"}</td>
                <td>
                  <button onClick={() => onEdit(row)} type="button">
                    {t("common.edit")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? <p className="empty-state">{t("traderConfig.noPricing")}</p> : null}
    </section>
  );
}

function DataSection({
  title,
  action,
  columns,
  rows,
}: {
  title: string;
  action?: React.ReactNode;
  columns: readonly string[];
  rows: readonly Record<string, unknown>[];
}) {
  return (
    <section className="data-panel">
      <div className="panel-heading">
        <h2>{title}</h2>
        {action}
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
            {rows.map((r, i) => (
              <tr key={String(r.id ?? r.orderNumber ?? i)}>
                {columns.map((c) => (
                  <td key={c}>{formatCell(r[c], c)}</td>
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
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}
function formatCell(value: unknown, key: string) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (["serviceFee", "amountToCollect"].includes(key)) return `AED ${Number(value).toFixed(2)}`;
  return String(value);
}
