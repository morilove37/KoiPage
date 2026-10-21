import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  initializeBirthdayReminder, retryBirthdayReminderSave, setBirthdayReminderEnabled, useBirthdayReminderStore,
} from './reminder-store';

export function BirthdayReminderSettings() {
  const state = useBirthdayReminderStore();
  useEffect(() => { void initializeBirthdayReminder(); }, []);
  return <div className="space-y-3">
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3">
      <input type="checkbox" role="switch" aria-label="启动时显示生日祝贺" checked={state.preferences?.enabled ?? true}
        disabled={state.loading || state.saving || !state.preferences}
        onChange={event => { void setBirthdayReminderEnabled(event.target.checked).catch(() => {}); }}
        className="mt-1 size-4 shrink-0 accent-primary" />
      <span>
        <span className="block text-sm font-medium">启动时显示生日祝贺</span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">当天有角色生日时展示角色图片与祝贺插画，按本机日期每天最多提醒一次，同一天重新打开也不重复提醒。</span>
      </span>
    </label>
    <p className="text-xs leading-relaxed text-muted-foreground">仅提醒游戏库中未隐藏的生日角色。关闭弹窗后，首页的角色生日卡片仍可正常查看。</p>
    {state.error ? <div className="flex flex-wrap items-center gap-3">
      <p role="alert" className="text-xs text-destructive">{state.error}</p>
      <Button size="sm" variant="outline" disabled={state.loading || state.saving} onClick={() => { void retryBirthdayReminderSave().catch(() => {}); }}>重试保存或读取</Button>
    </div> : null}
  </div>;
}
