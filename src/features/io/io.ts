/**
 * Import / export / backup bridge.
 *
 * The heavy lifting (CSV escaping, de-duplication, locating the sqlite file)
 * lives in `src-tauri/src/launcher/mod.rs`. This module is the typed frontend
 * side: it awaits the database connection first, then calls the commands and
 * returns camelCase results.
 *
 * Command signatures (Rust parameter name → the key this module sends):
 *   launch_game      (game_id)  → { gameId }
 *   stop_game        (game_id)  → { gameId }
 *   export_games     (format, path) → { format, path }
 *   import_games     (path)     → { path }
 *   backup_database  (dest_dir) → { destDir }
 *
 * `invoke` rejects with a **plain string** (Rust's `CmdError` serialises to a
 * string), not an `Error` object — use {@link errorMessage} when displaying one.
 */

import { invoke } from '@/lib/logging';

import { initDatabase } from '@/lib/db';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Returned by `launch_game`. */
export interface LaunchResult {
  sessionId: number;
  /** OS process id. */
  pid: number;
}

/** Returned by `import_games`. */
export interface ImportResult {
  imported: number;
  skipped: number;
}

/** Payload of the `game-exited` event. */
export interface GameExitedPayload {
  gameId: number;
  sessionId: number;
  durationSeconds: number;
  /** `null` when the process was killed rather than exiting on its own. */
  exitCode: number | null;
}

/** Export formats accepted by `export_games`. */
export const EXPORT_FORMATS = ['json', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Normalise a Tauri rejection (a bare string) into displayable text. */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

/** Start a game's process and open a play session. */
export function launchGame(gameId: number): Promise<LaunchResult> {
  return initDatabase().then(() => invoke<LaunchResult>('launch_game', { gameId }));
}

export interface LocaleToolStatus {
  available: boolean;
  path: string | null;
  version: string;
}

export function localeToolStatus(): Promise<LocaleToolStatus> {
  return invoke<LocaleToolStatus>('locale_tool_status');
}

/** Whether this app currently tracks a live process for the game. */
export function gameRunning(gameId: number): Promise<boolean> {
  return initDatabase().then(() => invoke<boolean>('game_running', { gameId }));
}

/** Kill a process this app started. `false` means nothing was running. */
export function stopGame(gameId: number): Promise<boolean> {
  return initDatabase().then(() => invoke<boolean>('stop_game', { gameId }));
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

/**
 * Write every game to `path` as `format`.
 *
 * `format` is explicit rather than inferred from the extension so the user can
 * pick either format for any file name. Returns the number of games written.
 */
export function exportGames(format: ExportFormat, path: string): Promise<number> {
  return initDatabase().then(() => invoke<number>('export_games', { format, path }));
}

/**
 * Import games from a `.json` or `.csv` export.
 *
 * The format is inferred from the file extension. Rows whose `installPath`
 * already exists — or that lack a title/path — are counted as `skipped`.
 */
export function importGames(path: string): Promise<ImportResult> {
  return initDatabase().then(() => invoke<ImportResult>('import_games', { path }));
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/**
 * Ask SQLite to create a consistent snapshot in `destDir` with a timestamped name.
 *
 * Resolves to the new file's absolute path. Rejects when the database file
 * cannot be found — the Rust side locates it through Tauri's path resolver and
 * verifies it exists rather than guessing a path.
 */
export function backupDatabase(destDir: string): Promise<string> {
  return initDatabase().then(() => invoke<string>('backup_database', { destDir }));
}

// ---------------------------------------------------------------------------
// File-name helpers
// ---------------------------------------------------------------------------

/** `YYYYMMDD-HHMMSS` in local time, for default export file names. */
function localTimestampSlug(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * A sensible default file name for the save dialog, e.g.
 * `galgame-library-20240501-123456.csv`.
 */
export function defaultExportFileName(format: ExportFormat, date?: Date): string {
  return `galgame-library-${localTimestampSlug(date)}.${format}`;
}

/** Strip a path down to its final component, for compact status messages. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}
