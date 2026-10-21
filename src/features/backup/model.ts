export interface BackupPreview {
  formatVersion: number;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  games: number;
  sessions: number;
  assets: number;
  archiveSha256: string;
}
export function backupSummary(value: Pick<BackupPreview, 'games' | 'sessions' | 'assets'>): string {
  return `${value.games} 款游戏 · ${value.sessions} 条游玩记录 · ${value.assets} 张图片`;
}
export function canRestore(preview: object | null, confirmed: boolean, busy: boolean): boolean {
  return preview !== null && confirmed && !busy;
}
