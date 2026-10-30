# Reliability Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task by task. User authorized execution; implement inline.

**Goal:** Protect curated metadata, resume failed imports, migrate snapshots together with the library, and bound large-library rendering.

**Architecture:** Reuse metadata selection and Rust autofetch; extract an import queue runner; extend backup format with validated snapshot entries and remap restored storage; progressively render library results.

**Tech Stack:** React 18, TypeScript, Rust, Tauri 2, SQLite.

**Spec:** docs/superpowers/specs/2026-10-30-reliability-design.md

## Global Constraints

- No new dependencies, no release installers, no synthetic entries in user data.
- Keep v1 backups readable and protect current data during restore.

## Review Focus

- Existing zero ratings count as populated.
- Cover failure after game creation must not cause duplicate retry.
- StrictMode replay and stop/resume must not run two queues.
- Snapshots carry binary files and empty directories; validate manifests before publishing.
- Full selection and returning scroll position must survive incremental rendering.

### Task 1: Metadata protection
- [x] Test existing-value defaults and Rust autofetch fill-empty behavior.
- [x] Add pure field protection helper, load current values, show current/incoming fields, skip existing cover.
- [x] Verify focused tests and typecheck.

### Task 2: Import retry
- [x] Test queue eligibility, partial failure retry, stop/resume and single-run guard.
- [x] Extract sequential queue with injectable importer; wire retry failed, resume pending and per-item buttons.
- [x] Verify tests and typecheck.

### Task 3: Migration wizard
- [x] Test binary snapshot roundtrip, unsafe paths, corruption, old archive compatibility and root remapping.
- [x] Extend backup manifest and validation, add estimate/export options, remap snapshot storage on staged restore.
- [x] Add wizard UI and update backup docs.
- [x] Verify Rust tests, IPC contract and frontend tests.

### Task 4: Large library and delivery
- [x] Test incremental rendering boundaries and restored counts.
- [x] Bound mounted cards/rows, expose load-more action and preserve full selection.
- [x] Run synthetic benchmark, full frontend/Rust checks and development window verification.
- [x] Record evidence and limitations in change notes.

## Delivery evidence

See docs/changes/2026-10-30-reliability.md for measured results and limits. Independent review issue (v1 root preservation) resolved with a regression test. Included in the user-authorized v0.6.6 release.
