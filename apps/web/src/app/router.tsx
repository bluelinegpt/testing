import { createBrowserRouter } from "react-router-dom";

import { App } from "./App.js";
import { ApplicationErrorBoundary } from "./ApplicationErrorBoundary.js";

export const router = createBrowserRouter([
  {
    element: <App />,
    errorElement: <ApplicationErrorBoundary />,
    path: "*",
  },
]);
