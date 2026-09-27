import { useState } from "react";

import type { ApiClient } from "../../api/api-client.js";

export type PdfAction = "download" | "preview" | "print";

/**
 * Shared Preview/Print/Download behaviour for server-generated reconciliation
 * PDFs (Driver Collection Report, Driver Shipment Manifest): fetches the real
 * PDF bytes via the authenticated API client, then opens or downloads the
 * blob. "Print" opens the PDF in its own window and prints that window, not
 * the caller's page — printing `window` directly would print whatever the
 * caller currently shows, not the report.
 */
export function useReconciliationPdfActions(api: ApiClient) {
  const [busy, setBusy] = useState<PdfAction>();

  const run = async (
    path: string,
    filename: string,
    mode: PdfAction,
    body?: unknown,
  ): Promise<unknown> => {
    setBusy(mode);
    // Open the tab synchronously while the click is still active. Waiting for
    // the API response before calling window.open makes browsers treat it as
    // a popup and silently leave the user on the Orders screen.
    const reportWindow =
      mode === "preview" || mode === "print"
        ? window.open("about:blank", "_blank")
        : null;
    try {
      const blob =
        body === undefined ? await api.getBinary(path) : await api.postBinary(path, body);
      const url = URL.createObjectURL(blob);
      if (mode === "download") {
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
      } else {
        if (mode === "print" && reportWindow !== null) {
          reportWindow.location.href = url;
          reportWindow.addEventListener("load", () => reportWindow.print());
        } else if (reportWindow !== null) {
          reportWindow.location.href = url;
        } else {
          // If the browser still blocks the tab, show the PDF in the current
          // tab rather than silently returning to the Orders screen.
          window.location.href = url;
        }
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      return undefined;
    } catch (error) {
      return error;
    } finally {
      setBusy(undefined);
    }
  };

  return { busy, run };
}
