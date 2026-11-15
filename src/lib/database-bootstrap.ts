/** A failed custom location must never silently open a different database. */
export async function bootstrapDatabase<T>(
  initialize: () => Promise<void>,
  connected: () => T,
  legacyLoad: () => Promise<T>,
): Promise<T> {
  try { await initialize(); }
  catch (cause) {
    if (/\bcommand\s+['"]?initialize_database['"]?\s+not found\b/i.test(String(cause))) return legacyLoad();
    throw cause;
  }
  return connected();
}
