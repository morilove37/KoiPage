/**
 * The prompt shown when the window's close button is pressed.
 *
 * Rust intercepts `CloseRequested` and emits `close-requested` (see
 * `lib.rs`); this component answers it: a stored preference acts immediately,
 * otherwise the user chooses between hiding to the tray and quitting.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { settingsGet, settingsSet } from "@/lib/db";

import { CLOSE_BEHAVIOR_KEY, normalizeCloseBehavior } from "./close-behavior";

export function CloseBehaviorDialog() {
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    void listen("close-requested", () => {
      void (async () => {
        try {
          const behavior = normalizeCloseBehavior(await settingsGet(CLOSE_BEHAVIOR_KEY));
          if (behavior === "tray") {
            await invoke("app_hide_to_tray");
            return;
          }
          if (behavior === "exit") {
            await invoke("app_quit");
            return;
          }
        } catch (cause) {
          // Reading the setting failed: fall through to the prompt so the user
          // can still decide instead of the close button doing nothing.
          console.warn("[window] close behaviour:", cause);
        }
        if (!cancelled) {
          setRemember(false);
          setError(null);
          setOpen(true);
        }
      })();
    })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch((cause) => console.warn("[window] close listener:", cause));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function choose(behavior: "tray" | "exit") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (remember) {
        // The chosen action wins even if persisting the preference fails.
        await settingsSet(CLOSE_BEHAVIOR_KEY, behavior).catch(() => {});
      }
      setOpen(false);
      await invoke(behavior === "tray" ? "app_hide_to_tray" : "app_quit");
    } catch (cause) {
      setError(typeof cause === "string" ? cause : String(cause));
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) setOpen(false);
      }}
      title="关闭恋页"
      description="选择关闭窗口时的行为；之后可在「设置 → 窗口」中修改。"
      className="max-w-md"
      footer={
        <>
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={remember}
              disabled={busy}
              onChange={(event) => setRemember(event.target.checked)}
              className="h-4 w-4 accent-[hsl(var(--primary))]"
            />
            今后不再提示
          </label>
          <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
          <Button variant="outline" disabled={busy} onClick={() => void choose("exit")}>直接关闭</Button>
          <Button loading={busy} onClick={() => void choose("tray")}>缩小至托盘</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">缩小至托盘</span>：窗口隐藏，应用继续在系统托盘运行；点击托盘图标或菜单「显示恋页」即可恢复。
        </p>
        <p>
          <span className="font-medium text-foreground">直接关闭</span>：退出恋页进程。托盘菜单里的「退出恋页」也会直接退出。
        </p>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      </div>
    </Dialog>
  );
}
