# Folder usability implementation plan

**Goal:** Implement the four approved folder improvements: recursive unique game counts, editable memberships in one dialog, empty-folder mode reset, and drag sorting/moving with undo.

**Architecture:** Keep folder data in the existing SQLite settings value and preserve array order for sibling order. Add pure folder operations and pointer-based internal dragging, with saves through the existing guarded persistence function. All updates publish after successful persistence. Keep built-in groups read-only and exclude invalid move/drop targets. Pointer capture preserves the existing native file-drop flow for archive import.

**Tech stack:** React, TypeScript, existing UI components and Tauri settings IPC. No new dependencies or installer build.

## Tasks

- [x] Model and tests: subtree unique memberships/counts, complete membership replacement preserving unavailable IDs, empty-only mode reset, folder sibling sorting/reparent validation, game-drop validation and operation undo.
- [x] Membership dialog: preselected editable existing games; searchable draft with add/remove summary; one save and failure-safe retry. Delegate this independent component and the move-dialog UI.
- [x] UI integration: recursive counts in titles and cards, visible empty-folder reset, folder/game dragging and valid targets, accessible move dialog fallback, bounded undo invalidated by later changes.
- [x] Verification: model tests for cycles/name collisions/mode restrictions/data preservation; actual mouse browser flows for membership diffs, empty-only reset, drag sorting/moves, game drops and undo; typecheck, 101 existing/new tests, IPC checks, frontend build, and Windows developer-runtime pointer drag.

## Review focus

- Never count deleted game IDs or duplicate a game that occurs in more than one descendant.
- Never reset a nonempty folder, even when current game filters hide its content.
- Never move a folder into itself/descendants, into a game folder, or beside a duplicate sibling name.
- Preserve all descendant links and memberships during reparenting and preserve unrelated changes on undo by invalidating old undo after later saves.
- Failed saves must retain prior data and retryable UI drafts. Search does not remove hidden checked memberships.
