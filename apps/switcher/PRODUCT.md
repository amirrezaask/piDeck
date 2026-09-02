# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated: WXT, Manifest V3, React, strict TypeScript, Tailwind CSS, shadcn/ui, Effect, Vitest, and Playwright in the existing pnpm monorepo.

## Users

Keyboard-driven Chrome users who keep many tabs and windows open and need to navigate or manage them without leaving the current page.

## Product Purpose

Switcher makes tab retrieval and common browser actions immediate through one command palette. Success means a user can invoke, search, act, and return to work without reaching for browser chrome.

## Positioning

Unlike a passive tab list, Switcher combines local fuzzy ranking, cross-window awareness, recency, and tab actions in a runtime-injected page overlay with a restricted-page fallback.

## Capabilities and Constraints

Chrome-first. Search open tabs, activate, close, pin, mute, and run a small browser-command set. No history, bookmarks, native messaging, agents, telemetry, external network requests, persistent host permissions, or static all-page content script.

## Brand Commitments

The product name is “Switcher.” Its interface is dense, professional, minimal, dark-mode friendly, and designed for power users in the spirit of Linear, Raycast, and modern command palettes.

## Product Principles

- Keyboard operation is complete, not secondary.
- Invocation is explicit and permissions stay narrow.
- Search feels local and immediate at high tab counts.
- Browser boundaries fail visibly and recover through the fallback.
- Provider and item seams make future sources additive.

## Accessibility & Inclusion

The palette is a modal dialog with visible focus, full keyboard control, screen-reader labels, sufficient contrast, and reduced-motion behavior.
