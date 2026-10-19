/**
 * Types and API wrapper for the scan/import flow.
 *
 * `ScanCandidate` mirrors `src-tauri/src/scanner/mod.rs` one-for-one; that
 * struct serialises with `#[serde(rename_all = "camelCase")]`, so every field
 * here is camelCase, matching the rest of {@link ../types/game}.
 */

import { invoke } from '@/lib/logging';

import { ready } from '@/lib/db';
import type { Game, GameInput } from '@/types/game';

/** One discovered game folder, as returned by the `scan_directory` command. */
export interface ScanCandidate {
  /** Absolute path of the game folder. */
  folderPath: string;
  /** Last path component of `folderPath`, for display. */
  folderName: string;
  /** All plausible executables, best candidate first. */
  exePaths: string[];
  /** `exePaths[0]` when one exists. */
  suggestedExe: string | null;
  /** Best cover image guess, by name priority then file size. */
  coverPath: string | null;
  /** Folder name with release-group noise stripped. */
  suggestedTitle: string;
  /** Size of the folder's own files (not recursive), in bytes. */
  sizeBytes: number;
  /** True when `folderPath` is already a `games.installPath`. */
  alreadyImported: boolean;
}

/**
 * `scan_directory` — recursively walk `path` and return one candidate per
 * folder that looks like a game installation.
 *
 * `maxDepth` is clamped on the Rust side to `1..=64`; depth 1 scans only the
 * chosen folder itself.
 */
export function scanDirectory(path: string, maxDepth: number): Promise<ScanCandidate[]> {
  // Mirrors every other helper in `lib/db.ts`: the Rust command reads the games
  // table for de-duplication, so the pool has to exist first.
  return ready.then(() =>
    invoke<ScanCandidate[]>('scan_directory', { path, maxDepth }),
  );
}

/** Format a byte count for the candidate list. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** Last path component of a Windows or POSIX path. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/**
 * Build the `game_create` payload for a confirmed candidate.
 *
 * `status` is deliberately left to the database default (`unplayed`) rather
 * than hardcoded here — see `src/types/game.ts` `GAME_STATUSES`.
 */
export function candidateToInput(
  candidate: ScanCandidate,
  overrides: { title?: string; exePath?: string | null; coverPath?: string | null } = {},
): GameInput {
  const title = (overrides.title ?? candidate.suggestedTitle).trim() || candidate.folderName;
  return {
    title,
    installPath: candidate.folderPath,
    exePath: overrides.exePath ?? candidate.suggestedExe,
    coverPath: overrides.coverPath ?? candidate.coverPath,
  };
}

/** Re-export so callers do not need a second import for the result type. */
export type ImportedGame = Game;
