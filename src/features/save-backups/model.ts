export interface SaveBackupConfig {
  beforeLaunch: boolean;
  afterExit: boolean;
  keepAutomatic: number;
}

export interface SaveSnapshot {
  id: string;
  createdAt: string;
  reason: string;
  files: number;
  bytes: number;
  sourcePath: string;
}

export interface AutomaticBackupResult {
  createdAt: string;
  success: boolean;
  message: string;
}

export function parseAutomaticBackupResult(value: string | null): AutomaticBackupResult | null {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const result = parsed as Partial<AutomaticBackupResult>;
    return typeof result.createdAt === 'string' && typeof result.success === 'boolean' && typeof result.message === 'string'
      ? { createdAt: result.createdAt, success: result.success, message: result.message } : null;
  } catch { return null; }
}

export const DEFAULT_SAVE_BACKUP_CONFIG: SaveBackupConfig = {
  beforeLaunch: false,
  afterExit: false,
  keepAutomatic: 10,
};

export function normalizeSaveBackupConfig(value: unknown): SaveBackupConfig {
  const config = value && typeof value === 'object' ? value as Partial<SaveBackupConfig> : {};
  return {
    beforeLaunch: config.beforeLaunch === true,
    afterExit: config.afterExit === true,
    keepAutomatic: typeof config.keepAutomatic === 'number' && Number.isInteger(config.keepAutomatic)
      ? Math.min(50, Math.max(1, config.keepAutomatic)) : 10,
  };
}

export function snapshotReason(reason: string): string {
  return ({ manual: '手动备份', beforeLaunch: '启动前', afterExit: '正常退出后', beforeRestore: '恢复前安全备份' } as Record<string, string>)[reason] ?? reason;
}

export function formatSnapshotSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小未知';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(1)} ${units[unit]}`;
}

export function snapshotDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
