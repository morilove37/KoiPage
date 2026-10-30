export const LIBRARY_RENDER_BATCH = 120;

/** Keep full-result filtering/selection separate from the mounted UI batch. */
export function libraryRenderCount(total: number, requested = LIBRARY_RENDER_BATCH): number {
  const count = Number.isFinite(requested) && requested > 0 ? Math.max(LIBRARY_RENDER_BATCH, Math.floor(requested)) : LIBRARY_RENDER_BATCH;
  return Math.min(Math.max(0, total), count);
}
