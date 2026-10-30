# VNDB Description Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Implement inline under the user's request.

**Goal:** Enrich VNDB imports with trustworthy Chinese descriptions from enabled providers.

**Architecture:** Reuse reference enrichment; prefer Chinese descriptions in merge; add conservative title-based fallback and optional description provenance in IPC. No database schema changes.

**Tech Stack:** Rust, Tauri, React, TypeScript.

**Spec:** docs/superpowers/specs/2026-10-30-vndb-description-design.md

## Global Constraints
- Keep existing-description protection and enabled-provider settings.
- No synthetic writes into actual user library; no installers.

## Review Focus
- English primary must accept Chinese secondary; Chinese primary must remain intact.
- Empty secondary must not erase a useful intro.
- Ambiguous titles, FD/sequels and conflicting known IDs must not borrow descriptions.
- Disabled/erroring secondary providers must preserve a successful VNDB result.
- Attribution and description provenance must follow the chosen text.

### Task 1: Merge and identity rules
- [x] Add failing tests for Chinese description preference and conservative candidate selection.
- [x] Implement focused helpers and source provenance.
- [x] Run focused Rust tests.

### Task 2: Resolve and confirmation
- [x] Wire enabled Bangumi/2DFan fallback into shared VNDB detail resolver.
- [x] Show description source in the confirmation field.
- [x] Add a read-only ignored live test and run it explicitly.

### Task 3: Verification
- [x] Run frontend tests/build/IPC checks and full Rust suite.
- [x] Review changes, build development app and inspect without writing test data.
- [x] Document results and limits.
