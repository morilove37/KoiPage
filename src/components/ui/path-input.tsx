import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "./button";
import { Input } from "./input";

/** A path can be typed, pasted, or selected with the native file dialog. */
export function PathInput({ label, value, onChange, kind, disabled = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  kind: "file" | "directory" | "either";
  disabled?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function pick(directory: boolean) {
    if (disabled || pending.current) return;
    pending.current = true;
    setPicking(true); setError(null);
    try {
      const path = await open({
        title: `选择${label}${directory ? "文件夹" : label.endsWith("文件") ? "" : "文件"}`,
        multiple: false,
        directory,
        defaultPath: value.trim() || undefined,
        filters: !directory && kind === "file" ? [{ name: "可执行文件或启动脚本", extensions: ["exe", "bat", "cmd"] }] : undefined,
      });
      if (mounted.current && typeof path === "string") onChange(path);
    } catch (cause) {
      if (mounted.current) setError(typeof cause === "string" ? cause : cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setPicking(false);
    }
  }

  return <div className="flex min-w-0 flex-col gap-1.5">
    <div className="flex min-w-0 items-center gap-2">
      <Input aria-label={label} value={value} disabled={disabled || picking}
        onChange={event => { setError(null); onChange(event.target.value); }} className="min-w-0 flex-1" />
      {kind !== "directory" ? <Button variant="outline" size="sm" disabled={disabled || picking}
        aria-label={`选择${label}${label.endsWith("文件") ? "" : "文件"}`} onClick={() => void pick(false)}>选择文件</Button> : null}
      {kind !== "file" ? <Button variant="outline" size="sm" disabled={disabled || picking}
        aria-label={`选择${label}文件夹`} onClick={() => void pick(true)}>选择文件夹</Button> : null}
    </div>
    {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : null}
  </div>;
}
