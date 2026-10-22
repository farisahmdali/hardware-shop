import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, X } from 'lucide-react';
import { cn } from './cn';

type Tone = 'success' | 'error' | 'warning';
interface Toast {
  id: number;
  tone: Tone;
  title: string;
  description?: string;
}

interface ToastApi {
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
  warning(title: string, description?: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (tone: Tone, title: string, description?: string) => {
      const id = nextId++;
      setToasts((t) => [...t.slice(-3), { id, tone, title, description }]);
      // Errors stay until read; confirmations fade on their own.
      if (tone !== 'error') setTimeout(() => dismiss(id), 4500);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      success: (t, d) => push('success', t, d),
      error: (t, d) => push('error', t, d),
      warning: (t, d) => push('warning', t, d),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-5 bottom-5 z-[100] flex w-96 flex-col gap-2" role="region" aria-label="Notifications">
        {toasts.map((t) => {
          const Icon = t.tone === 'success' ? CheckCircle2 : t.tone === 'warning' ? AlertTriangle : XCircle;
          return (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className={cn(
                'pointer-events-auto flex gap-3 rounded-lg border bg-surface p-3.5 shadow-pop',
                t.tone === 'success' && 'border-success/30',
                t.tone === 'warning' && 'border-warning/40',
                t.tone === 'error' && 'border-danger/40',
              )}
            >
              <Icon
                className={cn(
                  'mt-0.5 size-5 shrink-0',
                  t.tone === 'success' && 'text-success',
                  t.tone === 'warning' && 'text-warning',
                  t.tone === 'error' && 'text-danger',
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-ink">{t.title}</p>
                {t.description && <p className="mt-0.5 text-ink-2 break-words">{t.description}</p>}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="self-start rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink"
                aria-label="Dismiss"
              >
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const t = useContext(ToastContext);
  if (!t) throw new Error('useToast outside ToastProvider');
  return t;
}
