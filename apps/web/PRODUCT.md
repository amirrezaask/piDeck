# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

piDeck is for a solo developer supervising a large fleet of PI agents. They need to understand live execution across many concurrent agents and intervene without losing the broader operational picture.

## Product Purpose

piDeck is a web GUI for running and supervising PI agents. Its primary job is to make large-scale agent execution observable and controllable: the developer can monitor live work, identify agents that need attention, and intervene. Success means the developer can keep a large fleet progressing safely without reading every event stream sequentially.

## Positioning

piDeck is a PI-native supervisory control surface rather than a generic chat client. It presents many live agent runs as one operational system and supports direct intervention in execution.

## Operating Context

The product connects to local or remote PI supervisors. A developer may have many concurrent agents and nested agentic workflows active across repositories and tasks. The interface must support continuous monitoring, triage, and intervention while preserving enough execution context to make safe decisions.

## Capabilities and Constraints

- Connect to and anticipate multiple remote supervisors as well as local operation.
- Stream live agent and run events.
- Present large fleets and nested agentic workflows without assuming a single-chat layout.
- First-class interventions include approving or denying requests, pausing or resuming execution, and cancellation.
- The current stack is React, TypeScript, Vite, Tailwind CSS, and shadcn/ui.
- Current supervisor APIs expose managed agents and runs, event streams, cancellation, steering, and follow-up. Approval and pause/resume are confirmed product requirements even where backend support remains to be completed.
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
- Dense information should support expert scanning without becoming decorative telemetry.

## Accessibility & Inclusion

Status, urgency, and approval state must never rely on color alone. Keyboard operation and clearly announced live-state changes are required for the primary supervision workflow.
