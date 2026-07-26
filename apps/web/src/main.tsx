import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";

import "./localization/i18n.js";
import { router } from "./app/router.js";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) {
  throw new Error("Application root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
