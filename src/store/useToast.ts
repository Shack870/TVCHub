import { create } from 'zustand';

export type ToastType = 'error' | 'success' | 'info';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  action?: ToastAction;
}

interface ToastState {
  toasts: Toast[];
  push: (message: string, type?: ToastType, action?: ToastAction) => void;
  dismiss: (id: string) => void;
}

export const useToast = create<ToastState>((set, get) => ({
  toasts: [],
  push: (message, type = 'info', action) => {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts, { id, message, type, action }] }));
    // Actionable toasts (e.g. Undo) linger longer so there's time to react.
    setTimeout(() => get().dismiss(id), action ? 8000 : 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// Module-level helper so non-component code (e.g. lib/db.ts) can raise toasts.
export const notify = {
  error: (message: string) => useToast.getState().push(message, 'error'),
  success: (message: string, action?: ToastAction) =>
    useToast.getState().push(message, 'success', action),
  info: (message: string, action?: ToastAction) =>
    useToast.getState().push(message, 'info', action),
};
