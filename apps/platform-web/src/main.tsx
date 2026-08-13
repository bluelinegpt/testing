import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

// Side-effect import, before the stylesheet and before React: it stamps
// `data-theme` on the document element so the first paint is already the right
// palette. Mounting the theme inside a component would flash the wrong one.
import "./theme/bootstrap-theme.js";

import { App } from "./App.js";
import { PlatformErrorBoundary } from "./app/PlatformErrorBoundary.js";
import { PlatformSessionProvider } from "./app/PlatformSession.js";
import "./styles/platform.css";

const container = document.getElementById("root");
if (container === null) throw new Error("Platform root element is missing");

createRoot(container).render(
  <StrictMode>
    <PlatformErrorBoundary>
      <BrowserRouter>
        <PlatformSessionProvider>
          <App />
        </PlatformSessionProvider>
      </BrowserRouter>
    </PlatformErrorBoundary>
  </StrictMode>,
);
