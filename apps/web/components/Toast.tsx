"use client";

import { useEffect, useState } from "react";

type ToastState = { id: number; text: string };

const listeners = new Set<(text: string) => void>();

/**
 * Fire a transient toast. Safe to call from anywhere (client components,
 * event handlers). A `<Toast/>` mounted in the root layout renders it.
 */
export function showToast(message: string): void {
  for (const listener of listeners) listener(message);
}

export function Toast() {
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    // A fresh id per call so repeated identical messages still re-trigger.
    const listener = (text: string) => setToast({ id: Date.now(), text });
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!toast) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-8 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-2 font-serif text-[14px] italic text-paper shadow-lg"
    >
      {toast.text}
    </div>
  );
}
