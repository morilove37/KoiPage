//! Outbound network configuration shared by every HTTP client.
//!
//! A user behind a restrictive network needs a proxy for the metadata sources
//! (2DFan especially), the AI assistant and the share uploader. Rather than
//! thread an `AppHandle` into each client builder — several of them are built
//! inside `sync` code paths or deep in provider modules — the resolved proxy is
//! cached in a process-wide cell that the settings commands keep in sync.
//!
//! The cell is empty until [`proxy::reload`] runs, which the frontend triggers
//! on launch and the settings UI triggers on every save. An empty cell means
//! "no proxy configured", which is the default and keeps direct connections.

pub mod proxy;
