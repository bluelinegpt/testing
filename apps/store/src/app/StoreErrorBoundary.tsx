import { Component, type ErrorInfo, type ReactNode } from "react";

import { reportClientError } from "../api/error-reporting-client.js";

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly failed: boolean;
}

/**
 * Wraps the whole Store app. Reports to the same Error Handler screen every
 * other app reports to, via the PUBLIC endpoint (`error-reporting-client.ts`)
 * -- most shoppers hitting this are anonymous, so there is no session to
 * require.
 */
export class StoreErrorBoundary extends Component<Props, State> {
  public override state: State = { failed: false };

  public static getDerivedStateFromError(): State {
    return { failed: true };
  }

  public override componentDidCatch(error: Error, information: ErrorInfo): void {
    console.error("Store rendering failed", error, information.componentStack);
    reportClientError({
      message: error.message,
      stack: [error.stack, information.componentStack].filter(Boolean).join("\n\n"),
    });
  }

  public override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="store-error-page" role="alert">
        <p>Something went wrong. Please refresh the page.</p>
      </main>
    );
  }
}
