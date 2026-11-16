import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "../lib/utils";

type ToastItem = { id: number; text: string; leaving: boolean };
type ShowToast = (text: string) => void;

const ToastContext = createContext<ShowToast>(() => {});

let nextId = 1;

/**
 * App-wide floating notification. Toasts never take part in page layout: the
 * viewport is fixed above the content, entries animate in, auto-dismiss after
 * a few seconds and can be closed immediately with the button.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current = [];
    },
    [],
  );

  const dismiss = useCallback((id: number) => {
    setItems((list) =>
      list.map((item) => (item.id === id ? { ...item, leaving: true } : item)),
    );
    timers.current.push(
      window.setTimeout(
        () => setItems((list) => list.filter((item) => item.id !== id)),
        220,
      ),
    );
  }, []);

  const show = useCallback(
    (text: string) => {
      if (!text) return;
      const id = nextId++;
      setItems((list) => [...list.slice(-2), { id, text, leaving: false }]);
      timers.current.push(window.setTimeout(() => dismiss(id), 3600));
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-viewport" aria-live="polite" aria-atomic="false">
        {items.map((item) => (
          <div
            key={item.id}
            role="status"
            className={cn("toast", item.leaving && "is-leaving")}
          >
            <span className="toast-text">{item.text}</span>
            <button
              type="button"
              aria-label="关闭提示"
              className="toast-close"
              onClick={() => dismiss(item.id)}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ShowToast {
  return useContext(ToastContext);
}
