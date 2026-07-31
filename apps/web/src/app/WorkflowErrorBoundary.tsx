import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  readonly children: ReactNode;
  readonly fallbackDescription: string;
  readonly fallbackTitle: string;
  readonly resetKey: string;
  readonly retryLabel: string;
}

interface State {
  readonly failed: boolean;
}

export class WorkflowErrorBoundary extends Component<Props, State> {
  public state: State = { failed: false };

  public static getDerivedStateFromError(): State {
    return { failed: true };
  }

  public componentDidCatch(error: Error, information: ErrorInfo): void {
    // Keep unexpected workflow errors out of the application shell. Logging
    // remains diagnostic-only and no stack trace is rendered to the User.
    console.error("Workflow rendering failed", error, information.componentStack);
  }

  public componentDidUpdate(previous: Props): void {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  public render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="route-message" role="alert">
        <h2>{this.props.fallbackTitle}</h2>
        <p>{this.props.fallbackDescription}</p>
        <button
          className="button button-primary"
          onClick={() => this.setState({ failed: false })}
          type="button"
        >
          {this.props.retryLabel}
        </button>
      </section>
    );
  }
}
