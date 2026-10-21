export type LaunchSwitch = 'inherit' | 'on' | 'off';
export interface LaunchProfile {
  locale: LaunchSwitch;
  magpie: LaunchSwitch;
  luna: LaunchSwitch;
  localeSource: 'inherit' | 'bundled' | 'custom';
  localePath: string;
  scalingMode: string;
}
export function normalizeLaunchProfile(value: unknown): LaunchProfile {
  const p = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const flag = (v: unknown): LaunchSwitch => v === 'on' || v === 'off' ? v : 'inherit';
  return {
    locale: flag(p.locale), magpie: flag(p.magpie), luna: flag(p.luna),
    localeSource: p.localeSource === 'bundled' || p.localeSource === 'custom' ? p.localeSource : 'inherit',
    localePath: typeof p.localePath === 'string' ? p.localePath : '',
    scalingMode: typeof p.scalingMode === 'string' ? p.scalingMode : '',
  };
}
export function effectiveFlag(override: LaunchSwitch, inherited: boolean): boolean {
  return override === 'inherit' ? inherited : override === 'on';
}
