import { Component, type ErrorInfo, type ReactNode } from "react"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@yaade/ui/primitives"
import { AlertTriangle } from "lucide-react"

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[yaade] renderer crashed", error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>YAADE needs to recover</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Alert variant="destructive">
              <AlertTriangle aria-hidden />
              <AlertTitle>The interface hit an unexpected error</AlertTitle>
              <AlertDescription>
                Your files and terminal processes were not modified. Reload to reconnect.
              </AlertDescription>
            </Alert>
            <pre className="max-h-32 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
              {this.state.error.message}
            </pre>
            <Button onClick={() => window.location.reload()}>Reload YAADE</Button>
          </CardContent>
        </Card>
      </main>
    )
  }
}
