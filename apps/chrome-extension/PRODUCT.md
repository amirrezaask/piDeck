# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated: WXT, Manifest V3, React, strict TypeScript, Tailwind CSS, shadcn/ui, Effect, Vitest, and Playwright in the existing pnpm monorepo.

## Users

Keyboard-driven Chrome users who keep many tabs and windows open and need to navigate or manage them without leaving the current page.

## Product Purpose

ChromePlus turns Chrome into the shell for terminal and agent work. The extension opens each tool in a browser tab while the local piDeck host owns sessions, processes, and history. Switcher keeps tab retrieval and browser actions close to the keyboard.

## Positioning

ChromePlus uses Chrome tabs and native Split View instead of recreating browser navigation and pane layout inside one application page. Switcher adds local fuzzy ranking, cross-window awareness, recency, and tab actions.

## Capabilities and Constraints

Chrome-first. Open terminal and agent surfaces, search open tabs, then activate, close, pin, or mute them. Chrome does not expose an extension method for creating Split View, so the user creates the split and ChromePlus reuses its companion tab. No native messaging, telemetry, persistent host permissions, static all-page content script, or remote code.

## Brand Commitments

The product name is “ChromePlus.” Switcher is its command palette. The interface is dense, professional, minimal, dark-mode friendly, and built for power users.

## Product Principles

- Keyboard operation is complete, not secondary.
- Invocation is explicit and permissions stay narrow.
- Search feels local and immediate at high tab counts.
- Browser boundaries fail visibly and recover through the fallback.
- Native Chrome tabs own product navigation and Split View placement.
- Provider and item seams make future sources additive.

## Accessibility & Inclusion

The palette is a modal dialog with visible focus, full keyboard control, screen-reader labels, sufficient contrast, and reduced-motion behavior.
