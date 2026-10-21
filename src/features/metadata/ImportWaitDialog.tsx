import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

/** Acknowledging this notice never cancels the underlying metadata request. */
export function ImportWaitDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const continueButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    continueButton.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open]);

  return <div onKeyDownCapture={event => {
    // The notice has one action; keep keyboard focus above the import dialog.
    if (open && event.key === "Tab") {
      event.preventDefault();
      continueButton.current?.focus();
    }
  }}>
    <Dialog open={open} onClose={onClose} title="导入进行中" className="max-w-sm"
      footer={<div className="flex w-full justify-center">
        <Button ref={continueButton} type="button" onClick={onClose}>继续等待</Button>
      </div>}>
      <div className="py-2 text-center">
        <p className="font-medium">正在导入中，请耐心等待。</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">如导入速度过慢，可尝试开启代理。</p>
        <img src="/import/hotaru-waiting.png" alt="水无月萤抱着沙漏，陪你耐心等待" width={192} height={192}
          draggable={false} className="mx-auto mt-5 size-48 object-contain" />
      </div>
    </Dialog>
  </div>;
}
