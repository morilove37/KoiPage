const SECRET = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|token)/i;
export function logValue(value: unknown): string {
  let text: string;
  try {
    if (value instanceof Error) text = value.stack || `${value.name}: ${value.message}`;
    else if (typeof value === 'string') text = value;
    else {
      const seen = new WeakSet<object>();
      text = JSON.stringify(value, (key, item: unknown) => {
        if (SECRET.test(key)) return '[REDACTED]';
        if (item && typeof item === 'object') {
          if (seen.has(item)) return '[Circular]';
          seen.add(item);
        }
        return item;
      }) ?? String(value);
    }
  } catch { text = '[无法格式化的日志内容]'; }
  return text.slice(0, 8192);
}
export function trackedCommand(command: string): boolean {
  return /^(metadata_(search|detail|apply|cover_cache|autofetch)|scan_directory|inspect_exe_file|launch_game|stop_game|import_games|export_games|backup_database|archive_extract|archive_group|birthday.*(sync_start|import|export)|game_cover_import)$/.test(command);
}
