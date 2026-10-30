export type ImportStatus = 'pending' | 'searching' | 'loading' | 'saving' | 'imported' | 'review' | 'manual' | 'failed';
export interface ImportRow<T> { draft: T; status: ImportStatus; message: string; }
export interface ImportContext {
  stopped: () => boolean;
  update: (status: ImportStatus, message?: string) => void;
}
export type ImportOutcome = { status: 'pending' | 'imported' | 'review' | 'manual'; message: string };

/** Own the queue independently of React renders and reject overlapping runs. */
export class ImportQueue<T> {
  rows: ImportRow<T>[];
  running = false;
  private stopRequested = false;
  constructor(drafts: readonly T[]) { this.rows = drafts.map(draft => ({ draft, status: 'pending', message: '' })); }
  indices(status: ImportStatus): number[] { return this.rows.flatMap((row, index) => row.status === status ? [index] : []); }
  stop(): void { this.stopRequested = true; }
  async run(indices: readonly number[], importer: (draft: T, context: ImportContext) => Promise<ImportOutcome>, changed: (rows: ImportRow<T>[]) => void = () => {}): Promise<void> {
    if (this.running) return;
    this.running = true; this.stopRequested = false;
    const update = (index: number, status: ImportStatus, message = '') => {
      this.rows = this.rows.map((row, i) => i === index ? { ...row, status, message } : row);
      changed(this.rows);
    };
    try {
      for (const index of [...new Set(indices)]) {
        if (this.stopRequested) break;
        const row = this.rows[index];
        if (!row || (row.status !== 'failed' && row.status !== 'pending')) continue;
        try {
          const result = await importer(row.draft, { stopped: () => this.stopRequested, update: (status, message) => update(index, status, message) });
          update(index, result.status, result.message);
        } catch (cause) { update(index, 'failed', cause instanceof Error ? cause.message : String(cause)); }
      }
    } finally { this.running = false; }
  }
}
