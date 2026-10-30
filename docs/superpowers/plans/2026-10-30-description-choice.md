# Description Choice Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Implement inline.

**Goal:** Allow explicit introduction-source selection in manual metadata confirmation.

**Architecture:** Keep description variants in metadata responses, request additional variants only for confirmation, apply a pure frontend selection before preview/submission.

**Tech Stack:** Rust/Tauri, React, TypeScript.

**Spec:** docs/superpowers/specs/2026-10-30-description-choice-design.md

## Global Constraints
- Preserve matching guards, source settings, local-field protection and automatic import defaults.
- No user-library test writes, no database migrations or installers.

## Review Focus
- A non-selected alternative must survive merge.
- Text, language and source must change together while other fields stay unchanged.
- Switching must not toggle the user's overwrite checkbox.
- New candidates/open cycles must reset selection and stale requests must be ignored.
- Supplementary provider failure must leave available choices usable.

### Task 1: Data and selection
- [x] Add failing Rust variant retention and frontend selection tests.
- [x] Implement response variants and pure selection helper.

### Task 2: Collection and UI
- [x] Opt manual confirmation into parallel enabled-provider collection; preserve automatic path.
- [x] Add source selector, preview and submission wiring with reset behavior.

### Task 3: Verification
- [x] Run full frontend/Rust suites, build and IPC checks; review.
- [x] Verify read-only live options and switch previews in development app.
- [x] Record results and reopen development app.

User steering: Chinese introductions have first priority even with VNDB as default; within Chinese options prefer the configured source. Without Chinese use the default source/fallback. Manual overrides persist until candidate/open reset. Verified in actual read-only development preview.
