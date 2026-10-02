import { Toast } from "@base-ui/react/toast";
import { Check, CircleAlert, CircleCheck, Copy, Info, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { suppressNetworkFailureToast } from "@/lib/feedback";
import { projectUrl } from "@/lib/project-query";
import { redact } from "@/lib/redact";
import { copyText } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { xrStore } from "@/xrStore";

export type ToastKind = "error" | "success" | "info";

type ToastData = {
  copyText?: string;
};

const toastManager = Toast.createToastManager<ToastData>();

const SUCCESS_INFO_TIMEOUT_MS = 4_000;

function toastsEnabled() {
  return !xrStore.getState().session;
}

export function showToast(opts: {
  id?: string;
  type: ToastKind;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  /** How long a success or info toast stays. An error stays until dismissed. */
  timeoutMs?: number;
}) {
  if (!toastsEnabled()) return;
  const projectPath = projectUrl();
  const title = redact(opts.title, projectPath);
  const description = opts.description
    ? redact(opts.description, projectPath)
    : undefined;
  toastManager.add({
    id: opts.id,
    type: opts.type,
    title,
    description,
    timeout:
      opts.type === "error" ? 0 : (opts.timeoutMs ?? SUCCESS_INFO_TIMEOUT_MS),
    priority: opts.type === "error" ? "high" : "low",
    actionProps: opts.action
      ? {
          children: opts.action.label,
          onClick: opts.action.onClick,
        }
      : undefined,
    data:
      opts.type === "error" ? { copyText: description ?? title } : undefined,
  });
}

export function closeToast(id: string) {
  toastManager.close(id);
}

/** Error toast for fetch/HTTP failures. Quiet while the Mac session is down. */
export function showNetworkErrorToast(opts: {
  title: string;
  description?: string;
}) {
  if (suppressNetworkFailureToast()) return;
  showToast({
    type: "error",
    title: opts.title,
    description: opts.description,
  });
}

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider
      limit={3}
      timeout={SUCCESS_INFO_TIMEOUT_MS}
      toastManager={toastManager}
    >
      {children}
    </Toast.Provider>
  );
}

function CopyErrorButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(0);
  useEffect(() => {
    return () => {
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
    };
  }, []);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-6 px-1.5 text-xs"
      aria-label={copied ? "Copied" : "Copy"}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
          copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

const TOAST_ICONS = {
  error: CircleAlert,
  success: CircleCheck,
  info: Info,
} as const;

export function Toasts() {
  const { toasts } = Toast.useToastManager<ToastData>();
  return (
    <Toast.Portal>
      <Toast.Viewport
        data-slot="toast-viewport"
        className="pointer-events-none fixed bottom-4 left-4 z-[60] flex w-[min(20rem,calc(100%-2rem))] flex-col-reverse gap-2 outline-none"
      >
        {toasts.map((toast) => {
          const kind = (
            toast.type === "error" || toast.type === "success"
              ? toast.type
              : "info"
          ) as ToastKind;
          const Icon = TOAST_ICONS[kind];
          const copyTextValue = toast.data?.copyText;
          return (
            <Toast.Root
              key={toast.id}
              toast={toast}
              data-slot="toast"
              className={cn(
                "pointer-events-auto relative rounded-lg border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg",
                "data-limited:hidden",
                "data-ending-style:opacity-0 data-starting-style:opacity-0",
                "transition-opacity duration-150"
              )}
            >
              <Toast.Content className="flex gap-2">
                <Icon
                  aria-hidden
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    kind === "error" && "text-error",
                    kind === "success" && "text-foreground",
                    kind === "info" && "text-muted-foreground"
                  )}
                />
                <div className="min-w-0 flex-1">
                  <Toast.Title className="font-medium" />
                  {toast.description ? (
                    <Toast.Description className="mt-0.5 text-xs text-muted-foreground" />
                  ) : null}
                  {copyTextValue || toast.actionProps ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {copyTextValue ? (
                        <CopyErrorButton text={copyTextValue} />
                      ) : null}
                      {toast.actionProps ? (
                        <Toast.Action
                          className={cn(
                            buttonVariants({ size: "sm", variant: "outline" }),
                            "h-6 px-2 text-xs"
                          )}
                        >
                          {toast.actionProps.children}
                        </Toast.Action>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <Toast.Close
                  aria-label="Dismiss"
                  className={cn(
                    buttonVariants({ size: "icon-xs", variant: "ghost" }),
                    "shrink-0"
                  )}
                >
                  <X className="size-3.5" />
                </Toast.Close>
              </Toast.Content>
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}
