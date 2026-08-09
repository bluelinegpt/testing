import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App.js";
import { storeI18n } from "./localization/i18n.js";
import "./styles/tokens.css";
import "./styles/store.css";

const container = document.getElementById("root");
if (container === null) throw new Error("Store root element is missing");

createRoot(container).render(
  <StrictMode>
    <I18nextProvider i18n={storeI18n}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </I18nextProvider>
  </StrictMode>,
);
