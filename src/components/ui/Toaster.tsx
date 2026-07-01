import { AnimatePresence, motion } from 'framer-motion';
import { useToast } from '../../store/useToast';

export function Toaster() {
  const toasts = useToast((s) => s.toasts);
  const dismiss = useToast((s) => s.dismiss);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 14, scale: 0.97 }}
            transition={{ duration: 0.18 }}
            className={`pointer-events-auto flex items-start gap-3 rounded-lg px-4 py-3 font-type text-sm shadow-card ring-1 ring-black/20 ${
              t.type === 'error'
                ? 'bg-pad-red text-white'
                : t.type === 'success'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-pad-ink text-manila'
            }`}
          >
            <span className="flex-1">{t.message}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
                className="shrink-0 rounded bg-white/20 px-2 py-0.5 font-semibold transition hover:bg-white/30"
              >
                {t.action.label}
              </button>
            )}
            <button
              onClick={() => dismiss(t.id)}
              className="shrink-0 opacity-70 transition hover:opacity-100"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
