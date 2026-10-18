/**
 * Magpie 窗口缩放工具的 IPC 桥。
 *
 * 命令无参数；Rust 侧负责定位 Magpie.exe、读取版本 / 配置并启停进程。
 * `invoke` 失败时抛出的是纯字符串，展示时请使用 `errorMessage`。
 */

import { invoke } from '@tauri-apps/api/core';
import { ready } from '@/lib/db';

export interface LunaStatus {
  path: string;
  version: string;
  available: boolean;
  running: boolean;
  sourcePath: string;
  licensePath: string;
  noticePath: string;
}
export function lunaStatus(): Promise<LunaStatus> {
  return ready.then(() => invoke<LunaStatus>('luna_status'));
}
export function lunaLaunch(): Promise<boolean> {
  return ready.then(() => invoke<boolean>('luna_launch'));
}
export function lunaQuit(): Promise<boolean> {
  return ready.then(() => invoke<boolean>('luna_quit'));
}

export type MagpieSource = 'bundled' | 'custom' | 'process' | 'auto' | 'none';

export interface MagpieStatus {
  /** 内置模式下=解压后的 Magpie.exe 路径；外部模式=解析出的绝对路径。null 表示没找到。 */
  path: string | null;
  /** bundled=内置；custom/process/auto/none=外部模式解析结果。 */
  source: MagpieSource;
  /** 文件版本，例如 "0.12.1"。 */
  version: string | null;
  /** Magpie.exe 当前是否有进程在运行。 */
  running: boolean;
  /** 从 Magpie 配置读到的缩放快捷键，例如 "Win + Shift + A"。 */
  hotkey: string | null;
  /** Magpie 配置文件（config.json）路径，null 表示没有。 */
  configPath: string | null;
  /** 内置组件是否已就绪（解压成功）。 */
  bundledAvailable: boolean;
  /** 内置版本，目前 "0.12.1"。 */
  bundledVersion: string;
}

export function magpieStatus(): Promise<MagpieStatus> {
  return invoke<MagpieStatus>('magpie_status');
}

export function magpieLaunch(): Promise<boolean> {
  return invoke<boolean>('magpie_launch');
}

export function magpieQuit(): Promise<boolean> {
  return invoke<boolean>('magpie_quit');
}

// ---------------------------------------------------------------------------
// Scaling modes (read from / written to the local Magpie config.json)
// ---------------------------------------------------------------------------

export interface MagpieScalingMode {
  name: string;
  /** 该模式的效果链，按顺序给出 effect 名称，例如 ["FSR\\FSR_EASU", "FSR\\FSR_RCAS"]。 */
  effects: string[];
}

export interface MagpieScalingConfig {
  /** 可选的缩放模式列表。本机还没有配置时来自应用内置默认配置。 */
  modes: MagpieScalingMode[];
  /** 默认配置（profiles[0].scalingMode）在 modes 中的下标；无配置时为 null。 */
  defaultIndex: number | null;
  /** 读到的本机 config.json 路径；使用内置默认配置时为 null。 */
  configPath: string | null;
  /** true 表示本机还没有 Magpie 配置，当前展示的是应用内置的默认配置。 */
  usingAppDefaults: boolean;
}

export interface MagpieScalingSetResult {
  /** 是否已立即写入本机 Magpie 配置。 */
  applied: boolean;
  /** applied=false 时说明原因："running"（Magpie 正在运行，下次启动生效）或 "no-config"（还没有配置文件）。 */
  reason: string | null;
  configPath: string | null;
}

export function magpieScalingConfig(): Promise<MagpieScalingConfig> {
  return invoke<MagpieScalingConfig>('magpie_scaling_config');
}

export function magpieScalingSet(mode: string): Promise<MagpieScalingSetResult> {
  return invoke<MagpieScalingSetResult>('magpie_scaling_set', { mode });
}

export interface MagpieScalingResetResult {
  /** 恢复后的本机 config.json 路径。 */
  configPath: string;
  /** 恢复前旧配置的备份路径；原本没有配置时为 null。 */
  backupPath: string | null;
}

/** 把本机 Magpie 配置替换为应用内置默认配置（Magpie 运行中会被拒绝）。 */
export function magpieScalingReset(): Promise<MagpieScalingResetResult> {
  return invoke<MagpieScalingResetResult>('magpie_scaling_reset');
}
