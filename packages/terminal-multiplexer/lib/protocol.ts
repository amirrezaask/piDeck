export interface MultiplexerTerminal {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly cwd: string;
  readonly status: 'running' | 'exited';
  readonly createdAt: string;
  readonly exitCode?: number;
}

export type TerminalSocketInput =
  | { readonly type: 'input'; readonly data: string }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number };
