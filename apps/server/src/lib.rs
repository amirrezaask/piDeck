//! Rust implementation of the YAADE host runtime.
//!
//! The TypeScript executable remains the release entry point until the Rust
//! implementation passes the same protocol, persistence, PTY, security, and
//! lifecycle suites. Keeping both implementations in `apps/server` preserves
//! the existing application boundary during the parity migration.

pub mod agents;
pub mod config;
pub mod connection_outbound;
pub mod database_owner;
pub mod device_auth;
pub mod diagnostics;
pub mod event_hub;
pub mod model;
pub mod outbound_mailbox;
pub mod runtime;
pub mod server;
pub mod service;
pub mod store;
pub mod tasks;
pub mod terminal;
pub mod terminal_control;
pub mod terminal_history;
pub mod wire;
