# Bangumi Sync Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans; independent credential/client and frontend packages use superpowers:dispatching-parallel-agents with fixed interfaces.

**Goal:** User-configured token, bidirectional automatic collection sync and explicit conflicts.
**Architecture:** Isolated Rust sync module, Windows credentials, HTTP client, SQLite personal profiles/baselines, pure field merge; frontend settings/profile panels and polling runtime.
**Tech Stack:** Tauri/Rust/SQLite, Windows Credential Manager, React/TypeScript.
**Spec:** docs/superpowers/specs/2026-10-30-bangumi-sync-design.md

## Global Constraints
- Preserve existing work; no installer or actual user-account test writes.
- Tokens never go into settings, backup or API responses.
- Public rating/private notes remain separate from personal collection fields.

## Review Focus
- First sync and same-field conflicts must not overwrite valid differing values.
- Account/subject changes invalidate baselines.
- Concurrent local edits and failed/unknown upload outcomes must preserve pending work.
- Omitted tags/privacy must stay untouched for existing collections.
- Restoring backups cannot silently resume remote writes.

### Task 1: Credentials and client (isolated agent)
- [x] Implement fixed client/credential contract with local HTTP tests, no real token writes.
### Task 2: State and engine (parent)
- [x] Test pure mappings/merge first, add migration 4, transactional profiles, sync orchestration and commands.
### Task 3: Frontend (isolated agent)
- [x] Implement specified settings/profile/runtime interfaces; integrate settings/detail/root and test pure helpers.
### Task 4: Integration and review
- [x] Full frontend/Rust/IPC/release checks and independent review, development UI inspection without token.
- [x] Record tested and untested limits; reopen development app.

## Verification evidence

Frontend119passed; Rust227passed/17ignored; all build/IPC/release checks passed. Standard dev startup and actual library read-only checks passed. Remote-debug GUI automation was rejected by tool policy, so no claim of GUI automation or real-token end-to-end testing; see docs/changes/2026-10-30-bangumi-sync.md. No installer or commit.
