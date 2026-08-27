import {
  AlertTriangle,
  FilePlus2,
  Pencil,
  Plus,
  RefreshCw,
  UserRoundCheck,
  UserRoundX,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import type { DriverSummary, EmployeeSummary, WorkforcePage } from "../../api/contracts.js";
import { Modal } from "../../components/Modal.js";
import { PageHeader } from "../../components/PageHeader.js";
import { BusinessAccessPanel } from "../administration/BusinessAccessPanel.js";
import { parseMoneyInput } from "../../utils/numeric-input.js";

type WorkforceKind = "employees" | "drivers";
type Detail = Record<string, unknown>;
type VariableEarningRule = {
  amount: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  id: string;
  isCurrent: boolean;
  paymentType?: string;
};
type VariableEarningRules = {
  collection: VariableEarningRule[];
  delivery: VariableEarningRule[];
};

export function WorkforceConfigurationWorkspace({
  api,
  kind,
  onNavigate,
}: {
  api: ApiClient;
  kind: WorkforceKind;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState<WorkforcePage<EmployeeSummary | DriverSummary>>({
    items: [],
    page: 1,
    pageSize: 25,
    total: 0,
  });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [type, setType] = useState("");
  const [expiry, setExpiry] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [form, setForm] = useState<{ detail?: Detail; mode: "create" | "edit" }>();
  const [statusTarget, setStatusTarget] = useState<EmployeeSummary | DriverSummary>();
  const [allowanceDialog, setAllowanceDialog] = useState(false);

  const load = useCallback(
    async (targetPage = 1) => {
      setLoading(true);
      setError(undefined);
      try {
        const params = new URLSearchParams({
          documentExpiry: expiry,
          page: String(targetPage),
          pageSize: String(page.pageSize),
          search,
          status,
        });
        if (type !== "") params.set(kind === "drivers" ? "driverType" : "employeeType", type);
        setPage(
          await api.get<WorkforcePage<EmployeeSummary | DriverSummary>>(
            `configuration/${kind}?${params.toString()}`,
          ),
        );
      } catch {
        setError(t("common.loadFailed"));
      } finally {
        setLoading(false);
      }
    },
    [api, expiry, kind, page.pageSize, search, status, t, type],
  );

  useEffect(() => void load(1), [load]);

  const edit = async (item: EmployeeSummary | DriverSummary) => {
    try {
      setForm({
        detail: await api.get<Detail>(`configuration/${kind}/${item.code}`),
        mode: "edit",
      });
    } catch {
      setError(t("common.loadFailed"));
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={t("nav.configuration")}
        title={t(kind === "employees" ? "workforce.employees" : "workforce.drivers")}
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
              onClick={() => setForm({ mode: "create" })}
              type="button"
            >
              <Plus size={17} />
              {t(kind === "employees" ? "workforce.createEmployee" : "workforce.createDriver")}
            </button>
            {kind === "employees" ? (
              <button
                className="button button-secondary"
                onClick={() => setAllowanceDialog(true)}
                type="button"
              >
                {t("workforce.allowanceTypes")}
              </button>
            ) : null}
          </>
        }
      />
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <section className="workforce-filters" aria-label={t("workforce.filters")}>
        <label className="field">
          <span>{t("common.search")}</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("workforce.searchPlaceholder")}
            value={search}
          />
        </label>
        <label className="field">
          <span>{t("workforce.status")}</span>
          <select onChange={(event) => setStatus(event.target.value)} value={status}>
            <option value="active">{t("status.active")}</option>
            <option value="disabled">{t("status.disabled")}</option>
            <option value="all">{t("common.all")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t(kind === "drivers" ? "workforce.driverType" : "workforce.employeeType")}</span>
          <select onChange={(event) => setType(event.target.value)} value={type}>
            <option value="">{t("common.all")}</option>
            {kind === "drivers" ? (
              <>
                <option value="employee">{t("workforce.employeeDriver")}</option>
                <option value="outsourced">{t("workforce.outsourcedDriver")}</option>
              </>
            ) : null}
          </select>
        </label>
        <label className="field">
          <span>{t("workforce.documentExpiry")}</span>
          <select onChange={(event) => setExpiry(event.target.value)} value={expiry}>
            <option value="all">{t("common.all")}</option>
            <option value="expiring_soon">{t("workforce.expiringSoon")}</option>
            <option value="expired">{t("workforce.expired")}</option>
          </select>
        </label>
      </section>
      <div className="data-surface workforce-table-wrap">
        <table className="workforce-table">
          <thead>
            <tr>
              {kind === "employees" ? (
                <>
                  <th>{t("workforce.employeeCode")}</th>
                  <th>{t("workforce.name")}</th>
                  <th>{t("workforce.mobile")}</th>
                  <th>{t("workforce.jobTitle")}</th>
                  <th>{t("workforce.basicSalary")}</th>
                </>
              ) : (
                <>
                  <th>{t("workforce.driverCode")}</th>
                  <th>{t("workforce.name")}</th>
                  <th>{t("workforce.mobile")}</th>
                  <th>{t("workforce.driverType")}</th>
                  <th>{t("workforce.linkedEmployee")}</th>
                  <th>{t("workforce.commission")}</th>
                </>
              )}
              <th>{t("workforce.documents")}</th>
              <th>{t("workforce.status")}</th>
              <th>
                <span className="sr-only">{t("common.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((item) => (
              <tr key={item.id}>
                {kind === "employees" ? (
                  <EmployeeCells item={item as EmployeeSummary} />
                ) : (
                  <DriverCells item={item as DriverSummary} t={t} />
                )}
                <td>
                  <ExpiryBadge status={item.documentStatus} t={t} />
                </td>
                <td>
                  <span className={`status status-${item.status}`}>
                    {t(item.status === "active" ? "status.active" : "status.disabled")}
                  </span>
                </td>
                <td>
                  <div className="row-actions">
                    <button
                      onClick={() =>
                        onNavigate(`/configuration/${kind}/${encodeURIComponent(item.code)}`)
                      }
                      type="button"
                    >
                      {t("common.view")}
                    </button>
                    <button
                      aria-label={t("common.edit")}
                      onClick={() => void edit(item)}
                      type="button"
                    >
                      <Pencil size={16} />
                    </button>
                    {kind === "drivers" ? (
                      <button
                        aria-label={t(
                          item.status === "active" ? "workforce.disable" : "workforce.activate",
                        )}
                        onClick={() => setStatusTarget(item)}
                        type="button"
                      >
                        {item.status === "active" ? (
                          <UserRoundX size={17} />
                        ) : (
                          <UserRoundCheck size={17} />
                        )}
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
            {page.items.length === 0 && !loading ? (
              <tr>
                <td className="empty-state" colSpan={kind === "employees" ? 9 : 10}>
                  {t("workforce.noRecords")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {loading ? <div className="loading-row">{t("common.loading")}</div> : null}
        <footer className="pagination-row">
          <span>{t("workforce.total", { count: page.total })}</span>
          <div>
            <button
              disabled={page.page <= 1}
              onClick={() => void load(page.page - 1)}
              type="button"
            >
              {t("common.previous")}
            </button>
            <span>{page.page}</span>
            <button
              disabled={page.page * page.pageSize >= page.total}
              onClick={() => void load(page.page + 1)}
              type="button"
            >
              {t("common.next")}
            </button>
          </div>
        </footer>
      </div>
      {form === undefined ? null : (
        <WorkforceForm
          api={api}
          mode={form.mode}
          onClose={() => setForm(undefined)}
          onSaved={async () => {
            setForm(undefined);
            await load(page.page);
          }}
          {...(form.detail === undefined ? {} : { detail: form.detail })}
        />
      )}
      {statusTarget === undefined ? null : (
        <StatusDialog
          api={api}
          kind={kind}
          target={statusTarget}
          onClose={() => setStatusTarget(undefined)}
          onSaved={async () => {
            setStatusTarget(undefined);
            await load(page.page);
          }}
        />
      )}
      {allowanceDialog ? (
        <AllowanceTypesDialog api={api} onClose={() => setAllowanceDialog(false)} />
      ) : null}
    </>
  );
}

function AllowanceTypesDialog({ api, onClose }: { api: ApiClient; onClose: () => void }) {
  const { t } = useTranslation();
  const [types, setTypes] = useState<Detail[]>([]);
  const load = useCallback(
    async () => setTypes(await api.get<Detail[]>("configuration/allowance-types")),
    [api],
  );
  useEffect(() => void load(), [load]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await api.post("configuration/allowance-types", {
      code: String(data.get("code")),
      name: String(data.get("name")),
    });
    event.currentTarget.reset();
    await load();
  };
  return (
    <Modal
      className="modal-small"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("workforce.allowanceTypes")}
      titleId="allowance-types-title"
    >
      <form onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>{t("workforce.code")}</span>
          <input name="code" required />
        </label>
        <label className="field">
          <span>{t("workforce.name")}</span>
          <input name="name" required />
        </label>
        <button className="button button-primary" type="submit">
          {t("common.save")}
        </button>
      </form>
      <ul className="simple-list">
        {types.map((type) => (
          <li key={String(type.id)}>
            <strong>{String(type.code)}</strong>
            <span>{String(type.name)}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function EmployeeCells({ item }: { item: EmployeeSummary }) {
  return (
    <>
      <td>
        <strong>{item.code}</strong>
      </td>
      <td>{item.name}</td>
      <td>{item.mobileNumber ?? "-"}</td>
      <td>{item.jobTitle ?? "-"}</td>
      <td>{money(item.basicSalary)}</td>
    </>
  );
}
function DriverCells({ item, t }: { item: DriverSummary; t: (key: string) => string }) {
  return (
    <>
      <td>
        <strong>{item.code}</strong>
      </td>
      <td>{item.name}</td>
      <td>{item.mobileNumber}</td>
      <td>
        {t(item.type === "employee" ? "workforce.employeeDriver" : "workforce.outsourcedDriver")}
      </td>
      <td>{item.linkedEmployee ?? "-"}</td>
      <td>
        {item.commissionMethod === null
          ? "-"
          : `${item.commissionMethod} ${item.commissionRate ?? ""}`}
      </td>
    </>
  );
}
function ExpiryBadge({ status, t }: { status: string; t: (key: string) => string }) {
  return (
    <span className={`expiry-badge expiry-${status}`}>
      {status !== "valid" ? <AlertTriangle size={14} /> : null}
      {t(`workforce.${status}`)}
    </span>
  );
}

function WorkforceForm({
  api,
  detail,
  mode,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  detail?: Detail;
  mode: "create" | "edit";
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [allowanceTypes, setAllowanceTypes] = useState<Detail[]>([]);
  const [roles, setRoles] = useState<Detail[]>([]);
  const [roleId, setRoleId] = useState(String(detail?.employee_role_id ?? ""));
  // Engagement (Employee vs Outsourced) only applies to driver roles; edit
  // reads it from the linked Driver's type.
  const [engagement, setEngagement] = useState(String(detail?.driver_type ?? "employee"));
  const [addRoleOpen, setAddRoleOpen] = useState(false);
  const [earningRules, setEarningRules] = useState<VariableEarningRules>();
  const [deliveryEnabled, setDeliveryEnabled] = useState(false);
  const [collectionType, setCollectionType] = useState("none");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const initialEmployeeActive = detail?.is_active !== false;
  const [employeeActive, setEmployeeActive] = useState(initialEmployeeActive);
  const selectedRole = roles.find((role) => String(role.id) === roleId);
  const isDriverRole = Boolean(selectedRole?.isDriverRole);
  const salaried = !isDriverRole || engagement === "employee";
  const employeeStatusChanged =
    mode === "create" ? !employeeActive : employeeActive !== initialEmployeeActive;

  useEffect(() => {
    void api
      .get<Detail[]>("configuration/allowance-types")
      .then((result) => setAllowanceTypes(Array.isArray(result) ? result : []));
    void api
      .get<Detail[]>("configuration/employee-roles")
      .then((result) => setRoles(Array.isArray(result) ? result : []));
    if (mode === "edit" && detail?.id && detail.driver_type) {
      void api
        .get<VariableEarningRules>(`configuration/employees/${String(detail.id)}/variable-earnings`)
        .then((result) => {
          setEarningRules(result);
          setDeliveryEnabled(result.delivery.some((rule) => rule.isCurrent));
          setCollectionType(
            result.collection.find((rule) => rule.isCurrent)?.paymentType ?? "none",
          );
        });
    }
  }, [api]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const data = new FormData(formElement);
    setSaving(true);
    setError(undefined);
    setFieldErrors({});
    // Every refusal surfaces at the TOP of the form and scrolls there. The
    // inline per-field messages alone sit below the fold of this tall modal,
    // which made a rejected Save look like a Save that did nothing.
    const showFormError = (message: string) => {
      setError(message);
      formElement.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    try {
      if (mode === "edit" && employeeStatusChanged) {
        const id = String(detail?.id ?? "");
        await api.patch(`configuration/employees/${id}/status`, {
          isActive: employeeActive,
          reason: String(data.get("statusReason") ?? ""),
        });
        await onSaved();
        return;
      }
      const basicSalary = parseMoneyInput(String(data.get("basicSalary") ?? "0"));
      const outsourcedFee = parseMoneyInput(String(data.get("outsourcedFee") ?? "0"));
      const allowanceAmounts = Array.from({ length: 4 }, (_, index) =>
        parseMoneyInput(String(data.get(`allowanceAmount${index}`) ?? "0")),
      );
      const deliveryAmount = parseMoneyInput(String(data.get("deliveryAmount") ?? "0"));
      const collectionAmount = parseMoneyInput(String(data.get("collectionAmount") ?? "0"));
      const deliveryFrom = String(data.get("deliveryFrom") ?? "");
      const deliveryTo = optional(data, "deliveryTo");
      const collectionFrom = String(data.get("collectionFrom") ?? "");
      const collectionTo = optional(data, "collectionTo");
      const earningErrors: Record<string, string> = {};
      if (isDriverRole && engagement === "employee" && deliveryEnabled) {
        if (!deliveryAmount.ok || deliveryAmount.value <= 0)
          earningErrors.deliveryAmount = t("workforce.positiveAmountRequired");
        if (!deliveryFrom) earningErrors.deliveryFrom = t("workforce.dateRequired");
        if (deliveryTo && deliveryTo <= deliveryFrom)
          earningErrors.deliveryTo = t("workforce.invalidDateRange");
      }
      if (isDriverRole && collectionType !== "none") {
        if (!collectionAmount.ok || collectionAmount.value <= 0)
          earningErrors.collectionAmount = t("workforce.positiveAmountRequired");
        if (!collectionFrom) earningErrors.collectionFrom = t("workforce.dateRequired");
        if (collectionTo && collectionTo <= collectionFrom)
          earningErrors.collectionTo = t("workforce.invalidDateRange");
      }
      if (Object.keys(earningErrors).length > 0) {
        setFieldErrors(earningErrors);
        showFormError(t("workforce.variableEarningInvalid"));
        return;
      }
      if (!basicSalary.ok || !outsourcedFee.ok || allowanceAmounts.some((amount) => !amount.ok)) {
        showFormError(t("workforce.invalidAmount"));
        return;
      }
      const common = {
        // The code is backend-generated and never submitted.
        address: optional(data, "address"),
        areaId: optional(data, "areaId"),
        email: optional(data, "email"),
        joiningDate: optional(data, "joiningDate"),
        mobileNumber: String(data.get("mobileNumber") ?? ""),
        name: String(data.get("name") ?? ""),
        notes: optional(data, "notes"),
        secondMobileNumber: optional(data, "secondMobileNumber"),
      };
      // Salary + allowances, shared by employees and employee-type Drivers.
      const compensation = {
        allowances: Array.from({ length: 4 }, (_, index) => {
          const allowanceAmount = allowanceAmounts[index];
          return {
            allowanceTypeId: optional(data, `allowanceType${index}`),
            amount: allowanceAmount?.ok === true ? allowanceAmount.value : 0,
            effectiveFrom: String(data.get(`allowanceFrom${index}`) ?? today()),
            effectiveTo: optional(data, `allowanceTo${index}`),
          };
        }).filter((item) => item.allowanceTypeId !== undefined && item.amount >= 0),
        basicSalary: basicSalary.value,
        department: optional(data, "department"),
        jobTitle: optional(data, "jobTitle"),
        salaryEffectiveFrom: String(data.get("salaryEffectiveFrom") ?? today()),
      };
      if (roleId === "") {
        showFormError(t("workforce.roleRequired"));
        setSaving(false);
        return;
      }
      if (isDriverRole && common.mobileNumber.trim() === "") {
        showFormError(t("workforce.driverMobileRequired"));
        setSaving(false);
        return;
      }
      const payload = {
        ...common,
        employeeRoleId: roleId,
        payrollEligible: salaried && data.get("payrollEligible") === "on",
        ...(isDriverRole ? { engagement } : {}),
        ...(salaried ? compensation : { outsourcedFeePerDeliveredOrder: outsourcedFee.value }),
      };
      const id = String(detail?.id ?? "");
      // Everything is created through the Employee endpoint; a driver-role
      // Employee is turned into an operational Driver on the server.
      const saved =
        mode === "create"
          ? await api.post<Detail>("configuration/employees", payload)
          : await api.patch<Detail>(`configuration/employees/${id}`, payload);
      const employeeId = String(saved.id ?? id);
      const currentDelivery = earningRules?.delivery.find((rule) => rule.isCurrent);
      const deliveryChanged =
        deliveryEnabled &&
        (currentDelivery === undefined ||
          Number(currentDelivery.amount) !== (deliveryAmount.ok ? deliveryAmount.value : 0) ||
          currentDelivery.effectiveFrom !== deliveryFrom ||
          (currentDelivery.effectiveTo ?? "") !== (deliveryTo ?? ""));
      if (isDriverRole && engagement === "employee" && deliveryChanged) {
        await api.post(`configuration/employees/${employeeId}/variable-earnings/delivery`, {
          amountPerOrder: deliveryAmount.ok ? deliveryAmount.value : 0,
          effectiveFrom: deliveryFrom,
          ...(deliveryTo ? { effectiveTo: deliveryTo } : {}),
        });
      }
      const currentCollection = earningRules?.collection.find((rule) => rule.isCurrent);
      const collectionChanged =
        currentCollection === undefined
          ? collectionType !== "none"
          : currentCollection.paymentType !== collectionType ||
            Number(currentCollection.amount) !==
              (collectionType === "none" ? 0 : collectionAmount.ok ? collectionAmount.value : 0) ||
            currentCollection.effectiveFrom !== collectionFrom ||
            (currentCollection.effectiveTo ?? "") !== (collectionTo ?? "");
      if (isDriverRole && collectionChanged) {
        await api.post(`configuration/employees/${employeeId}/variable-earnings/collection`, {
          amount: collectionType === "none" ? 0 : collectionAmount.ok ? collectionAmount.value : 0,
          collectionPaymentType: collectionType,
          effectiveFrom: collectionFrom || today(),
          ...(collectionTo ? { effectiveTo: collectionTo } : {}),
        });
      }
      if (employeeStatusChanged) {
        await api.patch(`configuration/employees/${String(saved.id ?? id)}/status`, {
          isActive: employeeActive,
          reason: String(data.get("statusReason") ?? ""),
        });
      }
      await onSaved();
    } catch (caught) {
      const earningError =
        caught instanceof ApiError &&
        [
          "employee_delivery_rate_invalid",
          "employee_collection_rate_invalid",
          "employee_earning_period_invalid",
        ].includes(caught.code)
          ? t("workforce.variableEarningInvalid")
          : caught instanceof ApiError && caught.code.includes("overlap")
            ? t("workforce.variableEarningOverlap")
            : undefined;
      showFormError(
        earningError ??
          (caught instanceof ApiError && caught.code === "employee_salary_effective_date_overlap"
            ? t("workforce.salaryEffectiveDateConflict")
            : caught instanceof ApiError && caught.code === "driver_employee_mobile_required"
              ? t("workforce.driverMobileRequired")
              : t("common.saveFailed")),
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      className="modal-wide workforce-modal"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t(mode === "create" ? "workforce.createEmployee" : "common.edit")}
      titleId="workforce-form-title"
    >
      {/* noValidate: this form already has its own validation (earningErrors,
          fieldErrors, showFormError) with visible messages. Without it, the
          browser's NATIVE constraint validation (e.g. the delivery amount's
          min="0.01") silently blocks submission before `submit` ever runs â€”
          and its tooltip is invisible when the offending field is scrolled
          out of view in this tall modal, which read as "Save does nothing". */}
      <form noValidate onSubmit={(event) => void submit(event)}>
        {error === undefined ? null : <div className="alert alert-error">{error}</div>}
        <div className="workforce-form-grid">
          <fieldset>
            <legend>{t("workforce.basicInformation")}</legend>
            <label className="field">
              <span>{t("workforce.employeeCode")}</span>
              {/* Backend-generated; shown read-only, never typed. */}
              <input
                readOnly
                value={String(
                  detail?.employee_number ?? detail?.code ?? t("workforce.autoGenerated"),
                )}
              />
            </label>
            <label className="field">
              <span>{t("workforce.name")}</span>
              <input
                defaultValue={String(detail?.name_en ?? "")}
                maxLength={160}
                name="name"
                required
              />
            </label>
            {/* Role drives everything: a driver role makes the Employee an
                operational Driver and unlocks the engagement choice. */}
            <label className="field">
              <span>{t("workforce.role")}</span>
              <select onChange={(event) => setRoleId(event.target.value)} required value={roleId}>
                <option value="">{t("workforce.selectRole")}</option>
                {/* An Employee already assigned a Role that has since been
                    removed (deactivated) keeps that assignment -- roleId still
                    holds it -- but the now-filtered `roles` list no longer
                    offers it as an <option>, which would otherwise make the
                    <select> render with nothing visibly matching `value`, even
                    though the real selection is intact. Show it explicitly so
                    the form never looks blank for a value it actually holds. */}
                {roleId !== "" && !roles.some((role) => String(role.id) === roleId) ? (
                  <option value={roleId}>{t("workforce.inactiveRoleFallback")}</option>
                ) : null}
                {roles.map((role) => (
                  <option key={String(role.id)} value={String(role.id)}>
                    {String(role.nameEn ?? role.name_en ?? role.name)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button button-link"
              onClick={() => setAddRoleOpen(true)}
              type="button"
            >
              {t("workforce.addRole")}
            </button>
            {isDriverRole ? (
              <label className="field">
                <span>{t("workforce.engagement")}</span>
                <select onChange={(event) => setEngagement(event.target.value)} value={engagement}>
                  <option value="employee">{t("workforce.engagementEmployee")}</option>
                  <option value="outsourced">{t("workforce.engagementOutsourced")}</option>
                </select>
              </label>
            ) : null}
            {isDriverRole && engagement === "outsourced" ? (
              <label className="field">
                <span>{t("workforce.outsourcedFee")}</span>
                <input
                  defaultValue={String(detail?.outsourced_fee_per_delivered_order ?? "0")}
                  min="0"
                  name="outsourcedFee"
                  step="0.01"
                  type="number"
                />
              </label>
            ) : null}
            <label className="field">
              <span>{t("workforce.employeeStatus")}</span>
              <select
                name="employeeStatus"
                onChange={(event) => setEmployeeActive(event.target.value === "active")}
                value={employeeActive ? "active" : "disabled"}
              >
                <option value="active">{t("status.active")}</option>
                <option value="disabled">{t("status.disabled")}</option>
              </select>
            </label>
            {employeeStatusChanged ? (
              <label className="field">
                <span>{t("workforce.statusChangeReason")}</span>
                <textarea maxLength={500} name="statusReason" required />
              </label>
            ) : null}
          </fieldset>
          <fieldset>
            <legend>{t("workforce.contact")}</legend>
            <label className="field">
              <span>{t("workforce.mobile")}{isDriverRole ? " *" : ""}</span>
              <input
                autoComplete="tel"
                defaultValue={String(detail?.mobile_number ?? "")}
                inputMode="tel"
                name="mobileNumber"
                placeholder={t("common.mobilePlaceholder")}
                required
              />
            </label>
            <label className="field">
              <span>{t("workforce.secondMobile")}</span>
              <input
                autoComplete="tel"
                defaultValue={String(detail?.second_mobile_number ?? "")}
                inputMode="tel"
                name="secondMobileNumber"
                placeholder={t("common.mobilePlaceholder")}
              />
            </label>
            <label className="field">
              <span>{t("workforce.email")}</span>
              <input defaultValue={String(detail?.email ?? "")} name="email" type="email" />
            </label>
            <label className="field">
              <span>{t("workforce.address")}</span>
              <textarea defaultValue={String(detail?.address ?? "")} name="address" />
            </label>
          </fieldset>
          {salaried ? (
            <fieldset>
              <legend>{t("workforce.employment")}</legend>
              <label className="field">
                <span>{t("workforce.jobTitle")}</span>
                <input defaultValue={String(detail?.job_title ?? "")} name="jobTitle" />
              </label>
              <label className="field">
                <span>{t("workforce.department")}</span>
                <input defaultValue={String(detail?.department ?? "")} name="department" />
              </label>
              <label className="field">
                <span>{t("workforce.joiningDate")}</span>
                <input
                  defaultValue={String(detail?.hired_on ?? "")}
                  name="joiningDate"
                  type="date"
                />
              </label>
            </fieldset>
          ) : null}
          {/* Shown in BOTH modes since 2026-08-15: creating a Driver used to
              require save â†’ reopen â†’ edit just to enter the earning rates.
              The rules are posted right after the create call returns the new
              employee id. */}
          {isDriverRole ? (
            <DriverVariableEarningsFields
              collectionType={collectionType}
              deliveryEnabled={deliveryEnabled}
              engagement={engagement}
              errors={fieldErrors}
              onCollectionType={setCollectionType}
              onDeliveryEnabled={setDeliveryEnabled}
              {...(earningRules ? { rules: earningRules } : {})}
              t={t}
            />
          ) : null}
          {salaried ? (
            <fieldset>
              <legend>{t("workforce.compensation")}</legend>
              <label className="field">
                <span>{t("workforce.basicSalary")}</span>
                <input
                  defaultValue={String(detail?.basic_salary ?? "0")}
                  min="0"
                  name="basicSalary"
                  step="0.01"
                  type="number"
                  required
                />
              </label>
              <label className="field">
                <span>{t("workforce.effectiveFrom")}</span>
                <input
                  defaultValue={String(detail?.salary_effective_from ?? today())}
                  name="salaryEffectiveFrom"
                  type="date"
                  required
                />
              </label>
              <label className="field-checkbox">
                <input
                  defaultChecked={detail?.payroll_eligible === true}
                  name="payrollEligible"
                  type="checkbox"
                />
                <span>{t("workforce.payrollEligible")}</span>
              </label>
              <p className="field-help">{t("workforce.payrollEligibleHint")}</p>
              {allowanceTypes.length === 0 ? (
                <p className="field-help">{t("workforce.allowanceDeferredHint")}</p>
              ) : (
                Array.from({ length: 4 }, (_, index) => (
                  <div className="allowance-line" key={index}>
                    <select
                      aria-label={`${t("workforce.allowance")} ${index + 1}`}
                      name={`allowanceType${index}`}
                    >
                      <option value="">{t("workforce.noAllowance")}</option>
                      {allowanceTypes.map((type) => (
                        <option key={String(type.id)} value={String(type.id)}>
                          {String(type.name)}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label={`${t("workforce.amount")} ${index + 1}`}
                      min="0"
                      name={`allowanceAmount${index}`}
                      placeholder="0.00"
                      step="0.01"
                      type="number"
                    />
                    <input
                      aria-label={`${t("workforce.effectiveFrom")} ${index + 1}`}
                      defaultValue={today()}
                      name={`allowanceFrom${index}`}
                      type="date"
                    />
                    <input
                      aria-label={`${t("workforce.effectiveTo")} ${index + 1}`}
                      name={`allowanceTo${index}`}
                      type="date"
                    />
                  </div>
                ))
              )}
            </fieldset>
          ) : null}
          <fieldset>
            <legend>{t("workforce.notes")}</legend>
            <label className="field">
              <span>{t("workforce.notes")}</span>
              <textarea defaultValue={String(detail?.notes ?? "")} name="notes" />
            </label>
          </fieldset>
        </div>
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button className="button button-primary" disabled={saving} type="submit">
            {saving ? t("common.working") : t("common.save")}
          </button>
        </div>
      </form>
      {addRoleOpen ? (
        <AddRoleDialog
          api={api}
          onClose={() => setAddRoleOpen(false)}
          onRoleRemoved={(removedId) => {
            setRoles((current) => current.filter((role) => String(role.id) !== removedId));
            // The role removed from THIS employee's own picker while its form
            // is still open, if it was the one selected -- clearing it here
            // (rather than leaving a now-invisible selection) makes the
            // required-field validation on submit catch it, instead of
            // silently resubmitting a role no longer offered.
            if (roleId === removedId) setRoleId("");
          }}
          onSaved={(role) => {
            setRoles((current) => [...current, role]);
            setRoleId(String(role.id));
            if (!role.isDriverRole) setEngagement("employee");
            setAddRoleOpen(false);
          }}
          roles={roles}
        />
      ) : null}
    </Modal>
  );
}

function DriverVariableEarningsFields({
  collectionType,
  deliveryEnabled,
  engagement,
  errors,
  onCollectionType,
  onDeliveryEnabled,
  rules,
  t,
}: {
  collectionType: string;
  deliveryEnabled: boolean;
  engagement: string;
  errors: Record<string, string>;
  onCollectionType: (value: string) => void;
  onDeliveryEnabled: (value: boolean) => void;
  rules?: VariableEarningRules;
  t: (key: string) => string;
}) {
  const delivery = rules?.delivery.find((rule) => rule.isCurrent);
  const collection = rules?.collection.find((rule) => rule.isCurrent);
  const history = [...(rules?.delivery ?? []), ...(rules?.collection ?? [])].filter(
    (rule) => !rule.isCurrent,
  );
  return (
    <fieldset data-testid="driver-variable-earnings">
      <legend>{t("workforce.driverVariableEarnings")}</legend>
      {engagement === "employee" ? (
        <section>
          <h3>{t("workforce.deliveryEarnings")}</h3>
          <label className="field-checkbox">
            <input
              checked={deliveryEnabled}
              onChange={(event) => onDeliveryEnabled(event.target.checked)}
              type="checkbox"
            />
            <span>{t("workforce.eligibleDeliveryEarnings")}</span>
          </label>
          {deliveryEnabled ? (
            <>
              <EarningInput
                {...(errors.deliveryAmount ? { error: errors.deliveryAmount } : {})}
                label={t("workforce.feePerDeliveredOrder")}
                name="deliveryAmount"
                value={delivery?.amount ?? ""}
              />
              <EarningDate
                {...(errors.deliveryFrom ? { error: errors.deliveryFrom } : {})}
                label={t("workforce.effectiveFrom")}
                name="deliveryFrom"
                value={delivery?.effectiveFrom ?? today()}
              />
              <EarningDate
                {...(errors.deliveryTo ? { error: errors.deliveryTo } : {})}
                label={t("workforce.effectiveTo")}
                name="deliveryTo"
                value={delivery?.effectiveTo ?? ""}
              />
            </>
          ) : null}
        </section>
      ) : null}
      <section>
        <h3>{t("workforce.collectionEarnings")}</h3>
        <label className="field">
          <span>{t("workforce.collectionPaymentType")}</span>
          <select
            name="collectionType"
            onChange={(event) => onCollectionType(event.target.value)}
            value={collectionType}
          >
            <option value="none">{t("workforce.collectionNone")}</option>
            <option value="per_collected_order">{t("workforce.perCollectedOrder")}</option>
          </select>
        </label>
        {collectionType !== "none" ? (
          <>
            <EarningInput
              {...(errors.collectionAmount ? { error: errors.collectionAmount } : {})}
              label={t("workforce.amountAed")}
              name="collectionAmount"
              value={collection?.amount ?? ""}
            />
            <EarningDate
              {...(errors.collectionFrom ? { error: errors.collectionFrom } : {})}
              label={t("workforce.effectiveFrom")}
              name="collectionFrom"
              value={collection?.effectiveFrom ?? today()}
            />
            <EarningDate
              {...(errors.collectionTo ? { error: errors.collectionTo } : {})}
              label={t("workforce.effectiveTo")}
              name="collectionTo"
              value={collection?.effectiveTo ?? ""}
            />
          </>
        ) : null}
      </section>
      {history.length > 0 ? (
        <details>
          <summary>{t("workforce.rateHistory")}</summary>
          <ul className="simple-list">
            {history.map((rule) => (
              <li key={rule.id}>
                {rule.amount} AED Â· {rule.effectiveFrom} â€“ {rule.effectiveTo ?? "â€”"}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </fieldset>
  );
}

function EarningInput({
  error,
  label,
  name,
  value,
}: {
  error?: string;
  label: string;
  name: string;
  value: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        aria-invalid={Boolean(error)}
        defaultValue={value}
        min="0.01"
        name={name}
        step="0.01"
        type="number"
      />
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}
function EarningDate({
  error,
  label,
  name,
  value,
}: {
  error?: string;
  label: string;
  name: string;
  value: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input aria-invalid={Boolean(error)} defaultValue={value} name={name} type="date" />
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}

/**
 * Inline creation of a configurable Employee role from the Employee form,
 * plus removal of an existing one. Removal is a soft deactivate
 * (employee_roles.is_active), never a hard delete: it only drops the role
 * from this list and the Employee form's picker going forward. Any Employee
 * already on that role keeps their assignment untouched -- see
 * setEmployeeRoleStatus's own comment for why.
 */
function AddRoleDialog({
  api,
  onClose,
  onRoleRemoved,
  onSaved,
  roles,
}: {
  api: ApiClient;
  onClose: () => void;
  onRoleRemoved: (roleId: string) => void;
  onSaved: (role: Detail & { id: string; isDriverRole?: boolean }) => void;
  roles: readonly Detail[];
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [isDriverRole, setIsDriverRole] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [removingId, setRemovingId] = useState<string>();
  const [removeError, setRemoveError] = useState<string>();
  const removeRole = async (role: Detail) => {
    const roleId = String(role.id);
    const label = String(role.nameEn ?? role.name_en ?? role.name ?? "");
    if (!window.confirm(t("workforce.removeRoleConfirm", { role: label }))) return;
    setRemoveError(undefined);
    setRemovingId(roleId);
    try {
      await api.patch(`configuration/employee-roles/${roleId}/status`, { isActive: false });
      onRoleRemoved(roleId);
    } catch {
      setRemoveError(t("workforce.roleDeactivateFailed"));
    } finally {
      setRemovingId(undefined);
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const role = await api.post<Detail & { id: string; isDriverRole?: boolean }>(
        "configuration/employee-roles",
        { isDriverRole, name: name.trim() },
      );
      onSaved(role);
    } catch (caught) {
      const code = (caught as { code?: string }).code;
      setError(code === "role_exists" ? t("workforce.roleExists") : t("common.saveFailed"));
      setSaving(false);
    }
  };
  return (
    <Modal
      className="modal-small"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("workforce.manageRoles")}
      titleId="add-role-title"
    >
      <section className="workforce-roles-list">
        <h3>{t("workforce.existingRoles")}</h3>
        {removeError === undefined ? null : <div className="alert alert-error">{removeError}</div>}
        {roles.length === 0 ? (
          <p className="field-hint">{t("workforce.noRolesYet")}</p>
        ) : (
          <ul className="workforce-roles-list__items">
            {roles.map((role) => {
              const roleId = String(role.id);
              return (
                <li key={roleId}>
                  <span>{String(role.nameEn ?? role.name_en ?? role.name)}</span>
                  <button
                    className="button button-link"
                    disabled={removingId === roleId}
                    onClick={() => void removeRole(role)}
                    type="button"
                  >
                    {removingId === roleId ? t("common.working") : t("workforce.removeRole")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <form className="form-grid-single" onSubmit={(event) => void submit(event)}>
        {error === undefined ? null : <div className="alert alert-error">{error}</div>}
        <label className="field required-field">
          <span>{t("workforce.roleName")}</span>
          <input
            autoFocus
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
        </label>
        <label className="checkbox-label">
          <input
            checked={isDriverRole}
            onChange={(event) => setIsDriverRole(event.target.checked)}
            type="checkbox"
          />
          <span>{t("workforce.isDriverRole")}</span>
        </label>
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button className="button button-primary" disabled={saving} type="submit">
            {saving ? t("common.working") : t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function StatusDialog({
  api,
  kind,
  target,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  kind: WorkforceKind;
  target: EmployeeSummary | DriverSummary;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    const data = new FormData(event.currentTarget);
    try {
      await api.patch(`configuration/${kind}/${target.id}/status`, {
        isActive: target.status !== "active",
        reason: String(data.get("reason") ?? ""),
      });
      await onSaved();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      className="modal-small"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t(target.status === "active" ? "workforce.disable" : "workforce.activate")}
      titleId="workforce-status-title"
    >
      <form onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>{t("workforce.reason")}</span>
          <textarea autoFocus name="reason" required />
        </label>
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button className="button button-primary" disabled={saving} type="submit">
            {t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function WorkforceDetailWorkspace({
  api,
  code,
  kind,
  onBack,
  onNavigate,
}: {
  api: ApiClient;
  code: string;
  kind: WorkforceKind;
  onBack: () => void;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<Detail>();
  const [earningRules, setEarningRules] = useState<VariableEarningRules>();
  const [dialog, setDialog] = useState<"document" | "commission" | "calculation" | "payment">();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      const loaded = await api.get<Detail>(`configuration/${kind}/${encodeURIComponent(code)}`);
      setDetail(loaded);
      if (kind === "employees" && loaded.driver_type) {
        setEarningRules(
          await api.get<VariableEarningRules>(
            `configuration/employees/${String(loaded.id)}/variable-earnings`,
          ),
        );
      }
    } catch {
      setError(t("common.loadFailed"));
    }
  }, [api, code, kind, t]);
  useEffect(() => void load(), [load]);
  if (error !== undefined) return <div className="alert alert-error">{error}</div>;
  if (detail === undefined) return <div className="loading-row">{t("common.loading")}</div>;
  const documents = (detail.documents ?? []) as Detail[];
  const history = (detail.history ?? []) as Detail[];
  const rules = (detail.rules ?? []) as Detail[];
  const calculations = (detail.calculations ?? []) as Detail[];
  return (
    <>
      <PageHeader
        eyebrow={t(kind === "employees" ? "workforce.employees" : "workforce.drivers")}
        title={String(detail.name_en ?? code)}
        actions={
          <>
            <button className="button button-secondary" onClick={onBack} type="button">
              {t("common.back")}
            </button>
            <button
              className="button button-primary"
              onClick={() => setDialog("document")}
              type="button"
            >
              <FilePlus2 size={17} />
              {t("workforce.addDocument")}
            </button>
            {kind === "drivers" ? (
              <>
                <button
                  className="button button-primary"
                  onClick={() => setDialog("commission")}
                  type="button"
                >
                  <Plus size={17} />
                  {t("workforce.commissionRule")}
                </button>
                <button
                  className="button button-secondary"
                  onClick={() => setDialog("calculation")}
                  type="button"
                >
                  {t("workforce.runCalculation")}
                </button>
                {calculations.some((item) => item.status === "payable") ? (
                  <button
                    className="button button-secondary"
                    onClick={() => setDialog("payment")}
                    type="button"
                  >
                    {t("workforce.confirmPayment")}
                  </button>
                ) : null}
              </>
            ) : null}
          </>
        }
      />
      <section className="detail-band">
        <dl className="detail-grid">
          <Info
            label={t("workforce.code")}
            value={String(detail.employee_number ?? detail.code ?? "")}
          />
          <Info label={t("workforce.name")} value={String(detail.name_en ?? "")} />
          <Info label={t("workforce.mobile")} value={String(detail.mobile_number ?? "")} />
          <Info
            label={t("workforce.status")}
            value={String(
              detail.is_active === false || detail.account_status === "disabled"
                ? t("status.disabled")
                : t("status.active"),
            )}
          />
          {kind === "employees" ? (
            <>
              <Info
                label={t("workforce.basicSalary")}
                value={formatMoney(String(detail.basic_salary ?? 0))}
              />
              <div>
                <dt>{t("userAdmin.linkedUser")}</dt>
                <dd>
                  {detail.linked_account_id ? (
                    <button
                      className="button button-quiet"
                      onClick={() =>
                        onNavigate(`/configuration/users/${String(detail.linked_account_id)}`)
                      }
                      type="button"
                    >
                      {String(detail.linked_user_name ?? detail.linked_username)}
                    </button>
                  ) : (
                    t("userAdmin.noLinkedUser")
                  )}
                </dd>
              </div>
            </>
          ) : (
            <Info
              label={t("workforce.driverType")}
              value={t(
                String(detail.driver_type) === "employee"
                  ? "workforce.employeeDriver"
                  : "workforce.outsourcedDriver",
              )}
            />
          )}
        </dl>
      </section>
      <BusinessAccessPanel
        api={api}
        entityId={String(detail.id)}
        kind={kind === "employees" ? "employee" : "driver"}
        onNavigate={onNavigate}
        profileCode={String(detail.employee_number ?? detail.code ?? "")}
        profileMobileNumber={String(detail.mobile_number ?? "")}
        profileName={String(detail.name_en ?? "")}
      />
      {kind === "employees" && detail.driver_type ? (
        <CurrentVariableEarnings {...(earningRules ? { rules: earningRules } : {})} t={t} />
      ) : null}
      <DetailTable
        title={t("workforce.documents")}
        rows={documents}
        columns={[
          "document_type",
          "document_number",
          "issue_date",
          "expiry_date",
          "expiryStatus",
          "status",
        ]}
      />
      {kind === "drivers" ? (
        <>
          <DetailTable
            title={t("workforce.commissionRules")}
            rows={rules}
            columns={[
              "name",
              "commission_method",
              "commission_basis",
              "commission_rate",
              "calculation_frequency",
              "effective_from",
              "effective_to",
            ]}
          />
          <DetailTable
            title={t("workforce.calculations")}
            rows={calculations}
            columns={[
              "calculation_reference",
              "period_start",
              "period_end",
              "eligible_order_count",
              "gross_commission",
              "net_payable",
              "status",
            ]}
          />
        </>
      ) : null}
      <DetailTable
        title={t("workforce.history")}
        rows={history}
        columns={["action", "reason", "occurredAt"]}
      />
      {dialog === undefined ? null : (
        <DetailActionDialog
          api={api}
          detail={detail}
          kind={kind}
          mode={dialog}
          onClose={() => setDialog(undefined)}
          onSaved={async () => {
            setDialog(undefined);
            await load();
          }}
        />
      )}
    </>
  );
}
function CurrentVariableEarnings({
  rules,
  t,
}: {
  rules?: VariableEarningRules;
  t: (key: string) => string;
}) {
  const delivery = rules?.delivery.find((rule) => rule.isCurrent);
  const collection = rules?.collection.find((rule) => rule.isCurrent);
  const rows = [
    ...(delivery
      ? [
          {
            ...delivery,
            earning: t("workforce.deliveryEarnings"),
            payment: t("workforce.perDeliveredOrder"),
          },
        ]
      : []),
    ...(collection
      ? [
          {
            ...collection,
            earning: t("workforce.collectionEarnings"),
            payment: t(`workforce.collectionTypes.${collection.paymentType ?? "none"}`),
          },
        ]
      : []),
  ];
  return (
    <DetailTable
      title={`${t("workforce.driverVariableEarnings")} â€” ${t("workforce.currentRule")}`}
      rows={rows}
      columns={["earning", "payment", "amount", "effectiveFrom", "effectiveTo"]}
    />
  );
}
function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || "-"}</dd>
    </div>
  );
}
function DetailTable({
  title,
  rows,
  columns,
}: {
  title: string;
  rows: Detail[];
  columns: string[];
}) {
  return (
    <section className="data-surface detail-table">
      <h2>{title}</h2>
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column.replaceAll("_", " ")}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={String(row.id ?? index)}>
              {columns.map((column) => (
                <td key={column}>{String(row[column] ?? "-")}</td>
              ))}
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td className="empty-state" colSpan={columns.length}>
                -
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}
function DetailActionDialog({
  api,
  detail,
  kind,
  mode,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  detail: Detail;
  kind: WorkforceKind;
  mode: "document" | "commission" | "calculation" | "payment";
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const id = String(detail.id);
    if (mode === "document")
      await api.post(`configuration/${kind}/${id}/documents`, {
        description: optional(data, "description"),
        documentNumber: optional(data, "number"),
        documentType: String(data.get("type")),
        expiryDate: optional(data, "expiry"),
        issueDate: optional(data, "issue"),
      });
    else if (mode === "commission")
      await api.post(`configuration/drivers/${id}/commission-rules`, {
        effectiveFrom: String(data.get("from")),
        effectiveTo: optional(data, "to"),
        frequency: String(data.get("frequency")),
        method: String(data.get("method")),
        name: String(data.get("name")),
        rate: Number(data.get("rate")),
      });
    else if (mode === "calculation")
      await api.post(`configuration/drivers/${id}/commission-calculations`, {
        additions: Number(data.get("additions") ?? 0),
        adjustmentReason: optional(data, "reason"),
        deductions: Number(data.get("deductions") ?? 0),
        frequency: String(data.get("frequency")),
        periodEnd: String(data.get("periodEnd")),
        periodStart: String(data.get("periodStart")),
      });
    else
      await api.post(
        `configuration/commission-calculations/${String(data.get("calculationId"))}/pay`,
        {
          bankAccountId: optional(data, "bankAccountId"),
          idempotencyKey: crypto.randomUUID(),
          paymentDate: String(data.get("paymentDate")),
          paymentMethod: String(data.get("paymentMethod")),
          reference: optional(data, "reference"),
        },
      );
    await onSaved();
  };
  return (
    <Modal
      className="modal-small"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t(
        mode === "document"
          ? "workforce.addDocument"
          : mode === "commission"
            ? "workforce.commissionRule"
            : mode === "calculation"
              ? "workforce.runCalculation"
              : "workforce.confirmPayment",
      )}
      titleId="detail-action-title"
    >
      <form onSubmit={(event) => void submit(event)}>
        {mode === "document" ? (
          <>
            <label className="field">
              <span>{t("workforce.documentType")}</span>
              <select name="type">
                <option value="passport">Passport</option>
                <option value="emirates_id">Emirates ID</option>
                <option value="driving_licence">Driving Licence</option>
                <option value="visa_residency">Visa / Residency</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="field">
              <span>{t("workforce.documentNumber")}</span>
              <input name="number" />
            </label>
            <label className="field">
              <span>{t("workforce.issueDate")}</span>
              <input name="issue" type="date" />
            </label>
            <label className="field">
              <span>{t("workforce.expiryDate")}</span>
              <input name="expiry" type="date" />
            </label>
            <label className="field">
              <span>{t("workforce.description")}</span>
              <textarea name="description" />
            </label>
          </>
        ) : mode === "commission" ? (
          <>
            <label className="field">
              <span>{t("workforce.name")}</span>
              <input name="name" required />
            </label>
            <label className="field">
              <span>{t("workforce.method")}</span>
              <select name="method">
                <option value="fixed">Fixed</option>
                <option value="percentage">Percentage of Service Fee</option>
              </select>
            </label>
            <label className="field">
              <span>{t("workforce.rate")}</span>
              <input min="0" name="rate" step="0.0001" type="number" required />
            </label>
            <label className="field">
              <span>{t("workforce.frequency")}</span>
              <select name="frequency">
                <option value="daily">Daily</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <label className="field">
              <span>{t("workforce.effectiveFrom")}</span>
              <input defaultValue={today()} name="from" type="date" required />
            </label>
            <label className="field">
              <span>{t("workforce.effectiveTo")}</span>
              <input name="to" type="date" />
            </label>
          </>
        ) : mode === "calculation" ? (
          <>
            <label className="field">
              <span>{t("workforce.frequency")}</span>
              <select name="frequency">
                <option value="daily">Daily</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <label className="field">
              <span>{t("workforce.periodStart")}</span>
              <input name="periodStart" type="date" required />
            </label>
            <label className="field">
              <span>{t("workforce.periodEnd")}</span>
              <input name="periodEnd" type="date" required />
            </label>
            <label className="field">
              <span>{t("workforce.additions")}</span>
              <input defaultValue="0" min="0" name="additions" step="0.01" type="number" />
            </label>
            <label className="field">
              <span>{t("workforce.deductions")}</span>
              <input defaultValue="0" min="0" name="deductions" step="0.01" type="number" />
            </label>
            <label className="field">
              <span>{t("workforce.reason")}</span>
              <textarea name="reason" />
            </label>
          </>
        ) : (
          <>
            <label className="field">
              <span>{t("workforce.calculations")}</span>
              <select name="calculationId" required>
                {((detail.calculations ?? []) as Detail[])
                  .filter((item) => item.status === "payable")
                  .map((item) => (
                    <option key={String(item.id)} value={String(item.id)}>
                      {String(item.calculation_reference)} - {money(String(item.net_payable))}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span>{t("workforce.paymentMethod")}</span>
              <select name="paymentMethod">
                <option value="cash">Cash</option>
                <option value="bank_transfer">Bank transfer</option>
              </select>
            </label>
            <label className="field">
              <span>{t("workforce.paymentDate")}</span>
              <input defaultValue={today()} name="paymentDate" type="date" required />
            </label>
            <label className="field">
              <span>{t("workforce.bankAccountId")}</span>
              <input name="bankAccountId" />
            </label>
            <label className="field">
              <span>{t("workforce.reference")}</span>
              <input name="reference" />
            </label>
          </>
        )}
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
function optional(data: FormData, key: string): string | undefined {
  const value = String(data.get(key) ?? "").trim();
  return value === "" ? undefined : value;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function money(value: string) {
  return `AED ${new Intl.NumberFormat("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value))}`;
}
const formatMoney = money;



