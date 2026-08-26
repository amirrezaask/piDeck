# Coding harness UI research

Research date: 2026-03-11

## Products reviewed

| Product | Primary interface patterns |
| --- | --- |
| [T3 Code](https://github.com/pingdotgg/t3code) | Project and session rail, local or worktree execution, branch context, integrated terminal, diff review, approval modes |
| [OpenCode](https://opencode.ai/docs/web/) | Shared sessions across terminal and web clients, compact transcript, permission prompts, question dock, model and provider controls |
| [Codex app](https://openai.com/index/introducing-the-codex-app/) | Parallel task threads, Git worktrees, persistent composer, integrated terminal, review pane, staging and revert controls |
| [Claude Code desktop](https://code.claude.com/docs/en/desktop) | Parallel isolated sessions, split panes, terminal and editor, visual diffs with comments, previews, GitHub workflow |
| Cursor | Editor-first agent panel, file-aware composer, inline diffs, checkpoints, background agents, permission controls |
| Windsurf, Cline, and Roo Code | Editor-first task threads, tool approval, file changes, terminal output, checkpoints, model controls |

## Shared UI model

The products converge on the same operating model:

1. **Workspace before prompt.** The project, branch, worktree, or remote environment stays visible while you write and review a task.
2. **Sessions as durable work.** A left rail keeps active and completed threads available. Status appears in the rail so you can supervise work without opening each transcript.
3. **Transcript in the center.** User requests, assistant output, tool calls, and system events share one chronological surface. Tool detail stays collapsed until requested.
4. **Composer at the edge of action.** New-task controls include workspace, model, permissions, and attachments. Existing tasks keep a composer docked below the transcript.
5. **Explicit execution state.** Running, queued, completed, failed, reconnecting, and approval states use text plus a visual indicator.
6. **Review beside conversation.** Mature products expose file changes, diffs, terminal output, and preview state without replacing the task thread.
7. **Parallel work by default.** Sessions continue in the background. Worktrees or isolated environments prevent tasks from competing for one checkout.
8. **Keyboard-first navigation.** New task, project switching, session search, panel toggles, and send actions have shortcuts.

## Product differences

- T3 Code and Codex place Git worktrees and code review near the center of the experience.
- OpenCode keeps the transcript compact and exposes permissions and agent questions as first-class interaction states.
- Claude Code desktop invests in flexible panes, previews, and line-level review comments.
- Cursor and Windsurf remain editor-first. Their agent UI depends on the surrounding file tree and editor tabs.

## Direction for piDeck

piDeck should use the shared shell without turning into an editor clone. Fleet supervision is the product advantage.

### Implemented in this pass

- Fleet counts beside the session rail for active runs and runs that need attention.
- A workspace-oriented new-session screen with starter tasks, project, server, agent, model, thinking level, and attachments in one composer.
- `Cmd/Ctrl+N` for a new session and `Cmd/Ctrl+,` for settings.
- Project, branch, server, agent, and model context in the run header.
- A persistent run composer that explains queued follow-up versus immediate steering.
- Wider transcript measure, compact tool activity, refined focus depth, themed browser surfaces, and visible reduced-motion behavior.

### Delivered supervisor surfaces

- `/fleet` orders failures and active work first, reports server health, and nests runs linked by `parentRunId`.
- Run changes expose working-tree, staged, and branch diffs. Last-turn explicitly reports unavailable until the supervisor captures turn boundaries.
- Terminal sessions run bounded executable-plus-argv processes in managed workspaces. Electron exposes no process or shell IPC.
- Managed worktrees have recorded creation, readiness, release, failure, branch, and base-ref state. Runs record Local or Worktree execution.
- `/inbox` handles single-operator approvals and structured questions with atomic pending-to-resolved or cancelled transitions.
- Session search backs the global command palette and navigation shortcuts.

The terminal surface is intentionally not a full PTY. Interactive input exists at the supervisor seam, while the current UI runs bounded commands and polls durable output. Multi-user approval roles remain outside the single-operator product model.

## Sources

- [T3 Code repository](https://github.com/pingdotgg/t3code)
- [OpenCode web documentation](https://opencode.ai/docs/web/)
- [OpenCode permissions](https://opencode.ai/docs/permissions/)
- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
- [Codex app worktrees](https://developers.openai.com/codex/app/worktrees)
- [Codex app review](https://developers.openai.com/codex/app/review)
- [Claude Code desktop](https://code.claude.com/docs/en/desktop)
- [Cursor Agent](https://prod.cursor.com/help/ai-features/agent) and [background agents](https://docs.cursor.com/background-agent)
- [Windsurf Cascade](https://docs.windsurf.com/windsurf/cascade/cascade)
- [Cline IDE interface](https://docs.cline.bot/usage/ide) and [checkpoints](https://docs.cline.bot/core-workflows/checkpoints)
