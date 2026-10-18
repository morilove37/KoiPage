# LunaTranslator Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in this session. User authorized integration and explicitly selected bundled/offline deployment; preserve existing unrelated working changes.

**Goal:** Ship an unmodified official LunaTranslator with attribution, corresponding source and a usable Tools entry.
**Architecture:** Embed the original ZIP and source archive, deploy via existing 7-Zip into writable app-local storage, launch an independent normal-privilege process. React exposes preparation/status/launch and opt-in game autostart.
**Tech Stack:** Existing Tauri/Rust/React/7-Zip; no new dependency.
**Spec:** ../specs/2026-10-18-luna-translator.md

## Global Constraints
- Pin official 12.1.2.9 and its verified binary hash; include GPL, original LICENSES and corresponding source.
- Preserve userconfig and self-updates; normal privileges; no forced external termination.
- User chose bundled mode. No install-time download; online translators still require network.
- Keep current work and active development setup. No release package without request.

## Review Focus
- Interrupted deployment/retries must preserve user files and avoid marking incomplete copies ready.
- Two concurrent launch actions must avoid duplicate tool starts.
- Existing elevated or other-directory Luna instances must not be forcibly stopped.
- Optional autostart failures must not prevent games launching.
- Source and legal notices must actually ship and be accessible, not merely named in docs.

### Task 1: Bundled release and backend
Files: resources/luna/*, src-tauri/src/launcher/luna.rs and luna_tests.rs; extract/mod.rs seven_zip_path visibility; launcher/mod.rs and lib.rs.
Produces: luna_status() -> {path,version,available,running,sourcePath,licensePath,noticePath}; luna_launch() -> bool; autostart(AppHandle) best effort.
- [x] Write failing tests for release/source digest, deployment and idempotence, missing-file repair, command current_dir and argument boundaries.
- [x] Implement pinned resources and spawn_blocking deployment, per-process deployment/launch locks, Windows exact path process discovery, best-effort autostart and IPC.
- [x] Run cargo test luna --lib, expect green. Four tests pass, including interrupted installation and source archive recovery.

### Task 2: Tools interface
Files: LunaToolSection.tsx, tools/io.ts, ToolsPage.tsx, ToolsSectionNav.tsx.
- [x] Add card/navigation, status refresh, manual launch, directory/source/license links, official docs and default-off persisted autostart.
- [x] Verify pnpm build and pnpm check:ipc; isolated UI fixtures cover ready/error/launch/source actions and narrow/theme layouts. Three themes at 1280/960 pass; persisted autostart can be disabled even when deployment fails.

### Task 3: Runtime validation, review and docs
- [x] Verify full Rust/Node suite and front-end build; launch newest development app and confirm offline resource deployment and real Luna launch. Rust 123 pass / 13 existing live tests ignored; Node 29/29; build, IPC and release metadata checks pass. Native concurrent launch returns [true,false], one matching process remains running; source ZIP hash equals manifest; autostart stays unset/off.
- [x] Review integration independently, fix material issues and rerun affected checks. Independent review found interrupted extraction, partial source archive and unavailable autostart toggle; all reproduced RED then fixed GREEN using staging/atomic publication and independent settings loading.
- [x] Document GPL/source evidence, sizes, storage/config, autostart scope and offline translation distinction; leave development version usable. See docs/luna-translator.md and native screenshot ../_verify/luna-native-final.png. No installer generated.

## Execution decisions

- Follow-up: user requested a close control. Added luna_quit and「退出 Luna」using normal WM_CLOSE for exact-path Luna Qt windows, sharing the launch mutex. New policy and UI regressions verified RED → GREEN; independent review found no material issues. Native button test confirmed actual process exit, not-running status, disabled exit, enabled start, and no-op repeat quit. Five Luna Rust tests, frontend build/IPC and browser theme/layout checks passed; the development app remains open with Luna stopped.
- The user explicitly chose bundled delivery; retain the original official ZIP and exact source archive in resources rather than adding a network installer. Costs about 67 MiB of embedded archives, plus extracted runtime space.
- Integration uses an independent process and an opt-in launcher. It does not configure translation engines or keys, elevate automatically, or terminate unrelated Luna instances. Online engines still require connectivity.
- Preserve successful self-updates while ensuring retries after first-install interruption replace partial official files. Source/license/notice are fixed embedded artifacts, independently verified and atomically repaired.
- Work remains in the current feature branch/check-out with preexisting birthday/archive/tool/window edits preserved; no unrelated changes staged, no merge, push or release packaging performed.
