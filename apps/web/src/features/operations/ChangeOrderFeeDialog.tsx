import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { Modal } from "../../components/Modal.js";
import { parseMoneyInput } from "../../utils/numeric-input.js";

export interface ChangeOrderFeeResult {
  readonly orderNumber: string;
  readonly serviceFee: string;
  readonly additionalFees: string;
  readonly receivableNumber: string | null;
  readonly draftUpdated: boolean;
}

/**
 * Change the fee of a delivered or closed "Pay by Trader" Order (Aiman, 1 Nov
 * 2026). The server decides what is allowed: it refuses a fee already
 * collected and names the receipt to un-post first.
 */
export function ChangeOrderFeeDialog({
  api,
  onClose,
  onSaved,
  order,
}: {
  api: ApiClient;
  onClose: () => void;
  onSaved: (result: ChangeOrderFeeResult) => void | Promise<void>;
  order: {
    readonly id: string;
    readonly orderNumber: string;
    readonly referenceNumber?: string | null;
    readonly serviceFee: string;
    readonly additionalFees?: string | null;
  };
}) {
  const { t } = useTranslation();
  const [serviceFee, setServiceFee] = useState(order.serviceFee);
  const [additionalFees, setAdditionalFees] = useState(order.additionalFees ?? "0.00");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<ChangeOrderFeeResult>();
  const fee = parseMoneyInput(serviceFee, { required: true });
  const additional = parseMoneyInput(additionalFees, { required: true });
  const before = Number(order.serviceFee) + Number(order.additionalFees ?? 0);
  const after = fee.ok && additional.ok ? fee.value + additional.value : undefined;
  const valid = fee.ok && additional.ok && fee.value >= 0 && additional.value >= 0 && reason.trim() !== "";

  const submit = async () => {
    if (!fee.ok || !additional.ok) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.post<ChangeOrderFeeResult>(`operations/orders/${order.id}/change-fee`, {
        additionalFees: additional.value,
        reason: reason.trim(),
        serviceFee: fee.value,
      });
      setSaved(result);
      await onSaved(result);
    } catch (requestError) {
      setError(
        requestError instanceof ApiError || requestError instanceof Error
          ? requestError.message
          : t("operations.changeFee.failed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("operations.changeFee.title", { order: order.referenceNumber || order.orderNumber })}
      titleId={`change-fee-${order.id}`}
    >
      {saved !== undefined ? (
        <>
          <div className="alert alert-success" role="status">
            {t("operations.changeFee.saved", {
              order: saved.orderNumber,
              total: (Number(saved.serviceFee) + Number(saved.additionalFees)).toFixed(2),
            })}
            {saved.draftUpdated ? ` ${t("operations.changeFee.draftUpdated")}` : ""}
          </div>
          <div className="modal-actions">
            <button className="button button-primary" onClick={onClose} type="button">
              {t("common.close")}
            </button>
          </div>
        </>
      ) : (
        <>
      <p className="field-hint">{t("operations.changeFee.hint")}</p>
      <div className="compact-filters">
        <label className="field">
          <span>{t("operations.serviceFee")}</span>
          <input inputMode="decimal" onChange={(event) => setServiceFee(event.target.value)} value={serviceFee} />
        </label>
        <label className="field">
          <span>{t("operations.additionalFees")}</span>
          <input
            inputMode="decimal"
            onChange={(event) => setAdditionalFees(event.target.value)}
            value={additionalFees}
          />
        </label>
      </div>
      <p data-testid="change-fee-total">
        {t("operations.changeFee.total", {
          after: after === undefined ? "—" : after.toFixed(2),
          before: before.toFixed(2),
        })}
      </p>
      <label className="field">
        <span>{t("operations.changeFee.reason")}</span>
        <textarea onChange={(event) => setReason(event.target.value)} rows={2} value={reason} />
      </label>
      {error === undefined ? null : (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <div className="modal-actions">
        <button disabled={busy} onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={busy || !valid}
          onClick={() => void submit()}
          type="button"
        >
          {busy ? t("common.loading") : t("operations.changeFee.save")}
        </button>
      </div>
        </>
      )}
    </Modal>
  );
}
