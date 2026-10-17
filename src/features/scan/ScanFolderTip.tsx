import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { settingsGet, settingsSet } from "@/lib/db";

/** Settings key for "don't show this tip again". */
export const SCAN_FOLDER_TIP_KEY = "scan_folder_tip_dismissed";

/** Same truthy spellings the rest of the app accepts for boolean settings. */
function isEnabled(value: string | null): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export interface ScanFolderTip {
  /** True while the tip dialog is visible. */
  open: boolean;
  /** Run `action` after the one-time tip, or immediately once dismissed. */
  guard: (action: () => void) => void;
  /** Render once next to the caller's markup. */
  dialog: ReactNode;
}

/**
 * One-time advice shown before a scan-folder picker opens.
 *
 * Games are recognised by the executable's parent folder, so a directory that
 * also contains screenshots, patches or unrelated software produces false
 * positives or splits one game into several rows. The "don't show again" choice
 * lives in the `settings` table; a failed read (e.g. no database yet) simply
 * skips the tip once rather than blocking the picker.
 */
export function useScanFolderTip(): ScanFolderTip {
  // `null` = the stored flag is still loading. Until it resolves the tip is
  // skipped, so a slow database can never keep the file picker from opening.
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    let alive = true;
    settingsGet(SCAN_FOLDER_TIP_KEY)
      .then((value) => {
        if (alive) setDismissed(isEnabled(value));
      })
      .catch(() => {
        if (alive) setDismissed(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const guard = useCallback(
    (action: () => void) => {
      if (dismissed !== false) {
        action();
        return;
      }
      setRemember(false);
      setPending(() => action);
    },
    [dismissed],
  );

  const cancel = useCallback(() => setPending(null), []);

  const confirm = useCallback(() => {
    const action = pending;
    setPending(null);
    if (remember) {
      // Optimistic: a failed write only means the tip appears again next time.
      setDismissed(true);
      settingsSet(SCAN_FOLDER_TIP_KEY, "1").catch(() => {});
    }
    action?.();
  }, [pending, remember]);

  const dialog = (
    <Dialog
      open={pending !== null}
      onClose={cancel}
      title="建议把所有 Galgame 集中放在一个文件夹"
      description="扫描目录会递归查找里面的游戏程序。"
      footer={
        <>
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="h-4 w-4 accent-[hsl(var(--primary))]"
            />
            今后不再展示
          </label>
          <Button variant="outline" onClick={cancel}>取消</Button>
          <Button onClick={confirm}>继续选择文件夹</Button>
        </>
      }
    >
      <div data-scan-folder-tip className="space-y-3 text-sm leading-relaxed text-muted-foreground">
        <p>
          如果文件夹里混有截图、补丁、文档或其他软件，自动扫描可能会识别出无关文件，或把同一部作品拆成多条记录。
        </p>
        <p>
          推荐新建一个只存放 Galgame 的文件夹（例如{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs not-italic">D:\Galgame</code>
          {"，"}每部作品放一个子文件夹，再把整个文件夹添加为扫描目录。这样识别更准确，后续整理也更省心。
        </p>
        <p className="text-xs">扫描目录可以随时在「设置 → 扫描目录」中管理。</p>
      </div>
    </Dialog>
  );

  return { open: pending !== null, guard, dialog };
}
