import { Component, type ErrorInfo, type ReactNode } from "react";

import { platformApi } from "../api/platform-client.js";

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly failed: boolean;
}

/**
 * Wraps the whole Platform app. Until now this app had NO error boundary at
 * all -- an uncaught render error just broke silently, with nothing logged
 * anywhere. Reports to the same Error Handler screen every other app
 * reports to (`platformApi.reportError`), so a crash here is visible from
 * this very screen, not just invisible to whoever hit it.
 */
export class PlatformErrorBoundary extends Component<Props, State> {
  public override state: State = { failed: false };

  public static getDerivedStateFromError(): State {
    return { failed: true };
  }

  public override componentDidCatch(error: Error, information: ErrorInfo): void {
    console.error("Platform Administration rendering failed", error, information.componentStack);
    void platformApi.reportError({
      message: error.message,
      stack: [error.stack, information.componentStack].filter(Boolean).join("\n\n"),
    });
  }

  public override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="platform-loading" role="alert">
        <p>Unable to open Platform Administration. Please refresh the page.</p>
      </main>
    );
  }
}
