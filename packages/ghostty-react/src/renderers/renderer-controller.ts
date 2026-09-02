import type {
  GhosttyRenderUpdate,
  GhosttyViewportModel,
} from "@yaade/ghostty-core";
import type { GhosttyColor } from "../core.js";
import type { GhosttyCellMetrics } from "../renderer.js";
import type {
  TerminalRenderer,
  TerminalRenderFont,
  TerminalRenderOverlays,
  TerminalRenderViewport,
  TerminalRendererSubmissionDiagnostics,
} from "./terminal-renderer.js";

export type RendererControllerState =
  | "initializing"
  | "ready"
  | "recovering"
  | "fallback"
  | "unavailable"
  | "disposed";

export interface ControlledTerminalRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: TerminalRenderer;
}

export interface RendererControllerDiagnostics {
  readonly backend: TerminalRenderer["kind"] | "unavailable";
  readonly state: RendererControllerState;
  readonly generation: number;
  readonly recoveryCount: number;
  readonly lastErrorClass: string | null;
  readonly fallbackReason: string | null;
  readonly submission: TerminalRendererSubmissionDiagnostics | null;
}

export class RendererController {
  private active: ControlledTerminalRenderer | null;
  private stateValue: RendererControllerState = "initializing";
  private generationValue = 1;
  private recoveryCountValue = 0;
  private lastErrorClassValue: string | null = null;
  private fallbackReasonValue: string | null = null;
  private recovery: Promise<void> | null = null;
  private recoveryToken = 0;

  constructor(
    initial: ControlledTerminalRenderer,
    private readonly create: (
      backend: "webgl2" | "canvas2d",
    ) => Promise<ControlledTerminalRenderer>,
    private readonly onActivate: (
      next: ControlledTerminalRenderer,
      previous: ControlledTerminalRenderer | null,
    ) => void,
    private readonly onFullRepaint: () => void,
  ) {
    this.active = initial;
    this.stateValue = "ready";
    this.installContextListeners(initial);
  }

  get canvas(): HTMLCanvasElement | null { return this.active?.canvas ?? null; }
  get backend(): TerminalRenderer["kind"] | "unavailable" {
    return this.active?.renderer.kind ?? "unavailable";
  }
  get state(): RendererControllerState { return this.stateValue; }
  get generation(): number { return this.generationValue; }
  get diagnostics(): RendererControllerDiagnostics {
    return {
      backend: this.backend,
      state: this.stateValue,
      generation: this.generationValue,
      recoveryCount: this.recoveryCountValue,
      lastErrorClass: this.lastErrorClassValue,
      fallbackReason: this.fallbackReasonValue,
      submission: this.active?.renderer.submissionDiagnostics ?? null,
    };
  }

  clear(background: GhosttyColor): void {
    this.run("clear", renderer => renderer.clear(background));
  }

  resize(viewport: TerminalRenderViewport): void {
    this.run("resize", renderer => renderer.resize(viewport));
  }

  async setFont(font: TerminalRenderFont): Promise<GhosttyCellMetrics | null> {
    const active = this.active;
    if (active === null || this.stateValue === "disposed") return null;
    try {
      return await active.renderer.setFont(font);
    } catch (error) {
      this.handleFailure("font", error);
      return null;
    }
  }

  capturePixels(): Promise<ImageData | null> {
    const active = this.active;
    if (active === null || this.stateValue === "disposed" || !active.renderer.capturePixels) {
      return Promise.resolve(null);
    }
    return active.renderer.capturePixels().catch(error => {
      this.handleFailure("capture", error);
      return null;
    });
  }

  trimIdle(lastActivityAt: number, now?: number): boolean {
    const active = this.active
    if (active === null || this.stateValue === "disposed" || !active.renderer.trimIdle) return false
    try {
      return active.renderer.trimIdle(lastActivityAt, now)
    } catch (error) {
      this.handleFailure("idle-trim", error)
      return false
    }
  }

  render(
    model: GhosttyViewportModel,
    update: GhosttyRenderUpdate | null,
    overlays: TerminalRenderOverlays,
  ): void {
    if (this.stateValue !== "ready" && this.stateValue !== "fallback") return;
    this.run("render", (renderer) => renderer.render(model, update, overlays));
  }

  requestRecovery(reason: string, error?: Error): void {
    if (this.stateValue === "disposed" || this.recovery !== null) return;
    this.lastErrorClassValue = error?.name ?? null;
    this.fallbackReasonValue = reason;
    this.stateValue = "recovering";
    this.recoveryCountValue += 1;
    const token = ++this.recoveryToken;
    const preferred = this.active?.renderer.kind === "webgl2" ? "webgl2" : "canvas2d";
    this.recovery = this.recover(token, preferred).finally(() => {
      if (token === this.recoveryToken) this.recovery = null;
    });
  }

  dispose(): void {
    if (this.stateValue === "disposed") return;
    this.stateValue = "disposed";
    this.recoveryToken += 1;
    const active = this.active;
    this.active = null;
    if (active !== null) {
      this.removeContextListeners(active);
      active.renderer.dispose();
    }
  }

  private run(operation: string, apply: (renderer: TerminalRenderer) => void): void {
    const active = this.active;
    if (active === null || this.stateValue === "disposed") return;
    try {
      apply(active.renderer);
    } catch (error) {
      this.handleFailure(operation, error);
    }
  }

  private handleFailure(operation: string, error: unknown): void {
    const parsed = error instanceof Error ? error : new Error(`${operation} failed`);
    this.requestRecovery(operation, parsed);
  }

  private async recover(
    token: number,
    preferred: "webgl2" | "canvas2d",
  ): Promise<void> {
    const attempts: readonly ("webgl2" | "canvas2d")[] =
      preferred === "webgl2" ? ["webgl2", "canvas2d"] : ["canvas2d"];
    for (const backend of attempts) {
      try {
        const next = await this.create(backend);
        if (token !== this.recoveryToken || this.stateValue === "disposed") {
          next.renderer.dispose();
          return;
        }
        const previous = this.active;
        this.removeContextListeners(previous);
        this.active = next;
        this.generationValue += 1;
        this.stateValue = backend === preferred ? "ready" : "fallback";
        this.fallbackReasonValue = backend === preferred ? null : this.fallbackReasonValue;
        this.installContextListeners(next);
        this.onActivate(next, previous);
        previous?.renderer.dispose();
        this.onFullRepaint();
        return;
      } catch (error) {
        this.lastErrorClassValue = error instanceof Error ? error.name : "Error";
      }
    }
    if (token === this.recoveryToken && this.stateValue !== "disposed") {
      this.stateValue = "unavailable";
    }
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.requestRecovery("context-lost");
  };

  private readonly onContextRestored = (): void => {
    if (this.stateValue === "recovering") this.requestRecovery("context-restored");
  };

  private installContextListeners(value: ControlledTerminalRenderer): void {
    if (value.renderer.kind !== "webgl2") return;
    value.canvas.addEventListener("webglcontextlost", this.onContextLost);
    value.canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  private removeContextListeners(value: ControlledTerminalRenderer | null): void {
    if (value?.renderer.kind !== "webgl2") return;
    value.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    value.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
  }
}
