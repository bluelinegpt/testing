import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App.js";
import { StoreErrorBoundary } from "./app/StoreErrorBoundary.js";
import { CustomerSessionProvider } from "./auth/customer-session-context.js";
import { storeI18n } from "./localization/i18n.js";
import { NetworkStatusProvider } from "./pwa/network-status.js";
import { registerServiceWorker } from "./pwa/register-service-worker.js";
import "./styles/tokens.css";
import "./styles/store.css";

registerServiceWorker();

const container = document.getElementById("root");
if (container === null) throw new Error("Store root element is missing");

createRoot(container).render(
  <StrictMode>
    <StoreErrorBoundary>
      <I18nextProvider i18n={storeI18n}>
        <BrowserRouter>
          <NetworkStatusProvider>
            <CustomerSessionProvider>
              <App />
            </CustomerSessionProvider>
          </NetworkStatusProvider>
        </BrowserRouter>
      </I18nextProvider>
    </StoreErrorBoundary>
  </StrictMode>,
);
