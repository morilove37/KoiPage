export interface BackupPreview {
  formatVersion: number;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  games: number;
  sessions: number;
  assets: number;
  includesSaveSnapshots?: boolean;
  saveSnapshots?: number;
  saveBytes?: number;
  archiveSha256: string;
}
export function backupSummary(value: Pick<BackupPreview, 'games' | 'sessions' | 'assets' | 'includesSaveSnapshots' | 'saveSnapshots'>): string {
  return `${value.games} 款游戏 · ${value.sessions} 条游玩记录 · ${value.assets} 张图片${value.includesSaveSnapshots ? ` · ${value.saveSnapshots ?? 0} 个存档快照` : ''}`;
}
export function canRestore(preview: object | null, confirmed: boolean, busy: boolean): boolean {
  return preview !== null && confirmed && !busy;
}
