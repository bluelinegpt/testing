import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";

import "./theme/bootstrap-theme.js";
import "./localization/i18n.js";
import { router } from "./app/router.js";
import { installNumberInputWheelGuard } from "./utils/number-input-wheel-guard.js";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) {
  throw new Error("Application root element is missing");
}

// Before render: a wheel over a money field must never edit it. See the module
// for why this is global rather than per input.
installNumberInputWheelGuard();

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
