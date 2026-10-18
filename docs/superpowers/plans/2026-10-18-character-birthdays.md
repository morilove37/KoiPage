# Character Birthdays Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. User has authorized implementation in this session; preserve unrelated working changes.

**Goal:** Add cached, editable library character birthdays to the home sidebar.
**Architecture:** Rust owns SQLite, providers, avatar cache and one cancellable background sync. React reads snapshots, computes local recurring dates and presents card/list/detail/editor dialogs.
**Tech Stack:** Existing React/TypeScript/Tauri/Rust/sqlx/reqwest; directly enable PNG/JPEG/WebP/GIF decoding in the already-transitive image crate for full avatar validation.
**Spec:** ../specs/2026-10-18-character-birthdays.md

## Global Constraints
- Keep existing unrelated working changes; implement on feat/character-birthdays in current checkout to preserve the active development setup.
- First sync is explicit; subsequent sync is incremental, 30-day expiry and one-hour error backoff.
- VNDB first; Bangumi fallback for games without VNDB ID; no cross-source fuzzy identity matching.
- Display main/primary, non-spoiler associations; preserve overrides and cache on failures.
- Run development build only; never package a release without a user request.

## Review Focus
- Cancellation or metadata ID changes during requests must not replace valid links with partial or stale results.
- Source availability/429 must preserve previous data and allow retry/cancellation.
- Invalid imported identities/dates/images must fail atomically, without touching unrelated data.
- Unknown birthdays and hidden characters need reachable correction/restoration UI.
- Database backups and portable birthday exports must retain personal edits and cached avatar behavior.

### Task 1: Date model
Files: src/features/birthdays/types.ts, model.ts; tests/birthdays.test.mjs.
Produces: birthdayOccurrence(month, day, now), buildBirthdayEntries(characters, now), birthdayLabel(entry).
- [x] Write/run failing date and sort tests (cross year, leap day, unknown/invalid, local midnight, deterministic priority).
- [x] Implement pure TypeScript date model; run node --test tests/birthdays.test.mjs, expect all pass. User follow-up restricts home to today through +30 days; management list keeps all dates. Regression verified RED → GREEN.

### Task 2: Persisted character snapshots and provider parsing
Files: src-tauri/migrations/0003_birthdays.sql; src-tauri/src/birthdays/{mod,model,providers,store,tests}.rs; commands/mod.rs; lib.rs.
Produces: birthdays_list(), birthdays_update(id, input), birthdays_sync_start(force), birthdays_sync_cancel(). Snapshot includes characters, per-game sync states, enabled, progress.
- [x] Write Rust fixtures/database tests before implementation and observe failure.
- [x] Implement migration, parsers, transaction store, validated overrides, avatar storage, serial paginated sync with progress/cancellation and stale ID guards.
- [x] Run cargo test birthdays --lib, expect all pass; development build verifies compilation.

### Task 3: Portable birthday data
Files: src-tauri/src/birthdays/portable.rs; birthday IPC wrappers.
Produces: birthdays_export(path), birthdays_import(path), with bounded JSON and base64-free byte arrays for image contents.
- [x] Write atomic import/export and invalid payload tests; observe failure.
- [x] Implement versioned portable records, source identity matching, override preservation and avatar bytes; verify roundtrip tests pass.

### Task 4: Home card, all/detail/edit dialogs and sync lifecycle
Files: src/features/birthdays/{io,useBirthdays,BirthdayCard,BirthdayDialogs}.tsx/ts; src/features/home/HomePage.tsx; geometry-icon.tsx.
Consumes: Task 1 model and Task 2/3 IPC.
- [x] Implement card and dialogs using existing UI controls. Add incremental refresh on mount/library changes/focus, midnight timer, progress/cancel/retry, import/export actions, manual avatar picker and reset/hide/restore.
- [x] Run pnpm build and pnpm check:ipc; expect success.
- [x] Verify isolated browser fixtures at 1280/960 widths, dark/light/glass, first use/error/unknown/overflow states and edit/hide/restore actions. Screenshots in workspace _verify/birthday-*.png.

### Task 5: Development verification and review
- [x] Run date tests, existing node tests, Rust tests, IPC check and production frontend compilation (no release packaging). Node 29/29; Rust 119 passed, 13 existing live tests ignored.
- [x] Launch latest Rust development build and verify migration/list/update/backup against real IPC. Current library: 3 works, 21 primary characters, 7 known birthdays, zero provider errors. Reversible native edit restored in finally; 21-record portable roundtrip preserved values and associations; database backup succeeded. Invalid-image regression artifact removed by exact task-owned filename.
- [x] Request one independent review of birthday changes, fix material findings and re-run affected checks. Three P2 findings fixed with failing-then-passing regressions: stale association on import, cancellation awaiting DB connection, signature-only invalid images. Added real decoding tests for PNG/JPEG/WebP/GIF.
- [x] Record outcomes and limitations in docs/character-birthdays.md and development index. Home empty-state regression verifies known birthdays outside 30 days remain distinguished from genuinely unknown dates. Final frontend build/IPC check and browser QA passed after that correction; development application remains running.

## Execution decisions
- Use a feature branch in the existing checkout so unrelated uncommitted import/tool/window work and the active development server stay available. Do not stage or commit other work.
- User confirmed the in-chat design and implementation; continue without redundant approval prompts. Preserve the written spec and this plan for review.
- Image content validation requires decoding. Reuse the transitive image 0.25.10 crate as a direct dependency with four codecs; three codec helper packages enter Cargo.lock. Limit input to 4MB, dimensions to 4096×4096, and decode allocation to 64MB.
- Avatar files are external to SQLite backups. Portable birthday JSON embeds images, while database-only backup retains records, edits and cache paths. Existing cache is reused after restart; JSON is the portable transfer path.
