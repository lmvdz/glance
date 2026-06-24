import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { cn } from "@/lib/cn";

type ToastTone = "default" | "success" | "danger";
interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
}

interface ToastApi {
  toast: (opts: { title: string; description?: string; tone?: ToastTone }) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const toneRing: Record<ToastTone, string> = {
  default: "border-border",
  success: "border-[color-mix(in_srgb,var(--success)_40%,transparent)]",
  danger: "border-[color-mix(in_srgb,var(--danger)_40%,transparent)]",
};

let nextId = 1;

export function ToastProvider({ children, duration = 4000 }: { children: ReactNode; duration?: number }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback<ToastApi["toast"]>((opts) => {
    setItems((prev) => [...prev, { id: nextId++, tone: "default", ...opts }]);
  }, []);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      <ToastPrimitive.Provider duration={duration} swipeDirection="right">
        {children}
        {items.map((t) => (
          <ToastPrimitive.Root
            key={t.id}
            onOpenChange={(open) => !open && remove(t.id)}
            className={cn(
              "grid gap-1 rounded-[var(--radius-md)] border bg-popover px-3 py-2 text-popover-foreground shadow-[var(--shadow-2)]",
              "animate-[toastIn_0.16s_var(--ease-standard)]",
              toneRing[t.tone],
            )}
          >
            <ToastPrimitive.Title className="text-[length:var(--text-13)] font-semibold text-text-1">
              {t.title}
            </ToastPrimitive.Title>
            {t.description && (
              <ToastPrimitive.Description className="text-[length:var(--text-12)] text-text-2">
                {t.description}
              </ToastPrimitive.Description>
            )}
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}
