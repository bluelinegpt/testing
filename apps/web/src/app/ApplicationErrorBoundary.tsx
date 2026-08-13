import { useEffect } from "react";
import { useRouteError } from "react-router-dom";

import { reportClientError } from "../api/error-reporting-client.js";

export function ApplicationErrorBoundary() {
  const error = useRouteError();
  // Fires once per distinct error, not on every re-render of this boundary.
  useEffect(() => {
    const stack = error instanceof Error ? error.stack : undefined;
    reportClientError({
      message: error instanceof Error ? error.message : String(error),
      ...(stack === undefined ? {} : { stack }),
    });
  }, [error]);
  return (
    <main className="error-page" role="alert">
      <h1>Unable to open BluelineGPT</h1>
      <p>Please refresh the page. If the problem continues, contact support.</p>
    </main>
  );
}
