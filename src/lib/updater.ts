import { invoke, isTauri } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { settingsGet, settingsSet } from "./db";

export const UPDATE_CHECK_SETTING = "check_updates_on_startup";
export const DEVELOPMENT_BUILD = import.meta.env.DEV;
type UpdateStatus = "idle" | "checking" | "latest" | "available" | "downloading" | "installing" | "error";

interface UpdateState {
  startupPending: boolean;
  preferenceLoaded: boolean;
  automatic: boolean;
  status: UpdateStatus;
  version: string | null;
  notes: string;
  dialogOpen: boolean;
  downloaded: number;
  total: number | null;
  error: string | null;
}

export const useUpdateStore = create<UpdateState>(() => ({
  startupPending: !DEVELOPMENT_BUILD && isTauri(),
  preferenceLoaded: false, automatic: true, status: "idle", version: null,
  notes: "", dialogOpen: false, downloaded: 0, total: null, error: null,
}));

let currentUpdate: Update | null = null;
let preferenceRequest: Promise<void> | null = null;
let preferenceRevision = 0;
let checkRequest: Promise<void> | null = null;
let installRequest: Promise<void> | null = null;

export function loadUpdatePreference(): Promise<void> {
  if (!preferenceRequest) {
    const revision = preferenceRevision;
    preferenceRequest = settingsGet(UPDATE_CHECK_SETTING).then(value => {
      if (revision === preferenceRevision) useUpdateStore.setState({ preferenceLoaded: true, automatic: value !== "0" });
    }).finally(() => { preferenceRequest = null; });
  }
  return preferenceRequest;
}

export async function setAutomaticUpdates(automatic: boolean): Promise<void> {
  await settingsSet(UPDATE_CHECK_SETTING, automatic ? "1" : "0");
  preferenceRevision++;
  useUpdateStore.setState({ preferenceLoaded: true, automatic });
}

export function dismissUpdate(): void {
  const { status } = useUpdateStore.getState();
  if (status !== "downloading" && status !== "installing") useUpdateStore.setState({ dialogOpen: false });
}

function updateError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/signature|pubkey|verification/i.test(message)) return "更新签名校验失败，已停止安装。请稍后重试或从 GitHub 下载新版。";
  if (/游戏|游玩/.test(message)) return message;
  return "更新服务暂时无法连接或操作未完成。请检查网络后重试，也可以前往 GitHub 下载新版。";
}

/** Checks only; no download or installation until the user confirms. */
export async function checkForUpdates(): Promise<void> {
  if (installRequest) return;
  if (!isTauri()) {
    useUpdateStore.setState({ status: "error", error: "请在桌面应用中检查更新。" });
    return;
  }
  if (!checkRequest) {
    useUpdateStore.setState({ status: "checking", error: null });
    checkRequest = (async () => {
      try {
        const next = await check({ timeout: 15_000 });
        const previous = currentUpdate;
        currentUpdate = next;
        await previous?.close().catch(() => {});
        useUpdateStore.setState({
          status: next ? "available" : "latest", version: next?.version ?? null,
          notes: next?.body ?? "", dialogOpen: Boolean(next), downloaded: 0, total: null, error: null,
        });
      } catch (cause) {
        useUpdateStore.setState({ status: "error", error: updateError(cause) });
      }
    })().finally(() => { checkRequest = null; });
  }
  return checkRequest;
}

/** One delayed startup check. Failures stay in Settings and never open a modal. */
export function scheduleStartupUpdateCheck(): () => void {
  if (DEVELOPMENT_BUILD || !isTauri()) {
    useUpdateStore.setState({ startupPending: false });
    return () => {};
  }
  useUpdateStore.setState({ startupPending: true });
  let cancelled = false;
  const timer = window.setTimeout(() => {
    void loadUpdatePreference().then(() => {
      if (!cancelled && useUpdateStore.getState().automatic) return checkForUpdates();
    }).catch(() => {}).finally(() => {
      if (!cancelled) useUpdateStore.setState({ startupPending: false });
    });
  }, 3_000);
  return () => { cancelled = true; window.clearTimeout(timer); };
}

/** Explicit user action; the native plugin verifies the signature before install. */
export function installUpdate(): Promise<void> {
  if (installRequest) return installRequest;
  if (!currentUpdate || checkRequest) return Promise.resolve();
  if (DEVELOPMENT_BUILD) {
    useUpdateStore.setState({ error: "开发版仅支持检查更新。请从 GitHub 安装发布版后使用应用内更新。" });
    return Promise.resolve();
  }
  const update = currentUpdate;
  useUpdateStore.setState({ status: "downloading", error: null, downloaded: 0, total: null });
  installRequest = (async () => {
    try {
      await invoke("ensure_update_ready");
      await update.download(event => {
        if (event.event === "Started") useUpdateStore.setState({ total: event.data.contentLength ?? null });
        if (event.event === "Progress") useUpdateStore.setState(state => ({ downloaded: state.downloaded + event.data.chunkLength }));
      }, { timeout: 120_000 });
      await invoke("ensure_update_ready");
      useUpdateStore.setState({ status: "installing" });
      // Windows exits this process after spawning the installer and restarts the app.
      await update.install({ restartAfterInstall: true });
    } catch (cause) {
      useUpdateStore.setState({ status: "error", error: updateError(cause) });
    }
  })().finally(() => { installRequest = null; });
  return installRequest;
}
