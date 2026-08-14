import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";

import { Modal } from "./Modal.js";

/**
 * The Company's Mobile Code as a scannable panel — QR above, the six digits
 * beneath in type large enough to copy by hand. Both carry the same value, so
 * scanning and typing are interchangeable on the mobile app's first screen.
 *
 * The QR is drawn on demand from the code; nothing is generated ahead of time
 * or stored anywhere. Print opens a minimal page with the Company name ON the
 * paper — the name belongs on the printout (which only signed-in staff can
 * produce), never in any code-lookup response.
 */
export function MobileAppQrPanel({
  code,
  companyName,
  onRequestClose,
}: {
  /** undefined while the profile is still loading. */
  code: string | undefined;
  companyName: string;
  onRequestClose: () => void;
}) {
  const { t } = useTranslation();
  const [qrDataUrl, setQrDataUrl] = useState<string>();

  useEffect(() => {
    if (code === undefined) return;
    let active = true;
    QRCode.toDataURL(code, { margin: 2, width: 320 })
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [code]);

  const print = () => {
    if (qrDataUrl === undefined || code === undefined) return;
    const printWindow = window.open("", "_blank", "width=480,height=640");
    if (printWindow === null) return;
    printWindow.document.write(`<!doctype html>
<html>
  <head><title>${t("mobileQr.title")}</title></head>
  <body style="font-family: sans-serif; text-align: center; padding: 32px;">
    <h2 style="margin-bottom: 4px;">${escapeHtml(companyName)}</h2>
    <p style="margin-top: 0; color: #555;">${t("mobileQr.help")}</p>
    <img alt="" src="${qrDataUrl}" style="width: 320px; height: 320px;" />
    <p dir="ltr" style="font-size: 42px; letter-spacing: 10px; font-weight: 700; margin: 8px 0;">${code}</p>
    <script>window.onload = () => { window.print(); };</script>
  </body>
</html>`);
    printWindow.document.close();
  };

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onRequestClose}
      title={t("mobileQr.title")}
      titleId="mobile-app-qr-panel"
    >
      <p>{t("mobileQr.help")}</p>
      {code === undefined ? (
        <p>{t("common.loading")}</p>
      ) : (
        <div className="mobile-qr-panel">
          {qrDataUrl === undefined ? null : (
            <img alt={t("mobileQr.title")} className="mobile-qr-image" src={qrDataUrl} />
          )}
          <p className="mobile-qr-code" dir="ltr">
            {code}
          </p>
          <div className="modal-actions">
            <button className="button button-primary" onClick={print} type="button">
              {t("mobileQr.print")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
