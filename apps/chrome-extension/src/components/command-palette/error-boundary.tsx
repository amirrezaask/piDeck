import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangleIcon } from 'lucide-react';

interface Props {
  readonly children: ReactNode;
}
interface State {
  readonly failed: boolean;
}

export class PaletteErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };
  static getDerivedStateFromError(): State {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV) console.error('Switcher palette failed', { error, info });
  }
  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div
          role="alert"
          className="flex min-h-52 flex-col items-center justify-center gap-3 p-8 text-center"
        >
          <AlertTriangleIcon className="text-destructive" />
          <strong>Switcher could not render.</strong>
          <span className="text-sm text-muted-foreground">Dismiss and open it again.</span>
        </div>
      );
    }
    return this.props.children;
  }
}
