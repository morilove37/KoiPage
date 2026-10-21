import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/input';
import { PathInput } from '@/components/ui/path-input';
import { Select } from '@/components/ui/select';
import { errorMessage } from '@/features/io/io';
import { magpieScalingConfig } from '@/features/tools/io';
import { launchProfileGet, launchProfileSave } from './profile-api';
import type { EffectiveLaunchProfile } from './profile-api';
import { normalizeLaunchProfile } from './profile-model';
import type { LaunchProfile, LaunchSwitch } from './profile-model';

const options = [{ value: 'inherit', label: '跟随全局' }, { value: 'on', label: '开启' }, { value: 'off', label: '关闭' }] as const;
export function LaunchProfilePanel({ gameId, onSaved }: { gameId: number; onSaved?: (value: EffectiveLaunchProfile) => void }) {
  const [profile, setProfile] = useState<LaunchProfile>(normalizeLaunchProfile(null));
  const [effective, setEffective] = useState<EffectiveLaunchProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [modes, setModes] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    void launchProfileGet(gameId).then(value => { if (alive) { setProfile(normalizeLaunchProfile(value.profile)); setEffective(value); setLoaded(true); } }).catch(e => { if (alive) setError(errorMessage(e)); });
    void magpieScalingConfig().then(value => { if (alive) setModes(value.modes.map(mode => mode.name)); }).catch(() => {});
    return () => { alive = false; };
  }, [gameId]);
  async function save(reset = false) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const value = await launchProfileSave(gameId, reset ? normalizeLaunchProfile(null) : profile);
      setProfile(normalizeLaunchProfile(value.profile)); setEffective(value); setLoaded(true); onSaved?.(value);
      window.dispatchEvent(new CustomEvent('launch-profile-changed', { detail: gameId }));
      setNotice(reset ? '已恢复为跟随全局设置。' : '已保存本款游戏的启动配置。');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <section className="space-y-3 border-t border-border pt-4 sm:col-span-2" aria-label="本款启动配置">
    <div><h3 className="text-sm font-semibold">本款启动配置</h3><p className="mt-1 text-xs text-muted-foreground">只影响当前游戏；跟随全局时使用「实用工具」中的设置。此处单独保存。</p></div>
    <div className="grid gap-3 sm:grid-cols-3">
      {([['locale', '转区启动'], ['magpie', '随游戏启动 Magpie'], ['luna', '随游戏启动 Luna']] as const).map(([key, label]) => <Field key={key} label={label}>
        <Select<LaunchSwitch> aria-label={label} value={profile[key]} options={options} disabled={!loaded || busy} onValueChange={value => setProfile(p => ({ ...p, [key]: value }))} />
      </Field>)}
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="转区工具"><Select aria-label="本款转区工具" value={profile.localeSource} disabled={!loaded || busy} onValueChange={value => setProfile(p => ({ ...p, localeSource: value }))} options={[{ value: 'inherit', label: '跟随全局工具' }, { value: 'bundled', label: '内置 Locale Emulator' }, { value: 'custom', label: '自定义工具' }]} /></Field>
      <Field label="Magpie 缩放模式"><Select aria-label="本款缩放模式" value={profile.scalingMode} disabled={!loaded || busy} options={[{ value: '', label: '跟随全局' }, ...modes.map(name => ({ value: name, label: name })), ...(profile.scalingMode && !modes.includes(profile.scalingMode) ? [{ value: profile.scalingMode, label: `${profile.scalingMode}（当前不可用）`, disabled: true }] : [])]} onValueChange={value => setProfile(p => ({ ...p, scalingMode: value }))} /></Field>
    </div>
    {profile.localeSource === 'custom' ? <PathInput label="本款转区工具路径" kind="file" value={profile.localePath} disabled={!loaded || busy} onChange={value => setProfile(p => ({ ...p, localePath: value }))} /> : null}
    {effective ? <p className="text-xs text-muted-foreground">当前生效：转区{effective.locale ? '开启' : '关闭'} · Magpie {effective.magpie ? '开启' : '关闭'} · Luna {effective.luna ? '开启' : '关闭'}</p> : null}
    <div className="flex flex-wrap gap-2"><Button size="sm" loading={busy} disabled={!loaded} onClick={() => void save()}>保存启动配置</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void save(true)}>全部跟随全局</Button></div>
    {notice ? <p role="status" className="text-xs text-primary">{notice}</p> : null}
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
  </section>;
}
