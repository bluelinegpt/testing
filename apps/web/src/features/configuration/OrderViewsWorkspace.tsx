import { ArrowDown, ArrowUp, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";
import { PageHeader } from "../../components/PageHeader.js";
import { formatDateTime } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";
import {
  ACTIVE_ALLOWED_STATUSES,
  makeDefaultOrderView,
  moveOrderView,
  newCustomView,
  ORDER_VIEW_DATE_FIELDS,
  ORDER_VIEW_DATE_WINDOWS,
  ORDER_VIEW_DELIVERY_STATUSES,
  type OrderView,
  type OrderViewDateField,
  type OrderViewDateWindow,
  type OrderViewDefinition,
  type OrderViewDeliveryStatus,
  orderViewKind,
  orderViewLabel,
  type OrderViewsMenu,
  orderViewsProblems,
  standardOrderViews,
} from "./order-views.js";

/**
 * Configuration › Orders menu (Aiman, 9 Oct 2026; "Order Views Menu Setup"
 * design). Edits the Company's tab list for the Orders screen. Nothing here
 * changes an Order: a view only filters the list.
 *
 * The switch starts OFF, and while it is off the Orders screen keeps the
 * standard menu exactly as before -- the setup can be prepared first and
 * switched on when ready.
 */
export function OrderViewsWorkspace({
  api,
  permissions,
}: {
  api: ApiClient;
  permissions: readonly string[];
}) {
  const { i18n, t } = useTranslation();
  const language = normalizeLocale(i18n.resolvedLanguage);
  const canManage =
    permissions.includes("order_views.manage") || permissions.includes("users_roles.manage");
  const [loaded, setLoaded] = useState<OrderViewsMenu>();
  const [enabled, setEnabled] = useState(false);
  const [views, setViews] = useState<OrderView[]>([]);
  const [editing, setEditing] = useState<{ readonly isNew: boolean; readonly view: OrderView }>();
  const [notice, setNotice] = useState<{
    readonly details?: readonly string[];
    readonly text: string;
    readonly tone: "error" | "success";
  }>();
  const [busy, setBusy] = useState(false);

  const apply = useCallback((menu: OrderViewsMenu) => {
    setLoaded(menu);
    setEnabled(menu.enabled);
    setViews([...menu.views]);
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      apply(await api.get<OrderViewsMenu>("configuration/order-views"));
    } catch {
      setNotice({ text: t("orderViews.loadFailed"), tone: "error" });
    } finally {
      setBusy(false);
    }
  }, [api, apply, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty =
    loaded !== undefined &&
    (enabled !== loaded.enabled || canonicalJson(views) !== canonicalJson(loaded.views));
  const problems = useMemo(() => orderViewsProblems(views), [views]);

  const save = async () => {
    if (loaded === undefined || problems.length > 0) return;
    setBusy(true);
    setNotice(undefined);
    try {
      apply(
        await api.put<OrderViewsMenu>("configuration/order-views", {
          enabled,
          expectedVersion: loaded.version,
          views,
        }),
      );
      setNotice({ text: t("orderViews.saved"), tone: "success" });
    } catch (error) {
      if (error instanceof ApiError && error.code === "order_views_version_conflict") {
        setNotice({ text: t("orderViews.conflict"), tone: "error" });
      } else if (error instanceof ApiError && error.code === "order_views_invalid") {
        setNotice({
          ...(error.details === undefined ? {} : { details: error.details }),
          text: t("orderViews.invalid"),
          tone: "error",
        });
      } else {
        setNotice({ text: t("orderViews.saveFailed"), tone: "error" });
      }
    } finally {
      setBusy(false);
    }
  };

  const update = (key: string, change: Partial<OrderView>) =>
    setViews((current) => current.map((view) => (view.key === key ? { ...view, ...change } : view)));

  const applyEdit = (edited: OrderView, isNew: boolean) => {
    setViews((current) =>
      isNew ? [...current, edited] : current.map((view) => (view.key === edited.key ? edited : view)),
    );
    setEditing(undefined);
  };

  const remove = (key: string) =>
    setViews((current) => {
      const removed = current.find((view) => view.key === key);
      const rest = current.filter((view) => view.key !== key);
      return removed?.isDefault === true ? makeDefaultOrderView(rest, "active") : rest;
    });

  // While the switch is off the Orders screen keeps the standard menu, so the
  // preview shows exactly that, whatever is being prepared below.
  const previewTabs = enabled ? views.filter((view) => view.isVisible) : standardOrderViews();
  const previewFirst = enabled
    ? views.find((view) => view.isDefault)?.key
    : "active";

  return (
    <div className="order-views-workspace">
      <PageHeader
        actions={
          canManage ? (
            <>
              <button
                className="button"
                disabled={busy}
                onClick={() => setViews(standardOrderViews())}
                type="button"
              >
                <RotateCcw aria-hidden="true" size={16} /> {t("orderViews.reset")}
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() => setEditing({ isNew: true, view: newCustomView(views) })}
                type="button"
              >
                <Plus aria-hidden="true" size={16} /> {t("orderViews.addView")}
              </button>
              <button
                className="button button-primary"
                disabled={busy || !dirty || problems.length > 0}
                onClick={() => void save()}
                type="button"
              >
                {busy ? t("orderViews.saving") : t("orderViews.save")}
              </button>
            </>
          ) : undefined
        }
        description={t("orderViews.intro")}
        eyebrow={t("nav.configuration")}
        title={t("orderViews.title")}
      />

      {notice === undefined ? null : (
        <div
          className={`alert ${notice.tone === "success" ? "alert-success" : "alert-error"}`}
          role={notice.tone === "success" ? "status" : "alert"}
        >
          {notice.text}
          {notice.details === undefined ? null : (
            <ul className="order-views-problem-list">
              {notice.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {dirty ? (
        <div className="alert alert-info" role="status">
          {t("orderViews.unsaved")}
        </div>
      ) : null}
      {problems.length === 0 ? null : (
        <div className="alert alert-error" role="alert">
          <ul className="order-views-problem-list">
            {problems.map((problem) => (
              <li key={problem}>{t(`orderViews.problems.${problem}`)}</li>
            ))}
          </ul>
        </div>
      )}

      <section
        aria-label={t("orderViews.switchLabel")}
        className={`order-views-switch${enabled ? " is-on" : ""}`}
      >
        <label className="order-views-switch-control">
          <input
            checked={enabled}
            disabled={!canManage || busy || loaded === undefined}
            onChange={(event) => setEnabled(event.target.checked)}
            role="switch"
            type="checkbox"
          />
          <span className="order-views-switch-copy">
            <strong>{enabled ? t("orderViews.onTitle") : t("orderViews.offTitle")}</strong>
            <span>{enabled ? t("orderViews.onText") : t("orderViews.offText")}</span>
          </span>
        </label>
        <small className="field-hint">
          {loaded === undefined || loaded.updatedAt === null
            ? t("orderViews.neverSaved")
            : t("orderViews.lastChanged", {
                date: formatDateTime(loaded.updatedAt, language),
                user: loaded.updatedBy ?? "—",
              })}
        </small>
      </section>

      <section aria-label={t("orderViews.preview")} className="card order-views-preview">
        <small className="field-hint">{t("orderViews.preview")}</small>
        <div className="orders-quick-views" role="presentation">
          {previewTabs.map((view) => (
            <span
              className={`order-views-preview-tab${view.key === previewFirst ? " active" : ""}`}
              key={view.key}
            >
              {orderViewLabel(view, language)}
              {view.showCount ? <span className="tab-count">#</span> : null}
            </span>
          ))}
        </div>
      </section>

      <section aria-label={t("orderViews.listLabel")} className={enabled ? "" : "order-views-dimmed"}>
        <div className="table-scroll-x">
          <table className="order-views-table">
            <thead>
              <tr>
                <th scope="col">{t("orderViews.columns.order")}</th>
                <th scope="col">{t("orderViews.columns.name")}</th>
                <th scope="col">{t("orderViews.columns.type")}</th>
                <th scope="col">{t("orderViews.columns.shows")}</th>
                <th scope="col">{t("orderViews.columns.count")}</th>
                <th scope="col">{t("orderViews.columns.visible")}</th>
                <th scope="col">{t("orderViews.columns.default")}</th>
                <th scope="col">{t("orderViews.columns.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {views.map((view, index) => {
                const name = orderViewLabel(view, language) || t("orderViews.untitled");
                const kind = orderViewKind(view);
                return (
                  <tr key={view.key}>
                    <td className="order-views-move">
                      <button
                        aria-label={t("orderViews.moveUp", { name })}
                        className="icon-button"
                        disabled={!canManage || index === 0}
                        onClick={() => setViews((current) => moveOrderView(current, index, -1))}
                        type="button"
                      >
                        <ArrowUp aria-hidden="true" size={16} />
                      </button>
                      <button
                        aria-label={t("orderViews.moveDown", { name })}
                        className="icon-button"
                        disabled={!canManage || index === views.length - 1}
                        onClick={() => setViews((current) => moveOrderView(current, index, 1))}
                        type="button"
                      >
                        <ArrowDown aria-hidden="true" size={16} />
                      </button>
                    </td>
                    <td>
                      <strong>{view.labelEn || t("orderViews.untitled")}</strong>
                      {view.labelAr === null ? null : (
                        <span className="order-views-arabic" dir="rtl">
                          {view.labelAr}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`status-pill order-views-kind order-views-kind-${kind}`}>
                        {t(`orderViews.kinds.${kind}`)}
                      </span>
                    </td>
                    <td className="order-views-rule">{orderViewRuleSummary(view, t)}</td>
                    <td>
                      <input
                        aria-label={t("orderViews.showCount", { name })}
                        checked={view.showCount}
                        disabled={!canManage}
                        onChange={(event) => update(view.key, { showCount: event.target.checked })}
                        role="switch"
                        type="checkbox"
                      />
                    </td>
                    <td>
                      {kind === "always" ? (
                        <span className="field-hint">{t("orderViews.always")}</span>
                      ) : (
                        <input
                          aria-label={t("orderViews.showTab", { name })}
                          checked={view.isVisible}
                          disabled={!canManage || view.isDefault}
                          onChange={(event) => update(view.key, { isVisible: event.target.checked })}
                          role="switch"
                          type="checkbox"
                        />
                      )}
                    </td>
                    <td>
                      <input
                        aria-label={t("orderViews.openFirst", { name })}
                        checked={view.isDefault}
                        disabled={!canManage}
                        name="order-views-default"
                        onChange={() => setViews((current) => makeDefaultOrderView(current, view.key))}
                        type="radio"
                      />
                    </td>
                    <td className="order-views-actions">
                      <button
                        aria-label={t("orderViews.editView", { name })}
                        className="icon-button"
                        disabled={!canManage}
                        onClick={() => setEditing({ isNew: false, view })}
                        type="button"
                      >
                        <Pencil aria-hidden="true" size={16} />
                      </button>
                      {view.kind === "custom" ? (
                        <button
                          aria-label={t("orderViews.deleteView", { name })}
                          className="icon-button"
                          disabled={!canManage}
                          onClick={() => remove(view.key)}
                          type="button"
                        >
                          <Trash2 aria-hidden="true" size={16} />
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="field-hint order-views-legend">{t("orderViews.legend")}</p>
      </section>

      {editing === undefined ? null : (
        <OrderViewEditor
          isNew={editing.isNew}
          onApply={(edited) => applyEdit(edited, editing.isNew)}
          onClose={() => setEditing(undefined)}
          view={editing.view}
        />
      )}
    </div>
  );
}

/** JSON with object keys sorted, so key order never reads as a change. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : item,
  );
}

/** One line describing what a view shows, for the list. */
export function orderViewRuleSummary(view: OrderView, t: TFunction): string {
  const statusNames = (statuses: readonly string[]) =>
    statuses.map((status) => t(`statuses.${status}`)).join(", ");
  if (view.key === "active") {
    return t("orderViews.rules.active", { statuses: statusNames(view.definition?.statuses ?? []) });
  }
  if (view.kind === "system") return t(`orderViews.rules.${view.key}`);
  const definition = view.definition;
  if (definition === null) return "";
  const statuses =
    definition.statuses.length === 0 ? t("orderViews.rules.anyStatus") : statusNames(definition.statuses);
  const field = t(`orderViews.fields.${definition.dateField ?? "order_date"}`);
  const window = definition.dateWindow ?? "any";
  const date =
    window === "any"
      ? t("orderViews.windowSummary.anyDate")
      : window === "last_n_days"
        ? t("orderViews.windowSummary.lastN", { days: definition.lastNDays ?? 0, field })
        : window === "range"
          ? t("orderViews.windowSummary.range", {
              field,
              from: definition.dateFrom ?? "",
              to: definition.dateTo ?? "",
            })
          : t("orderViews.windowSummary.window", { field, window: t(`orderViews.windows.${window}`) });
  return t("orderViews.rules.custom", { date, statuses });
}

function OrderViewEditor({
  isNew,
  onApply,
  onClose,
  view,
}: {
  isNew: boolean;
  onApply: (view: OrderView) => void;
  onClose: () => void;
  view: OrderView;
}) {
  const { t } = useTranslation();
  const kind = orderViewKind(view);
  const [labelEn, setLabelEn] = useState(view.labelEn);
  const [labelAr, setLabelAr] = useState(view.labelAr ?? "");
  const [statuses, setStatuses] = useState<readonly OrderViewDeliveryStatus[]>(
    view.definition?.statuses ?? [],
  );
  const [dateWindow, setDateWindow] = useState<OrderViewDateWindow>(
    view.definition?.dateWindow ?? "any",
  );
  const [dateField, setDateField] = useState<OrderViewDateField>(
    view.definition?.dateField ?? "order_date",
  );
  const [lastNDays, setLastNDays] = useState(String(view.definition?.lastNDays ?? 7));
  const [dateFrom, setDateFrom] = useState(view.definition?.dateFrom ?? "");
  const [dateTo, setDateTo] = useState(view.definition?.dateTo ?? "");
  const [showCount, setShowCount] = useState(view.showCount);
  const [isVisible, setIsVisible] = useState(view.isVisible);

  const offered = view.key === "active" ? ACTIVE_ALLOWED_STATUSES : ORDER_VIEW_DELIVERY_STATUSES;
  const toggle = (status: OrderViewDeliveryStatus) =>
    setStatuses((current) =>
      current.includes(status)
        ? current.filter((item) => item !== status)
        : ORDER_VIEW_DELIVERY_STATUSES.filter((item) => item === status || current.includes(item)),
    );

  const days = Number(lastNDays);
  const problems: string[] = [];
  if (labelEn.trim() === "") problems.push(t("orderViews.problems.nameRequired"));
  if (labelEn.trim().length > 40 || labelAr.trim().length > 40)
    problems.push(t("orderViews.problems.nameTooLong"));
  if (view.key === "active" && statuses.length === 0)
    problems.push(t("orderViews.problems.activeNeedsStatus"));
  if (kind === "custom" && dateWindow === "last_n_days" && (!Number.isInteger(days) || days < 1 || days > 365))
    problems.push(t("orderViews.problems.lastNDaysInvalid"));
  if (kind === "custom" && dateWindow === "range" && (dateFrom === "" || dateTo === "" || dateFrom > dateTo))
    problems.push(t("orderViews.problems.rangeInvalid"));

  const build = (): OrderView => {
    let definition: OrderViewDefinition | null = view.definition;
    if (view.key === "active") definition = { statuses };
    if (kind === "custom") {
      definition = {
        dateField,
        dateWindow,
        statuses,
        ...(dateWindow === "last_n_days" ? { lastNDays: days } : {}),
        ...(dateWindow === "range" ? { dateFrom, dateTo } : {}),
      };
    }
    return {
      ...view,
      definition,
      isVisible: view.isDefault ? true : isVisible,
      labelAr: labelAr.trim() === "" ? null : labelAr.trim(),
      labelEn: labelEn.trim(),
      showCount,
    };
  };

  const title = isNew
    ? t("orderViews.editor.titleNew")
    : t("orderViews.editor.titleEdit", { name: view.labelEn });

  return (
    <Modal
      className="modal-large order-view-editor"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={title}
      titleId="order-view-editor-title"
    >
      <div className="form-grid">
        <label className="field">
          <span>{t("orderViews.editor.nameEn")}</span>
          <input
            maxLength={40}
            onChange={(event) => setLabelEn(event.target.value)}
            value={labelEn}
          />
        </label>
        <label className="field">
          <span>{t("orderViews.editor.nameAr")}</span>
          <input
            dir="rtl"
            maxLength={40}
            onChange={(event) => setLabelAr(event.target.value)}
            value={labelAr}
          />
        </label>
      </div>

      {kind === "fixed" ? (
        <p className="alert alert-info">{t("orderViews.editor.fixedRule")}</p>
      ) : null}

      {view.key === "active" || kind === "custom" ? (
        <fieldset className="order-views-fieldset">
          <legend>
            {view.key === "active"
              ? t("orderViews.editor.activeStatuses")
              : t("orderViews.editor.statuses")}
          </legend>
          <div className="order-views-chips">
            {offered.map((status) => (
              <label className="order-views-chip" key={status}>
                <input
                  checked={statuses.includes(status)}
                  onChange={() => toggle(status)}
                  type="checkbox"
                />
                <span>{t(`statuses.${status}`)}</span>
              </label>
            ))}
          </div>
          {view.key === "active" ? (
            <>
              <p className="field-hint">{t("orderViews.editor.activeLocked")}</p>
              {statuses.includes("delivered") ? null : (
                <p className="alert alert-warning" role="alert">
                  {t("orderViews.editor.deliveredWarning")}
                </p>
              )}
            </>
          ) : (
            <p className="field-hint">{t("orderViews.editor.statusesHint")}</p>
          )}
        </fieldset>
      ) : null}

      {kind === "custom" ? (
        <fieldset className="order-views-fieldset">
          <legend>{t("orderViews.editor.dateWindow")}</legend>
          <div className="form-grid">
            <label className="field">
              <span>{t("orderViews.editor.dateWindow")}</span>
              <select
                onChange={(event) => setDateWindow(event.target.value as OrderViewDateWindow)}
                value={dateWindow}
              >
                {ORDER_VIEW_DATE_WINDOWS.map((window) => (
                  <option key={window} value={window}>
                    {t(`orderViews.windows.${window}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("orderViews.editor.dateField")}</span>
              <select
                disabled={dateWindow === "any"}
                onChange={(event) => setDateField(event.target.value as OrderViewDateField)}
                value={dateField}
              >
                {ORDER_VIEW_DATE_FIELDS.map((field) => (
                  <option key={field} value={field}>
                    {t(`orderViews.fields.${field}`)}
                  </option>
                ))}
              </select>
            </label>
            {dateWindow === "last_n_days" ? (
              <label className="field">
                <span>{t("orderViews.editor.lastNDays")}</span>
                <input
                  max={365}
                  min={1}
                  onChange={(event) => setLastNDays(event.target.value)}
                  step={1}
                  type="number"
                  value={lastNDays}
                />
              </label>
            ) : null}
            {dateWindow === "range" ? (
              <>
                <label className="field">
                  <span>{t("orderViews.editor.from")}</span>
                  <input onChange={(event) => setDateFrom(event.target.value)} type="date" value={dateFrom} />
                </label>
                <label className="field">
                  <span>{t("orderViews.editor.to")}</span>
                  <input onChange={(event) => setDateTo(event.target.value)} type="date" value={dateTo} />
                </label>
              </>
            ) : null}
          </div>
          <p className="field-hint">{t("orderViews.editor.dateNote")}</p>
        </fieldset>
      ) : null}

      <label className="checkbox-field">
        <input
          checked={showCount}
          onChange={(event) => setShowCount(event.target.checked)}
          type="checkbox"
        />
        <span>{t("orderViews.editor.showCount")}</span>
      </label>
      {kind === "always" ? null : (
        <label className="checkbox-field">
          <input
            checked={view.isDefault ? true : isVisible}
            disabled={view.isDefault}
            onChange={(event) => setIsVisible(event.target.checked)}
            type="checkbox"
          />
          <span>{t("orderViews.editor.visible")}</span>
        </label>
      )}

      {problems.length === 0 ? null : (
        <div className="alert alert-error" role="alert">
          <ul className="order-views-problem-list">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={problems.length > 0}
          onClick={() => onApply(build())}
          type="button"
        >
          {t("orderViews.editor.apply")}
        </button>
      </div>
    </Modal>
  );
}
