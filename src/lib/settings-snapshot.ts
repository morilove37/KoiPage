/**
 * A single read of the `settings` table, shared by every startup reader.
 *
 * Startup used to read appearance settings one key at a time: the theme, the
 * accent, four backdrop keys and two glass keys meant nine separate IPC calls,
 * each of which had to wait for the database connection first. They are all
 * plain `settings` rows, so one `settings_get_all` answers all of them.
 *
 * This module is deliberately dependency-free (not even a type import, so it
 * loads under the Node test runner's type stripping): modules the tests load
 * with a mocked `./db` can use it without dragging the real database layer in.
 */

/** Key → raw stored value, as returned by one `settings_get_all` call. */
export type SettingsSnapshot = ReadonlyMap<string, string | null>;

/** One row of a `settings_get_all` response. */
export interface SettingRow {
  key: string;
  value: string | null;
}

/** Build a lookup from the rows of a `settings_get_all` response. */
export function toSettingsSnapshot(settings: readonly SettingRow[]): SettingsSnapshot {
  const snapshot = new Map<string, string | null>();
  for (const setting of settings) snapshot.set(setting.key, setting.value);
  return snapshot;
}

/**
 * Read one key from a snapshot.
 *
 * Returns `null` for a missing key — the same answer `settings_get` gives — so
 * parsers never have to distinguish "absent" from "stored empty".
 */
export function snapshotValue(snapshot: SettingsSnapshot | undefined, key: string): string | null | undefined {
  return snapshot ? (snapshot.get(key) ?? null) : undefined;
}
