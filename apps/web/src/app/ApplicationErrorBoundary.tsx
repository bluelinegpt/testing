import { useRouteError } from "react-router-dom";

export function ApplicationErrorBoundary() {
  useRouteError();
  return (
    <main className="error-page" role="alert">
      <h1>Unable to open BluelineGPT</h1>
      <p>Please refresh the page. If the problem continues, contact support.</p>
    </main>
  );
}
