# Product

<!-- impeccable:product-schema 1 -->

## Platform

Electron desktop application with a React renderer and a standalone Node server binary

## Users

piDeck is for a solo developer supervising a large fleet of PI agents. They need to understand live execution across many concurrent agents and intervene without losing the broader operational picture.

## Product Purpose

piDeck is a web GUI for running and supervising PI agents. Its primary job is to make large-scale agent execution observable and controllable: the developer can monitor live work, identify agents that need attention, and intervene. Success means the developer can keep a large fleet progressing safely without reading every event stream sequentially.

## Positioning

piDeck is a PI-native supervisory control surface rather than a generic chat client. It presents many live agent runs as one operational system and supports direct intervention in execution.

## Operating Context

The product connects to local or remote PI supervisors. A developer may have many concurrent agents and nested agentic workflows active across repositories and tasks. The interface must support continuous monitoring, triage, and intervention while preserving enough execution context to make safe decisions.

## Capabilities and Constraints

- Connect to multiple local or remote supervisors. Users manage server origins and access tokens in Settings, sessions from all connected servers share one sidebar, and each new session targets an explicit server.
- Stream live agent and run events.
- Present large fleets and nested agentic workflows without assuming a single-chat layout.
- Current first-class interventions are cancellation, immediate steering while a run streams, and queued follow-up for a completed run. Approval and pause/resume are not implemented controls and must be represented as unavailable rather than simulated.
- The client stack is Electron, React, TypeScript, Vite, Tailwind CSS, and shadcn/ui. The Electron main process owns encrypted server credentials and authenticated HTTP transport; the sandboxed renderer receives only narrow preload capabilities.
- Current supervisor APIs expose managed agents and runs, bounded event history, authenticated resumable event streams, cancellation, steering, and follow-up. Image attachments are sent through Pi’s image input; unsupported arbitrary files are rejected before submission.
- Authentication, collaboration, mobile operation, and deployment topology remain open decisions.

## Brand Commitments

The product name is piDeck. Product language should be direct, technical, and operational rather than anthropomorphic or playful.

## Evidence on Hand

- The repository contains a working local supervisor service with health, agent, run, event-stream, cancel, steer, and follow-up endpoints.
- Typed contracts for agents, runs, workflows, events, statuses, models, and tool activity live under `packages/contracts`.
- The existing `apps/web` interface is an early connectivity placeholder, not a mature product surface.
- No customer claims, benchmarks, testimonials, or production-scale usage evidence are available and must not be fabricated.

## Product Principles

- Fleet state before individual conversation.
- Attention is prioritized; raw activity is available on demand.
- Every intervention shows its target, consequence, and acknowledgement.
- Live state must remain trustworthy under reconnects, delayed events, and partial supervisor failure.
- Durable run/event history is authoritative over a chat view; the next architecture direction remains fleet state before an individual conversation.
- Dense information should support expert scanning without becoming decorative telemetry.

## Accessibility & Inclusion

Status, urgency, and approval state must never rely on color alone. Keyboard operation and clearly announced live-state changes are required for the primary supervision workflow.
