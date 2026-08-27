import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  readonly error?: Error;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer failed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
        <section className="w-full max-w-lg rounded-xl border bg-card p-6 shadow-sm">
          <h1 className="text-lg font-semibold">piDeck could not render this view</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your supervisor data is still stored. Reload the renderer to reconnect.
          </p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            className="mt-4 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
            onClick={() => window.location.reload()}
          >
            Reload piDeck
          </button>
        </section>
      </main>
    );
  }
}
